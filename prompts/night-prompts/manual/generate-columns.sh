#!/bin/bash
# コラム生成スクリプト（手動実行 / alias: gcs）
#
# 管理画面「コラムのネタ」タブに投稿された未使用ネタを取得し、
# Claude + WebFetch で公式AWSドキュメントを使って裏取りしながらコラム（Tips）に仕上げ、
# コラム管理タブに登録する。コラム化に成功したネタは status='used' に無効化する。
#
# 使い方:
#   gcs                # 未使用ネタを全件処理
#   gcs -n 3           # 先頭3件だけ処理
#   gcs --dry-run      # 生成だけ行い、登録・無効化はしない（確認用）
#   API_STAGE=dev gcs  # /dev エンドポイントを使う（既定は /prod。DynamoDBは共通）

set -uo pipefail

export PATH="/home/yuzuki/local/bin:/home/sera/.config/nvm/versions/node/v20.20.2/bin:$PATH"
unset ANTHROPIC_API_KEY

_find_claude() {
  [ -x /usr/local/bin/claude ] && { echo /usr/local/bin/claude; return; }
  local _cv; _cv=$(command -v claude 2>/dev/null)
  [ -n "$_cv" ] && [ -x "$_cv" ] && { echo "$_cv"; return; }
}
CLAUDE_CMD=$(_find_claude)
if [ -z "${CLAUDE_CMD:-}" ]; then
  echo "⚠️  claude バイナリ未検出。30秒後にリトライします..." >&2
  sleep 30
  CLAUDE_CMD=$(_find_claude)
fi
if [ -z "${CLAUDE_CMD:-}" ] || [ ! -x "${CLAUDE_CMD:-}" ]; then
  echo "❌ claude コマンドが見つかりません" >&2; exit 1
fi

AWS_CLI=/home/yuzuki/local/bin/aws
[ -x "$AWS_CLI" ] || AWS_CLI=$(command -v aws)

# ── パス解決 ──
_d="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# manual/ の一つ上が night-prompts
NIGHT_PROMPTS_DIR="$(dirname "$_d")"
LOG_DIR="$NIGHT_PROMPTS_DIR/logs"
mkdir -p "$LOG_DIR"

API_STAGE="${API_STAGE:-prod}"
API_ENDPOINT="https://a0q3656qw4.execute-api.ap-northeast-1.amazonaws.com/${API_STAGE}"

LIMIT=0          # 0 = 全件
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    -n|--num)     LIMIT="${2:-0}"; shift 2 ;;
    --dry-run)    DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "不明なオプション: $1" >&2; exit 1 ;;
  esac
done

TS=$(date +%Y%m%d_%H%M%S)
LOG_FILE="$LOG_DIR/generate-columns_${TS}.log"
log() { echo "$@" | tee -a "$LOG_FILE"; }

log "=== コラム生成 (gcs) $(date '+%Y-%m-%d %H:%M:%S') / stage=$API_STAGE / dry_run=$DRY_RUN ==="

# ── Cognito 認証 ──
log "--- Cognito 認証中 ---"
ID_TOKEN=$(AWS="$AWS_CLI" bash /home/yuzuki/aws-quiz-app/scripts/batch-id-token.sh)
if [ -z "$ID_TOKEN" ] || [ "$ID_TOKEN" = "None" ]; then
  log "❌ Cognito 認証失敗"; exit 1
fi
log "✓ 認証完了"

# ── 未使用ネタを取得 ──
log "--- 未使用ネタを取得中 ---"
IDEAS_JSON=$(curl -s -H "Authorization: Bearer $ID_TOKEN" "$API_ENDPOINT/admin/column-ideas?status=pending")
IDEAS_FILE=$(mktemp /tmp/column_ideas_XXXX.json)
echo "$IDEAS_JSON" > "$IDEAS_FILE"

