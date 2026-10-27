#!/bin/bash
# サイト保守の夜間処理を、固定時刻ではなくトークン回復後（claude-timer のピン+10分のフック）に走らせる。
#   - 毎日分（mugenknock-nightly-noai.service）: その日まだなら実行。通常は夜間の最初のピン(0〜4時台)、
#     PC が止まっていて夜間ピンが無かった日は、起動後の最初のピンで実行する（補欠）。
#   - 週1回分（mugenknock-daily-services-weekly.service）: 前回から7日以上たっていれば、毎日分の後に実行。
# 中身（何をどの順で走らせるか）は各 .service に書いてある。ここは「いつ走らせるか」だけを決める。
# 実行済みの印は先に付ける（長引いている間に次のピンのフックが来ても二重に走らせない）。
# 失敗しても同じ日に再試行はしない（各ステップは || true で続行し、結果は日次レポートに出る）。
set -uo pipefail
export TZ=Asia/Tokyo

STATE_DIR="$HOME/.config/mugenknock"
DAILY_STAMP="$STATE_DIR/maintenance_daily_last"     # 中身: 最後に毎日分を実行した日 YYYY-MM-DD
WEEKLY_STAMP="$STATE_DIR/maintenance_weekly_last"   # 中身: 最後に週1回分を実行した日 YYYY-MM-DD
WEEKLY_INTERVAL_DAYS=7
mkdir -p "$STATE_DIR"

log() { printf '[%s] [maintenance-hook] %s\n' "$(date '+%F %T')" "$*"; }
log "起動 anchor=${CLAUDE_TIMER_ANCHOR:-不明}"

TODAY=$(date +%F)

if [ "$(cat "$DAILY_STAMP" 2>/dev/null)" = "$TODAY" ]; then
  log "毎日分は本日実行済み → スキップ"
  exit 0
fi
echo "$TODAY" > "$DAILY_STAMP"
log "毎日分を実行（mugenknock-nightly-noai）"
systemctl --user start mugenknock-nightly-noai.service || log "⚠️ 毎日分が失敗（journalctl --user -u mugenknock-nightly-noai）"

LAST_WEEKLY=$(cat "$WEEKLY_STAMP" 2>/dev/null || echo "")
DAYS=$(LAST="$LAST_WEEKLY" python3 -c "
import os, datetime
s = os.environ['LAST'].strip()
print((datetime.date.today() - datetime.date.fromisoformat(s)).days if s else 9999)")
if [ "$DAYS" -lt "$WEEKLY_INTERVAL_DAYS" ]; then
  log "週1回分は前回から${DAYS}日 → スキップ"
  exit 0
fi
echo "$TODAY" > "$WEEKLY_STAMP"
log "週1回分を実行（mugenknock-daily-services-weekly）"
systemctl --user start mugenknock-daily-services-weekly.service || log "⚠️ 週1回分が失敗（journalctl --user -u mugenknock-daily-services-weekly）"
