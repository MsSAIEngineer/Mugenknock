#!/bin/bash
# サイト静的コンテンツの現行性チェック（月1・検知と報告のみ／自動修正はしない）
#
# 問題データ以外の「サイトに直書きされた AWS 情報」が陳腐化していないかを
# 公式情報と突き合わせて検知する。既存の仕組みでカバーされていない2領域が対象:
#
#   A. サービス図鑑 (src/data/awsServiceCatalog.ts)
#      state/service-catalog.json（SSM由来・公式WebFetchで確認済み）と突き合わせる。
#      突き合わせは決定的なので claude を呼ばない（コストゼロ）。
#
#   B. チートシート (src/views/CheatSheet.tsx の CHEAT_DATA・374項目)
#      公式ドキュメントと照らして、古い記述・変わった制限値を検知する。
#      量が多いので毎回 -n 件だけ巡回し、確認が古い順に回す。
#
# 試験メタ情報（試験コード・問題数・時間）と資格の新設/廃止は
# 99-send-report.sh の「AWS公式情報チェック」が既に週次で見ているので、ここでは扱わない。
#
# 出力: logs/site-content_<日時>.md（99-send-report.sh がメールに載せる）
#
# 環境変数（すべて任意）:
#   SITE_CHECK_MAX_AGE_DAYS=30   この日数以内に実行済みならスキップ（月1相当）
#   SITE_CHECK_N=12              1回に公式確認するチートシート項目数
#   SITE_CHECK_FORCE=1           鮮度スキップを無視して強制実行

set -uo pipefail

export PATH="/home/yuzuki/local/bin:/home/sera/.config/nvm/versions/node/v20.20.2/bin:$PATH"
unset ANTHROPIC_API_KEY

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NIGHT_PROMPTS_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(dirname "$(dirname "$NIGHT_PROMPTS_DIR")")"
LOG_DIR="$NIGHT_PROMPTS_DIR/logs"
STATE_DIR="$SCRIPT_DIR/state"
STATE_FILE="$STATE_DIR/site_content_check.json"
MCP_CONFIG="$SCRIPT_DIR/mcp-aws-docs.json"

CATALOG_TS="$PROJECT_DIR/src/data/awsServiceCatalog.ts"
CHEATSHEET_TSX="$PROJECT_DIR/src/views/CheatSheet.tsx"
SERVICE_CATALOG_JSON="$STATE_DIR/service-catalog.json"

MAX_AGE_DAYS="${SITE_CHECK_MAX_AGE_DAYS:-30}"
CHECK_N="${SITE_CHECK_N:-12}"

mkdir -p "$LOG_DIR" "$STATE_DIR"

TS=$(date '+%Y%m%d_%H%M%S')
JST_NOW=$(TZ='Asia/Tokyo' date '+%Y-%m-%d %H:%M JST')
REPORT="$LOG_DIR/site-content_${TS}.md"

_find_claude() {
  [ -x /usr/local/bin/claude ] && { echo /usr/local/bin/claude; return; }
  local _cv; _cv=$(command -v claude 2>/dev/null)
  [ -n "$_cv" ] && [ -x "$_cv" ] && { echo "$_cv"; return; }
}
CLAUDE_CMD=$(_find_claude)

echo "=========================================="
echo "サイト静的コンテンツ 現行性チェック: $JST_NOW"
echo "=========================================="

# ── 0. 鮮度チェック（月1相当のスキップ）──────────────────────────
if [ "${SITE_CHECK_FORCE:-0}" != "1" ]; then
  SKIP=$(STATE="$STATE_FILE" MAXAGE="$MAX_AGE_DAYS" python3 << 'PYEOF'
import json, os, datetime
state_path, max_age = os.environ['STATE'], int(os.environ['MAXAGE'])
try:
    last = json.load(open(state_path)).get('last_run_at')
    d = datetime.date.fromisoformat(last[:10])
    age = (datetime.date.today() - d).days
    print('skip' if age < max_age else 'run', age)
except Exception:
    print('run', -1)
PYEOF
)
  if [ "${SKIP%% *}" = "skip" ]; then
    echo "前回実行から ${SKIP##* } 日。${MAX_AGE_DAYS}日未満のためスキップ（月1相当）。"
    exit 0
  fi
  echo "前回実行から ${SKIP##* } 日 → 実行する"
