#!/bin/bash
# 検証フック(systemd timerから呼ばれる)
# 各ピンサイクルの30分前に妥当性チェック(02-check-validity)を最大1000問分で走らせ、
# トークン回復(=次のピン)の数分前で止める。生成フック(20分前)と並走する。
# claimed.json で重複処理は防がれるため同時実行可能。
# 実際に処理できる件数はトークンで決まる（1000問は「枠が尽きるまで止まらない」ための上限）。
set -uo pipefail
export TZ=Asia/Tokyo
export PATH="/usr/local/bin:/usr/bin:/bin:$HOME/local/bin:$PATH"

REPO=/home/yuzuki/aws-quiz-app
AWS=/home/yuzuki/local/bin/aws
ACCT=$("$AWS" sts get-caller-identity --query Account --output text 2>/dev/null)
S3="mugenknock-fargate-state-${ACCT}"
SC="$REPO/prompts/night-prompts/scripts"

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }

# フック無効(ct off)なら何もしない。タイマー未arm時の保険(stale発火対策)。
[ -f "$HOME/.config/mugenknock/hooks_enabled" ] || { log "フック無効(ct off) のためスキップ"; exit 0; }

mkdir -p "$SC/state" "$SC/instructions" "$SC/logs"

# pull

# deadline = 次のピン(=トークン回復)の MARGIN_MIN 分前。next_ping から求める（mk-hook-deadline.sh）。
# -D は「判定時に走行中のチャンクは完走」する仕様なので、そのはみ出し(1チャンク≒数十秒)も
# 回復前に収まるよう余裕を持たせ、トークン回復後に検証が継続しないようにする。
# shellcheck source=mk-hook-deadline.sh
source "$REPO/scripts/mk-hook-deadline.sh"
if ! hook_deadline 30; then
  log "ピン直前または超過のためスキップ (締切まで${HOOK_REMAIN_MIN:-?}分)"
  exit 0
fi
log "妥当性チェック実行 (最大1000問 / deadline=$HOOK_DEADLINE / 回復の${HOOK_MARGIN_MIN}分前で停止 / 締切まで${HOOK_REMAIN_MIN}分 / 基準=$HOOK_DEADLINE_SRC)..."
cd "$REPO"
FARGATE_MODE=1 bash prompts/night-prompts/scripts/02-check-validity.sh -n 1000 -D "$HOOK_DEADLINE"
EC=$?
log "完了 (exit $EC)"

# push（ログだけ）
"$AWS" s3 sync "$SC/logs/"         "s3://$S3/night-logs/"   --quiet 2>/dev/null || true
bash "$REPO/scripts/commit-night-assets.sh" || true
exit $EC
