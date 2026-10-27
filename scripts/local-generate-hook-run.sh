#!/bin/bash
# 生成フック(systemd timerから呼ばれる)
# 各ピンサイクルの20分前に問題生成(01-generate-questions --hard)を累計1000問まで走らせ、
# トークン回復(=次のピン)の数分前で止める。ログだけ S3 に写す。
# ※ 30分前フック(local-validity-hook-run.sh)が妥当性チェック(02-check-validity)を担当する。
#
# 01 は1回の実行で「需要比が最大の資格」を選び、1ドメイン GEN_DOMAIN_CAP(既定20)問までを作って終わる
# （同じ論点の問題が1ドメインに集中するのを避けるため）。1回では枠を使い切れないので、
# 締切か累計1000問に達するまで繰り返す。繰り返すたびに資格は選び直され（需要比は取込で下がる）、
# プロンプトに渡す既出一覧も作り直される。
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
# -D は「判定時に走行中のチャンクは完走」する仕様なので、そのはみ出し(1チャンク≒1分)も
# 回復前に収まるよう余裕を持たせ、トークン回復後に生成が継続しないようにする。
# shellcheck source=mk-hook-deadline.sh
source "$REPO/scripts/mk-hook-deadline.sh"
if ! hook_deadline 20; then
  log "ピン直前または超過のためスキップ (締切まで${HOOK_REMAIN_MIN:-?}分)"
  exit 0
fi
TARGET=1000
log "問題生成実行 (--hard / 累計${TARGET}問まで / deadline=$HOOK_DEADLINE / 回復の${HOOK_MARGIN_MIN}分前で停止 / 締切まで${HOOK_REMAIN_MIN}分 / 基準=$HOOK_DEADLINE_SRC)..."
cd "$REPO"
TOTAL=0; ROUND=0; EC=0
while [ "$TOTAL" -lt "$TARGET" ] && [ "$(date +%s)" -lt "$HOOK_DEADLINE_EPOCH" ]; do
  ROUND=$((ROUND + 1))
  OUT=$(mktemp /tmp/hook_gen_XXXX.log)
  # -n は「1ドメインあたりの予算」。上限(GEN_DOMAIN_CAP)が先に効くので、大きく取って予算で止まらないようにする
  FARGATE_MODE=1 bash prompts/night-prompts/scripts/01-generate-questions.sh -H -n "$TARGET" -D "$HOOK_DEADLINE" 2>&1 | tee "$OUT"
  EC=${PIPESTATUS[0]}
  N=$(grep -oE '^合計インポート: [0-9]+' "$OUT" | tail -1 | grep -oE '[0-9]+$')
  rm -f "$OUT"
  TOTAL=$((TOTAL + ${N:-0}))
  log "生成 ${ROUND}回目: ${N:-0}問取込 (累計${TOTAL}/${TARGET}問, exit $EC)"
  # 異常終了、または1問も取り込めなかった（レート制限・締切など）なら止める。
  # ※ 01 の終了コードはログ出力の tee に隠れて常に 0 になるため、実際に止まるのは主に「0問」の判定
  [ "$EC" -ne 0 ] && break
  [ "${N:-0}" -eq 0 ] && break
done
log "完了 (累計${TOTAL}問 / ${ROUND}回 / exit $EC)"

# push（ログだけ）
"$AWS" s3 sync "$SC/logs/"         "s3://$S3/night-logs/"   --quiet 2>/dev/null || true
bash "$REPO/scripts/commit-night-assets.sh" || true
exit $EC