# ideaId<TAB>examType<TAB>text(base64)<TAB>note の形式で1行ずつ出力。
# text は常に非空の base64 で3番目に置く（note が空でも tab-IFS の連結で text がずれないように）。
PARSED=$(python3 - "$IDEAS_FILE" "$LIMIT" << 'PYEOF'
import json, sys, base64
path, limit = sys.argv[1], int(sys.argv[2])
try:
    data = json.load(open(path, encoding='utf-8'))
except Exception as e:
    sys.stderr.write(f"parse error: {e}\n"); sys.exit(0)
items = data.get('items', []) if isinstance(data, dict) else []
items = [i for i in items if i.get('status') != 'used']
if limit > 0:
    items = items[:limit]
for it in items:
    txt = base64.b64encode((it.get('text') or '').encode('utf-8')).decode('ascii')
    note = (it.get('note') or '').replace('\t', ' ').replace('\n', ' ')
    print('\t'.join([it.get('ideaId', ''), it.get('examType', 'ALL'), txt, note]))
PYEOF
)
rm -f "$IDEAS_FILE"

if [ -z "$PARSED" ]; then
  log "未使用のネタはありません。終了します。"
  exit 0
fi

TOTAL=$(echo "$PARSED" | grep -c .)
log "未使用ネタ: ${TOTAL} 件を処理します"
log ""

OK_COUNT=0; SKIP_COUNT=0; FAIL_COUNT=0
IDX=0

while IFS=$'\t' read -r IDEA_ID EXAM_TYPE TEXT_B64 NOTE; do
  [ -z "$IDEA_ID" ] && continue
  IDX=$((IDX+1))
  TEXT=$(echo "$TEXT_B64" | base64 -d)
  log "── [$IDX/$TOTAL] idea=$IDEA_ID exam=$EXAM_TYPE ──"
  log "ネタ: $(echo "$TEXT" | head -c 120)"

  if [ "$EXAM_TYPE" = "ALL" ]; then
    EXAM_NOTE='examType には内容に応じて "CLF" / "SAA" / "SAP" / "DOP" / "AIF" / "AIB" / "MLA" / "AIP" / "ALL" のいずれかを設定してください。'
  else
    EXAM_NOTE="examType には \"$EXAM_TYPE\" を設定してください。"
  fi
  NOTE_LINE=""
  [ -n "$NOTE" ] && NOTE_LINE="【投稿者メモ・参考】$NOTE"

  PROMPT_FILE=$(mktemp /tmp/column_prompt_XXXX.txt)
  cat > "$PROMPT_FILE" << PROMPTEOF
あなたはAWSクラウドの教育コンテンツ作成の専門家です。
以下の「ネタ」を題材に、AWS認定試験の学習者向けコラム（豆知識）を1件作成してください。

【ネタ】
$TEXT
$NOTE_LINE

【最重要・裏取り（ファクトチェック）】
・このネタに含まれる事実（サービスの仕様・制限・歴史・課金・ベストプラクティス等）が現在も正確かどうかを、WebFetch で公式AWSドキュメント（docs.aws.amazon.com / aws.amazon.com 等）を確認して裏取りしてください。
・確信が持てない数値・固有名詞・現行性（廃止/名称変更/仕様変更）は推測で書かず、必ず WebFetch で確認してから書くこと。
・ネタの一部が誤っている場合は、正しい事実に修正してコラム化してください。
・ネタ全体が事実として明確に誤り、または題材としてコラムに不適切で救いようがない場合のみ skip にしてください。

【コラム作成ルール】
・タイトルは30字以内で、内容を端的に表すこと
・本文は120〜280字程度で、試験に役立つ実践的・正確な知識を書くこと
・「〜です。〜ます。」調の丁寧語で統一すること
・読者が「へぇ」と思える面白さと、試験での実用性を両立させること
・$EXAM_NOTE

