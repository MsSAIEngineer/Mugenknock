#!/bin/bash
# AWS問題の正当性チェックスクリプト
# 問題なし→確認日のみ更新 / 問題あり→自動修正またはDB削除

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
INSTRUCTION_DIR="$_d/instructions"
LOG_DIR="$NIGHT_PROMPTS_DIR/logs"

# 資格コード → 公式試験ガイドURL（instructions/*.txt の # EXAM_GUIDE_URL: 行から読む）
_get_exam_guide_url() {
  local exam="$1"
  local inst_file="${INSTRUCTION_DIR}/${exam}.txt"
  [ -f "$inst_file" ] && grep "^# EXAM_GUIDE_URL:" "$inst_file" | head -1 | sed 's/^# EXAM_GUIDE_URL: *//'
}
mkdir -p "$LOG_DIR"
DATE=$(date '+%Y%m%d_%H%M%S')
LOG_FILE="$LOG_DIR/validity_${DATE}.log"


show_help() {
  cat << 'EOF'
usage: check-validity.sh [-n N] [-D HH:MM] [-q FILE] [-T N|--no-triage] [-h]

  -n N       チェック問題数 (default: 30)
  -D HH:MM   処理終了時刻 (JST)。この時刻を過ぎたチャンクはスキップ
  -q FILE    問題IDを指定してチェック（1行1ID、#開始行は無視）。
             指定時はソート順を無視しこのリストの問題だけを対象にする
             （既知パターンの一括修正など、対象を特定できる場合に使う）
  -T N       Jevトリアージのプール倍率 (default: 3、1で無効)
  --no-triage  Jevトリアージを無効化（-T 1 と同じ）
  -h         このヘルプを表示

挙動:
  -q 指定時  : 指定ID群のみを対象（順不同・存在しないIDは無視・トリアージ無効）
  action=ok  → validityCheckedAt のみ更新
  action=fix → 問題内容を上書き・validityEditLog を記録・updatedAt 更新
  action=delete → DynamoDB から削除

選定の優先順位（-q 未指定時）:
  ① 未確認（validityCheckedAt なし）を常に最優先・古い順。
     未確認はアプリ非公開なので、公開までの時間を最短にすることを最優先する。
     未確認だけでバッチが埋まる場合は Jev を呼ばない（費用ゼロ）。
  ② 残り枠は確認済みから。Jev で「誤っている可能性」をスコア化し、
     スコアのバンド（既定0.25刻み＝5段階）降順 → 同バンド内は確認日の古い順。
     連続値のままだと 0.94 と 0.93 の差で順序が決まり日付が効かないため丸める。

Jevトリアージ:
  古い順の上位 残り枠×倍率 をプールにしてスコア化する。トークン律速で全問回せない
  ため、限られた Claude 枠を欠陥密度の高い問題へ寄せる（実測 約1.7〜1.8倍）。
  費用は 1問 $0.0003・実際に検証する1問あたり $0.0009（倍率3のとき）。
  ゲートではないのでスコアが低い問題も後日のバッチで必ず処理される。
  Jev が使えない場合は自動的に従来どおり古い順で処理する（検証は止めない）。

環境変数:
  JEV_TRIAGE_POOL  プール倍率（既定 3・1で無効）
  JEV_TRIAGE_POOL_MAX  プールの上限件数（既定 360。-n を大きく取っても超えない）
  JEV_TRIAGE_BAND  スコアのバンド幅（既定 0.25＝5段階）
EOF
}

BATCH_SIZE=30
# 1回の claude 呼び出しで検証する問題数。共通ヘッダ（確認観点・追加観点・出力形式で約9,000字）は
# 毎回送り直すので、5問だと入力の6割以上がヘッダだった（2026-10-12 実測: ヘッダ9,112字・問題5,594字・
# 入力1.9万トークン）。10問にして1問あたりのヘッダ分を半分にする。
CHUNK_SIZE=${VALIDITY_CHUNK_SIZE:-10}
DEADLINE=""
QID_FILE=""
# Jevトリアージのプール倍率。1 で無効。環境変数でも上書き可。
TRIAGE_POOL="${JEV_TRIAGE_POOL:-3}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n) BATCH_SIZE="${2:?-n requires N}"; shift 2 ;;
    -D) DEADLINE="${2:?-D requires HH:MM}"; shift 2 ;;
    -q) QID_FILE="${2:?-q requires FILE}"; shift 2 ;;
    -T) TRIAGE_POOL="${2:?-T requires N}"; shift 2 ;;
    --no-triage) TRIAGE_POOL=1; shift ;;
    -h|--help) show_help; exit 0 ;;
    *) echo "不明なオプション: $1" >&2; show_help >&2; exit 1 ;;
  esac
done

# Jevトリアージのスクリプト位置と設定を python ブロックへ渡す
export JEV_TRIAGE_SCRIPT="$_d/jev-triage.py"
export JEV_TRIAGE_POOL="$TRIAGE_POOL"

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
    # 過去時刻は翌日扱い（01-generate と同じ繰り越し。深夜0時台のリセット時刻で
    # 前夜のhookが「すでに過ぎた今日のHH:MM」を渡して即終了するのを防ぐ）
    if t <= now:
        t = t + timedelta(days=1)
    print(int(t.timestamp()))
except Exception as e:
    print(f"❌ -D のパースエラー: {e}", file=sys.stderr); print(0)
PYEOF
)
fi

# 並列実行の競合防止: 日付単位の共有セッションで処理中の問題IDをクレーム
# 同日に複数インスタンスが起動しても、同じ問題IDを二重処理しないようにする
_SESSION_DIR="/tmp/validity_session_$(date '+%Y%m%d')"
mkdir -p "$_SESSION_DIR"
export SESSION_CLAIMED="$_SESSION_DIR/claimed.json"
export SESSION_LOCK="$_SESSION_DIR/lock"
[ -f "$SESSION_CLAIMED" ] || echo '{}' > "$SESSION_CLAIMED"
touch "$SESSION_LOCK"

# レート制限が判明している間はスキップする。
# hook(ピン-30分) と hook2(ピン-15分) はトークン残量を消化する目的で連続して走るため、
# 先行runが枯渇を検出したあとも後続がフルテーブルスキャン(4000件超)→100件クレーム→
# 1チャンク目で即レート制限、を繰り返していた（処理0問でスキャンだけ発生）。
# 枯渇を検出した run が「回復予定時刻」を残し、それまでは即終了する。
RATE_LIMIT_MARKER="$_SESSION_DIR/ratelimit_until"
if [ -f "$RATE_LIMIT_MARKER" ]; then
  _until=$(cat "$RATE_LIMIT_MARKER" 2>/dev/null || echo 0)
  if [ "${_until:-0}" -gt "$(date +%s)" ] 2>/dev/null; then
    echo "⏸  レート制限中のためスキップ（回復予定 $(date -d "@$_until" '+%H:%M' 2>/dev/null || echo "$_until")）"
    exit 0
  fi
  rm -f "$RATE_LIMIT_MARKER"
fi

