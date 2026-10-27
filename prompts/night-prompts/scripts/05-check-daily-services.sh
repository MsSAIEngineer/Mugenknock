#!/bin/bash
# 日めくりAWSサービスの体裁・内容妥当性チェックスクリプト
# 問題なし→確認日のみ更新 / 問題あり→自動修正またはDB削除

set -uo pipefail

export PATH="/home/yuzuki/local/bin:$PATH"
unset ANTHROPIC_API_KEY

# --lifecycle-only: 冒頭の決定的な処理（0. 提供状態ライフサイクル・0.5 重複削除）だけを実行して終える。
# claude を使わないので、トークン節約で止めている夜間バッチとは別に、毎晩の
# mugenknock-nightly-noai（カタログ更新の直後）から呼ぶ（2026-10-27）。
LIFECYCLE_ONLY=0
DRY_RUN=0
for _a in "$@"; do
  [ "$_a" = "--lifecycle-only" ] && LIFECYCLE_ONLY=1
  [ "$_a" = "--dry-run" ] && { LIFECYCLE_ONLY=1; DRY_RUN=1; }
done
export DRY_RUN

_find_claude() {
  [ -x /usr/local/bin/claude ] && { echo /usr/local/bin/claude; return; }
  local _cv; _cv=$(command -v claude 2>/dev/null)
  [ -n "$_cv" ] && [ -x "$_cv" ] && { echo "$_cv"; return; }
}
CLAUDE_CMD=$(_find_claude)
if [ "$LIFECYCLE_ONLY" -eq 1 ]; then
  CLAUDE_CMD="${CLAUDE_CMD:-unused}"
elif [ -z "${CLAUDE_CMD:-}" ]; then
  echo "⚠️  claude バイナリ未検出。30秒後にリトライします..." >&2
  sleep 30
  CLAUDE_CMD=$(_find_claude)
fi
if [ "$LIFECYCLE_ONLY" -eq 0 ] && { [ -z "${CLAUDE_CMD:-}" ] || [ ! -x "${CLAUDE_CMD:-}" ]; }; then
  echo "❌ claude コマンドが見つかりません" >&2; exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NIGHT_PROMPTS_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$NIGHT_PROMPTS_DIR/logs"
mkdir -p "$LOG_DIR"
DATE=$(date '+%Y%m%d_%H%M%S')
LOG_FILE="$LOG_DIR/daily_check_${DATE}.log"

RATE_LIMIT_FILE="$NIGHT_PROMPTS_DIR/.claude_rate_limit_reset"