fi

{
  echo "# サイト静的コンテンツ 現行性チェック"
  echo ""
  echo "実行: $JST_NOW"
  echo ""
} > "$REPORT"

# ── A. サービス図鑑の棚卸し（決定的・claude不要）────────────────────
echo ""
echo "--- [A] サービス図鑑 (awsServiceCatalog.ts) の棚卸し ---"

CATALOG_TS="$CATALOG_TS" SERVICE_CATALOG_JSON="$SERVICE_CATALOG_JSON" REPORT="$REPORT" \
python3 << 'PYEOF'
import json, os, re, sys

ts_path = os.environ['CATALOG_TS']
sc_path = os.environ['SERVICE_CATALOG_JSON']
report  = os.environ['REPORT']

def norm(s):
    """比較用の正規化。AWS/Amazon の接頭辞と記号・空白を落とす。"""
    s = re.sub(r'^(AWS|Amazon)\s+', '', (s or '').strip(), flags=re.I)
    return re.sub(r'[^a-z0-9]', '', s.lower())

out = ['## A. サービス図鑑 (awsServiceCatalog.ts)', '']

# 図鑑側: category ごとの services[].name を拾う
try:
    src = open(ts_path).read()
except Exception as e:
    out.append(f'⚠ 図鑑を読めませんでした: {e}')
    open(report, 'a').write('\n'.join(out) + '\n\n'); sys.exit()

catalog = {}           # norm -> 表示名
current_cat = None
for line in src.splitlines():
    mc = re.search(r"category:\s*'([^']+)'", line)
    if mc:
        current_cat = mc.group(1); continue
    mn = re.search(r"\{\s*name:\s*'([^']+)'", line)
    if mn:
        catalog[norm(mn.group(1))] = (mn.group(1), current_cat)

# 公式確認済みカタログ側
try:
    sc = json.load(open(sc_path)).get('services', {})
except Exception as e:
    out.append(f'⚠ service-catalog.json を読めませんでした: {e}')
    open(report, 'a').write('\n'.join(out) + '\n\n'); sys.exit()

# 公式側は正式名、図鑑側は略称（S3 / EC2 / IAM）で書かれていることが多い。
# name だけで突き合わせると「Amazon Simple Storage Service が未掲載」のような
# 誤検知が大量に出るので、shortName と serviceCode も別名として索引に入れる。
verified = {}          # norm -> entry
aliases = {}           # norm(別名) -> norm(正式名)
for key, e in sc.items():
    nm = e.get('name') or ''
    if not nm:
        continue
    nk = norm(nm)
    verified[nk] = e
    for alt in (e.get('shortName'), e.get('serviceCode')):
        ak = norm(alt or '')
        if ak and ak != nk:
            aliases.setdefault(ak, nk)

def in_catalog(nk, entry):
    """図鑑に載っているか。正式名・略称・サービスコードのどれかで一致すれば載っている。"""
    if nk in catalog:
        return True
    for alt in (entry.get('shortName'), entry.get('serviceCode')):
        ak = norm(alt or '')
        if ak and ak in catalog:
            return True
    return False

out.append(f'- 図鑑の掲載サービス: {len(catalog)}件')
out.append(f'- 公式確認済みカタログ: {len(verified)}件')
out.append('')

# A-1. 図鑑に載っているが、公式カタログ上で現行でないもの
stale = []
for nk, (disp, cat) in sorted(catalog.items()):
    e = verified.get(nk) or verified.get(aliases.get(nk, ''))
    if not e:
        continue
    st = (e.get('status') or '').strip()
    if st and st not in ('active', 'unknown'):
        note = (e.get('statusNote') or '').strip()
        stale.append(f"- **{disp}**（{cat}）: status=`{st}`" + (f" — {note}" if note else ''))