{
echo "=========================================="
echo "正当性チェック開始: $(date)"
echo "バッチサイズ: ${BATCH_SIZE}問 / チャンクサイズ: ${CHUNK_SIZE}問"
echo "=========================================="

# ── 1. DynamoDBから問題を取得 ──────────────────────────────────
DYNAMO_TMP=$(mktemp /tmp/dynamo_XXXX.json)
if ! aws dynamodb scan --table-name Questions --output json > "$DYNAMO_TMP" 2>&1; then
  echo "❌ DynamoDB scan 失敗:"
  head -5 "$DYNAMO_TMP"
  rm -f "$DYNAMO_TMP"
  exit 1
fi
if [ ! -s "$DYNAMO_TMP" ]; then
  echo "❌ DynamoDB scan: レスポンスが空です（ネットワーク障害の可能性）"
  rm -f "$DYNAMO_TMP"
  exit 1
fi

QUESTIONS_JSON=$(BATCH_SIZE=$BATCH_SIZE DYNAMO_TMP="$DYNAMO_TMP" QID_FILE="$QID_FILE" python3 << 'PYEOF'
import json, os, sys
from datetime import datetime, timezone, timedelta

AWS_EXAM_TYPES = {'CLF','AIF','AIB','SAA','DVA','SOA','DEA','MLA','SAP','DOP','AIP','ANS','SCS','ML','DB','NW','SEC'}

with open(os.environ['DYNAMO_TMP']) as f:
    content = f.read()
if not content.strip():
    sys.stderr.write("❌ DynamoDB レスポンスが空です\n")
    sys.exit(1)
try:
    data = json.loads(content)
except json.JSONDecodeError as e:
    sys.stderr.write(f"❌ JSON パース失敗: {e}\n")
    sys.exit(1)
items = data.get('Items', [])
# AWS以外の試験種別（OCIAA等）を除外
items = [it for it in items if it.get('examType', {}).get('S', '') in AWS_EXAM_TYPES or 'examType' not in it]

def deser(v):
    if 'S' in v: return v['S']
    if 'N' in v: return float(v['N']) if '.' in v['N'] else int(v['N'])
    if 'BOOL' in v: return v['BOOL']
    if 'L' in v: return [deser(i) for i in v['L']]
    if 'M' in v: return {k: deser(vv) for k, vv in v['M'].items()}
    return None

questions = [{ k: deser(v) for k, v in item.items() } for item in items]

qid_file = os.environ.get('QID_FILE', '').strip()
if qid_file:
    # -q 指定時: 対象ID群のみ・ソート無視（既知パターンの一括修正など対象を特定できる場合用）
    with open(qid_file) as f:
        target_ids = [l.strip() for l in f if l.strip() and not l.strip().startswith('#')]
    by_id = {q.get('questionId'): q for q in questions if not q.get('isHidden')}
    selected = [by_id[qid] for qid in target_ids if qid in by_id]
    print(json.dumps(selected))
    sys.exit(0)

EPOCH_ZERO = datetime(1970, 1, 1, tzinfo=timezone.utc)
candidates = []
for q in questions:
    if q.get('isHidden'):
        continue
    checked = q.get('validityCheckedAt')
    sort_key = EPOCH_ZERO
    try:
        if checked:
            sort_key = datetime.fromisoformat(checked.replace('Z', '+00:00'))
    except:
        pass
    candidates.append((sort_key, q))

candidates.sort(key=lambda x: x[0])
batch = int(os.environ.get('BATCH_SIZE', 30))

# ── クレーム処理（並列競合防止） ──
# flock で同日セッションの claimed.json を排他ロックし、
# 他インスタンスがすでに処理中のIDを除外してからバッチを確定する
import fcntl, time

# クレームには取得時刻を持たせ、一定時間を過ぎたものは自動的に再取得可能にする。
# 実行がハング・強制終了して解放処理まで到達しなかった場合、時刻が無いと
# その問題は当日ずっと選定対象から外れ「未確認のまま」になるため（実際に
# dop-q-053 / dop-q-054 が 08-02 のクレームに取り残された）。
# 1バッチは長くても数十分なので、それを十分に超える 3時間 を期限とする。
CLAIM_TTL_SEC = int(os.environ.get('CLAIM_TTL_SEC', 3 * 3600))
now_ts = time.time()

def load_claims(path):
    """{qid: 取得時刻} を返す。旧形式（IDの配列）は期限切れ扱いにして拾い直す。"""
    try:
        with open(path) as f:
            raw = json.load(f)
    except Exception:
        return {}
    if isinstance(raw, dict):
        return {k: float(v) for k, v in raw.items()}
    return {k: 0.0 for k in raw}

session_lock_path = os.environ.get('SESSION_LOCK', '')
session_claimed_path = os.environ.get('SESSION_CLAIMED', '')

# ── 選定の優先順位 ────────────────────────────────────────────────
#   ① 未確認（validityCheckedAt なし）を常に最優先・古い順。トリアージにかけない。
#      未確認問題はアプリ非公開なので、公開までの時間を最短にすることが最優先。
#      未確認だけでバッチが埋まる場合は Jev を一切呼ばない（費用も発生しない）。
#   ② 残りは Jev でスコアリングし、「誤っている可能性が高いバンド」内で古い順。
#      スコアをバンドに丸めるのは、連続値のままだと 0.94 と 0.93 の差で順序が決まり
#      日付が効かなくなるため。同程度に疑わしいものの中では古いものから処理する。
#
# ②のプールを「古い順の上位 batch×倍率」に限定するのが要点。全体をスコア順にすると
# 低スコアの問題が永久に選ばれない飢餓が起きるが、プールを古い順で切れば
# 全問が必ず順番にプールへ上がってくるので、取り逃しても後日必ず処理される。
#
# ロックは取らずに実行する。ネットワークI/O中に flock を保持すると並列runを
# 数十秒〜数分ブロックするため。クレームの権威的な除外はこの後のロック内で行い、
# ここでは待ち時間を無駄にしないための事前除外にだけ claimed.json を読む。
_triage_pool_mult = int(os.environ.get('JEV_TRIAGE_POOL', '3') or 3)
_triage_script = os.environ.get('JEV_TRIAGE_SCRIPT', '')
# バンド幅 0.25 = 疑わしさを5段階に区切る。Jev のスコアは非決定的（2回実行の差は
# 中央値0.010・最大0.110）なので、細かく刻むほどノイズで順序が入れ替わるだけで
# 日付が効かなくなる。実測でバンドが揺れる率は 0.1→17% / 0.2→12% / 0.25→4%。
_triage_band = float(os.environ.get('JEV_TRIAGE_BAND', '0.25') or 0.25)

# ① 未確認を常に先頭へ（candidates は既に古い順なので順序は保たれる）
_unverified = [(sk, q) for sk, q in candidates if not q.get('validityCheckedAt')]
_verified   = [(sk, q) for sk, q in candidates if q.get('validityCheckedAt')]
candidates = _unverified + _verified

_pre_claims = load_claims(session_claimed_path) if session_claimed_path else {}
_pre_claims = {k: t for k, t in _pre_claims.items() if now_ts - t < CLAIM_TTL_SEC}
_unclaimed_unverified = sum(1 for _, q in _unverified if q.get('questionId') not in _pre_claims)
if _unverified:
    sys.stderr.write(f"未確認を優先: {len(_unverified)}問（うち未クレーム {_unclaimed_unverified}問）\n")

# ② 未確認でバッチが埋まらない分だけ、確認済みを Jev で並べ替える
_slots = batch - _unclaimed_unverified
# プールの上限。-n を大きく取っても（フックは -n 1000）、実際に処理できる件数はトークンで決まり
# 1回あたり100〜150問程度。プールを slots×倍率（3000問）にすると Jev の予算（120秒≒700問）で
# 途中までしかスコアが付かず、スコア無しの問題が最優先（1.0）になって事実上「古い順」に戻る。
# 実際に処理される先頭部分を確実にスコア化するため、プールは上限で切る。
_pool_max = int(os.environ.get('JEV_TRIAGE_POOL_MAX', '360') or 360)
if (_triage_pool_mult > 1 and _triage_script and os.path.exists(_triage_script)
        and _slots > 0 and _verified):
    import subprocess
    _pool = [(sk, q) for sk, q in _verified
             if q.get('questionId') not in _pre_claims][:min(_slots * _triage_pool_mult, _pool_max)]
    if len(_pool) > min(_slots, 20):
        try:
            _pr = subprocess.run(
                [sys.executable, _triage_script],
                input=json.dumps([q for _, q in _pool]),
                capture_output=True, text=True, timeout=240)
            sys.stderr.write(_pr.stderr)
            _scores = json.loads(_pr.stdout) if _pr.stdout.strip() else {}
        except Exception as e:
            sys.stderr.write(f"⚠️  Jevトリアージ失敗（古い順で続行）: {e}\n")
            _scores = {}
        if _scores:
            # 並べ替え用のスコア。得られなかった問題は 1.0 とし、Jev の失敗で不利にならないようにする
            # （＝「分からないものは従来どおり処理する」側に倒す）。
            def _sc(qid):
                v = _scores.get(qid)
                return float(v['score']) if isinstance(v, dict) and 'score' in v else 1.0
            # Jev が実際に判定した問題だけ、観点別の値を _jev として問題に付ける。
            # 後段のプロンプト生成が「どのくらい怪しいか」の参考値として Claude に渡す。
            # _jev は DB へは書かれない（DB更新は Claude の fix の値だけを使う）。
            for _, q in _pool:
                v = _scores.get(q.get('questionId'))
                if isinstance(v, dict):
                    q['_jev'] = {k: v[k] for k in ('hint_leak',) if k in v}
            _pool_ids = {q.get('questionId') for _, q in _pool}
            _in  = [(sk, q) for sk, q in _verified if q.get('questionId') in _pool_ids]
            _out = [(sk, q) for sk, q in _verified if q.get('questionId') not in _pool_ids]
            # スコアをバンドに丸めて降順、同一バンド内は確認日の古い順。
            # +1e-9 は浮動小数点対策（0.70/0.1 が 6.999… になりバンドが1つ下にずれる）。
            def _triage_key(t):
                sk, q = t
                return (-int(_sc(q.get('questionId')) / _triage_band + 1e-9), sk)
            _in.sort(key=_triage_key)
            candidates = _unverified + _in + _out
            _sel = [(_sc(q.get('questionId')), sk) for sk, q in _in[:_slots]]
            sys.stderr.write(
                f"Jevトリアージ: 確認済み{len(_pool)}問をスコア化 → 上位{min(_slots, len(_in))}問を選定"
                f"（スコア {max(s for s, _ in _sel):.2f}〜{min(s for s, _ in _sel):.2f}"
                f"・バンド幅{_triage_band}・同バンド内は古い順）\n")
elif _slots <= 0:
    sys.stderr.write("未確認だけでバッチが埋まるため Jev トリアージはスキップ（費用ゼロ）\n")

if session_lock_path and session_claimed_path:
    lock_fd = open(session_lock_path, 'w')
    fcntl.flock(lock_fd, fcntl.LOCK_EX)
    try:
        claims = load_claims(session_claimed_path)
        # 期限切れクレームは落として再取得可能にする
        claims = {k: t for k, t in claims.items() if now_ts - t < CLAIM_TTL_SEC}
        # 有効なクレームを除外
        remaining = [(sk, q) for sk, q in candidates if q.get('questionId') not in claims]
        selected = [q for _, q in remaining[:batch]]
        # 今回のバッチを現在時刻でクレーム登録
        for q in selected:
            claims[q['questionId']] = now_ts
        with open(session_claimed_path, 'w') as f:
            json.dump(claims, f)
    finally:
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        lock_fd.close()
else:
    selected = [q for _, q in candidates[:batch]]

print(json.dumps(selected))
PYEOF
)
rm -f "$DYNAMO_TMP"

COUNT=$(echo "$QUESTIONS_JSON" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo 0)
echo "チェック対象: ${COUNT}問"

if [ "$COUNT" -eq 0 ]; then
  if [ -z "$QUESTIONS_JSON" ]; then
    echo "❌ 問題取得失敗（DynamoDB scan またはパースエラー）"
    exit 1
  fi
  echo "チェック対象なし（全問が直近にチェック済み）"
  exit 0
fi

# 選択済みバッチの questionId を選定直後に保存する。
# QUESTIONS_JSON は前処理で再代入され run 末尾には空になり得るため、
# クレーム解放は QUESTIONS_JSON ではなくこの固定リストを正とする（過去のロールバック失敗の原因）。
SELECTED_IDS_FILE=$(mktemp /tmp/validity_selected_XXXX.txt)
echo "$QUESTIONS_JSON" | python3 -c "import json,sys
for q in json.load(sys.stdin):
    qid=q.get('questionId')
    if qid: print(qid)" > "$SELECTED_IDS_FILE" 2>/dev/null || true

# ── 前処理: choices のラベル接頭辞自動除去（Claude 不要・確定的修正） ──
echo "前処理: choices ラベル接頭辞チェック..."
_PRE_TMP=$(mktemp /tmp/validity_pre_XXXX.json)
echo "$QUESTIONS_JSON" > "$_PRE_TMP"
QUESTIONS_JSON=$(QS_FILE="$_PRE_TMP" python3 << 'PYEOF'
import json, sys, re, subprocess, tempfile, os
from datetime import datetime, timezone

label_re = re.compile(r'^[A-E][.\s:：]\s+', re.IGNORECASE)
with open(os.environ['QS_FILE']) as f:
    data = json.load(f)
AWS_CMD = 'aws'
now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

fixed = 0
clean_data = []
for q in data:
    choices = q.get('choices', [])
    if not any(label_re.match(str(c)) for c in choices):
        clean_data.append(q)
        continue
    clean_choices = [label_re.sub('', str(c)).strip() for c in choices]
    q['choices'] = clean_choices
    clean_data.append(q)
    af = tempfile.mktemp(suffix='.json', prefix='/tmp/pre_fix_')
    with open(af, 'w') as f:
        json.dump({':c': {'L': [{'S': c} for c in clean_choices]}, ':u': {'S': now}}, f, ensure_ascii=False)
    r = subprocess.run([AWS_CMD, 'dynamodb', 'update-item',
        '--table-name', 'Questions',
        '--key', json.dumps({'questionId': {'S': q['questionId']}}),
        '--condition-expression', 'attribute_exists(questionId)',
        '--update-expression', 'SET choices = :c, updatedAt = :u',
        '--expression-attribute-values', f'file://{af}',
        '--output', 'json'], capture_output=True, text=True)
    os.unlink(af)
    if r.returncode == 0:
        fixed += 1
        print(f"  ✓ {q['questionId']}: choices ラベル接頭辞除去", file=sys.stderr)
    else:
        print(f"  ❌ {q['questionId']}: choices 更新失敗", file=sys.stderr)
if fixed > 0:
    print(f"  前処理完了: choices ラベル自動除去 {fixed}件", file=sys.stderr)
else:
    print(f"  前処理: ラベル接頭辞なし（全問クリーン）", file=sys.stderr)
# ── 構造チェック（確定的・Claude 不要）──
# 正解と選択肢の完全一致 / isMultiple の整合 / 選択肢別解説の件数。全4,894問で違反0件（2026-10-01 実測）。
# 以前はこれらをプロンプトの確認観点に入れ、毎回モデルに確認させていた。
# 違反がある問題にだけ _struct を付け、プロンプトの「構造チェック:」行として Claude に直させる。
# _struct は DB へは書かれない（DB更新は Claude の fix の値だけを使うため）。
def structural_issues(q):
    issues = []
    choices = [str(c) for c in (q.get('choices') or [])]
    answers = [str(c) for c in (q.get('correctAnswers') or [])]
    indices = q.get('correctAnswerIndices')
    ce = q.get('choiceExplanations') or []
    text_ok = True
    if answers and choices:
        miss = [a for a in answers if a.strip() not in {c.strip() for c in choices}]
        if miss:
            text_ok = False
            issues.append(f"correctAnswers が choices のいずれとも完全一致しない（{len(miss)}件）")
    if isinstance(indices, list) and indices and choices:
        if any((not isinstance(i, int)) or i < 0 or i >= len(choices) for i in indices):
            issues.append("correctAnswerIndices が choices の範囲外")
        elif answers and text_ok and [choices[i].strip() for i in indices] != [a.strip() for a in answers]:
            # 文字列の一致が取れているときだけ見る（取れていないと上と同じ原因を二重に報告する）
            issues.append("correctAnswerIndices と correctAnswers が指す選択肢が食い違う")
    n_correct = len(indices) if isinstance(indices, list) and indices else len(answers)
    if n_correct and bool(q.get('isMultiple')) != (n_correct > 1):
        issues.append(f"isMultiple={bool(q.get('isMultiple'))} だが正解は{n_correct}個")
    if choices and len(ce) != len(choices):
        issues.append(f"choiceExplanations が{len(ce)}件（choices は{len(choices)}件）" if ce else "choiceExplanations が未設定")
    return issues

_struct_n = 0
for q in clean_data:
    _iss = structural_issues(q)
    if _iss:
        q['_struct'] = _iss
        _struct_n += 1
print(f"  構造チェック: 違反あり {_struct_n}問 / {len(clean_data)}問", file=sys.stderr)
print(json.dumps(clean_data))
PYEOF
)
rm -f "$_PRE_TMP"

# ── 2. チャンクファイルに分割 ────────────────────────────────────
CHUNKS_DIR=$(mktemp -d /tmp/validity_chunks_XXXX)
QUESTIONS_TMP=$(mktemp /tmp/validity_qs_XXXX.json)
echo "$QUESTIONS_JSON" > "$QUESTIONS_TMP"
CHUNK_COUNT=$(QUESTIONS_FILE="$QUESTIONS_TMP" CHUNK_SIZE=$CHUNK_SIZE CHUNKS_DIR="$CHUNKS_DIR" python3 << 'PYEOF'
import json, os
with open(os.environ['QUESTIONS_FILE']) as f:
    qs = json.load(f)
cs = int(os.environ['CHUNK_SIZE'])
# 同じ資格の問題を同じチャンクにまとめる（安定ソートなので資格内の優先順位は保たれる）。
# プロンプトは資格に関係するドメイン表・追加観点だけを入れるので、混ざるほど長くなる。
# ただし未確認（非公開）の問題は確認済みより必ず先に置く。資格だけで並べると、終了時刻で
# 打ち切られたときに Jev で選んだ確認済みの問題が先に処理され、新規問題の公開が遅れる。
qs.sort(key=lambda q: (bool(q.get('validityCheckedAt')), q.get('examType', '')))
for i in range(0, len(qs), cs):
    chunk = qs[i:i+cs]
    idx = i // cs
    with open(f"{os.environ.get('CHUNKS_DIR', '/tmp')}/{idx:04d}.json", 'w') as f:
        json.dump(chunk, f)
print((len(qs) + cs - 1) // cs)
PYEOF
)
rm -f "$QUESTIONS_TMP"
echo "チャンク数: ${CHUNK_COUNT}"

# ── 3. チャンクごとにClaude → 即DB更新 ──────────────────────────
TOTAL_OK=0
TOTAL_FIX=0
TOTAL_DEL=0
RATE_LIMITED=0

# このrunで実際に「解決」できた問題ID（ok/削除/再チェック不要のfix）を蓄積する。
# 選択済みだが未解決（部分処理での取りこぼし・再チェック要のfix・LLMが結果を返さなかった等）の
# クレームは run 終了時に解放し、当日の後続 run で再選定できるようにする。
RESOLVED_IDS_FILE=$(mktemp /tmp/validity_resolved_XXXX.txt)
export RESOLVED_IDS_FILE

# 公式試験ガイドURLマップを instructions/*.txt から構築
EXAM_GUIDE_URLS_JSON=$(INST_DIR="$INSTRUCTION_DIR" python3 << 'PYEOF'
import os, json
inst_dir = os.environ.get('INST_DIR', '')
urls = {}
if inst_dir and os.path.isdir(inst_dir):
    for fname in os.listdir(inst_dir):
        if not fname.endswith('.txt') or fname.startswith('_'):
            continue
        exam = fname[:-4]
        path = os.path.join(inst_dir, fname)
        try:
            with open(path) as f:
                for line in f:
                    if line.startswith('# EXAM_GUIDE_URL:'):
                        urls[exam] = line.split(':', 1)[1].strip()
                        break
        except Exception:
            pass
print(json.dumps(urls, ensure_ascii=False))
PYEOF
)
# JSON取得失敗時のフォールバック
[ -z "$EXAM_GUIDE_URLS_JSON" ] && EXAM_GUIDE_URLS_JSON='{}'

# 自動改良で追記される追加確認観点（audit-questions.sh -i が編集）。存在すればプロンプトに注入。
VALIDITY_EXTRA=""
[ -f "$INSTRUCTION_DIR/_validity-extra.txt" ] && VALIDITY_EXTRA="$(cat "$INSTRUCTION_DIR/_validity-extra.txt")"

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
  echo "--- チャンク $((CHUNK_IDX+1))/${CHUNK_COUNT}: ${CHUNK_NUM}問  開始=$(date '+%H:%M:%S') ---"

  PROMPT_FILE=$(mktemp /tmp/validity_prompt_XXXX.txt)
  EXAM_GUIDE_URLS_JSON_ESC="$EXAM_GUIDE_URLS_JSON" VALIDITY_EXTRA="$VALIDITY_EXTRA" python3 - "$chunk_file" > "$PROMPT_FILE" << 'PYEOF'
import json, sys, os
with open(sys.argv[1]) as f:
    questions = json.load(f)
# A(再有効化): 検証ゲートでは WebFetch を許可し、現行性が不確かな場合のみ公式ドキュメントで裏取りさせる。
#   生成・検証が同じモデル知識のみだと「同じ思い込みの事実誤り」を素通りさせるため、
#   ゲート側だけ外部の正解突き合わせ手段を残す。トークン抑制のためチャンク内に実在する資格のURLだけ添える。
exam_guide_urls = json.loads(os.environ.get('EXAM_GUIDE_URLS_JSON_ESC', '{}') or '{}')
_chunk_exam_set = set(q.get('examType', '') for q in questions)
_chunk_urls = {k: v for k, v in exam_guide_urls.items() if k in _chunk_exam_set}
url_note = ''
if _chunk_urls:
    url_lines = '\n'.join(f'  {k}: {v}' for k, v in sorted(_chunk_urls.items()))
    url_note = f'\n【公式試験ガイドURL（出題範囲・現行性の確認に使用してよい）】\n{url_lines}\n'
PROMPT_HEADER = 'あなたはAWS認定試験の問題品質チェッカーです。\n以下の問題を精査し、資格勉強サイトの問題として適切かどうか確認してください。' + url_note + '\n【確認観点】\n- AWSサービスの仕様・廃止状況が正確か（廃止/非推奨のサービスを現行として扱っていないか）。廃止/非推奨・具体的数値（SLA・上限値・保持期間等）が正否の決め手でモデル知識に疑いがある時のみ、公式ドキュメントで確認（WebFetch、または AWS ドキュメント MCP の mcp__aws-docs__search_documentation / read_documentation。MCP は ToolSearch で読み込む。合わせてチャンクあたり最大2回・確信があれば使わない）。一般的事実の毎回確認は不要。CodeCommitは現行サービス（廃止扱い禁止）\n- 正解が正しく、選択肢に正解が含まれているか\n- 解説が正確で適切か。ダミーの選択肢がだめな理由も解説しているか\n- 試験問題として適切な形式・難易度か\n- 選択肢本文に略語の展開（正式名称/意味の括弧補足）が入っていないか（選択肢は用語のみ。入っていれば不要なヒントになるため fix で削り用語のみにする）。一方で解説(explanation・choiceExplanations)側では重要な略語が初出で英語フルスペル併記により展開されているか（例 解説内で「BLEU(Bilingual Evaluation Understudy)」。未展開なら fix で解説に補う）。全略語ではなく重要語のみ、S3・VPC等の周知略称は対象外\n- 選択肢に用語の説明・定義文・略語の展開が含まれていないか（選択肢は用語・答えのみにすべき。過剰な説明文や略語の括弧補足は fix で削り用語のみにする。削った内容・略語の意味は choiceExplanations／explanation 側で担保）\n- タグが下記ドメインの正確な値か（空・欠落・範囲外はfix）\n  CLF: クラウドの概念 / セキュリティとコンプライアンス / クラウドのテクノロジーとサービス / 請求、料金、およびサポート\n  SAA: セキュアなアーキテクチャの設計 / 弾力性に優れたアーキテクチャの設計 / 高性能なアーキテクチャの設計 / コスト最適化されたアーキテクチャの設計\n  SAP: 組織の複雑さに対応する設計 / 新しいソリューションのための設計 / 既存のソリューションの継続的改善 / ワークロードの移行とモダン化の加速\n  DOP: SDLC の自動化 / 構成管理と Infrastructure as Code (IaC) / 弾力性に優れたクラウドソリューション / モニタリングとロギング / インシデントとイベントへの対応 / セキュリティとコンプライアンス\n  DVA: AWSのサービスを使用した開発 / セキュリティ / デプロイ / トラブルシューティングと最適化\n  SOA: モニタリング、ロギング、分析、修復、およびパフォーマンスの最適化 / 信頼性とビジネス継続性 / デプロイ、プロビジョニング、および自動化 / セキュリティとコンプライアンス / ネットワークとコンテンツ配信\n  DEA: データの取り込みと変換 / データストアの管理 / データオペレーションとサポート / データのセキュリティとガバナンス\n  AIF: AIとMLの基礎 / 生成AIの基礎 / 基盤モデルのアプリケーション / 責任あるAIのガイドライン / AIソリューションのセキュリティ、コンプライアンス、ガバナンス\n  AIB: AIの基礎とリテラシー / AI戦略とビジネス価値創出 / AIガバナンスと責任あるAIリーダーシップ / ビジネス準備・リーダーシップ・AI変革\n  MLA: 機械学習のためのデータ準備 / MLモデルの開発 / MLワークフローのデプロイとオーケストレーション / MLソリューションの監視、メンテナンス、セキュリティ\n  AIP: 基盤モデルの統合、データ管理、コンプライアンス / 実装と統合 / AIの安全性、セキュリティ、ガバナンス / 生成AIアプリケーションの運用効率と最適化 / テスト、検証、トラブルシューティング\n  ANS: ネットワーク設計 / ネットワーク実装 / ネットワーク管理と運用 / ネットワークのセキュリティ、コンプライアンス、ガバナンス\n  SCS: 検出 / インシデント対応 / インフラストラクチャのセキュリティ / アイデンティティとアクセス管理 / データ保護 / セキュリティの基盤とガバナンス\n  ML: AI/MLの基礎概念 / データ準備・特徴量エンジニアリング / モデル学習と最適化 / モデル評価と指標 / 生成AI・基盤モデル / 責任あるAI・運用\n  DB: リレーショナル設計・正規化 / SQL・クエリ / インデックスと性能 / トランザクション・整合性 / データモデリング・分析基盤 / データ処理方式・品質\n  NW: ネットワーク基礎（OSI/TCP-IP） / IPアドレッシング・サブネット / ルーティング / DNS・名前解決 / トランスポート・アプリ層 / ネットワークセキュリティ・運用\n  SEC: 暗号技術の基礎 / 認証・認可・アイデンティティ / ネットワークセキュリティ / 脅威・脆弱性・攻撃手法 / インシデント対応・監視・ログ / データ保護・ガバナンス・コンプライアンス\n※ ML/DB/NW はAWS認定ではない基礎知識カード。AWSサービスが登場してもよいが、AWSサービスそのもの（仕様・選定・使い分け）が主題の問題は不適切（基礎概念を主眼に直せなければdelete、直せるならfix）。基礎概念が主眼ならok\n- 構造（正解と選択肢の完全一致・isMultiple の整合・選択肢別解説の件数）は事前に機械チェック済み。確認不要（問題のあるものだけ「構造チェック:」行が付く）\n- choiceExplanations[i] と choices[i] の内容が対応しているか（ずれていればfixで並び替え）\n- 1つの選択肢や解説（choices・correctAnswers・explanation・choiceExplanations）に「原因：」「対処：」「メリット：」「デメリット：」等の複数のラベル付き項目が改行なしで1行に詰まっている場合は、各ラベルの直前に改行（文字 \\n）を入れて1ラベル1行に分ける fix を行う（choices を変更したら correctAnswers も同じ改行で完全一致させること）\n\n【アクション】\n- "ok": 問題なし（確認日のみ更新）\n- "fix": 問題あり・修正可能（修正後の内容を含める。変更する項目のみ）\n  ※ fix は「事実・正確性・データ整合」の問題に加え、以下の明示対象に限る（廃止/誤ったサービス、正解の誤り・選択肢との不一致、isMultiple/ドメインの誤り、choiceExplanations の件数・対応ズレ、実在しない連携、仕様の過大主張、【必須fix】選択肢本文に入った略語の展開(括弧補足)の除去＝選択肢は用語のみにし略語の意味は解説側へ移す(ヒント漏れ防止)。かつ解説(explanation・choiceExplanations)側で重要な略語が英語フルスペルで展開されていなければ解説に追加(例 SMOTE(Synthetic Minority Over-sampling Technique)。BLEU/ROC-AUC/RMSE/MAE/F1/RBAC/MVCC/CIDR/OWASP 等が該当。全略語でなく重要語のみ。S3/VPC等の周知AWS略称は対象外)、【必須fix】選択肢の過剰説明＝用語+定義文になっている選択肢は用語のみに削り説明は choiceExplanations へ 等）。\n  ※ 「易しすぎる／ペア構造(2案×2組)でない／消去法が成立する／暗記寄り」等の難易度・構成に関する好みは、既存問題では fix しない（action=ok とする）。これらは生成時に担保する事項であり、成立している問題を難化目的で作り直さない。下記【追加の確認観点】に難易度・構成の指摘があっても、事実の誤りを伴わない限り fix せず ok とすること。\n  ※ 字数超過（解説や choiceExplanations が長い）だけを理由に既存を縮めない。字数上限は生成時（新規生成）のみ担保し、内容が妥当なら長くても ok とする。※ 「正解選択肢が最長」だけを理由に fix しない。正解が最長になるのは一定割合（目安2〜3割）で許容し、長さと正解の相関を作らない方針。ただし正解が他の全選択肢より極端に長く（概ね1.5倍超、または正解だけ2文構成）長さだけで正解が明白な場合のみ、技術的内容を保ったまま短縮する fix 対象とする。なお選択肢がすべて単語・用語のみ（説明文でない）の場合は長さのバランスを一切問わず、最長の用語が正解でも fix しない。\n  ※ 体裁（問題文・解説の改行や列挙・手順の整形、choiceExplanations 文頭のサービス名主語、番号手順の連番順）はトークン節約のため検証(02)では確認も fix もしない。ただし「選択肢に入った略語の展開の除去（選択肢は用語のみ・略語の意味は解説側へ）」「選択肢の過剰説明の除去（用語のみに）」「解説での重要略語の英語フルスペル展開の補完」「1つの選択肢や解説に複数ラベル（原因／対処 等）が改行なしで詰まっている場合の改行挿入」は上記【確認観点】のとおり fix 対象とする（体裁扱いにして見送らないこと）。生成(01)で担保する事項であり、可読性の決定的整形が要る場合は別途 fix-list-linebreaks.py 等で処理する。\n- "delete": 修正不可能な致命的問題（正解が選択肢に存在しない、完全に誤った情報など）\n\n【出力形式】\n必ず以下のJSONのみを出力してください。説明文・前置きは不要です。\n\n{"results":[\n  {"questionId":"...","action":"ok","reason":"日本語100字以内"},\n  {"questionId":"...","action":"fix","reason":"...","fix":{"questionText":"修正後（変更する場合のみ）","choices":["A","B","C","D"],"correctAnswers":["正解（choices配列内の完全一致テキスト、記号接頭辞なし）"],"explanation":"修正後解説（変更する場合のみ）","choiceExplanations":["選択肢0の解説","選択肢1の解説","選択肢2の解説","選択肢3の解説"],"tags":["出題ドメイン（変更する場合のみ）"],"isMultiple":true}},\n  {"questionId":"...","action":"delete","reason":"..."}\n]}\n\n【問題リスト】'
# 自動改良された追加確認観点を注入（audit-questions.sh -i が _validity-extra.txt を更新）
_extra = (os.environ.get('VALIDITY_EXTRA', '') or '').strip()
# 追加観点の絞り込み。# 行（ファイルの説明）は入れない。「- {AIF,MLA} …」のように資格タグが付いた行は
# チャンクにその資格があるときだけ入れる（{AWS} は ML/DB/NW/SEC 以外）。以前は AIF/MLA 向けの
# 事実や AWS サービスの仕様が、DB・NW のチャンクにも毎回入っていた。
import re as _re0
_NON_AWS = {'ML', 'DB', 'NW', 'SEC'}
_cx = {q.get('examType', '') for q in questions}
_cx_tags = _cx | ({'AWS'} if _cx - _NON_AWS else set())
_kept, _section = [], []
for _ln in _extra.split('\n'):
    if _ln.startswith('#') and not _ln.startswith('## '):
        continue
    if _ln.startswith('## ') or not _ln.strip():
        if _section and any(x.startswith('- ') for x in _section):
            _kept.extend(_section)
        _section = [_ln] if _ln.startswith('## ') else []
        continue
    _m = _re0.match(r'^- \{([A-Za-z0-9,]+)\}\s*', _ln)
    if _m:
        if not ({t.strip() for t in _m.group(1).split(',')} & _cx_tags):
            continue
        _ln = '- ' + _ln[_m.end():]
    _section.append(_ln)
if _section and any(x.startswith('- ') for x in _section):
    _kept.extend(_section)
_extra = '\n'.join(_kept).strip()
if _extra:
    PROMPT_HEADER = PROMPT_HEADER.replace('\n\n【問題リスト】', '\n\n【追加の確認観点（監査による自動改良）】\n' + _extra + '\n\n【問題リスト】')
# 構造チェック行(_struct)が付いた問題がチャンクにある場合だけ、直し方を入れる。
# 違反は全4,894問で0件なので、大半のチャンクでは入らず、プロンプトがその分だけ軽くなる。
if any(isinstance(q.get('_struct'), list) and q.get('_struct') for q in questions):
    _STRUCT_NOTE = (
        '【構造チェックの直し方】\n'
        '「構造チェック:」行が付いた問題は、その指摘を fix で直すこと。\n'
        '- 正解は choices 内の完全一致テキストにする（記号接頭辞なし）。choices を変えたら correctAnswers も同じ内容に揃える。\n'
        '- isMultiple は、正解が複数なら true・1つなら false。\n'
        '- 選択肢別解説の件数が合わない・未設定のときは生成する（各80字以内・判定文不可）。'
        '※既存の解説が80字を超えているだけで、内容が妥当・件数一致・サービス名主語あり、なら fix しない。'
    )
    PROMPT_HEADER = PROMPT_HEADER.replace('\n\n【問題リスト】', '\n\n' + _STRUCT_NOTE + '\n\n【問題リスト】')
# Jev 事前スコアが付いた問題がチャンクにある場合だけ、読み方の注意書きを入れる（無ければ従来と同一）。
# 数値の根拠は jev-validity-eval.py の実測（AUC: hint_leak 0.82 / 事実誤り 0.64 / 正解の当否 0.47）。
# 「低スコア＝問題なし」と受け取って確認を省くと、Jev が見逃す種類の欠陥（正解の誤り等）が素通りするため、
# その誤読を防ぐ文言を入れている。
if any(isinstance(q.get('_jev'), dict) and q.get('_jev') for q in questions):
    _JEV_NOTE = (
        '【Jev事前スコアの読み方】\n'
        '一部の問題には、軽量判定モデル Jev による事前スコア（0=問題なし寄り〜1=疑わしい）が付いている。'
        '参考情報であり、最終判断は必ずあなた自身の確認で行うこと。\n'
        '- スコアは「選択肢の括弧補足（略語展開・定義文）によるヒント漏れ」だけを見たもの。比較的信頼できる。'
        '高い問題は選択肢の括弧を最優先で確認する。ただし数量「（12シャード）」・参照記号「（要件①）」・'
        '製品名の一部など正当な括弧でも高く出ることがあるので、削るかどうかはあなたが判断する。\n'
        '- スコアが低いことは「問題なし」の保証ではない。Jev は事実誤り・正解の当否・解説のズレ・ドメインの誤りなどを'
        '一切判定していない。【確認観点】は全問について通常どおり確認すること。\n'
        '- スコアが高いことだけを理由に fix / delete しない。根拠をあなた自身が確認できた場合のみ行う。\n'
        '- スコアが付いていない問題は Jev 未判定であり、問題の良し悪しとは無関係。'
    )
    PROMPT_HEADER = PROMPT_HEADER.replace('\n\n【問題リスト】', '\n\n' + _JEV_NOTE + '\n\n【問題リスト】')
# B: チャンク内に実在する資格のドメイン表だけ残す（他資格の "  XXX: ..." 行を削除しトークン削減）
import re as _re
_chunk_exams = set(q.get('examType', '') for q in questions)
PROMPT_HEADER = _re.sub(r'\n  ([A-Z]{2,4}): [^\n]+',
                        lambda m: m.group(0) if m.group(1) in _chunk_exams else '',
                        PROMPT_HEADER)
lines = [PROMPT_HEADER]
EXAM_DOMAINS_LOCAL = {'CLF': ['クラウドの概念', 'セキュリティとコンプライアンス', 'クラウドのテクノロジーとサービス', '請求、料金、およびサポート'], 'SAA': ['セキュアなアーキテクチャの設計', '弾力性に優れたアーキテクチャの設計', '高性能なアーキテクチャの設計', 'コスト最適化されたアーキテクチャの設計'], 'SAP': ['組織の複雑さに対応する設計', '新しいソリューションのための設計', '既存のソリューションの継続的改善', 'ワークロードの移行とモダン化の加速'], 'DVA': ['AWSのサービスを使用した開発', 'セキュリティ', 'デプロイ', 'トラブルシューティングと最適化'], 'SOA': ['モニタリング、ロギング、分析、修復、およびパフォーマンスの最適化', '信頼性とビジネス継続性', 'デプロイ、プロビジョニング、および自動化', 'セキュリティとコンプライアンス', 'ネットワークとコンテンツ配信'], 'DOP': ['SDLC の自動化', '構成管理と Infrastructure as Code (IaC)', '弾力性に優れたクラウドソリューション', 'モニタリングとロギング', 'インシデントとイベントへの対応', 'セキュリティとコンプライアンス'], 'AIF': ['AIとMLの基礎', '生成AIの基礎', '基盤モデルのアプリケーション', '責任あるAIのガイドライン', 'AIソリューションのセキュリティ、コンプライアンス、ガバナンス'], 'MLA': ['機械学習のためのデータ準備', 'MLモデルの開発', 'MLワークフローのデプロイとオーケストレーション', 'MLソリューションの監視、メンテナンス、セキュリティ'], 'AIP': ['基盤モデルの統合、データ管理、コンプライアンス', '実装と統合', 'AIの安全性、セキュリティ、ガバナンス', '生成AIアプリケーションの運用効率と最適化', 'テスト、検証、トラブルシューティング'], 'DEA': ['データの取り込みと変換', 'データストアの管理', 'データオペレーションとサポート', 'データのセキュリティとガバナンス'], 'ANS': ['ネットワーク設計', 'ネットワーク実装', 'ネットワーク管理と運用', 'ネットワークのセキュリティ、コンプライアンス、ガバナンス'], 'SCS': ['検出', 'インシデント対応', 'インフラストラクチャのセキュリティ', 'アイデンティティとアクセス管理', 'データ保護', 'セキュリティの基盤とガバナンス']}
try:
    import json as _ejson, os as _eos
    _ep = _eos.environ.get('EXAM_DOMAINS_JSON_PATH')
    if _ep and _eos.path.exists(_ep):
        with open(_ep, encoding='utf-8') as _ef:
            EXAM_DOMAINS_LOCAL = {k: [d['ja'] for d in v] for k, v in _ejson.load(_ef).items()}
except Exception:
    pass
for q in questions:
    lines.append(f"ID: {q['questionId']}")
    lines.append(f"試験: {q.get('examType','')}")
    lines.append(f"問題文: {q.get('questionText','')}")
    choices = q.get('choices', [])
    if choices:
        lines.append(f"選択肢: {' / '.join(str(c) for c in choices)}")
    correct = q.get('correctAnswers', [])
    if correct:
        lines.append(f"正解: {', '.join(str(c) for c in correct)}")
    exp = q.get('explanation', '')
    if exp:
        lines.append(f"解説: {exp}")
    ce = q.get('choiceExplanations', [])
    if ce:
        if len(ce) == len(choices):
            lines.append(f"選択肢別解説（choiceExplanations[i]とchoices[i]の対応を確認すること）:")
            for i, (ch, ex) in enumerate(zip(choices, ce)):
                lines.append(f"  [{i}] 選択肢: 「{str(ch)}」")
                lines.append(f"      解説:   「{str(ex)}」")
        else:
            lines.append(f"選択肢別解説数: {len(ce)}件（choices数: {len(choices)}件・不一致）")
    else:
        lines.append(f"選択肢別解説: なし（要生成）")
    domain_int = q.get('domain')
    tags = q.get('tags', [])
    if isinstance(domain_int, int):
        exam = q.get('examType', '')
        domain_name = (EXAM_DOMAINS_LOCAL.get(exam, [])[domain_int:domain_int+1] or [''])[0]
        lines.append(f"ドメイン: {domain_name if domain_name else '（不明）'}")
    else:
        lines.append(f"タグ: {', '.join(tags) if tags else '（なし）'}")
    _st = q.get('_struct')
    if isinstance(_st, list) and _st:
        lines.append("構造チェック: " + " / ".join(str(x) for x in _st))
    # 小数1桁に丸める。Jev のスコアは同一入力でも最大0.1程度揺れるので、それ以上の桁は偽の精度になる。
    _jv = q.get('_jev')
    if isinstance(_jv, dict) and _jv:
        if isinstance(_jv.get('hint_leak'), (int, float)):
            lines.append(f"Jev事前スコア（0=問題なし寄り〜1=疑わしい）: 選択肢ヒント漏れ {_jv['hint_leak']:.1f}")
    lines.append("")
print('\n'.join(lines))
PYEOF

  # claude 呼び出し（529 Overloaded は最大2回リトライ）
  _OVERLOAD_RETRY=0
  _SKIP_CHUNK=0
  while true; do
    _STDOUT_F=$(mktemp /tmp/claude_out_XXXX)
    _STDERR_F=$(mktemp /tmp/claude_err_XXXX)
    timeout -k 30 "${CLAUDE_TIMEOUT:-1800}" "$CLAUDE_CMD" -p --model sonnet --tools WebFetch,ToolSearch --allowed-tools WebFetch,mcp__aws-docs --strict-mcp-config --mcp-config /home/yuzuki/aws-quiz-app/prompts/night-prompts/scripts/mcp-aws-docs.json < "$PROMPT_FILE" > "$_STDOUT_F" 2> "$_STDERR_F"
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
        timeout -k 30 "${CLAUDE_TIMEOUT:-1800}" "$CLAUDE_CMD" -p --model sonnet --tools WebFetch,ToolSearch --allowed-tools WebFetch,mcp__aws-docs --strict-mcp-config --mcp-config /home/yuzuki/aws-quiz-app/prompts/night-prompts/scripts/mcp-aws-docs.json < "$PROMPT_FILE" > "$_STDOUT_F" 2> "$_STDERR_F"
        AI_EXIT=$?
        RESULT=$(cat "$_STDOUT_F")
        _STDERR=$(cat "$_STDERR_F")
        rm -f "$_STDOUT_F" "$_STDERR_F"
      fi
    fi

    # 致命的エラー（認証・コマンド問題）→ 即終了
    if echo "$_STDERR" | grep -qiE "command not found|No such file|GEMINI_API_KEY|API.?key"; then
      rm -f "$PROMPT_FILE"
      echo "❌ claude 実行エラー（認証またはコマンド問題）。スクリプトを終了します"
      echo "stderr: $(echo "$_STDERR" | head -3)"
      exit 1
    fi

    _RESULT_HEAD=$(echo "$RESULT" | head -3)

    # 529 Overloaded（一時的なサーバー過負荷）→ 最大2回リトライ後、このチャンクのみスキップして続行
    if echo "$_STDERR $_RESULT_HEAD" | grep -qiE "529|Overloaded"; then
      if [ $_OVERLOAD_RETRY -lt 2 ]; then
        _OVERLOAD_RETRY=$(( _OVERLOAD_RETRY + 1 ))
        echo "⚠️  サーバー過負荷（529）を検出。60秒後にリトライ（${_OVERLOAD_RETRY}/2回目）"
        sleep 60
        continue
      else
        echo "⚠️  529 Overloaded が続くためチャンク $((CHUNK_IDX+1)) をスキップして続行"
        echo "stdout: $_RESULT_HEAD"
        _SKIP_CHUNK=1
        break
      fi
    fi

    # 真のレート制限（429・quota 超過など）→ 残りチャンクをすべてスキップ
    if echo "$_STDERR $_RESULT_HEAD" | grep -qiE "rate.?limit|too many requests|quota exceeded|usage limit|resource_exhausted|session.?limit|hit your"; then
      rm -f "$PROMPT_FILE"
      echo "⚠️  レート制限を検出。残りチャンクをスキップ"
      echo "stdout: $_RESULT_HEAD"
      # 後続 run が同じことを繰り返さないよう回復予定時刻を残す。
      # -D の終了時刻がトークン回復の数分前に設定されているので、それを回復目安とする
      # （-D 未指定なら控えめに30分後）。
      if [ "$DEADLINE_EPOCH" -gt 0 ]; then
        echo "$DEADLINE_EPOCH" > "$RATE_LIMIT_MARKER"
      else
        echo "$(( $(date +%s) + 1800 ))" > "$RATE_LIMIT_MARKER"
      fi
      RATE_LIMITED=1
      break 2
    fi

    break
  done
  rm -f "$PROMPT_FILE"

  [ $_SKIP_CHUNK -eq 1 ] && continue

  # タイムアウト（timeout の exit 124 / KILL後は 137）→ ハング。スキップして続行
  if [ $AI_EXIT -eq 124 ] || [ $AI_EXIT -eq 137 ]; then
    echo "⚠️  チャンク $((CHUNK_IDX+1)) が ${CLAUDE_TIMEOUT:-1800}秒 で応答なし（ハング）。スキップして続行"
    continue
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

  # ── DB即時更新 ────────────────────────────────────────────────
  RESULT_JSON_FILE=$(mktemp /tmp/validity_result_XXXX.json)
  echo "$RESULT_JSON" > "$RESULT_JSON_FILE"
  CHUNK_STATS=$(python3 - "$RESULT_JSON_FILE" "$chunk_file" << 'PYEOF'
import json, sys, subprocess, os
from datetime import datetime, timezone

with open(sys.argv[1]) as f:
    data = json.load(f)
results = data.get('results', [])
now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

# Build original question map for before/after diff
with open(sys.argv[2]) as f:
    orig_questions = {q['questionId']: q for q in json.load(f)}

ok_count, fix_count, del_count = 0, 0, 0

# このチャンクで解決した（validityCheckedAt 付与 or 削除）ID。run終了時のクレーム解放判定に使う。
resolved_ids = []

REMOVE_EXPR = 'REMOVE validityRating, validityNote, fixProposalJson, tags'

EXAM_DOMAINS_FIX = {'CLF': ['クラウドの概念', 'セキュリティとコンプライアンス', 'クラウドのテクノロジーとサービス', '請求、料金、およびサポート'], 'SAA': ['セキュアなアーキテクチャの設計', '弾力性に優れたアーキテクチャの設計', '高性能なアーキテクチャの設計', 'コスト最適化されたアーキテクチャの設計'], 'SAP': ['組織の複雑さに対応する設計', '新しいソリューションのための設計', '既存のソリューションの継続的改善', 'ワークロードの移行とモダン化の加速'], 'DVA': ['AWSのサービスを使用した開発', 'セキュリティ', 'デプロイ', 'トラブルシューティングと最適化'], 'SOA': ['モニタリング、ロギング、分析、修復、およびパフォーマンスの最適化', '信頼性とビジネス継続性', 'デプロイ、プロビジョニング、および自動化', 'セキュリティとコンプライアンス', 'ネットワークとコンテンツ配信'], 'DOP': ['SDLC の自動化', '構成管理と Infrastructure as Code (IaC)', '弾力性に優れたクラウドソリューション', 'モニタリングとロギング', 'インシデントとイベントへの対応', 'セキュリティとコンプライアンス'], 'AIF': ['AIとMLの基礎', '生成AIの基礎', '基盤モデルのアプリケーション', '責任あるAIのガイドライン', 'AIソリューションのセキュリティ、コンプライアンス、ガバナンス'], 'MLA': ['機械学習のためのデータ準備', 'MLモデルの開発', 'MLワークフローのデプロイとオーケストレーション', 'MLソリューションの監視、メンテナンス、セキュリティ'], 'AIP': ['基盤モデルの統合、データ管理、コンプライアンス', '実装と統合', 'AIの安全性、セキュリティ、ガバナンス', '生成AIアプリケーションの運用効率と最適化', 'テスト、検証、トラブルシューティング'], 'DEA': ['データの取り込みと変換', 'データストアの管理', 'データオペレーションとサポート', 'データのセキュリティとガバナンス'], 'ANS': ['ネットワーク設計', 'ネットワーク実装', 'ネットワーク管理と運用', 'ネットワークのセキュリティ、コンプライアンス、ガバナンス'], 'SCS': ['検出', 'インシデント対応', 'インフラストラクチャのセキュリティ', 'アイデンティティとアクセス管理', 'データ保護', 'セキュリティの基盤とガバナンス']}
try:
    import json as _ejson, os as _eos
    _ep = _eos.environ.get('EXAM_DOMAINS_JSON_PATH')
    if _ep and _eos.path.exists(_ep):
        with open(_ep, encoding='utf-8') as _ef:
            EXAM_DOMAINS_FIX = {k: [d['ja'] for d in v] for k, v in _ejson.load(_ef).items()}
except Exception:
    pass

def queue_for_review(qid, review_reason, note, proposal=None):
    """問題を非表示にして「人の確認待ち」に入れる。proposal があれば修正案（fixProposalJson）として残す。"""
    sets = ['isHidden = :h', 'reviewReason = :rr', 'humanReviewRequestedAt = :t', 'validityCheckedAt = :t', 'validityNote = :n', 'updatedAt = :t']
    vals = {':h': {'BOOL': True}, ':rr': {'S': review_reason}, ':t': {'S': now}, ':n': {'S': note or ''}}
    if proposal:
        sets.append('fixProposalJson = :fp')
        vals[':fp'] = {'S': json.dumps(proposal, ensure_ascii=False)}
    subprocess.run(['aws', 'dynamodb', 'update-item', '--table-name', 'Questions',
        '--key', json.dumps({'questionId': {'S': qid}}),
        '--condition-expression', 'attribute_exists(questionId)',
        '--update-expression', 'SET ' + ', '.join(sets),
        '--expression-attribute-values', json.dumps(vals)], capture_output=True)

for r in results:
    qid = r.get('questionId', '')
    action = r.get('action', 'ok')
    reason = r.get('reason', '')
    fix = r.get('fix', {})
    orig = orig_questions.get(qid, {})
    created_at = orig.get('createdAt', '')[:10] if orig.get('createdAt') else '不明'
    prev_checked = orig.get('validityCheckedAt', '')[:10] if orig.get('validityCheckedAt') else '未確認'

    if action == 'delete':
        # 削除は取り返しがつかないので、AI は消さずに非表示にして人の確認に回す（2026-10-27〜。docs/10-ops-review.md 4.2）。
        # 管理画面「人の確認待ち」で、削除するか表示に戻すかを決める。
        queue_for_review(qid, 'ai-delete', reason)
        del_count += 1
        resolved_ids.append(qid)
        print(f'  [HOLD ] {qid}  生成:{created_at}  前回確認:{prev_checked}: AI が削除を提案 → 非表示にして人の確認待ち: {reason}')
        continue

    if action == 'fix' and not fix:
        # 「fix」なのに修正内容が無い。以前は ok と同じ扱いで確認済みにしていたが、
        # 問題ありと判断した問題を公開してしまうので、未解決のまま次回に回す。
        print(f'  [WARN ] {qid}: action=fix だが修正内容が空。確認済みにせず次回再チェック: {reason}')
        continue

    if action == 'fix' and fix:
        import re as _re
        _label_re = _re.compile(r'^[A-E]\.\s*')
        # Build before/after changes dict
        changes = {}
        update_parts = ['updatedAt = :u', 'validityEditLog = :log']
        expr_values = {':u': {'S': now}}
        # True のとき validityCheckedAt を更新せず、次回実行の再チェック対象に残す
        needs_recheck = False

        # ── 整合性ガード ──
        # fix 適用後の correctAnswers 全件が適用後の choices に完全一致で解決できない場合、
        # choices/correctAnswers/choiceExplanations の変更を破棄する。
        # （correctAnswers テキストだけ更新されて correctAnswerIndices が旧値のまま残ると、
        #   アプリの正解表示（indices が正準）と解説が食い違うため）
        stripped_ca = [_label_re.sub('', str(c)) for c in (fix.get('correctAnswers') or [])]
        eff_choices = fix.get('choices') or orig.get('choices', [])
        eff_ca = stripped_ca or orig.get('correctAnswers', [])
        if (fix.get('choices') or stripped_ca) and not (eff_ca and all(ca in eff_choices for ca in eff_ca)):
            print(f'  [WARN ] {qid}: fix の correctAnswers が choices に解決できないため choices/correctAnswers/choiceExplanations の変更を破棄（次回再チェック）')
            fix.pop('choices', None)
            fix.pop('correctAnswers', None)
            fix.pop('choiceExplanations', None)
            stripped_ca = []
            eff_choices = orig.get('choices', [])
            eff_ca = orig.get('correctAnswers', [])
            needs_recheck = True

        if fix.get('questionText') and fix['questionText'] != orig.get('questionText'):
            update_parts.append('questionText = :qt')
            expr_values[':qt'] = {'S': fix['questionText']}
            changes['questionText'] = {'before': orig.get('questionText', ''), 'after': fix['questionText']}

        if fix.get('choices') and fix['choices'] != orig.get('choices'):
            update_parts.append('choices = :ch')
            expr_values[':ch'] = {'L': [{'S': str(c)} for c in fix['choices']]}
            changes['choices'] = {'before': orig.get('choices', []), 'after': fix['choices']}

        if stripped_ca:
            if stripped_ca != orig.get('correctAnswers'):
                update_parts.append('correctAnswers = :ca')
                expr_values[':ca'] = {'L': [{'S': c} for c in stripped_ca]}
                changes['correctAnswers'] = {'before': orig.get('correctAnswers', []), 'after': stripped_ca}
            # correctAnswerIndices を再計算（整合性ガード通過済み＝全件解決可能）
            indices = [eff_choices.index(ca) for ca in stripped_ca]
            update_parts.append('correctAnswerIndices = :ci')
            expr_values[':ci'] = {'L': [{'N': str(i)} for i in indices]}
        elif fix.get('choices'):
            # choices のみ変わった場合も correctAnswerIndices を更新（整合性ガード通過済み）
            indices = [eff_choices.index(ca) for ca in eff_ca]
            if indices:
                update_parts.append('correctAnswerIndices = :ci')
                expr_values[':ci'] = {'L': [{'N': str(i)} for i in indices]}

        if fix.get('explanation') and fix['explanation'] != orig.get('explanation'):
            update_parts.append('explanation = :ex')
            expr_values[':ex'] = {'S': fix['explanation']}
            changes['explanation'] = {'before': orig.get('explanation', ''), 'after': fix['explanation']}

        if fix.get('choiceExplanations'):
            eff_choices = fix.get('choices', orig.get('choices', []))
            if len(fix['choiceExplanations']) == len(eff_choices) and fix['choiceExplanations'] != orig.get('choiceExplanations'):
                update_parts.append('choiceExplanations = :ce')
                expr_values[':ce'] = {'L': [{'S': str(c)} for c in fix['choiceExplanations']]}
                changes['choiceExplanations'] = {'before': orig.get('choiceExplanations', []), 'after': fix['choiceExplanations']}

        if fix.get('tags'):
            new_tags = fix['tags']
            # tags → domain 整数インデックスに変換してセット（アプリは domain integer を使用）
            exam = orig.get('examType', '')
            new_tag = new_tags[0] if new_tags else ''
            domains_for_exam = EXAM_DOMAINS_FIX.get(exam, [])
            domain_idx = domains_for_exam.index(new_tag) if new_tag in domains_for_exam else -1
            if domain_idx >= 0 and domain_idx != orig.get('domain'):
                update_parts.append('#d = :domidx')
                expr_values[':domidx'] = {'N': str(domain_idx)}
                changes['domain'] = {'before': orig.get('domain'), 'after': domain_idx}
            # 旧 tags フィールドは書き込まない（domain 整数インデックスが正準。tags は REMOVE で削除）

        # ── 正解が変わる修正は自動で反映しない（2026-10-27〜。docs/10-ops-review.md 4.2）──
        # 正解の取り違えはいちばん害が大きいので、修正案（fixProposalJson）として残し、問題は非表示にして
        # 管理画面「人の確認待ち」で適用／却下を決める。選択肢の文言だけ変わる（正解の位置が同じ）修正は従来どおり反映する。
        _orig_ch = orig.get('choices', []) or []
        _orig_idx = orig.get('correctAnswerIndices')
        if not isinstance(_orig_idx, list) or not _orig_idx:
            _orig_idx = [_orig_ch.index(c) for c in (orig.get('correctAnswers') or []) if c in _orig_ch]
        _new_idx = [eff_choices.index(c) for c in eff_ca if c in eff_choices]
        if sorted(int(i) for i in _orig_idx) != sorted(_new_idx):
            proposal = {k: v for k, v in {
                'questionText': fix.get('questionText'), 'choices': fix.get('choices'),
                'correctAnswers': stripped_ca or None, 'explanation': fix.get('explanation'),
                'choiceExplanations': fix.get('choiceExplanations'),
            }.items() if v}
            queue_for_review(qid, 'answer-change', reason, proposal)
            fix_count += 1
            resolved_ids.append(qid)
            print(f'  [HOLD ] {qid}  生成:{created_at}  前回確認:{prev_checked}: 正解が変わる修正（{sorted(_orig_idx)}→{sorted(_new_idx)}）→ 修正案にして人の確認待ち: {reason}')
            continue

        # ── 決定的チェック: fix 適用後に正解が「極端に」長くないか ──
        # 正解が最長になること自体は一定割合で許容する方針（長さと正解を無相関にし
        # 「正解は最長にならない」というメタ読みを防ぐ）。ここで弾くのは長さだけで
        # 正解が明白になる極端なケース（不正解最長の1.5倍超）のみ。
        if ('choices' in changes) or ('correctAnswers' in changes):
            _corr_lens = [len(str(c)) for c in eff_choices if c in eff_ca]
            _inc_lens = [len(str(c)) for c in eff_choices if c not in eff_ca]
            if _corr_lens and _inc_lens and max(_corr_lens) > max(_inc_lens) * 1.5:
                needs_recheck = True
                print(f'  [WARN ] {qid}: fix 適用後に正解が極端に長い（正解{max(_corr_lens)}字 > 不正解最長{max(_inc_lens)}字×1.5）。次回再チェック対象に残す')

        # 再チェックが必要な場合は validityCheckedAt を更新しない
        # （未チェック扱いのままにして次回実行の先頭で再検査させる）
        if not needs_recheck:
            update_parts.insert(0, 'validityCheckedAt = :t')
            expr_values[':t'] = {'S': now}

        edit_log = {'action': 'fixed', 'checkedAt': now, 'reason': reason, 'changes': changes}
        expr_values[':log'] = {'S': json.dumps(edit_log, ensure_ascii=False)}

        # 正解・選択肢が変わるfixでは全ユーザー正答率カウンタもリセットする
        # （旧内容に対する正答率が新内容に引き継がれるのを防ぐ）
        remove_expr = REMOVE_EXPR
        if ('choices' in changes) or ('correctAnswers' in changes):
            remove_expr += ', globalAttempts, globalCorrect'
        update_expr = f'SET {", ".join(update_parts)} {remove_expr}'
        cmd = ['aws', 'dynamodb', 'update-item',
            '--table-name', 'Questions',
            '--key', json.dumps({'questionId': {'S': qid}}),
            '--condition-expression', 'attribute_exists(questionId)',
            '--update-expression', update_expr,
            '--expression-attribute-values', json.dumps(expr_values),
        ]
        if '#d' in update_expr:
            cmd += ['--expression-attribute-names', '{"#d": "domain"}']
        subprocess.run(cmd, capture_output=True)
        fix_count += 1
        # needs_recheck の fix は validityCheckedAt を付けない＝未解決。クレームを解放して次回再検査させる。
        if not needs_recheck:
            resolved_ids.append(qid)
        changed_fields = list(changes.keys()) or ['(変更なし)']
        print(f'  [FIX  ] {qid}  生成:{created_at}  前回確認:{prev_checked}: {reason} → 変更: {", ".join(changed_fields)}')

    else:
        # action == 'ok' (or unrecognized)
        update_expr = f'SET validityCheckedAt = :t {REMOVE_EXPR}'
        expr_values = {':t': {'S': now}}
        subprocess.run([
            'aws', 'dynamodb', 'update-item',
            '--table-name', 'Questions',
            '--key', json.dumps({'questionId': {'S': qid}}),
            '--condition-expression', 'attribute_exists(questionId)',
            '--update-expression', update_expr,
            '--expression-attribute-values', json.dumps(expr_values),
        ], capture_output=True)
        ok_count += 1
        resolved_ids.append(qid)
        print(f'  [OK   ] {qid}  生成:{created_at}  前回確認:{prev_checked}')

# 解決IDを run 共有ファイルに追記（run終了時のクレーム解放判定に使う）
_resolved_file = os.environ.get('RESOLVED_IDS_FILE', '')
if _resolved_file and resolved_ids:
    with open(_resolved_file, 'a') as _rf:
        for _qid in resolved_ids:
            _rf.write(_qid + '\n')

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

# run 終了時、選択済みバッチのうち「未解決」のクレームを解放する。
# 解決済み（ok / 削除 / 再チェック不要の fix = validityCheckedAt 付与済み）はクレームを維持し、
# 未解決（部分処理での取りこぼし・再チェック要の fix・LLMが結果を返さなかった問題）だけ解放する。
# これにより中断・再チェック分が当日の後続 run で先頭（未チェック優先）から再選定される。
# 解決済みを維持するのは、並列 run が同一問題を二重チェックしないようにするため。
echo ""
echo "未解決クレームの解放処理..."
SELECTED_IDS_FILE="$SELECTED_IDS_FILE" SESSION_CLAIMED="$SESSION_CLAIMED" SESSION_LOCK="$SESSION_LOCK" RESOLVED_IDS_FILE="$RESOLVED_IDS_FILE" python3 << 'PYEOF'
import json, sys, os, fcntl
try:
    selected_path = os.environ.get('SELECTED_IDS_FILE', '')
    with open(selected_path) as sf:
        selected_ids = {l.strip() for l in sf if l.strip()}
    claimed_path = os.environ.get('SESSION_CLAIMED', '')
    lock_path    = os.environ.get('SESSION_LOCK', '')
    resolved_path = os.environ.get('RESOLVED_IDS_FILE', '')
    if not claimed_path or not lock_path or not selected_ids:
        sys.exit(0)
    resolved = set()
    try:
        with open(resolved_path) as rf:
            resolved = {l.strip() for l in rf if l.strip()}
    except Exception:
        pass
    # 解放対象 = 選択したが解決できなかった ID
    to_release = selected_ids - resolved
    with open(lock_path, 'w') as lf:
        fcntl.flock(lf, fcntl.LOCK_EX)
        try:
            # クレームは {qid: 取得時刻} 形式（旧形式の配列も読めるようにする）
            try:
                with open(claimed_path) as f:
                    raw = json.load(f)
                claimed = ({k: float(v) for k, v in raw.items()} if isinstance(raw, dict)
                           else {k: 0.0 for k in raw})
            except Exception:
                claimed = {}
            new_claimed = {k: t for k, t in claimed.items() if k not in to_release}
            with open(claimed_path, 'w') as f:
                json.dump(new_claimed, f)
            print(f"  クレーム解放: 未解決 {len(to_release)}件を解放 / 解決維持 {len(selected_ids & resolved)}件（残クレーム: {len(new_claimed)}件）")
        finally:
            fcntl.flock(lf, fcntl.LOCK_UN)
except Exception as e:
    print(f"  クレーム解放失敗（無視して続行）: {e}")
PYEOF
rm -f "$RESOLVED_IDS_FILE" "$SELECTED_IDS_FILE"

echo ""
echo "完了サマリー: 問題なし=${TOTAL_OK}問 / 自動修正=${TOTAL_FIX}問 / 削除=${TOTAL_DEL}問"

if [ $RATE_LIMITED -eq 1 ] || [ ${TIMEOUT_HIT:-0} -eq 1 ]; then
  exit 1
fi

echo ""
echo "=========================================="
echo "チェック終了: $(date)"
echo "=========================================="

} 2>&1 | tee -a "$LOG_FILE"

find "$LOG_DIR" -name "validity_*.log" -mtime +30 -delete
# 2日以上前のセッションディレクトリを削除（当日分は並列実行中の他インスタンスが使うため残す）
find /tmp -maxdepth 1 -name "validity_session_*" -type d -mtime +1 -exec rm -rf {} + 2>/dev/null || true