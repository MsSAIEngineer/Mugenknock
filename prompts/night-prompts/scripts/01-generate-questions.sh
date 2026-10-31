#!/bin/bash
# 問題自動生成スクリプト
# instructions/ 内の資格ごとの指示を元に Claude で問題を生成し API 経由でインポートする
# 資格は「問題数が最も少ない資格」を自動選択する
#
# 環境変数（すべて任意）:
#   GEN_DOMAIN_CAP=20        1回の実行で1ドメインに割り当てる上限
#   GEN_CHUNK_SIZE=5         1回の claude 呼び出しで作る問題数
#   GEN_AVOID_MAX=60         プロンプトに渡す既出の正解肢の件数

set -uo pipefail

export PATH="/home/yuzuki/local/bin:/home/sera/.config/nvm/versions/node/v20.20.2/bin:$PATH"
unset ANTHROPIC_API_KEY

# ドメイン定義の単一マスタ（フロント src/data/examDomains.json と共通）。
# 未設定なら本スクリプト位置から解決。python ブロックはこの env を読む（無ければ埋め込みdictにフォールバック）。
_EDR_SD="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd 2>/dev/null || true)"
export EXAM_DOMAINS_JSON_PATH="${EXAM_DOMAINS_JSON_PATH:-${_EDR_SD}/../../../src/data/examDomains.json}"

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

# scripts/ 配下のどの深さに置かれても動作するパス解決
_d="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
while [ "$(basename "$_d")" != "scripts" ] && [ "$_d" != "/" ]; do _d="$(dirname "$_d")"; done
NIGHT_PROMPTS_DIR="$(dirname "$_d")"
LOG_DIR="$NIGHT_PROMPTS_DIR/logs"
INSTRUCTION_DIR="$_d/instructions"
STATE_DIR="$_d/state"
COUNT_CACHE_FILE="$STATE_DIR/question_counts.json"
API_ENDPOINT="https://a0q3656qw4.execute-api.ap-northeast-1.amazonaws.com/dev"
QUESTIONS_PER_DOMAIN=5
mkdir -p "$STATE_DIR"