if stale:
    out.append(f'### 図鑑に残っているが現行でないサービス（{len(stale)}件）')
    out.extend(stale)
else:
    out.append('### 図鑑に残っているが現行でないサービス')
    out.append('- 指摘なし')
out.append('')

# A-2. 試験に関係するのに図鑑へ未掲載のもの
#     examRelevance が high/medium かつ active のものだけを候補にする（全AWSサービスは多すぎる）
missing = []
for nk, e in verified.items():
    if in_catalog(nk, e):
        continue
    if (e.get('status') or '') != 'active':
        continue
    rel = (e.get('examRelevance') or '').strip()
    if rel not in ('high', 'medium'):
        continue
    missing.append((rel, e.get('name'), e.get('category') or ''))

missing.sort(key=lambda t: (t[0] != 'high', t[1]))
if missing:
    out.append(f'### 試験に関係するのに図鑑へ未掲載（{len(missing)}件）')
    for rel, nm, cat in missing[:30]:
        out.append(f'- **{nm}**（{cat}・関連度 {rel}）')
    if len(missing) > 30:
        out.append(f'- …ほか {len(missing)-30}件')
else:
    out.append('### 試験に関係するのに図鑑へ未掲載')
    out.append('- 指摘なし')
out.append('')

open(report, 'a').write('\n'.join(out) + '\n')
print(f"  図鑑 {len(catalog)}件 / 確認済み {len(verified)}件 → 現行でない {len(stale)}件・未掲載 {len(missing)}件")
PYEOF

# ── B. チートシートの事実確認（claude + WebFetch・ローテーション）──────
echo ""
echo "--- [B] チートシート (CHEAT_DATA) の事実確認 ---"

if [ -z "${CLAUDE_CMD:-}" ] || [ ! -x "${CLAUDE_CMD:-}" ]; then
  echo "  ⚠️  Claude 未検出のためスキップ"
  {
    echo "## B. チートシート (CHEAT_DATA)"
    echo ""
    echo "⚠ Claude 未検出のため未実施。"
    echo ""
  } >> "$REPORT"
else
  # 確認が古い順に CHECK_N 件を選ぶ
  ITEMS_TMP=$(mktemp /tmp/cheat_items_XXXX.txt)
  PICKED=$(CHEATSHEET="$CHEATSHEET_TSX" STATE="$STATE_FILE" N="$CHECK_N" OUT="$ITEMS_TMP" \
  python3 << 'PYEOF'
import json, os, re

src_path, state_path = os.environ['CHEATSHEET'], os.environ['STATE']
n, out_path = int(os.environ['N']), os.environ['OUT']

src = open(src_path).read()
body = src[src.index('const CHEAT_DATA'):]

# exam セクションと、その中の { name: '...', desc: '...' } を拾う
items, exam = [], None
for line in body.splitlines():
    me = re.match(r'^  (\w+): \[', line)
    if me:
        exam = me.group(1); continue
    mi = re.search(r"\{\s*name:\s*'([^']+)',\s*desc:\s*'((?:[^'\\]|\\.)*)'", line)
    if mi and exam:
        desc = mi.group(2).replace('\\n', '\n').replace("\\'", "'")
        items.append({'exam': exam, 'name': mi.group(1), 'desc': desc})

# 前回までの確認日を読み、古い順（未確認を最優先）に並べる
try:
    checked = json.load(open(state_path)).get('cheat_checked', {})
except Exception:
    checked = {}

def key(it):
    return f"{it['exam']}::{it['name']}"

items.sort(key=lambda it: (checked.get(key(it)) or '', key(it)))
picked = items[:n]

with open(out_path, 'w') as f:
    for it in picked:
        f.write(f"### [{it['exam']}] {it['name']}\n{it['desc']}\n\n")

print(f"{len(items)} {len(picked)}")
PYEOF
)
  TOTAL_ITEMS="${PICKED%% *}"; PICK_N="${PICKED##* }"
  echo "  CHEAT_DATA ${TOTAL_ITEMS}項目中 ${PICK_N}件を公式と突き合わせ（確認が古い順）"

  CHEAT_PROMPT=$(mktemp /tmp/cheat_prompt_XXXX.txt)
  cat > "$CHEAT_PROMPT" << PROMPT
