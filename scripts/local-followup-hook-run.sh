#!/bin/bash
# 「もっと知りたい」質問の付与フック（claude-timer・ピン25分前。specs/009-follow-up-questions）
# 使い切りモード(ct on)のときだけ、検証(30分前)・生成(20分前)と並走し、トークン回復の数分前で止める。
# 1周で1問1つ・最大3つ。質問の少ない問題から付ける。軽いモデル(Haiku)。手動ではエイリアス afq。
set -uo pipefail
export TZ=Asia/Tokyo
export PATH="/usr/local/bin:/usr/bin:/bin:$HOME/local/bin:$PATH"

REPO=/home/yuzuki/aws-quiz-app
log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }

[ -f "$HOME/.config/mugenknock/hooks_enabled" ] || { log "フック無効(ct off) のためスキップ"; exit 0; }

# shellcheck source=mk-hook-deadline.sh
source "$REPO/scripts/mk-hook-deadline.sh"
if ! hook_deadline 25; then
  log "ピン直前または超過のためスキップ (締切まで${HOOK_REMAIN_MIN:-?}分)"
  exit 0
fi
log "質問の付与 (最大1000問 / deadline=$HOOK_DEADLINE / 締切まで${HOOK_REMAIN_MIN}分)..."
cd "$REPO"
# 先に既存の whatif 質問が単体で通じるかを点検する（2026-10-31〜。点検済みには rev=2 が付き、残りが無くなればすぐ終わる）。
# 1回300問までにして、付与の時間を残す。
python3 prompts/night-prompts/scripts/11-add-follow-up-questions.py --recheck -n 300 -c 10 -D "$HOOK_DEADLINE"
python3 prompts/night-prompts/scripts/11-add-follow-up-questions.py -n 1000 -c 10 -D "$HOOK_DEADLINE"
EC=$?
log "完了 (exit $EC)"
exit $EC
