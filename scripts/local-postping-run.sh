#!/bin/bash
# ピンの10分後に共通タイマー claude-timer のフック(+10)として発火する。夜間サイクルなら夜間バッチを実行
# (当日未実行のときのみ・二重実行防止)。タイマーの仕込み直しは claude-timer 側が行うので、ここではしない。
#
# 夜間サイクル = 基準のピン(CLAUDE_TIMER_ANCHOR。claude-timer が渡す)が 0〜4時台で、
#               その日の夜間バッチがまだ(prompts/.last_run_date が別の日)。
# ※ 2026-10 時点ではトークン節約のため hooks.d/mugenknock.conf で登録をコメントアウトしている。
set -uo pipefail
export TZ=Asia/Tokyo
export PATH="/usr/local/bin:/usr/bin:/bin:$HOME/local/bin:$PATH"

REPO=/home/yuzuki/aws-quiz-app
AWS=/home/yuzuki/local/bin/aws
ACCT=$("$AWS" sts get-caller-identity --query Account --output text 2>/dev/null || echo "")
S3="mugenknock-fargate-state-${ACCT}"
HOOKS_FLAG="$HOME/.config/mugenknock/hooks_enabled"   # 無ければフック無効(夜間バッチしない)

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }

[ -f "$HOOKS_FLAG" ] || { log "フック無効(ct off) → 夜間バッチはスキップ"; exit 0; }

LOCAL_LRD=$(tr -d '\n' < "$REPO/prompts/.last_run_date" 2>/dev/null || echo "")
RUN_NIGHT=$(ANCHOR="${CLAUDE_TIMER_ANCHOR:-}" LRD="$LOCAL_LRD" python3 -c "
import os
from datetime import datetime
a = os.environ['ANCHOR'].strip()
try:
    d = datetime.strptime(a, '%Y-%m-%dT%H:%M:%S')
except ValueError:
    print(0); raise SystemExit
print(1 if d.hour < 5 and os.environ['LRD'].strip() != d.strftime('%Y-%m-%d') else 0)
")
if [ "$RUN_NIGHT" != "1" ]; then
  log "夜間サイクルでない(基準のピン=${CLAUDE_TIMER_ANCHOR:-不明}) → スキップ"
  exit 0
fi

TODAY=$(date +%Y-%m-%d)
LRD=$("$AWS" s3 cp "s3://$S3/meta/.last_run_date" - --quiet 2>/dev/null | tr -d '\n' || echo "")
if [ "$LRD" = "$TODAY" ]; then
  log "夜間バッチは本日実行済み($LRD) → スキップ"
  exit 0
fi
log "夜間サイクル → 夜間バッチ実行"
bash "$REPO/scripts/local-night-run.sh"