check_rate_limit() {
  [ -f "$RATE_LIMIT_FILE" ] || return 0
  local _rst _now _rep _disp
  _rst=$(cat "$RATE_LIMIT_FILE" 2>/dev/null)
  [ -z "$_rst" ] && { rm -f "$RATE_LIMIT_FILE"; return 0; }
  _now=$(date +%s)
  _rep=$(python3 -c "
from datetime import datetime
try: print(int(datetime.fromisoformat('$_rst').timestamp()))
except: print(0)
" 2>/dev/null || echo 0)
  if [ "$_now" -lt "$_rep" ]; then
    _disp=$(python3 -c "
from datetime import datetime, timezone, timedelta
jst = timezone(timedelta(hours=9))
try: print(datetime.fromisoformat('$_rst').astimezone(jst).strftime('%H:%M JST'))
except: print('$_rst')
" 2>/dev/null || echo "$_rst")
    echo "  🔒 レート制限中: リセット予定 $_disp"
    return 1
  fi
  rm -f "$RATE_LIMIT_FILE"
}

record_rate_limit() {
  local _c="$1" _tmp _rst _disp
  _tmp=$(mktemp /tmp/rl_XXXX.txt)
  printf '%s' "$_c" > "$_tmp"
  _rst=$(python3 - "$_tmp" << 'PYEOF'
import sys, re
from datetime import datetime, timezone, timedelta
jst = timezone(timedelta(hours=9))
with open(sys.argv[1]) as f:
    text = f.read()
m = re.search(r'resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)', text, re.IGNORECASE)
if not m:
    print((datetime.now(jst) + timedelta(hours=6)).isoformat())
    sys.exit(0)
hour = int(m.group(1))
minute = int(m.group(2)) if m.group(2) else 0
mer = m.group(3).lower()
if mer == 'pm' and hour != 12: hour += 12
elif mer == 'am' and hour == 12: hour = 0
now = datetime.now(jst)
reset_dt = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
if reset_dt <= now:
    reset_dt += timedelta(days=1)
print(reset_dt.isoformat())
PYEOF
)
  rm -f "$_tmp"
  if [ -n "$_rst" ]; then
    echo "$_rst" > "$RATE_LIMIT_FILE"
    _disp=$(python3 -c "
from datetime import datetime, timezone, timedelta
jst = timezone(timedelta(hours=9))
try: print(datetime.fromisoformat('$_rst').astimezone(jst).strftime('%Y-%m-%d %H:%M JST'))
except: print('$_rst')
" 2>/dev/null || echo "$_rst")
    echo "  🔒 レート制限ロックファイル記録: $_disp"
  fi
}

show_help() {
  cat << 'EOF'
usage: 05-check-daily-services.sh [-n N] [-D HH:MM] [-h]

  -n N       チェック件数 (default: 20)
  -D HH:MM   処理終了時刻 (JST)。この時刻を過ぎたチャンクはスキップ
  --lifecycle-only  提供状態ライフサイクルと重複削除だけ実行して終える（claude 不要）
  --dry-run         --lifecycle-only を DynamoDB を書き換えずに実行し、何をするかだけ表示する
  -h         このヘルプを表示

挙動:
  未チェック（contentCheckedAt なし）を優先
  全件チェック済みの場合は確認日付が古い順
  action=ok     → contentCheckedAt のみ更新
  action=fix    → サービス内容を上書き・contentCheckedAt 更新
  action=delete → DynamoDB から削除
EOF
}

BATCH_SIZE=5
CHUNK_SIZE=5
DEADLINE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n) BATCH_SIZE="${2:?-n requires N}"; shift 2 ;;
    -D) DEADLINE="${2:?-D requires HH:MM}"; shift 2 ;;
    --lifecycle-only|--dry-run) shift ;;
    -h|--help) show_help; exit 0 ;;
    *) echo "不明なオプション: $1" >&2; show_help >&2; exit 1 ;;
  esac
done

# 終了時刻をepoch秒に変換（JST）
DEADLINE_EPOCH=0
if [ -n "$DEADLINE" ]; then
  DEADLINE_EPOCH=$(python3 - "$DEADLINE" << 'PYEOF'
import sys
from datetime import datetime, timedelta, timezone
JST = timezone(timedelta(hours=9))
now = datetime.now(JST)
try:
    h, m = map(int, sys.argv[1].split(':'))
    t = now.replace(hour=h, minute=m, second=0, microsecond=0)
    print(int(t.timestamp()))
except Exception as e:
    print(f"❌ -D のパースエラー: {e}", file=sys.stderr); print(0)
PYEOF
)
fi

