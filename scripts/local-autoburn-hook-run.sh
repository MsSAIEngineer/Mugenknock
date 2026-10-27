#!/bin/bash
# 週間上限の使い切りモード（ct on）を、残りの週間枠から自動で入れる。
# claude-timer のフック（ピン+3分）から呼ばれ、ピンのたびに次を判定する。
#
#   必要な量   = 週間使用率の残り R（%）
#   使える量   = 週リセットまでに残るピンの数 N × 1枠あたりの消費 C × 安全率 S
#   R >= N×C×S になったら ct on。「ここで入れないと使い切れないかも」の線。
#
# C は usage.log の実績（5時間枠を使い切ったとき週間が何%進むか。直近4週の回帰）。取れなければ 8.5。
# S は「使い切りモードの枠が満タンまで使われない分」の見込み（0.8）。小さいほど早く入る。
# いったん入れたら、土曜 03:00 の mugenknock-mode-reset（ct off）まで切らない。
# 自動を止めたいときは ~/.config/mugenknock/autoburn_disabled を作る。
set -uo pipefail
export TZ=Asia/Tokyo

CFG="$HOME/.config/mugenknock"
HOOKS_FLAG="$CFG/hooks_enabled"
DISABLED_FLAG="$CFG/autoburn_disabled"
USAGE_LOG="$HOME/.config/claude-timer/usage.log"
CT_NEXT_FILE="${CLAUDE_TIMER_NEXT_PING_FILE:-$HOME/.config/claude-timer/next_ping}"
SAFETY="${AUTOBURN_SAFETY:-0.8}"
FALLBACK_CYCLE_PCT=8.5
CYCLE_HOURS=5

log() { printf '[%s] [autoburn] %s\n' "$(date '+%F %T')" "$*"; }

[ -f "$DISABLED_FLAG" ] && { log "autoburn_disabled があるためスキップ"; exit 0; }
if [ -f "$HOOKS_FLAG" ]; then
  log "すでに ON（土曜 03:00 の mode-reset まで維持）"
  exit 0
fi

read -r DECISION DETAIL < <(USAGE_LOG="$USAGE_LOG" NEXT_FILE="$CT_NEXT_FILE" SAFETY="$SAFETY" FALLBACK="$FALLBACK_CYCLE_PCT" CYCLE_HOURS="$CYCLE_HOURS" python3 - << 'PY'
import json, os
from datetime import datetime, timedelta
F = '%Y-%m-%dT%H:%M:%S'
rows = []
try:
    for l in open(os.environ['USAGE_LOG']):
        l = l.strip()
        if l:
            rows.append(json.loads(l))
except OSError:
    pass
if not rows:
    print('skip', 'usage.log なし'); raise SystemExit
last = rows[-1]
now = datetime.now()
age_h = (now - datetime.strptime(last['ts'], F)).total_seconds() / 3600
if age_h > 8:
    print('skip', f"usage.log が古い({age_h:.1f}h前)"); raise SystemExit
week_pct = last['week_pct']
reset = datetime.strptime(last['week_reset'], F)
try:
    nxt = datetime.strptime(open(os.environ['NEXT_FILE']).read().strip(), F)
except Exception:
    nxt = now + timedelta(hours=float(os.environ['CYCLE_HOURS']))
cyc = timedelta(hours=float(os.environ['CYCLE_HOURS']))
# 週リセットまでにフックが効くピンの数（次回ピンを含む）
n = int((reset - nxt) / cyc) + 1 if nxt < reset else 0

# 1枠を使い切ったときの週間消費(%)。直近4週の隣り合う記録から、週間の増分合計 ÷ 枠使用率の合計。
cutoff = now - timedelta(days=28)
s = w = 0
for p, r in zip(rows, rows[1:]):
    if datetime.strptime(r['ts'], F) < cutoff or p['week_reset'][:10] != r['week_reset'][:10]:
        continue
    dw = r['week_pct'] - p['week_pct']
    if dw >= 0 and r['session_pct'] >= 30:
        s += r['session_pct']; w += dw
c = (w / (s / 100)) if s >= 1000 and w > 0 else float(os.environ['FALLBACK'])
safety = float(os.environ['SAFETY'])
usable = n * c * safety
remain = 100 - week_pct
detail = f"残り{remain}% / 使えるのは残り{n}枠×{c:.1f}%×{safety}={usable:.1f}% (reset {reset:%m/%d %H:%M})"
print('on' if remain >= usable and remain > 1 else 'wait', detail)
PY
)

case "$DECISION" in
  on)
    log "使い切りモードに切替: $DETAIL"
    "$HOME/aws-quiz-app/scripts/ct.sh" on
    ;;
  wait) log "まだ入れない: $DETAIL" ;;
  *)    log "スキップ: $DETAIL" ;;
esac
