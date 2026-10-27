#!/bin/bash
# フック共通: 「次のピン(=トークン回復)の MARGIN_MIN 分前」を締切として求める。
#
# source して hook_deadline <フォールバックの先行分> を呼ぶと、次の変数が入る:
#   HOOK_DEADLINE        締切の HH:MM（01/02 の -D にそのまま渡す）
#   HOOK_DEADLINE_EPOCH  締切の epoch 秒（ループの打ち切り判定用）
#   HOOK_REMAIN_MIN      締切までの残り分
# 戻り値: 0=実行してよい / 1=ピン直前または超過のためスキップすべき
#
# 以前は各フックが「自分はピンの30分前（15分前）に発動する」と仮定して締切を固定値で計算していた。
# hooks.d/mugenknock.conf で発動時刻を変えても締切が追従しないので、ピン時刻の唯一の正
# （共通タイマー claude-timer の next_ping。フックには CLAUDE_TIMER_NEXT_PING_FILE で渡される）から求める。
# next_ping が読めないときだけ、フォールバック（発動からの先行分）で代用する。
HOOK_MARGIN_MIN="${HOOK_MARGIN_MIN:-3}"
HOOK_NEXT_PING_FILE="${HOOK_NEXT_PING_FILE:-${CLAUDE_TIMER_NEXT_PING_FILE:-$HOME/.config/claude-timer/next_ping}}"

hook_deadline() {
  local fallback_lead="$1" out
  out=$(python3 - "$HOOK_NEXT_PING_FILE" "$HOOK_MARGIN_MIN" "$fallback_lead" << 'PYEOF'
import sys
from datetime import datetime, timedelta
path, margin, lead = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
now = datetime.now()
try:
    ping = datetime.fromisoformat(open(path).read().strip())
    src = 'next_ping'
except Exception:
    ping = now + timedelta(minutes=lead)
    src = 'fallback'
dl = ping - timedelta(minutes=margin)
remain = int((dl - now).total_seconds() // 60)
# 上限60分: next_ping が遠い未来を指していても、フック1回で1時間以上は走らせない
remain = min(remain, 60)
dl = now + timedelta(minutes=remain) if remain == 60 else dl
print(dl.strftime('%H:%M'), int(dl.timestamp()), remain, src)
PYEOF
  ) || return 1
  read -r HOOK_DEADLINE HOOK_DEADLINE_EPOCH HOOK_REMAIN_MIN HOOK_DEADLINE_SRC <<< "$out"
  [ "${HOOK_REMAIN_MIN:-0}" -ge 2 ]
}