【出力形式】
必ず以下のJSONのみを1個出力してください（前後の説明文・マークダウンのコードフェンスは不要）。
コラム化する場合:
{"title":"コラムタイトル","content":"コラム本文","examType":"SAA"}
題材が不適切でコラム化しない場合:
{"skip":true,"reason":"理由を日本語で簡潔に"}
PROMPTEOF

  _STDOUT_F=$(mktemp /tmp/claude_out_XXXX)
  _STDERR_F=$(mktemp /tmp/claude_err_XXXX)
  "$CLAUDE_CMD" -p --allowed-tools WebFetch < "$PROMPT_FILE" > "$_STDOUT_F" 2> "$_STDERR_F"
  AI_EXIT=$?
  RESULT=$(cat "$_STDOUT_F")
  _STDERR=$(cat "$_STDERR_F")
  rm -f "$_STDOUT_F" "$_STDERR_F" "$PROMPT_FILE"

  if echo "$_STDERR" | grep -qiE "command not found|No such file|API.?key|rate.?limit|usage limit|hit your"; then
    log "❌ claude 実行エラー: $(echo "$_STDERR" | head -2)"
    FAIL_COUNT=$((FAIL_COUNT+1))
    continue
  fi

  # JSON を抽出して title/content/examType または skip を取り出す
  OUT_FILE=$(mktemp /tmp/column_out_XXXX.txt)
  echo "$RESULT" > "$OUT_FILE"
  PARSED_OUT=$(python3 - "$OUT_FILE" "$EXAM_TYPE" << 'PYEOF'
import json, sys, re, base64
raw = open(sys.argv[1], encoding='utf-8').read()
default_exam = sys.argv[2]
# コードフェンス除去
raw = re.sub(r'```[a-zA-Z]*', '', raw)
# 最初の { から対応する } までを素朴に抽出
start = raw.find('{')
obj = None
if start >= 0:
    depth = 0
    for i in range(start, len(raw)):
        if raw[i] == '{': depth += 1
        elif raw[i] == '}':
            depth -= 1
            if depth == 0:
                try: obj = json.loads(raw[start:i+1])
                except Exception: obj = None
                break
if not isinstance(obj, dict):
    print("ERROR"); sys.exit(0)
if obj.get('skip'):
    print("SKIP\t" + (obj.get('reason','') or '').replace('\n',' '))
    sys.exit(0)
title = (obj.get('title') or '').strip()
content = (obj.get('content') or '').strip()
exam = (obj.get('examType') or default_exam or 'ALL').strip()
if not title or not content:
    print("ERROR"); sys.exit(0)
payload = base64.b64encode(json.dumps({"examType": exam, "title": title, "content": content}, ensure_ascii=False).encode('utf-8')).decode('ascii')
print("OK\t" + payload)
PYEOF
)
  rm -f "$OUT_FILE"

  KIND=$(echo "$PARSED_OUT" | cut -f1)
  if [ "$KIND" = "SKIP" ]; then
    REASON=$(echo "$PARSED_OUT" | cut -f2-)
    log "⏭  skip: $REASON （ネタは未使用のまま残します）"
    SKIP_COUNT=$((SKIP_COUNT+1))
    continue
  fi
  if [ "$KIND" != "OK" ]; then
    log "❌ 出力の解析に失敗（$(echo "$RESULT" | head -c 120)）"
    FAIL_COUNT=$((FAIL_COUNT+1))
    continue
  fi

  TIP_JSON=$(echo "$PARSED_OUT" | cut -f2- | base64 -d)
  TITLE_PREVIEW=$(echo "$TIP_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["title"])' 2>/dev/null)
  log "✓ コラム生成: $TITLE_PREVIEW"

  if [ "$DRY_RUN" = "1" ]; then
    log "   (dry-run: 登録・無効化はスキップ)"
    log "   $TIP_JSON"
    OK_COUNT=$((OK_COUNT+1))
    log ""
    continue
  fi

  # Tips に登録
  TIP_RES=$(curl -s -X POST -H "Authorization: Bearer $ID_TOKEN" -H "Content-Type: application/json" \
    -d "$TIP_JSON" "$API_ENDPOINT/admin/tips")
  TIP_ID=$(echo "$TIP_RES" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("tipId",""))' 2>/dev/null)
  if [ -z "$TIP_ID" ]; then
    log "❌ コラム登録失敗: $(echo "$TIP_RES" | head -c 200)"
    FAIL_COUNT=$((FAIL_COUNT+1))
    log ""
    continue
  fi
  log "✓ コラム登録 tipId=$TIP_ID"

  # ネタを無効化（used）
  curl -s -X PUT -H "Authorization: Bearer $ID_TOKEN" -H "Content-Type: application/json" \
    -d "{\"status\":\"used\",\"resultTipId\":\"$TIP_ID\"}" \
    "$API_ENDPOINT/admin/column-ideas/$IDEA_ID" > /dev/null
  log "✓ ネタを無効化（used）"
  OK_COUNT=$((OK_COUNT+1))
  log ""
done <<< "$PARSED"

log "=== 完了: 生成 $OK_COUNT 件 / skip $SKIP_COUNT 件 / 失敗 $FAIL_COUNT 件 ==="
log "ログ: $LOG_FILE"