あなたはAWS認定試験の教材を校正する担当です。
以下は学習サイトのチートシートに掲載している記述です。
各項目が**現在のAWSの仕様と食い違っていないか**を確認してください。

【確認の方針】
- 制限値・上限・既定値・対応リージョン・サービス名・料金体系など、**変わりうる事実**を重点的に見る
- 少しでも不確かなら推測せず、WebFetch または AWS ドキュメントで公式（docs.aws.amazon.com / aws.amazon.com）を確認する
- 確信が持てないものは「要確認」として挙げ、断定しない
- 書き方・言い回し・教え方の好みは**指摘しない**。事実が古いものだけを挙げる

【出力形式】日本語のマークダウン。指摘が1件も無ければ「指摘なし」の1行のみ。
指摘がある場合は1件につき以下の形式:
#### [資格コード] 項目名
- 現在の記述: <どう書かれているか（該当部分のみ引用）>
- 実際: <現在の正しい内容>
- 出典: <確認した公式URL>

【対象の記述】
$(cat "$ITEMS_TMP")
PROMPT

  CHEAT_RESULT=$(timeout -k 30 "${CLAUDE_TIMEOUT:-1800}" "$CLAUDE_CMD" -p \
    --model sonnet \
    --tools WebFetch,ToolSearch --allowed-tools WebFetch,mcp__aws-docs \
    --strict-mcp-config --mcp-config "$MCP_CONFIG" \
    < "$CHEAT_PROMPT" 2>&1 | head -300)
  CHEAT_EXIT=$?
  rm -f "$CHEAT_PROMPT"

  {
    echo "## B. チートシート (CHEAT_DATA)"
    echo ""
    echo "${TOTAL_ITEMS}項目中 ${PICK_N}件を確認（確認が古い順に巡回）"
    echo ""
    if [ $CHEAT_EXIT -ne 0 ] && [ -z "$CHEAT_RESULT" ]; then
      echo "⚠ Claude 実行エラー (exit=$CHEAT_EXIT)"
    else
      echo "$CHEAT_RESULT"
    fi
    echo ""
  } >> "$REPORT"

  echo "$CHEAT_RESULT" | head -5 | sed 's/^/  /'

  # 確認した項目の日付を state に記録（成功時のみ・次回は別の項目へ回る）
  if [ $CHEAT_EXIT -eq 0 ]; then
    STATE="$STATE_FILE" ITEMS="$ITEMS_TMP" python3 << 'PYEOF'
import json, os, re, datetime
state_path, items_path = os.environ['STATE'], os.environ['ITEMS']
try:
    state = json.load(open(state_path))
except Exception:
    state = {}
checked = state.setdefault('cheat_checked', {})
today = datetime.date.today().isoformat()
for line in open(items_path):
    m = re.match(r'^### \[(\w+)\] (.+)$', line.strip())
    if m:
        checked[f'{m.group(1)}::{m.group(2)}'] = today
state['cheat_checked'] = checked
json.dump(state, open(state_path, 'w'), ensure_ascii=False, indent=2)
PYEOF
  fi
  rm -f "$ITEMS_TMP"
fi

# ── 実行日を記録 ────────────────────────────────────────────
STATE="$STATE_FILE" python3 << 'PYEOF'
import json, os, datetime
p = os.environ['STATE']
try:
    s = json.load(open(p))
except Exception:
    s = {}
s['last_run_at'] = datetime.datetime.now().isoformat(timespec='seconds')
json.dump(s, open(p, 'w'), ensure_ascii=False, indent=2)
PYEOF

echo ""
echo "レポート: $REPORT"
echo "=========================================="