# ── ヘルプ ──────────────────────────────────────────────────
show_help() {
  local exams
  exams=$(ls "$INSTRUCTION_DIR"/*.txt 2>/dev/null | xargs -I{} basename {} .txt | tr '\n' ' ')
  cat << EOF
usage: $(basename "$0") [options]

  -e, --exam EXAM       生成する資格を指定（例: SAA, CLF, DOP）
                        省略時は問題数が最も少ない資格を自動選択
  -d, --domain DOMAIN   生成するドメインを指定（-e と組み合わせて使用）
                        部分一致で検索（例: "セキュリティ"）。省略時は全ドメインを処理
  -n, --questions N     1ドメインあたりの問題数（デフォルト: ${QUESTIONS_PER_DOMAIN}）
  -D, --deadline HH:MM  処理終了時間（JST）。この時刻を過ぎたドメインはスキップ
  -H, --hard            難易度強化（全選択肢で同一サービス・競合要件など本試験の難問レベルへ。正解の一意性は厳守）
  -h, --help            このヘルプを表示

利用可能な資格: ${exams:-（instructions/ に .txt がありません）}
EOF
}

# ── 引数処理 ─────────────────────────────────────────────────
FORCE_EXAM=""
FORCE_DOMAIN=""
DEADLINE=""
REBUILD_COUNTS=0
HARD_MODE=0   # --hard で有効。難易度を本試験の難問レベルへ引き上げる（正確性・一意の正解は厳守）

while [[ $# -gt 0 ]]; do
  case "$1" in
    -e|--exam)
      FORCE_EXAM="${2:?--exam requires EXAM}"
      shift 2
      ;;
    -d|--domain)
      FORCE_DOMAIN="${2:?--domain requires DOMAIN}"
      shift 2
      ;;
    -n|--questions)
      QUESTIONS_PER_DOMAIN="${2:?--questions requires N}"
      shift 2
      ;;
    -D|--deadline)
      DEADLINE="${2:?--deadline requires HH:MM}"
      shift 2
      ;;
    -R|--rebuild-counts)
      REBUILD_COUNTS=1
      shift
      ;;
    -H|--hard)
      HARD_MODE=1
      shift
      ;;
    -h|--help)
      show_help; exit 0
      ;;
    *)
      echo "❌ 不明なオプション: $1" >&2
      show_help >&2
      exit 1
      ;;
  esac
done

# ── デッドライン計算 ──────────────────────────────────────────
DEADLINE_EPOCH=0
if [ -n "$DEADLINE" ]; then
  DEADLINE_EPOCH=$(python3 -c "
from datetime import datetime, timezone, timedelta
JST = timezone(timedelta(hours=9))
now = datetime.now(JST)
hh, mm = map(int, '${DEADLINE}'.split(':'))
dt = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
if dt <= now:
    dt = dt + timedelta(days=1)
print(int(dt.timestamp()))
" 2>/dev/null || echo 0)
  echo "⏰ デッドライン: ${DEADLINE} JST (epoch=${DEADLINE_EPOCH})"
fi

mkdir -p "$LOG_DIR"
DATE=$(date '+%Y%m%d_%H%M%S')
LOG_FILE="$LOG_DIR/generate_${DATE}.log"

# ── ドメイン定義: src/data/examDomains.json（単一マスタ）から読み込む ─
# DynamoDB の domain は examDomains.json の配列インデックスで格納される。
# Lambda 側の import も名前→index を examDomains.json の indexOf で解決するため、
# 生成・集計・割り当てのすべてでこのマスタと完全一致した名前を使う必要がある。
#
# ※ 以前は instructions/*.txt の # DOMAINS: 行も持っていたが、公式ガイドの表記が
#   毎月書き込まれてマスタと食い違い（集計が 0 問扱いになる不具合の原因になった）、
#   かつマスタ一本化後は警告を出す以外に使い道が無くなったため廃止した。
declare -A DOMAINS
_load_domains() {
  local exam="$1"
  local d
  d=$(EXAM="$exam" python3 - "$EXAM_DOMAINS_JSON_PATH" << 'PYEOF' 2>/dev/null
import json, os, sys
try:
    with open(sys.argv[1], encoding='utf-8') as f:
        data = json.load(f)
    names = [x['ja'] for x in data.get(os.environ['EXAM'], [])]
    if names:
        print(','.join(names))
except Exception:
    pass
PYEOF
  )
  [ -n "$d" ] && { echo "$d"; return; }
  # fallback（examDomains.json が読めない場合。内容はマスタと同一に保つこと）
  case "$exam" in
    CLF) echo "クラウドの概念,セキュリティとコンプライアンス,クラウドのテクノロジーとサービス,請求、料金、およびサポート" ;;
    SAA) echo "セキュアなアーキテクチャの設計,弾力性に優れたアーキテクチャの設計,高性能なアーキテクチャの設計,コスト最適化されたアーキテクチャの設計" ;;
    SAP) echo "組織の複雑さに対応する設計,新しいソリューションのための設計,既存のソリューションの継続的改善,ワークロードの移行とモダン化の加速" ;;
    DVA) echo "AWSのサービスを使用した開発,セキュリティ,デプロイ,トラブルシューティングと最適化" ;;
    SOA) echo "モニタリング、ロギング、分析、修復、およびパフォーマンスの最適化,信頼性とビジネス継続性,デプロイ、プロビジョニング、および自動化,セキュリティとコンプライアンス,ネットワークとコンテンツ配信" ;;
    DOP) echo "SDLC の自動化,構成管理と Infrastructure as Code (IaC),弾力性に優れたクラウドソリューション,モニタリングとロギング,インシデントとイベントへの対応,セキュリティとコンプライアンス" ;;
    AIF) echo "AIとMLの基礎,生成AIの基礎,基盤モデルのアプリケーション,責任あるAIのガイドライン,AIソリューションのセキュリティ、コンプライアンス、ガバナンス" ;;
    AIB) echo "AIの基礎とリテラシー,AI戦略とビジネス価値創出,AIガバナンスと責任あるAIリーダーシップ,ビジネス準備・リーダーシップ・AI変革" ;;
    MLA) echo "ML と AI のためのデータの準備,ML モデルと基盤モデル (FM) の開発,ML と AI のワークフローのデプロイとオーケストレーション,ML と AI のソリューションの運用、モニタリング、保護" ;;
    AIP) echo "基盤モデルの統合、データ管理、コンプライアンス,実装と統合,AIの安全性、セキュリティ、ガバナンス,生成AIアプリケーションの運用効率と最適化,テスト、検証、トラブルシューティング" ;;
    DEA) echo "データの取り込みと変換,データストアの管理,データオペレーションとサポート,データのセキュリティとガバナンス" ;;
    ANS) echo "ネットワーク設計,ネットワーク実装,ネットワーク管理と運用,ネットワークのセキュリティ、コンプライアンス、ガバナンス" ;;
    SCS) echo "検出,インシデント対応,インフラストラクチャのセキュリティ,アイデンティティとアクセス管理,データ保護,セキュリティの基盤とガバナンス" ;;
  esac
}

_get_exam_guide_url() {
  local exam="$1"
  local inst_file="${INSTRUCTION_DIR}/${exam}.txt"
  [ -f "$inst_file" ] && grep "^# EXAM_GUIDE_URL:" "$inst_file" | head -1 | sed 's/^# EXAM_GUIDE_URL: *//'
}


{
echo "=========================================="
echo "問題自動生成 開始: $(date)"
echo "=========================================="

# ── 対象資格の一覧を instructions/ から構築 ─────────────────
mapfile -t EXAM_TYPES < <(
  ls "$INSTRUCTION_DIR"/*.txt 2>/dev/null \
    | xargs -I{} basename {} .txt \
    | python3 -c "
import sys
ORDER = ['CLF', 'SAA', 'SAP', 'DVA', 'SOA', 'DEA', 'DOP', 'AIF', 'AIB', 'MLA', 'AIP', 'ANS', 'SCS', 'ML', 'DB', 'NW', 'SEC']
items = [l.strip() for l in sys.stdin if l.strip() and not l.strip().startswith('_')]
known   = [x for x in ORDER if x in items]
unknown = sorted(x for x in items if x not in ORDER)
print('\n'.join(known + unknown))
"
)

if [ ${#EXAM_TYPES[@]} -eq 0 ]; then
  echo "⚠️  instructions/ に .txt ファイルがありません"
  exit 0
fi

echo "対象資格: ${EXAM_TYPES[*]}"

# ── 生成する資格を決定 ────────────────────────────────────────
if [ -n "$FORCE_EXAM" ]; then
  # -e で明示指定
  if [ ! -f "$INSTRUCTION_DIR/${FORCE_EXAM}.txt" ]; then
    echo "❌ 指定した資格の指示ファイルがありません: ${INSTRUCTION_DIR}/${FORCE_EXAM}.txt"
    exit 1
  fi
  NEXT_EXAM="$FORCE_EXAM"
  echo "指定資格: $NEXT_EXAM"
else
  # ── 問題数が最も少ない資格を選ぶ ──
  # 2026-10-12 に一度「需要比（解答数/問題数）が最大の資格」に変えたが、CLF・SAA に偏るため
  # 同日中に問題数が最少の方式へ戻した（本人の判断）。需要は選定には使わず、ログの参考表示だけに残す。
  # 問題数は毎回 DynamoDB から取る（以前のキャッシュは S3 同期で巻き戻り、MLA の問題数が
  # 古い値で凍った実例がある）。同数のときは EXAM_TYPES の並び順で先のもの。
  echo "資格ごとの問題数・解答数を DynamoDB から取得中..."
  _SCAN_TMP=$(mktemp /tmp/gen_scan_XXXX.json)
  aws dynamodb scan --table-name Questions \
    --projection-expression "examType, globalAttempts" --output json > "$_SCAN_TMP" 2>/dev/null || true
  _SEL=$(python3 - "$_SCAN_TMP" "$COUNT_CACHE_FILE" "${EXAM_TYPES[@]}" << 'PYEOF'
import json, sys
from datetime import datetime
scan_file, cache_file, exams = sys.argv[1], sys.argv[2], sys.argv[3:]
with open(scan_file, encoding='utf-8') as f:
    content = f.read()
items, pos, dec = [], 0, json.JSONDecoder()
while True:
    s = content.find('{', pos)
    if s == -1:
        break
    try:
        obj, pos = dec.raw_decode(content, s)
    except ValueError:
        break
    items.extend(obj.get('Items', []))
count = {e: 0 for e in exams}
att = {e: 0 for e in exams}
for it in items:
    e = it.get('examType', {}).get('S')
    if e in count:
        count[e] += 1
        try:
            att[e] += int(it.get('globalAttempts', {}).get('N', '0'))
        except ValueError:
            pass
if not items:
    print('ERROR 0')
    sys.exit(0)
for e in sorted(exams, key=lambda e: count[e]):
    print(f'  {e}: {count[e]}問 / 解答{att[e]}回', file=sys.stderr)
pick = min(exams, key=lambda e: count[e])
why = '最少'
try:
    with open(cache_file) as fp:
        cache = json.load(fp)
except Exception:
    cache = {'exams': {}}
for e in exams:
    cache.setdefault('exams', {}).setdefault(e, {})['total'] = count[e]
cache['updated_at'] = datetime.now().isoformat()
with open(cache_file, 'w') as fp:
    json.dump(cache, fp, ensure_ascii=False, indent=2)
print(f'{pick} {count[pick]} {why}')
PYEOF
  )
  rm -f "$_SCAN_TMP"
  read -r NEXT_EXAM MIN_COUNT _SEL_WHY <<< "$_SEL"
  if [ "$NEXT_EXAM" = "ERROR" ] || [ -z "$NEXT_EXAM" ]; then
    echo "❌ DynamoDB から問題数を取得できませんでした"
    exit 1
  fi
  echo "選択: $NEXT_EXAM (現在${MIN_COUNT}問 — ${_SEL_WHY})"
fi

# ── ドメイン一覧を取得（examDomains.json が単一マスタ）──
DOMAIN_STR=$(_load_domains "$NEXT_EXAM")
if [ -z "$DOMAIN_STR" ]; then
  echo "⚠️  $NEXT_EXAM のドメイン定義がありません（src/data/examDomains.json に $NEXT_EXAM を追加してください）"
  exit 1
fi
EXAM_GUIDE_URL=$(_get_exam_guide_url "$NEXT_EXAM")
[ -n "$EXAM_GUIDE_URL" ] && echo "試験ガイドURL: $EXAM_GUIDE_URL"

IFS=',' read -ra DOMAIN_LIST <<< "$DOMAIN_STR"
DOMAIN_COUNT=${#DOMAIN_LIST[@]}

# ── ドメイン指定の解決 ────────────────────────────────────────
STATE_FILE="$STATE_DIR/last_domain_idx.json"

if [ -n "$FORCE_DOMAIN" ]; then
  # 完全一致 → 部分一致（大文字小文字無視）の順で検索
  MATCHED_DOMAIN=""
  for d in "${DOMAIN_LIST[@]}"; do
    if [ "$d" = "$FORCE_DOMAIN" ]; then
      MATCHED_DOMAIN="$d"
      break
    fi
  done
  if [ -z "$MATCHED_DOMAIN" ]; then
    MATCH_COUNT=0
    for d in "${DOMAIN_LIST[@]}"; do
      if echo "$d" | grep -qiF "$FORCE_DOMAIN"; then
        MATCHED_DOMAIN="$d"
        MATCH_COUNT=$(( MATCH_COUNT + 1 ))
      fi
    done
    if [ "$MATCH_COUNT" -gt 1 ]; then
      echo "❌ --domain '$FORCE_DOMAIN' が複数のドメインに一致します。より具体的なキーワードを指定してください:"
      for d in "${DOMAIN_LIST[@]}"; do
        echo "$d" | grep -qiF "$FORCE_DOMAIN" && echo "  - $d"
      done
      exit 1
    fi
  fi
  if [ -z "$MATCHED_DOMAIN" ]; then
    echo "❌ --domain '$FORCE_DOMAIN' が $NEXT_EXAM のどのドメインにも一致しません"
    echo "利用可能なドメイン:"
    printf '  - %s\n' "${DOMAIN_LIST[@]}"
    exit 1
  fi
  ROTATED_LIST=("$MATCHED_DOMAIN")
  START_IDX=0
  TOTAL_QUESTIONS=$QUESTIONS_PER_DOMAIN
  echo "対象ドメイン: $MATCHED_DOMAIN  /  ${QUESTIONS_PER_DOMAIN}問"
  # ドメイン手動指定時は重み付け割り当て不要（ループ内でデフォルト値を使用）
  DOMAIN_ALLOC_SKIP=1
else
  DOMAIN_ALLOC_SKIP=0
  TOTAL_QUESTIONS=$(( QUESTIONS_PER_DOMAIN * DOMAIN_COUNT ))
  echo "ドメイン数: $DOMAIN_COUNT  /  基本 ${QUESTIONS_PER_DOMAIN}問/ドメイン（重み付きで配分）  /  合計予算 ${TOTAL_QUESTIONS}問"

  START_IDX=$(python3 - "$STATE_FILE" "$NEXT_EXAM" "$DOMAIN_COUNT" << 'PYEOF'
import json, sys
sf, exam, count = sys.argv[1], sys.argv[2], int(sys.argv[3])
try:
    with open(sf) as f:
        state = json.load(f)
    last = int(state.get(exam, -1))
    print((last + 1) % count)
except:
    print(0)
PYEOF
)

  ROTATED_LIST=()
  for (( _i = 0; _i < DOMAIN_COUNT; _i++ )); do
    ROTATED_LIST+=("${DOMAIN_LIST[$(( (START_IDX + _i) % DOMAIN_COUNT ))]}")
  done
  echo "開始ドメイン: [${START_IDX}] ${ROTATED_LIST[0]}"
fi

# ── 指示ファイルを読み込む ────────────────────────────────────
INSTRUCTION=$(cat "$INSTRUCTION_DIR/${NEXT_EXAM}.txt")
COMMON_RULES=$(cat "$INSTRUCTION_DIR/_common-rules.txt")

# ── 難易度強化ブロック（--hard 時のみプロンプトへ注入）────────────────
# 本物の試験の難問レベルへ引き上げる。ただし「正解は必ず一意」「不正解は
# 明確な技術的理由で誤り」を絶対条件とし、正確性・問題としての正当性は失わない。
HARD_BLOCK=""
if [ "$HARD_MODE" -eq 1 ]; then
  HARD_HEAD=$(cat << 'HARDEOF'

【難易度強化（本試験の難問レベルへ）】
この資格の出題レベルの範囲内で、表面的な知識では解けない難問にすること。
※絶対条件: 正解は必ず1つに定まり、不正解はいずれも「特定の技術的理由」で明確に誤りであること。複数正解・解釈次第・優劣が曖昧、になる問題は作らない。
HARDEOF
)
  # 1. ペア構成はプロフェッショナル・専門知識（SAP/DOP/ANS/SCS）だけに課す。検証側の追加観点
  # （_validity-extra.txt）もこの4資格だけを想定しており、入門・基礎カードにまで一律で課すと
  # 選択肢の作り方が単調になる。それ以外の資格では 1. を付けない。
  HARD_PAIR=""
  case "$NEXT_EXAM" in
    SAP|DOP|ANS|SCS) HARD_PAIR=$(cat << 'HARDEOF'
1. ペア構成で惑わせる（本試験の最頻出パターン・必須）: 4択の選択肢を「2サービス×各2案」のペア構造にすること。
   - A・B: サービスXを使う2案（設定・構成・動作が異なる）
   - C・D: サービスYを使う2案（設定・構成・動作が異なる）
   例: A・B は EC2 Auto Scaling ベース（トリガー条件が異なる2案）、C・D は ECS Fargate ベース（タスク定義が異なる2案）
   → 「どちらのサービス群が正解か」に加え「そのサービスのどの設定が正しいか」の2段階判断を要求する。
   → 5択・複数正解の場合も同様に、2〜3のサービス/アプローチを2案ずつ用意して混乱させること。
   ※ 全選択肢が1サービスだけ（例：全部 CodeDeploy）でも良いが、その場合は設定の差を極力細かくすること。

HARDEOF
)
 ;;
  esac
  HARD_REST=$(cat << 'HARDEOF'
2. 不正解も実在の妥当な機能・設定にする: いかにも正しそうに見える実在の構成にしつつ、各不正解には「要件を満たさない明確な理由」（非対応・スケール/リージョン制限・前提条件の欠落・パフォーマンスやコストの不適合など）を必ず1つ持たせる。

3. 競合する複数要件を入れる: シナリオにコスト/性能/可用性/運用負荷/セキュリティ等の競合要件を複数含め、すべてを同時に満たす唯一の選択肢を問う。「最も〜（コスト効率/運用負荷最小 等）」型を活用する。

4. 具体条件を明示する: 数値・制限値・SLA・データ規模・AZ/リージョン構成・既存アーキテクチャなどの具体条件をシナリオに含め、条件の取捨選択を要求する。

5. ヒントを残さない: 選択肢の語調・丁寧さを揃え、正解だけ用語が丁寧・正解だけ極端に長い等のメタな手がかりを作らない。※文字数は上の【正解の文字数指定】に従う（正解を最長にする指定問題ではそれを優先。長さと正解を無相関にするための指定であり、正解が最長でも問題ない）。

※解説では「なぜ正解が唯一適切か」に加え、各不正解の「具体的な失格理由」を必ず明記すること。
HARDEOF
)
  # ペア構成を付けないときは、残りの規則の番号を 1 から振り直す（2.〜5. → 1.〜4.）
  if [ -z "$HARD_PAIR" ]; then
    HARD_REST=$(printf '%s\n' "$HARD_REST" | sed -e 's/^2\. /1. /' -e 's/^3\. /2. /' -e 's/^4\. /3. /' -e 's/^5\. /4. /')
  fi
  HARD_BLOCK="${HARD_HEAD}

${HARD_PAIR:+${HARD_PAIR}

}${HARD_REST}"
  echo "🎯 難易度強化モード（--hard）有効"
fi

# ── Cognito 認証（ループ前に1回だけ）────────────────────────────
echo ""
echo "--- Cognito 認証中 ---"
# 夜間バッチ専用ユーザーでログインする（scripts/batch-id-token.sh。人の管理者アカウントは MFA 付きなので使わない）
_cognito_auth() {
  local _t
  _t=$(bash /home/yuzuki/aws-quiz-app/scripts/batch-id-token.sh) || return 1
  ID_TOKEN="$_t"
}

# 1問分の取込ペイロード（$_validated）を POST する。結果は _http_body / _http_code に入る。
_import() {
  _http_resp=$(curl -s -w "\n%{http_code}" \
    -X POST \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${ID_TOKEN}" \
    -d "$_validated" \
    "${API_ENDPOINT}/admin/questions")
  _http_body=$(echo "$_http_resp" | head -n -1)
  _http_code=$(echo "$_http_resp" | tail -n 1)
}

if ! _cognito_auth; then
  echo "❌ Cognito 認証失敗"
  exit 1
fi
echo "✓ 認証完了"

# ── ドメイン別問題数を取得 → 逆数重み付き割り当て計算 ───────────────────────
echo ""
echo "--- ドメイン別問題数を取得・割り当て計算中 ---"
# questionText も一緒に取得し、既存問題リストとドメインカウントを同時に構築
_EXISTING_TMP=$(mktemp /tmp/existing_XXXX.json)
aws dynamodb query \
  --table-name Questions \
  --index-name examType-index \
  --key-condition-expression "examType = :e" \
  --expression-attribute-values "{\":e\": {\"S\": \"$NEXT_EXAM\"}}" \
  --projection-expression "#dom, questionText, correctAnswers, createdAt" \
  --expression-attribute-names '{"#dom":"domain"}' \
  --output json 2>/dev/null > "$_EXISTING_TMP" || echo '{"Items":[]}' > "$_EXISTING_TMP"

EXISTING_QS_FILE=$(mktemp /tmp/existing_qs_XXXX.json)
_COUNTS_TMP_EARLY=$(mktemp /tmp/domain_counts_XXXX.json)

TAG_COUNT_TEXT=$(python3 - "$_EXISTING_TMP" "$EXISTING_QS_FILE" "$_COUNTS_TMP_EARLY" "$DOMAIN_STR" "$NEXT_EXAM" << 'PYEOF'
import json, sys, re
from collections import Counter

def norm(s):
    return re.sub(r'[\s　]+', ' ', s).strip()

EXAM_DOMAINS = {'CLF': ['クラウドの概念', 'セキュリティとコンプライアンス', 'クラウドのテクノロジーとサービス', '請求、料金、およびサポート'], 'SAA': ['セキュアなアーキテクチャの設計', '弾力性に優れたアーキテクチャの設計', '高性能なアーキテクチャの設計', 'コスト最適化されたアーキテクチャの設計'], 'SAP': ['組織の複雑さに対応する設計', '新しいソリューションのための設計', '既存のソリューションの継続的改善', 'ワークロードの移行とモダン化の加速'], 'DVA': ['AWSのサービスを使用した開発', 'セキュリティ', 'デプロイ', 'トラブルシューティングと最適化'], 'SOA': ['モニタリング、ロギング、分析、修復、およびパフォーマンスの最適化', '信頼性とビジネス継続性', 'デプロイ、プロビジョニング、および自動化', 'セキュリティとコンプライアンス', 'ネットワークとコンテンツ配信'], 'DOP': ['SDLC の自動化', '構成管理と Infrastructure as Code (IaC)', '弾力性に優れたクラウドソリューション', 'モニタリングとロギング', 'インシデントとイベントへの対応', 'セキュリティとコンプライアンス'], 'AIF': ['AIとMLの基礎', '生成AIの基礎', '基盤モデルのアプリケーション', '責任あるAIのガイドライン', 'AIソリューションのセキュリティ、コンプライアンス、ガバナンス'], 'MLA': ['ML と AI のためのデータの準備', 'ML モデルと基盤モデル (FM) の開発', 'ML と AI のワークフローのデプロイとオーケストレーション', 'ML と AI のソリューションの運用、モニタリング、保護'], 'AIP': ['基盤モデルの統合、データ管理、コンプライアンス', '実装と統合', 'AIの安全性、セキュリティ、ガバナンス', '生成AIアプリケーションの運用効率と最適化', 'テスト、検証、トラブルシューティング'], 'DEA': ['データの取り込みと変換', 'データストアの管理', 'データオペレーションとサポート', 'データのセキュリティとガバナンス'], 'ANS': ['ネットワーク設計', 'ネットワーク実装', 'ネットワーク管理と運用', 'ネットワークのセキュリティ、コンプライアンス、ガバナンス'], 'SCS': ['検出', 'インシデント対応', 'インフラストラクチャのセキュリティ', 'アイデンティティとアクセス管理', 'データ保護', 'セキュリティの基盤とガバナンス']}
try:
    import json as _ejson, os as _eos
    _ep = _eos.environ.get('EXAM_DOMAINS_JSON_PATH')
    if _ep and _eos.path.exists(_ep):
        with open(_ep, encoding='utf-8') as _ef:
            EXAM_DOMAINS = {k: [d['ja'] for d in v] for k, v in _ejson.load(_ef).items()}
except Exception:
    pass

# AWS CLI paginates DynamoDB output as multiple concatenated JSON objects
_all_items = []
with open(sys.argv[1]) as _f:
    _content = _f.read()
_dec = json.JSONDecoder()
_pos = 0
while _pos < len(_content):
    _skip = _content.find('{', _pos)
    if _skip == -1:
        break
    try:
        _obj, _end = _dec.raw_decode(_content, _skip)
        _all_items.extend(_obj.get('Items', []))
        _pos = _end
    except Exception:
        break
data = {'Items': _all_items}

# ドメイン名セット（正規化済み）― これ以外のタグは割り当て計算・プロンプト表示から除外
domain_set = {norm(d.strip()) for d in sys.argv[4].split(',')} if len(sys.argv) > 4 else set()

counts = Counter()

for item in data.get('Items', []):
    domain_name = ''
    # 新形式: domain 整数インデックス → ドメイン名に変換
    # ※ examType はプロジェクションに含まれないため argv[5] で受け取る
    if 'N' in item.get('domain', {}):
        exam_type = sys.argv[5] if len(sys.argv) > 5 else ''
        try:
            idx = int(item['domain']['N'])
            domain_name = (EXAM_DOMAINS.get(exam_type, [])[idx:idx+1] or [''])[0]
        except (ValueError, IndexError):
            pass
    # 旧形式: tags リスト（後方互換）
    if not domain_name:
        tags_raw = item.get('tags', {})
        tags = []
        if 'L' in tags_raw:
            tags = [t.get('S', '').strip() for t in tags_raw['L'] if t.get('S', '').strip()]
        elif 'SS' in tags_raw:
            tags = [str(v).strip() for v in tags_raw['SS'] if str(v).strip()]
        if tags:
            domain_name = tags[0]
    if domain_name:
        counts[domain_name] += 1

# ドメイン名のみのカウント（逆数割り当て計算用）
# 0問のドメインもキーとして残す。落とすと「集計対象外」と「本当に0問」が
# 区別できず、割り当て表示・キャッシュから消えて重み付けの根拠が見えなくなる。
domain_order = [d.strip() for d in sys.argv[4].split(',') if d.strip()]
if domain_order:
    _by_norm = {}
    for k, v in counts.items():
        _by_norm[norm(k)] = _by_norm.get(norm(k), 0) + v
    domain_counts = {d: _by_norm.get(norm(d), 0) for d in domain_order}
    # マスタに無い名前で集計された分（旧データ等）は警告として残す
    orphans = {k: v for k, v in counts.items() if norm(k) not in domain_set}
    if orphans:
        for k, v in sorted(orphans.items()):
            print(f'  ⚠️ マスタ外のドメイン名 "{k}": {v}問（examDomains.json と不一致）')
else:
    domain_counts = dict(counts)

# _COUNTS_TMP_EARLY はドメイン名のみ（割り当て計算の入力）
with open(sys.argv[3], 'w', encoding='utf-8') as f:
    json.dump(domain_counts, f, ensure_ascii=False)

# プロンプトへの表示もドメイン名のみ
if domain_counts:
    for k, v in sorted(domain_counts.items(), key=lambda x: x[1]):
        print(f'  {k}: {v}問')
else:
    print('  （まだ問題がありません）')
PYEOF
)
# 重複対策の既出一覧（同じ資格の全問題。question-dedup.py が判定・プロンプト用要約に使う）
DEDUP_PY="$_d/question-dedup.py"
_EXISTING_N=$(python3 "$DEDUP_PY" build "$_EXISTING_TMP" "$NEXT_EXAM" "$DOMAIN_STR" "$EXISTING_QS_FILE" 2>/dev/null || echo "")
if [ -z "$_EXISTING_N" ]; then
  # 一覧が作れなくても生成は止めない（重複判定なしの従来動作になる）
  echo "⚠️  既出一覧の作成に失敗。重複判定なしで続行"
  echo '[]' > "$EXISTING_QS_FILE"
fi
rm -f "$_EXISTING_TMP"
echo "$TAG_COUNT_TEXT"

# ── キャッシュにドメイン内訳を同期（DynamoDB の正確な値で上書き）────────────
python3 - "$COUNT_CACHE_FILE" "$NEXT_EXAM" "$_COUNTS_TMP_EARLY" << 'PYEOF' 2>/dev/null || true
import json, sys
from datetime import datetime
cache_file, exam, counts_file = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(counts_file, encoding='utf-8') as f:
        domain_counts = json.load(f)
except Exception:
    sys.exit(0)
try:
    with open(cache_file) as f:
        cache = json.load(f)
except Exception:
    cache = {"exams": {}}
entry = cache.setdefault("exams", {}).setdefault(exam, {})
entry["domains"] = domain_counts
entry["total"] = sum(domain_counts.values())
cache["updated_at"] = datetime.now().isoformat()
with open(cache_file, 'w') as f:
    json.dump(cache, f, ensure_ascii=False, indent=2)
PYEOF

# ── 逆数重みによるドメイン別問題数割り当て ──────────────────────────────────
# ドメイン指定時はスキップ（QUESTIONS_PER_DOMAIN をそのまま使用）
if [ "$DOMAIN_ALLOC_SKIP" -eq 0 ]; then
  # 総予算 (TOTAL_QUESTIONS) を各ドメインの現在問題数の逆数で按分する
  # 問題数が少ないドメインほど多く割り当て、最低1問/ドメインを保証
  # 表示はstderrへ(outer 2>&1|teeでログに記録)、JSONはstdoutへ($()でキャプチャ)
  echo ""
  echo "ドメイン別生成数（逆数重み付き割り当て）:"

  DOMAIN_ALLOC_JSON=$(PYTHONIOENCODING=utf-8 python3 - "$DOMAIN_STR" "$_COUNTS_TMP_EARLY" "$TOTAL_QUESTIONS" << 'PYEOF'
import json, os, sys, re

def norm(s):
    return re.sub(r'[\s　]+', ' ', s).strip()

domains = [d.strip() for d in sys.argv[1].split(',')]
total   = int(sys.argv[3])
try:
    with open(sys.argv[2], encoding='utf-8') as f:
        raw_counts = json.load(f)
    counts = {norm(k): v for k, v in raw_counts.items()}
except Exception:
    counts = {}

# 最小数0（全予算を格差解消に充てる）
alloc = {d: 0 for d in domains}
remaining = total

# 1ドメインあたりの上限（1回の実行で）。以前は上限が無く、600問の予算が最少の1ドメインに
# 集中して「2問×57回」同じプロンプトで生成し、同じ論点の問題が大量にできていた
# （DB「インデックスと性能」96問中19問が同じ複合インデックスの論点）。上限を超えた予算は使わない
# （トークンは検証(02)に残る）。
cap = int(os.environ.get('GEN_DOMAIN_CAP', '20') or 20)

# レベル埋めアルゴリズム:
#   最も問題数が少ないドメイン群を「次のティア」まで引き上げることを繰り返し、
#   差を積極的に縮める（逆数重みより格差解消効果が大きい）。上限に達したドメインは外す。
def cur(d):
    return counts.get(norm(d), 0) + alloc[d]

while remaining > 0:
    open_d = [d for d in domains if alloc[d] < cap]
    if not open_d:
        break
    min_val  = min(cur(d) for d in open_d)
    at_min   = [d for d in open_d if cur(d) == min_val]
    above    = [d for d in open_d if cur(d) > min_val]

    if not above:
        # 全ドメイン同じ水準 → 現在の少ない順に1問ずつ配分
        sorted_d = sorted(open_d, key=lambda d: counts.get(norm(d), 0))
        i = 0
        while remaining > 0 and any(alloc[d] < cap for d in sorted_d):
            d = sorted_d[i % len(sorted_d)]
            if alloc[d] < cap:
                alloc[d] += 1
                remaining -= 1
            i += 1
        break

    next_level   = min(cur(d) for d in above)
    needed_per   = min(next_level - min_val, min(cap - alloc[d] for d in at_min))
    needed_total = needed_per * len(at_min)

    if needed_total <= remaining:
        # at_min 全員を next_level（または上限）まで引き上げる
        for d in at_min:
            alloc[d] += needed_per
        remaining -= needed_total
    else:
        # 予算不足: at_min に均等配分（余り分は現在数の少ない順に +1）
        each  = remaining // len(at_min)
        extra = remaining % len(at_min)
        for i, d in enumerate(sorted(at_min, key=lambda d: counts.get(norm(d), 0))):
            alloc[d] += each + (1 if i < extra else 0)
        remaining = 0

# 表示をstderrに出力(ログに記録される)
for d, n in sorted(alloc.items(), key=lambda x: -x[1]):
    print(f'  {n}問 → {d} (現在{counts.get(norm(d), 0)}問)', file=sys.stderr)
print(f'  合計: {sum(alloc.values())}問', file=sys.stderr)

# JSONをstdoutに出力($()でキャプチャ)。キーは現在の問題数が少ない順に並べる
# （後段の処理順で、割り当てが同数のときの並びに使う）。
print(json.dumps({d: alloc[d] for d in sorted(domains, key=lambda d: counts.get(norm(d), 0))}))
PYEOF
  )
  rm -f "$_COUNTS_TMP_EARLY"
  DOMAIN_ALLOC_JSON="${DOMAIN_ALLOC_JSON:-{}}"
  # 上限で削った後の実際の予算（合計インポートの分母に使う）
  TOTAL_QUESTIONS=$(printf '%s' "$DOMAIN_ALLOC_JSON" | python3 -c "import json,sys; print(sum(json.load(sys.stdin).values()))" 2>/dev/null || echo "$TOTAL_QUESTIONS")
else
  rm -f "$_COUNTS_TMP_EARLY"
  DOMAIN_ALLOC_JSON="{}"
fi

# 割り当て結果をファイルに保存（ループ内で sys.argv 経由でルックアップするため）
_ALLOC_FILE=$(mktemp /tmp/alloc_XXXX.json)
printf '%s\n' "$DOMAIN_ALLOC_JSON" > "$_ALLOC_FILE"

# ドメイン指定なし時：割り当て数の降順（＝現在問題数の昇順）にROTATED_LISTをソート
# → トークン切れで途中スキップされても問題数の少ない重要ドメインを先に処理できる
if [ "$DOMAIN_ALLOC_SKIP" -eq 0 ]; then
  SORTED=()
  while IFS= read -r _d; do SORTED+=("$_d"); done < <(
    PYTHONIOENCODING=utf-8 python3 - "$_ALLOC_FILE" "${ROTATED_LIST[@]}" << 'PYEOF'
import json, sys
try:
    with open(sys.argv[1], encoding='utf-8') as f:
        alloc, _ = json.JSONDecoder().raw_decode(f.read().strip())
except Exception:
    alloc = {}
domains = sys.argv[2:]
# 割り当てが同数（上限20で揃うことが多い）なら、alloc のキー順＝現在の問題数が少ない順にする。
# 名前順にすると、途中でレート制限に当たったときに手薄なドメインが後回しになる。
_order = {d: i for i, d in enumerate(alloc)}
for d in sorted(domains, key=lambda d: (-alloc.get(d, 0), _order.get(d, len(_order)))):
    print(d)
PYEOF
  )
  ROTATED_LIST=("${SORTED[@]}")
  echo "処理順（問題数少ない順）: $(IFS=', '; echo "${ROTATED_LIST[*]}")"
fi

# ── ドメインごとに生成 → 即インポート ──────────────────────────
RATE_LIMITED=0
TOTAL_IMPORTED=0
TIMEOUT_HIT=0
_DOMAIN_OFFSET=0

for domain in "${ROTATED_LIST[@]}"; do
  _DOMAIN_IDX=$(( (START_IDX + _DOMAIN_OFFSET) % DOMAIN_COUNT ))
  if [ "$DEADLINE_EPOCH" -gt 0 ] && [ "$(date +%s)" -ge "$DEADLINE_EPOCH" ]; then
    echo "⏰ デッドライン到達 (${DEADLINE} JST)。残りドメインをスキップ"
    TIMEOUT_HIT=1
    break
  fi

  _DOMAIN_T0=$(date +%s)
  # このドメインの割り当て問題数を取得（日本語をソースコードに埋め込まず sys.argv で渡す）
  Q_FOR_DOMAIN=$(PYTHONIOENCODING=utf-8 python3 - "$domain" "$QUESTIONS_PER_DOMAIN" "$_ALLOC_FILE" << 'PYEOF'
import json, sys
domain, default, alloc_file = sys.argv[1], int(sys.argv[2]), sys.argv[3]
try:
    with open(alloc_file, encoding='utf-8') as f:
        content = f.read().strip()
    alloc, _ = json.JSONDecoder().raw_decode(content)
except Exception as e:
    print(f'[WARN] alloc parse error: {e}', file=sys.stderr)
    alloc = {}
print(alloc.get(domain, default))
PYEOF
  )

  # チャンク分割。1回の呼び出しで5問。
  # 呼び出しごとに資格別の指示書（最大約1万字）と共通ルール（約2,600字）を送り直すので、
  # 1回あたりの問題数が少ないほど1問あたりの入力トークンが増える。以前は SAP/ANS 等を3問、
  # --hard でさらに半減（2問・SAA 等は1問）にしていた。根拠は「1チャンク300〜700秒かかり
  # レート制限の前に完走できない」だったが、2026-10 時点で2問約40秒になり当てはまらない。
  # 出力は1問ずつ即インポートするので、途中でレート制限に当たっても失うのは書きかけの1問だけ。
  CHUNK_SIZE=${GEN_CHUNK_SIZE:-5}; MIN_CHUNK_Q=3
  CHUNKS_TOTAL=$(( (Q_FOR_DOMAIN + CHUNK_SIZE - 1) / CHUNK_SIZE ))
  # 端数チャンクが最低問題数を下回る場合、最初のチャンクに吸収（チャンク数を1減らす）
  _LAST_Q=$(( Q_FOR_DOMAIN % CHUNK_SIZE ))
  if [ "$_LAST_Q" -ne 0 ] && [ "$_LAST_Q" -lt "$MIN_CHUNK_Q" ] && [ "$CHUNKS_TOTAL" -gt 1 ]; then
    FIRST_CHUNK_SIZE=$(( CHUNK_SIZE + _LAST_Q ))
    CHUNKS_TOTAL=$(( CHUNKS_TOTAL - 1 ))
  else
    FIRST_CHUNK_SIZE=$CHUNK_SIZE
  fi
  echo ""
  if [ "$CHUNKS_TOTAL" -gt 1 ]; then
    echo "--- [${domain}] ${Q_FOR_DOMAIN}問 生成中 (${CHUNK_SIZE}問×${CHUNKS_TOTAL}チャンク) --- 開始=$(date '+%H:%M:%S')"
  else
    echo "--- [${domain}] ${Q_FOR_DOMAIN}問 生成中 --- 開始=$(date '+%H:%M:%S')"
  fi

  DOMAIN_IMPORTED=0
  DOMAIN_DUP=0
  STATE_UPDATED=0
  DOMAIN_RATE_LIMITED=0

  for (( _chunk=1; _chunk<=CHUNKS_TOTAL; _chunk++ )); do
    # このチャンクで生成する問題数（端数対応・最初のチャンクは増量調整あり）
    if [ "$_chunk" -eq 1 ]; then
      _CHUNK_Q=$FIRST_CHUNK_SIZE
      [ "$_CHUNK_Q" -gt "$Q_FOR_DOMAIN" ] && _CHUNK_Q=$Q_FOR_DOMAIN
    else
      _CHUNK_Q=$(( Q_FOR_DOMAIN - FIRST_CHUNK_SIZE - (_chunk - 2) * CHUNK_SIZE ))
      [ "$_CHUNK_Q" -gt "$CHUNK_SIZE" ] && _CHUNK_Q=$CHUNK_SIZE
    fi

    # 終了時刻はチャンクごとに見る。以前はドメインの頭でしか見ておらず、1ドメインに多数の
    # チャンクがあると終了時刻を過ぎても走り続け、ラッパー側に強制終了されて末尾の処理
    # （キャッシュ再構築・S3同期・再ビルド予約）が飛んでいた（2026-10-12 07:30 の実行）。
    if [ "$DEADLINE_EPOCH" -gt 0 ] && [ "$(date +%s)" -ge "$DEADLINE_EPOCH" ]; then
      echo "⏰ デッドライン到達 (${DEADLINE} JST)。残りチャンクをスキップ"
      TIMEOUT_HIT=1
      break
    fi

    [ "$CHUNKS_TOTAL" -gt 1 ] && echo "  チャンク ${_chunk}/${CHUNKS_TOTAL}: ${_CHUNK_Q}問 生成中..."

    # ── 正解を最長にする問題をスクリプト側でランダム抽選（約6%）──────────────
    # 「正解は最長にならない」という規則性はメタ読み（最長を除外する消去法）を生む。
    # 一方でモデルは放っておくと正解を長く書く。以前は約25%を「正解を最長に」と指定していたが、
    # 実測（2026-10-10〜11 の435問）で正解が単独最長になった割合は39%（4択の偶然は25%）。
    # 指定しなかった問題でも約19%が最長になっていたので、指定は約6%（0..15 の一様乱数で 0）に下げ、
    # 合計が偶然の25%前後になるようにする。生成後の実測で調整すること。
    _LONGEST_NUMS=""
    for (( _qn=1; _qn<=_CHUNK_Q; _qn++ )); do
      if [ $(( RANDOM % 16 )) -lt 1 ]; then
        _LONGEST_NUMS="${_LONGEST_NUMS:+${_LONGEST_NUMS}, }${_qn}"
      fi
    done
    if [ -n "$_LONGEST_NUMS" ]; then
      LONGEST_DIRECTIVE="【正解の文字数指定（厳守）】
- 出力する${_CHUNK_Q}問のうち、${_LONGEST_NUMS} 番目の問題は「正解の選択肢」を4択の中で最長にすること（正解が最長でよい）。
- それ以外の番号の問題は正解を最長にしない。
- どの問題も、長さ以外の手がかり（正解だけ極端に長い・語調や要件語の反復）で正解を悟らせないこと。"
    else
      LONGEST_DIRECTIVE="【正解の文字数指定】この一連の問題では正解を最長の選択肢にせず、各選択肢の長さを揃える。"
    fi

    # このドメインの既出の決め手（正解肢）。今回の実行で取り込んだ分も含む（question-dedup.py が
    # 取り込みのたびに追記する）。モデルが既存問題を知らずに同じ論点を繰り返すのを防ぐ。
    _AVOID=$(python3 "$DEDUP_PY" avoid "$EXISTING_QS_FILE" "$domain" "${GEN_AVOID_MAX:-60}" 2>/dev/null || true)
    AVOID_BLOCK=""
    if [ -n "$_AVOID" ]; then
      AVOID_BLOCK="【このドメインの既出問題の正解（新しい順・抜粋）】
この一覧に無い概念・サービス・観点をできるだけ優先し、${_CHUNK_Q}問の論点もそれぞれ別にすること。
頻出論点を一覧と別の角度・別の要件で問うのはよいが、同じ問題の言い換えにはしない。
（指示書に「【現在のドメイン別問題数】を参考に手薄な概念を優先」とある場合は、この一覧に無い概念を優先する、と読み替える）
${_AVOID}
"
    fi

    PROMPT_FILE=$(mktemp /tmp/gen_prompt_XXXX.txt)
    cat > "$PROMPT_FILE" << PROMPT
${INSTRUCTION}

【対象資格】${NEXT_EXAM}
【対象ドメイン】${domain}
【作成問題数】${_CHUNK_Q} 問
${EXAM_GUIDE_URL:+【公式試験ガイド】${EXAM_GUIDE_URL}
（上の「公式試験ガイド概要」は本ガイドから抽出・最新化済み。Web取得は不要。概要のタスク・対象サービスに基づいて作成すること）
}

【出力形式】1問ずつ以下のJSON形式で1行に出力。前置き・後書き・コードブロック不要。${_CHUNK_Q} 問出力後は何も追記しない。

{"q":{"questionText":"問題文","choices":["選択肢0","選択肢1","選択肢2","選択肢3"],"correctAnswers":["正解の選択肢テキスト"],"correctAnswerIndices":[1],"explanation":"全体解説（120字以内）","choiceExplanations":["選択肢0の解説","選択肢1の解説","選択肢2の解説","選択肢3の解説"],"isMultiple":false}}

※ フォーマット規則:
- choices にラベル（A. B. 等）を付けない（テキストのみ）
- correctAnswerIndices が正解の正準指定（choices 配列内のインデックス・0始まり）。必ず正確に設定すること
- correctAnswers は必須。choices 配列内の正解テキストと完全一致で記載すること（欠落・不一致の問題は取込前バリデーションで破棄される）
- choiceExplanations は choices と同じ要素数・同じ順序（⚠最重要: choiceExplanations[i] は必ず choices[i] の選択肢を説明すること。順序ズレ厳禁）
  - 各選択肢の解説は簡潔に（上限80字。1文で完結でよい）
  - 正解選択肢: なぜ正解か（根拠から書き始める）
  - 不正解選択肢: なぜ不正解か（誤りの理由から書き始める）
  - 文頭に「正解です」「不正解です」などの判定文を入れない
- 複数正解: isMultiple true、correctAnswerIndices を複数要素で
- domain・tags フィールドは不要（インポート時にサーバー側でセットされる）
- 本サービスは日本語のみ。英語フィールド（questionTextEn 等）は出力しない。
- 選択肢にはその用語・答えのみを簡潔に記載し、用語の説明・定義文・略語の展開を選択肢内に含めない（不要なヒントになるため。説明・比較・理由・略語の意味は choiceExplanations／explanation 側へ）
- 略語が何の略かは選択肢ではなく解説側で説明する: explanation・choiceExplanations で重要な略語を初出で英語フルスペル併記して展開する（例 解説内で「BLEU(Bilingual Evaluation Understudy)」）。選択肢本文には展開を入れない
- 選択肢が単語・用語のみ（説明文でない）の場合は、選択肢の長さバランス規則を適用しない（最長の用語が正解でもよい）

${AVOID_BLOCK}
${LONGEST_DIRECTIVE}
${HARD_BLOCK}
【品質基準】
${COMMON_RULES}
PROMPT

    # 1問ずつNDJSON形式でストリーミング出力→即インポート。
    # < <() プロセス置換でサブシェルを作らずに外部変数を更新できる。
    # チャンクを大きくしても途中切れ時の全損がなく、出力済み分はDBに保存済み。
    _CHUNK_RATE_LIMITED=0
    _CHUNK_OVERLOADED=0
    _CHUNK_IMPORTED=0
    _OVERLOAD_RETRY=0
    _CHUNK_T0=$(date +%s)

    # 529 Overloaded（一時的なサーバー過負荷）はレート制限ではないので、チャンク単位でリトライする。
    while :; do
    _CHUNK_OVERLOADED=0
    _line_count=0
    while IFS= read -r _line || [ -n "$_line" ]; do
      _line_count=$(( _line_count + 1 ))

      # 先頭数行でエラー検出（問題文・解説中に同語句があっても誤検知しないよう、
      # まだ1問もインポートされていない最初の5行のみ対象にする）
      if [ "$_CHUNK_IMPORTED" -eq 0 ] && [ "$_line_count" -le 5 ]; then
        _head="${_line:0:300}"
        if echo "$_head" | grep -qiE "command not found|No such file|GEMINI_API_KEY|API.?key"; then
          echo "❌ claude 実行エラー（認証またはコマンド問題）。スクリプトを終了します"
          echo "出力: $_head"
          exit 1
        fi
        if echo "$_head" | grep -qiE "FailedToOpenSocket|connection refused|network error|socket|ECONNREFUSED|ETIMEDOUT"; then
          echo "⚠️  ネットワーク接続エラー。残りをスキップ"
          echo "出力: $_head"
          _CHUNK_RATE_LIMITED=1; break
        fi
        if echo "$_head" | grep -qiE "exceeded.*output token|output token.*maximum|CLAUDE_CODE_MAX_OUTPUT_TOKENS"; then
          echo "⚠️  出力トークン上限超過。チャンクサイズを下げてください"
          echo "出力: $_head"
          _CHUNK_RATE_LIMITED=1; break
        fi
        # 529 Overloaded（一時的なサーバー過負荷）はレート制限ではない。リトライ対象として区別する。
        if echo "$_head" | grep -qiE "529|Overloaded"; then
          echo "⚠️  サーバー過負荷（529 Overloaded）を検出"
          echo "出力: $_head"
          _CHUNK_OVERLOADED=1; break
        fi
        if echo "$_head" | grep -qiE "rate.?limit|too many requests|quota exceeded|usage limit|resource_exhausted|session.?limit|hit your"; then
          echo "⚠️  レート制限を検出。残りをスキップ"
          echo "出力: $_head"
          _CHUNK_RATE_LIMITED=1; break
        fi
      fi

      # {"q":{...,"questionText":...}} 形式の行のみ処理（前置き・後書きをスキップ）
      [[ "$_line" == *'"q"'*'"questionText"'* ]] || continue

      # バリデーション + APIペイロード生成（1問単位）
      _validated=$(echo "$_line" | PYTHONIOENCODING=utf-8 python3 -c "
import sys, json, re
label_re = re.compile(r'^[A-E][.\s]\s*', re.IGNORECASE)
try:
    obj = json.loads(sys.stdin.read().strip())
    q = obj.get('q')
    if not q or 'questionText' not in q:
        sys.exit(1)
    choices = [label_re.sub('', str(c)).strip() for c in q.get('choices', [])]
    correct = [label_re.sub('', str(c)).strip() for c in q.get('correctAnswers', [])]
    if len(choices) < 4 or len(set(choices)) != len(choices) or not correct:
        sys.stderr.write('  [DROP] 不正な問題: ' + str(q.get('questionText',''))[:30] + '\n')
        sys.exit(1)
    if any(ca not in choices for ca in correct):
        sys.stderr.write('  [DROP] 正解が選択肢にない: ' + str(q.get('questionText',''))[:30] + '\n')
        sys.exit(1)
    q['choices'] = choices
    q['correctAnswers'] = correct
    q['correctAnswerIndices'] = [choices.index(ca) for ca in correct]
    q['isMultiple'] = len(correct) > 1
    ce = q.get('choiceExplanations', [])
    if ce and len(ce) != len(choices):
        del q['choiceExplanations']
    print(json.dumps({'examType': '${NEXT_EXAM}', 'domain': '${domain}', 'questions': [q]},
                     ensure_ascii=False))
except Exception:
    sys.exit(1)
" 2>/dev/null) || continue

      # 重複判定（決定的・Claude 不要）。既出と問題文が完全一致（類似度0.9以上）なら取り込まない。
      # 頻出論点の被りは許容する方針なので、決め手が同じだけの問題は弾かない。
      # 判定を通ったものは既出一覧に追記され、以降のチャンクのプロンプトにも載る。
      if _dup_reason=$(printf '%s' "$_validated" | python3 "$DEDUP_PY" check "$EXISTING_QS_FILE" 2>/dev/null); then
        :
      elif [ $? -eq 3 ]; then
        echo "  [DUP] 既出と完全一致のため破棄: ${_dup_reason}"
        DOMAIN_DUP=$(( DOMAIN_DUP + 1 ))
        continue
      fi

      # 即インポート
      _import
      # ID トークンの有効期限は1時間。長い実行で切れると以降の取り込みがすべて 401 になり、
      # 生成済みの問題を捨てていた（2026-09-25）。401 なら1回だけ取り直して再送する。
      if [ "$_http_code" = "401" ] && _cognito_auth; then
        echo "  ↻ ID トークンを再取得して再送"
        _import
      fi

      if [ "$_http_code" -eq 200 ] || [ "$_http_code" -eq 201 ]; then
        _created_id=$(echo "$_http_body" | python3 -c \
          "import sys,json; print(json.load(sys.stdin).get('created',['?'])[0])" 2>/dev/null || echo "?")
        echo "  ✓ インポート: $_created_id"
        _CHUNK_IMPORTED=$(( _CHUNK_IMPORTED + 1 ))
        DOMAIN_IMPORTED=$(( DOMAIN_IMPORTED + 1 ))

        # キャッシュをインクリメント（1問単位）
        python3 - "$COUNT_CACHE_FILE" "$NEXT_EXAM" "$domain" << 'PYEOF' 2>/dev/null || true
import json, sys
from datetime import datetime
cache_file, exam, domain_name = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(cache_file) as f: cache = json.load(f)
except Exception: cache = {"exams": {}}
entry = cache.setdefault("exams", {}).setdefault(exam, {})
entry["total"] = entry.get("total", 0) + 1
entry.setdefault("domains", {})[domain_name] = entry["domains"].get(domain_name, 0) + 1
cache["updated_at"] = datetime.now().isoformat()
with open(cache_file, 'w') as f: json.dump(cache, f, ensure_ascii=False, indent=2)
PYEOF

        # State 更新（最初の成功インポート時のみ・ドメイン手動指定時はスキップ）
        if [ "$DOMAIN_ALLOC_SKIP" -eq 0 ] && [ "$STATE_UPDATED" -eq 0 ]; then
          python3 - "$STATE_FILE" "$NEXT_EXAM" "$_DOMAIN_IDX" << 'PYEOF' 2>/dev/null || true
import json, sys
sf, exam, idx = sys.argv[1], sys.argv[2], int(sys.argv[3])
try:
    with open(sf) as f: state = json.load(f)
except:
    state = {}
state[exam] = idx
with open(sf, 'w') as f: json.dump(state, f)
PYEOF
          STATE_UPDATED=1
        fi

      else
        echo "  ❌ API エラー (HTTP $_http_code): $_http_body"
      fi

    done < <(CLAUDE_CODE_MAX_OUTPUT_TOKENS=56000 timeout -k 30 "${CLAUDE_TIMEOUT:-1800}" "$CLAUDE_CMD" --strict-mcp-config -p --model sonnet --tools "" < "$PROMPT_FILE" 2>&1)

    # 529 Overloaded かつ このチャンクでまだ1問も取れていない → 最大3回リトライ（60秒待機）。
    # deadline を過ぎている場合はリトライせず打ち切る（トークン回復後まで走らせない）。
    if [ "$_CHUNK_OVERLOADED" -eq 1 ] && [ "$_CHUNK_IMPORTED" -eq 0 ] && [ "$_OVERLOAD_RETRY" -lt 3 ] \
       && { [ "$DEADLINE_EPOCH" -le 0 ] || [ "$(date +%s)" -lt "$DEADLINE_EPOCH" ]; }; then
      _OVERLOAD_RETRY=$(( _OVERLOAD_RETRY + 1 ))
      echo "  ⏳ 529 Overloaded のためリトライ (${_OVERLOAD_RETRY}/3回目・60秒待機)..."
      sleep 60
      continue
    fi
    break
    done  # 529リトライループ終了
    rm -f "$PROMPT_FILE"

    echo "  チャンク${_chunk}: ${_CHUNK_IMPORTED}問インポート  経過=$(( $(date +%s) - _CHUNK_T0 ))秒"

    # 529 が続いて0問のまま → このチャンクだけ諦めて次チャンクへ続行（残り全チャンクは捨てない）
    if [ "$_CHUNK_OVERLOADED" -eq 1 ] && [ "$_CHUNK_IMPORTED" -eq 0 ]; then
      echo "  ⚠️  529 Overloaded が継続。チャンク${_chunk}をスキップして次へ続行"
      continue
    fi

    if [ "$_CHUNK_IMPORTED" -eq 0 ] && [ "$_line_count" -gt 3 ]; then
      echo "❌ [${domain}] チャンク${_chunk}: {\"q\":...} 形式の問題が取得できませんでした（出力 ${_line_count} 行）"
    fi

    if [ "$_CHUNK_RATE_LIMITED" -eq 1 ]; then
      DOMAIN_RATE_LIMITED=1
      break
    fi

  done  # チャンクループ終了

  # このドメインでインポートした分を必ず合計へ計上する。レート制限で中断した場合も、
  # それまでにDB登録済み(HTTP 200)の分は計上する（以前は break が下記加算を飛ばし、
  # 実際にはインポート済みでも「合計インポート: 0問」と誤表示していた）。
  echo "  [${domain}] 合計 ${DOMAIN_IMPORTED}/${Q_FOR_DOMAIN}問 インポート（重複で破棄 ${DOMAIN_DUP}問）"
  TOTAL_IMPORTED=$(( TOTAL_IMPORTED + DOMAIN_IMPORTED ))
  echo "  終了=$(date '+%H:%M:%S')  経過=$(( $(date +%s) - _DOMAIN_T0 ))秒"

  if [ "$DOMAIN_RATE_LIMITED" -eq 1 ]; then
    RATE_LIMITED=1
    break
  fi
  [ "$TIMEOUT_HIT" -eq 1 ] && break

  _DOMAIN_OFFSET=$(( _DOMAIN_OFFSET + 1 ))
done

rm -f "$EXISTING_QS_FILE" "$_ALLOC_FILE"

echo ""
echo "合計インポート: ${TOTAL_IMPORTED}問 / ${TOTAL_QUESTIONS}問"

# ── 終了後キャッシュ再構築（DynamoDBから正確な値を取得）────────────────────
echo ""
echo "--- 問題数キャッシュを再構築中（DynamoDBから正確な値を取得）---"
declare -A _FINAL_COUNTS
_CACHE_VALID=1
for exam in "${EXAM_TYPES[@]}"; do
  count=$(aws dynamodb query \
    --table-name Questions \
    --index-name examType-index \
    --key-condition-expression "examType = :e" \
    --expression-attribute-values "{\":e\": {\"S\": \"$exam\"}}" \
    --select COUNT \
    --query 'Count' \
    --output text 2>&1 | awk '{s+=$1} END{print s+0}')
  count=${count:-0}
  # 全試験が0なら DynamoDB クエリ失敗とみなしキャッシュ更新をスキップ
  if [ "$count" -eq 0 ]; then _CACHE_VALID=0; fi
  _FINAL_COUNTS[$exam]=$count
  echo "  $exam: ${count}問"
done
if [ "$_CACHE_VALID" -eq 0 ] && [ "${#_FINAL_COUNTS[@]}" -gt 0 ]; then
  _total_sum=0
  for v in "${_FINAL_COUNTS[@]}"; do _total_sum=$(( _total_sum + v )); done
  if [ "$_total_sum" -eq 0 ]; then
    echo "⚠️  全試験が0問 — DynamoDBクエリ失敗の可能性。キャッシュ更新をスキップします"
    find "$LOG_DIR" -name "generate_*.log" -mtime +30 -delete 2>/dev/null || true
    exit 0
  fi
fi
python3 - "$COUNT_CACHE_FILE" << PYEOF
import json
from datetime import datetime
f = "$COUNT_CACHE_FILE"
try:
    with open(f) as fp: cache = json.load(fp)
except Exception: cache = {"exams": {}}
$(for exam in "${!_FINAL_COUNTS[@]}"; do echo "cache.setdefault('exams', {}).setdefault('${exam}', {})['total'] = ${_FINAL_COUNTS[$exam]}"; done)
cache["updated_at"] = datetime.now().isoformat()
with open(f, 'w') as fp: json.dump(cache, fp, ensure_ascii=False, indent=2)
PYEOF
echo "キャッシュ更新完了"

if [ $RATE_LIMITED -eq 1 ] || [ $TIMEOUT_HIT -eq 1 ]; then
  exit 1
fi

if [ $TOTAL_IMPORTED -gt 0 ]; then
  echo "インポート完了: $NEXT_EXAM +${TOTAL_IMPORTED}問"

  # Cloudflare Pages 再ビルドを2時間後にスケジュール
  # （手動実行・夜間実行どちらでも対応。複数回生成された場合は最後の完了から2時間にリセット）
  DEPLOY_HOOK="https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/7835a67a-386f-4874-b5d2-964556deea71"
  DEPLOY_UNIT="cloudflare-pages-deploy"
  # 既存スケジュールをキャンセルして新しく設定（最後の完了から2時間に更新）
  systemctl --user stop "${DEPLOY_UNIT}.service" 2>/dev/null || true
  systemctl --user reset-failed "${DEPLOY_UNIT}.service" 2>/dev/null || true
  if systemd-run --user --collect --on-active=7200 \
      --unit="$DEPLOY_UNIT" \
      --description="Cloudflare Pages Deploy Hook (scheduled)" \
      bash -c "curl -s -X POST '${DEPLOY_HOOK}' -o /dev/null -w 'CF Deploy: HTTP %{http_code}\n' && echo \"\$(date): CF Pages rebuild triggered\" >> /tmp/cloudflare-deploy.log" \
      2>/dev/null; then
    TRIGGER_TIME=$(date -d '+2 hours' '+%H:%M' 2>/dev/null || date -v+2H '+%H:%M' 2>/dev/null || echo "2時間後")
    echo "✓ Cloudflare Pages 再ビルドを ${TRIGGER_TIME} にスケジュールしました"
  else
    # systemd-runが使えない場合は即時フォールバック
    curl -s -X POST "$DEPLOY_HOOK" -o /dev/null -w "CF Deploy (即時): HTTP %{http_code}\n" 2>/dev/null \
      || echo "⚠ 再ビルドトリガー失敗"
  fi
fi

echo ""
echo "=========================================="
echo "完了: $(date)"
echo "=========================================="

# ── 更新した state を S3 へ書き戻す ────────────────────────────────
# state/ は各ラッパー（local-generate-hook-run 等）が起動時に S3 から引き直すが、
# s3 sync は「サイズが違えば古い方でも上書きダウンロード」するため、
# 夜間バッチ外（手動実行）で更新した question_counts.json / last_domain_idx.json は
# 次のフックで S3 の古い版に巻き戻る。実際 2026-08-02 の値で凍結していた。
# 自分が更新した分はここで S3 に反映し、ローカルと S3 を一致させておく。
if _acct=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) && [ -n "${_acct:-}" ]; then
  if aws s3 sync "$STATE_DIR/" "s3://mugenknock-fargate-state-${_acct}/state/" --quiet 2>/dev/null; then
    echo "✓ state を S3 に同期しました"
  else
    echo "⚠ state の S3 同期に失敗（ローカルのみ更新）"
  fi
fi

} 2>&1 | tee -a "$LOG_FILE"

find "$LOG_DIR" -name "generate_*.log" -mtime +30 -delete 2>/dev/null || true