{
[ "$LIFECYCLE_ONLY" -eq 0 ] && check_rate_limit
echo "=========================================="
echo "日めくりサービス体裁チェック開始: $(date)"
echo "バッチサイズ: ${BATCH_SIZE}件 / チャンクサイズ: ${CHUNK_SIZE}件"
echo "=========================================="

# ── 0. 提供状態ライフサイクル（カタログ照合・決定的・WebFetch不要）──────
#   service-catalog.json が単一の真実source。記事のサービスを名称で照合し:
#     status が active 以外（新規受付終了/非推奨/EOL/改名）→
#        未フラグなら警告(deprecationNote)＋deprecatedAt を付与（記事は残す＝猶予1ヶ月）
#        deprecatedAt から30日経過なら削除
#     status が active に戻った（復活）→ 警告フラグを解除
#   ※判定は事前にカタログ側が claude+WebFetch で確認済みのため、ここはDB更新のみ。
CATALOG_FILE="$SCRIPT_DIR/state/service-catalog.json"
GRACE_DAYS=30
# 図鑑から記事を消したら記録する。generate-release-note.sh がその日のリリースノートに載せる（2026-10-27）
export REMOVALS_FILE="$SCRIPT_DIR/state/daily-service-removals.jsonl"
if [ -f "$CATALOG_FILE" ]; then
  echo ""
  echo "--- 提供状態ライフサイクル照合中（猶予 ${GRACE_DAYS}日）---"
  _LC_TMP=$(mktemp /tmp/ds_lifecycle_XXXX.json)
  /home/yuzuki/local/bin/aws dynamodb scan --table-name DailyServices --output json 2>/dev/null > "$_LC_TMP" || echo '{}' > "$_LC_TMP"
  CATALOG_FILE="$CATALOG_FILE" GRACE_DAYS="$GRACE_DAYS" DS_TMP="$_LC_TMP" python3 << 'PYEOF'
import json, os, re, subprocess
def _run(cmd, **kw):
    # DRY_RUN=1 のときは DynamoDB を書き換えず、何をするかだけ表示する
    if os.environ.get('DRY_RUN') == '1':
        return None
    return subprocess.run(cmd, **kw)
from datetime import datetime, timezone, date

AWS = '/home/yuzuki/local/bin/aws'
grace = int(os.environ['GRACE_DAYS'])
today = date.today()
now_iso = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

def norm(s):
    s = (s or '').lower().strip()
    s = re.sub(r'^(amazon|aws)\s+', '', s)
    return re.sub(r'[^a-z0-9]', '', s)

# カタログ: 正規化名 → status情報（status==unknown は判定対象外）
with open(os.environ['CATALOG_FILE'], encoding='utf-8') as f:
    catalog = json.load(f)
# 同じ名前のエントリが複数あることがある（例: 現行の「AWS Transform」と、Migration Hub が
# 「AWS Transform」へ改名されたことを表す __code__mgh）。後勝ちにすると現行サービスを廃止扱いにするので:
#   - active と renamed が並んだら active を採る（改名先の名前は生きている）
#   - それ以外は lastVerifiedAt が新しい方を採る
def _prefer(cur, new):
    if cur is None:
        return new
    pair = {cur.get('status'), new.get('status')}
    if pair == {'active', 'renamed'}:
        return cur if cur.get('status') == 'active' else new
    return new if (new.get('lastVerifiedAt') or '') > (cur.get('lastVerifiedAt') or '') else cur

status_map = {}
for v in catalog.get('services', {}).values():
    name = v.get('name')
    st = v.get('status')
    if not name or st in (None, 'unknown'):
        continue
    status_map[norm(name)] = _prefer(status_map.get(norm(name)), v)

NON_ACTIVE = {'closed_to_new', 'deprecated', 'eol', 'renamed'}
LABEL = {
    'closed_to_new': '新規受付が終了しています',
    'deprecated': '非推奨となっています',
    'eol': '提供終了（予定）です',
    'renamed': '別サービスへ統合・改名されました',
}

def deser(v):
    if 'S' in v: return v['S']
    if 'N' in v: return v['N']
    if 'BOOL' in v: return v['BOOL']
    return None

with open(os.environ['DS_TMP']) as f:
    ds = json.load(f)
items = ds.get('Items', [])

flagged = deleted = cleared = 0
for it in items:
    sid = (it.get('serviceId') or {}).get('S')
    name = (it.get('name') or {}).get('S')
    if not sid or not name:
        continue
    cat = status_map.get(norm(name))
    cur_dep_at = (it.get('deprecatedAt') or {}).get('S')

    # active（またはカタログ未収録）→ 既にフラグ済みなら解除
    if not cat or cat.get('status') not in NON_ACTIVE:
        if cur_dep_at:
            _run([AWS, 'dynamodb', 'update-item', '--table-name', 'DailyServices',
                '--key', json.dumps({'serviceId': {'S': sid}}),
                '--condition-expression', 'attribute_exists(serviceId)',
                '--update-expression', 'REMOVE deprecatedAt, deprecationNote, deprecationStatus SET updatedAt = :u',
                '--expression-attribute-values', json.dumps({':u': {'S': now_iso}})], capture_output=True)
            cleared += 1
            print(f'  [復活] {name}: active復帰 → 警告解除')
        continue

    st = cat['status']
    note_reason = cat.get('statusNote') or ''
    # 既にフラグ済み → 猶予超過なら削除
    if cur_dep_at:
        try:
            d0 = datetime.fromisoformat(cur_dep_at.replace('Z', '+00:00')).date()
        except Exception:
            d0 = today
        if (today - d0).days >= grace:
            _run([AWS, 'dynamodb', 'delete-item', '--table-name', 'DailyServices',
                '--key', json.dumps({'serviceId': {'S': sid}})], capture_output=True)
            deleted += 1
            print(f'  [削除] {name}: {LABEL.get(st, st)}・猶予{grace}日経過 → 削除')
            if os.environ.get('DRY_RUN') != '1':
                with open(os.environ['REMOVALS_FILE'], 'a', encoding='utf-8') as rf:
                    rf.write(json.dumps({'date': today.isoformat(), 'serviceId': sid, 'name': name,
                        'reason': LABEL.get(st, st), 'reasonNote': note_reason, 'source': 'lifecycle'}, ensure_ascii=False) + '\n')
        continue

    # 未フラグ → 警告を付与（記事は残す）
    from datetime import timedelta
    del_on = (today + timedelta(days=grace)).isoformat()
    base = f'このサービスはAWSで{LABEL.get(st, st)}'
    if note_reason:
        base += f'（{note_reason}）'
    note = base + f'。{del_on}頃にサービス図鑑から削除されます。'
    _run([AWS, 'dynamodb', 'update-item', '--table-name', 'DailyServices',
        '--key', json.dumps({'serviceId': {'S': sid}}),
        '--condition-expression', 'attribute_exists(serviceId)',
        '--update-expression', 'SET deprecatedAt = :a, deprecationNote = :n, deprecationStatus = :s, updatedAt = :u',
        '--expression-attribute-values', json.dumps({
            ':a': {'S': today.isoformat()}, ':n': {'S': note},
            ':s': {'S': st}, ':u': {'S': now_iso}})], capture_output=True)
    flagged += 1
    print(f'  [警告] {name}: {LABEL.get(st, st)} → 警告付与（{del_on}削除予定）')

print(f'  → ライフサイクル: 新規警告={flagged} 削除={deleted} 復活解除={cleared}')
PYEOF
  rm -f "$_LC_TMP"
fi

# ── 0.5 重複記事の自動削除（docUrlで正準照合・決定的・WebFetch不要）──────
#   同一サービス(docUrl一致)の記事が複数ある場合、order最小の確立済み1件を残して残りを削除。
#   略称⇔正式名の二重生成(例 AWS DMS / AWS Database Migration Service)を機械的に解消する。
echo ""
echo "--- 重複記事チェック（docUrl照合・自動削除）---"
_DUP_TMP=$(mktemp /tmp/ds_dup_XXXX.json)
/home/yuzuki/local/bin/aws dynamodb scan --table-name DailyServices --output json 2>/dev/null > "$_DUP_TMP" || echo '{}' > "$_DUP_TMP"
DS_TMP="$_DUP_TMP" python3 << 'PYEOF'
import json, os, re, subprocess
def _run(cmd, **kw):
    # DRY_RUN=1 のときは DynamoDB を書き換えず、何をするかだけ表示する
    if os.environ.get('DRY_RUN') == '1':
        return None
    return subprocess.run(cmd, **kw)
from datetime import datetime, timezone
AWS = '/home/yuzuki/local/bin/aws'
now_iso = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

def norm_url(u):
    u = (u or '').lower().strip().rstrip('/')
    u = re.sub(r'^https?://', '', u)
    u = re.sub(r'/(jp|ja|en)(/|$)', '/', u)
    return u

with open(os.environ['DS_TMP']) as f:
    items = json.load(f).get('Items', [])

groups = {}
for it in items:
    sid = (it.get('serviceId') or {}).get('S')
    url = norm_url((it.get('docUrl') or {}).get('S'))
    if not sid or not url:
        continue
    try:
        order = int((it.get('order') or {}).get('N', '0'))
    except Exception:
        order = 0
    name = (it.get('name') or {}).get('S', '')
    groups.setdefault(url, []).append({'sid': sid, 'order': order, 'name': name})

removed = 0
for url, g in groups.items():
    if len(g) < 2:
        continue
    # order最小（＝確立済み・解放者が多い想定）を残し、残りを削除
    g.sort(key=lambda x: (x['order'], x['sid']))
    keep, drops = g[0], g[1:]
    print(f'  重複検出 docUrl={url}: 残す[{keep["name"]}/{keep["sid"]}] 削除{len(drops)}件')
    for d in drops:
        _run([AWS, 'dynamodb', 'delete-item', '--table-name', 'DailyServices',
            '--key', json.dumps({'serviceId': {'S': d['sid']}})], capture_output=True)
        removed += 1
        print(f'    [削除] {d["name"]}/{d["sid"]} (order={d["order"]})')

print(f'  → 重複削除: {removed}件' if removed else '  → 重複なし')
PYEOF
rm -f "$_DUP_TMP"

if [ "$LIFECYCLE_ONLY" -eq 1 ]; then
  echo ""
  echo "✅ ライフサイクル照合のみ完了（--lifecycle-only・体裁チェックは実行しない）"
  exit 0
fi

# ── 1. DynamoDBからサービスを取得 ──────────────────────────────
DYNAMO_TMP=$(mktemp /tmp/dynamo_XXXX.json)
/home/yuzuki/local/bin/aws dynamodb scan --table-name DailyServices --output json 2>/dev/null > "$DYNAMO_TMP"

SERVICES_JSON=$(BATCH_SIZE=$BATCH_SIZE DYNAMO_TMP="$DYNAMO_TMP" python3 << 'PYEOF'
import json, os
from datetime import datetime, timezone, timedelta

with open(os.environ['DYNAMO_TMP']) as f:
    data = json.load(f)
items = data.get('Items', [])

def deser(v):
    if 'S' in v: return v['S']
    if 'N' in v: return float(v['N']) if '.' in v['N'] else int(v['N'])
    if 'BOOL' in v: return v['BOOL']
    if 'L' in v: return [deser(i) for i in v['L']]
    if 'M' in v: return {k: deser(vv) for k, vv in v['M'].items()}
    return None

services = [{ k: deser(v) for k, v in item.items() } for item in items]

EPOCH_ZERO = datetime(1970, 1, 1, tzinfo=timezone.utc)
candidates = []
for s in services:
    checked = s.get('contentCheckedAt')
    sort_key = EPOCH_ZERO
    try:
        if checked:
            sort_key = datetime.fromisoformat(checked.replace('Z', '+00:00'))
    except:
        pass
    candidates.append((sort_key, s))

candidates.sort(key=lambda x: x[0])
batch = int(os.environ.get('BATCH_SIZE', 20))
print(json.dumps([s for _, s in candidates[:batch]]))
PYEOF
)
rm -f "$DYNAMO_TMP"

COUNT=$(echo "$SERVICES_JSON" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo 0)
echo "チェック対象: ${COUNT}件"

if [ "$COUNT" -eq 0 ]; then
  echo "チェック対象なし（全件が直近にチェック済み）"
  exit 0
fi

# ── 2. チャンクファイルに分割 ───────────────────────────────────
CHUNKS_DIR=$(mktemp -d /tmp/daily_check_chunks_XXXX)
SERVICES_TMP=$(mktemp /tmp/daily_check_svcs_XXXX.json)
echo "$SERVICES_JSON" > "$SERVICES_TMP"
CHUNK_COUNT=$(SERVICES_FILE="$SERVICES_TMP" CHUNK_SIZE=$CHUNK_SIZE CHUNKS_DIR="$CHUNKS_DIR" python3 << 'PYEOF'
import json, os
with open(os.environ['SERVICES_FILE']) as f:
    svcs = json.load(f)
cs = int(os.environ['CHUNK_SIZE'])
for i in range(0, len(svcs), cs):
    chunk = svcs[i:i+cs]
    idx = i // cs
    with open(f"{os.environ.get('CHUNKS_DIR', '/tmp')}/{idx:04d}.json", 'w') as f:
        json.dump(chunk, f)
print((len(svcs) + cs - 1) // cs)
PYEOF
)
rm -f "$SERVICES_TMP"
echo "チャンク数: ${CHUNK_COUNT}"

# ── 3. チャンクごとにClaude → 即DB更新 ─────────────────────────
TOTAL_OK=0
TOTAL_FIX=0
TOTAL_DEL=0
RATE_LIMITED=0
TIMEOUT_HIT=0

for chunk_file in "$CHUNKS_DIR"/*.json; do
  [ -e "$chunk_file" ] || continue

  # 終了時刻チェック
  if [ "$DEADLINE_EPOCH" -gt 0 ] && [ "$(date +%s)" -ge "$DEADLINE_EPOCH" ]; then
    echo ""
    echo "⏰ 終了時刻 ${DEADLINE} を過ぎたため、残りチャンクをスキップ（成果はDB反映済み）"
    TIMEOUT_HIT=1
    break
  fi

  CHUNK_NUM=$(python3 -c "import json,sys; print(len(json.load(open(sys.argv[1]))))" "$chunk_file" 2>/dev/null || echo 0)
  CHUNK_IDX=$(basename "$chunk_file" .json | sed 's/^0*//')
  CHUNK_IDX=${CHUNK_IDX:-0}
  _CHUNK_T0=$(date +%s)
  echo ""
  echo "--- チャンク $((CHUNK_IDX+1))/${CHUNK_COUNT}: ${CHUNK_NUM}件  開始=$(date '+%H:%M:%S') ---"

  PROMPT_FILE=$(mktemp /tmp/daily_check_prompt_XXXX.txt)
  python3 - "$chunk_file" > "$PROMPT_FILE" << 'PYEOF'
import json, sys
with open(sys.argv[1]) as f:
    services = json.load(f)

VALID_CATEGORIES = [
    'コンピューティング', 'ストレージ', 'データベース', 'ネットワーキング', 'メッセージング',
    'コンテナ', 'セキュリティ', 'モニタリング', 'アプリケーション統合', 'DevOps',
    'データ分析', '機械学習', '生成AI', 'マネジメント', '移行',
]

lines = [
    '日めくりAWSサービスのコンテンツ品質と現行性をチェックし、JSONのみで返してください。',
    '',
    '【確認項目】',
    '- 【実在性のみ】このサービスが実在するAWSサービス名か（完全に架空・捏造の名称なら delete）。※廃止・提供終了・新規受付停止・改名などの「現行性」判定はここでは行わない＝上流のカタログ照合が唯一の真実source。モデル内蔵知識は古くGA復帰等の最新変更を反映できないため、現行性を理由にした delete は禁止（例: CodeCommit は2024年に新規受付停止後2025年11月にGA復帰済み。古い知識で delete しないこと）',
    '- 必須フィールド（name/shortName/category/description/trivia）が空でないか',
    '- description: 80〜120字。何ができるか・どんな場面で使うかを試験受験者向けに。複数特徴は\\nで区切る（なければfixで追加）',
    '- trivia: 80〜150字。名前の由来・覚え方・試験ポイント・有名企業事例など。複数事実は\\nで区切る（なければfixで追加）',
    f'- category: {"/".join(VALID_CATEGORIES)} のいずれか（違えばfixで最近傍に修正）',
    '- icon: "/icons/aws/..."形式か空文字（違う形式はfixで修正または空文字に）',
    '- docUrl: "https://aws.amazon.com/jp/..."形式か空文字（違う形式はfixで修正または空文字に）',
    '- "本アプリでも利用しています"は Cognito/API Gateway/Lambda/DynamoDB/Amplify/S3 使用サービスのみ許可（他はfixで削除）',
    '',
    '【アクション】ok=問題なし / fix=修正可能（変更フィールドのみ含める） / delete=実在しない架空サービスのみ（※廃止/提供終了/新規受付停止を理由にした delete は禁止＝カタログ照合が管理）',
    '',
    '【出力】JSONのみ。前置き不要。',
    '{"results":[{"serviceId":"...","action":"ok","reason":"100字以内"},{"serviceId":"...","action":"fix","reason":"...","fix":{"フィールド名":"修正後（変更のみ）"}},{"serviceId":"...","action":"delete","reason":"..."}]}',
    '',
    '【サービス一覧】',
]
for s in services:
    lines.append(f"serviceId: {s.get('serviceId','')}")
    lines.append(f"name: {s.get('name','')}  shortName: {s.get('shortName','')}  category: {s.get('category','')}")
    lines.append(f"description: {s.get('description','')}")
    lines.append(f"trivia: {s.get('trivia','')}")
    lines.append(f"icon: {s.get('icon','')}  docUrl: {s.get('docUrl','')}")
    lines.append("")
print('\n'.join(lines))
PYEOF

  _STDOUT_F=$(mktemp /tmp/claude_out_XXXX)
  _STDERR_F=$(mktemp /tmp/claude_err_XXXX)
  CLAUDE_CODE_MAX_OUTPUT_TOKENS=32000 timeout -k 30 "${CLAUDE_TIMEOUT:-1800}" "$CLAUDE_CMD" --strict-mcp-config -p --model sonnet --tools "" < "$PROMPT_FILE" > "$_STDOUT_F" 2> "$_STDERR_F"
  AI_EXIT=$?
  RESULT=$(cat "$_STDOUT_F")
  _STDERR=$(cat "$_STDERR_F")
  rm -f "$_STDOUT_F" "$_STDERR_F"

  # npm更新による一時的なバイナリ消失 → 再探索してリトライ
  if [ $AI_EXIT -ne 0 ] && echo "$_STDERR" | grep -q "No such file"; then
    CLAUDE_CMD=$(_find_claude)
    if [ -x "${CLAUDE_CMD:-}" ]; then
      _STDOUT_F=$(mktemp /tmp/claude_out_XXXX)
      _STDERR_F=$(mktemp /tmp/claude_err_XXXX)
      CLAUDE_CODE_MAX_OUTPUT_TOKENS=32000 timeout -k 30 "${CLAUDE_TIMEOUT:-1800}" "$CLAUDE_CMD" --strict-mcp-config -p --model sonnet --tools "" < "$PROMPT_FILE" > "$_STDOUT_F" 2> "$_STDERR_F"
      AI_EXIT=$?
      RESULT=$(cat "$_STDOUT_F")
      _STDERR=$(cat "$_STDERR_F")
      rm -f "$_STDOUT_F" "$_STDERR_F"
    fi
  fi
  rm -f "$PROMPT_FILE"

  # 致命的エラー（認証・コマンド問題）→ 即終了
  if echo "$_STDERR" | grep -qiE "command not found|No such file|GEMINI_API_KEY|API.?key"; then
    echo "❌ claude 実行エラー（認証またはコマンド問題）。スクリプトを終了します"
    echo "stderr: $(echo "$_STDERR" | head -3)"
    exit 1
  fi

  # レート制限 → stderrのみで判定
  if echo "$_STDERR" | grep -qiE "rate.?limit|too many requests|529|quota exceeded|usage limit|resource_exhausted"; then
    echo "⚠️  レート制限を検出。残りチャンクをスキップ"
    echo "stderr: $(echo "$_STDERR" | head -3)"
    record_rate_limit "$(echo "${RESULT:-} ${_STDERR:-}" | head -10)"
    RATE_LIMITED=1
    break
  fi

  # その他の非ゼロ終了 → このチャンクのみスキップして続行
  if [ $AI_EXIT -ne 0 ]; then
    echo "⚠️  チャンク $((CHUNK_IDX+1)) でエラー（exit $AI_EXIT）。このチャンクをスキップして続行"
    echo "stderr: $(echo "$_STDERR" | head -5)"
    echo "stdout: $(echo "$RESULT" | head -3)"
    continue
  fi

  RESULT_JSON=$(echo "$RESULT" | python3 -c "
import sys, json, re
text = sys.stdin.read()
cb = re.search(r'\`\`\`(?:json)?\s*(\{)', text, re.DOTALL)
if cb:
    text = text[cb.start(1):]
    text = re.sub(r'\s*\`\`\`.*\$', '', text, flags=re.DOTALL)
start = text.find('{')
if start == -1: print('{}'); exit(0)
try:
    obj, _ = json.JSONDecoder().raw_decode(text, start)
    print(json.dumps(obj) if 'results' in obj else '{}')
except: print('{}')
")

  # ── DB即時更新 ──────────────────────────────────────────────
  RESULT_JSON_FILE=$(mktemp /tmp/daily_check_result_XXXX.json)
  echo "$RESULT_JSON" > "$RESULT_JSON_FILE"
  CHUNK_STATS=$(python3 - "$RESULT_JSON_FILE" << 'PYEOF'
import json, sys, subprocess
from datetime import datetime, timezone

with open(sys.argv[1]) as f:
    data = json.load(f)
results = data.get('results', [])
now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

ok_count, fix_count, del_count = 0, 0, 0

for r in results:
    sid = r.get('serviceId', '')
    action = r.get('action', 'ok')
    reason = r.get('reason', '')
    fix = r.get('fix', {})

    if action == 'delete':
        # リリースノートに載せるため、消す前にサービス名を引いて記録する
        try:
            got = subprocess.run(['/home/yuzuki/local/bin/aws', 'dynamodb', 'get-item', '--table-name', 'DailyServices',
                '--key', json.dumps({'serviceId': {'S': sid}}), '--projection-expression', '#n',
                '--expression-attribute-names', json.dumps({'#n': 'name'}), '--output', 'json'],
                capture_output=True, text=True)
            svc_name = json.loads(got.stdout or '{}').get('Item', {}).get('name', {}).get('S', sid)
            import os
            from datetime import date as _date
            with open(os.environ['REMOVALS_FILE'], 'a', encoding='utf-8') as rf:
                rf.write(json.dumps({'date': _date.today().isoformat(), 'serviceId': sid, 'name': svc_name,
                    'reason': '内容の確認で実在しないサービスと判定', 'reasonNote': reason, 'source': 'content-check'}, ensure_ascii=False) + '\n')
        except Exception as e:
            print(f'  ⚠️ 削除記録の書き込みに失敗: {e}')
        subprocess.run([
            '/home/yuzuki/local/bin/aws', 'dynamodb', 'delete-item',
            '--table-name', 'DailyServices',
            '--key', json.dumps({'serviceId': {'S': sid}}),
        ], capture_output=True)
        del_count += 1
        print(f'  [DELETE] {sid}: {reason}')
        continue

    if action == 'fix' and fix:
        update_parts = ['contentCheckedAt = :t', 'updatedAt = :u']
        expr_values = {':t': {'S': now}, ':u': {'S': now}}
        changes = []

        for field in ('description', 'trivia', 'category', 'icon', 'docUrl'):
            if field in fix and fix[field] is not None:
                placeholder = f':{field[:3]}'
                update_parts.append(f'{field} = {placeholder}')
                expr_values[placeholder] = {'S': str(fix[field])}
                changes.append(field)

        update_expr = f'SET {", ".join(update_parts)}'
        subprocess.run([
            '/home/yuzuki/local/bin/aws', 'dynamodb', 'update-item',
            '--table-name', 'DailyServices',
            '--key', json.dumps({'serviceId': {'S': sid}}),
            '--condition-expression', 'attribute_exists(serviceId)',
            '--update-expression', update_expr,
            '--expression-attribute-values', json.dumps(expr_values),
        ], capture_output=True)
        fix_count += 1
        print(f'  [FIX  ] {sid}: {reason} → 変更: {", ".join(changes) or "(変更なし)"}')

    else:
        # action == 'ok'
        subprocess.run([
            '/home/yuzuki/local/bin/aws', 'dynamodb', 'update-item',
            '--table-name', 'DailyServices',
            '--key', json.dumps({'serviceId': {'S': sid}}),
            '--condition-expression', 'attribute_exists(serviceId)',
            '--update-expression', 'SET contentCheckedAt = :t',
            '--expression-attribute-values', json.dumps({':t': {'S': now}}),
        ], capture_output=True)
        ok_count += 1
        print(f'  [OK   ] {sid}')

print(f'  → 更新完了: OK={ok_count} 修正={fix_count} 削除={del_count}')
print(f'__STATS__{ok_count},{fix_count},{del_count}')
PYEOF
)

  rm -f "$RESULT_JSON_FILE"
  echo "$CHUNK_STATS" | grep -v '^__STATS__'
  STATS_LINE=$(echo "$CHUNK_STATS" | grep '^__STATS__' | sed 's/^__STATS__//')
  if [ -n "$STATS_LINE" ]; then
    _ok=$(echo "$STATS_LINE" | cut -d, -f1)
    _fix=$(echo "$STATS_LINE" | cut -d, -f2)
    _del=$(echo "$STATS_LINE" | cut -d, -f3)
    TOTAL_OK=$(( TOTAL_OK + _ok ))
    TOTAL_FIX=$(( TOTAL_FIX + _fix ))
    TOTAL_DEL=$(( TOTAL_DEL + _del ))
  fi
  echo "  終了=$(date '+%H:%M:%S')  経過=$(( $(date +%s) - _CHUNK_T0 ))秒"
done

rm -rf "$CHUNKS_DIR"

echo ""
echo "完了サマリー: 問題なし=${TOTAL_OK}件 / 自動修正=${TOTAL_FIX}件 / 削除=${TOTAL_DEL}件"

if [ $RATE_LIMITED -eq 1 ] || [ ${TIMEOUT_HIT:-0} -eq 1 ]; then
  exit 1
fi

echo ""
echo "=========================================="
echo "チェック終了: $(date)"
echo "=========================================="

} 2>&1 | tee -a "$LOG_FILE"

find "$LOG_DIR" -name "daily_check_*.log" -mtime +30 -delete
