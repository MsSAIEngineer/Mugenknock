#!/bin/bash
# ローカル夜間バッチ実行(systemd timerから呼ばれる)
# Fargateはピンのみ。夜間バッチ本体(生成/検証/監査/レポート/日めくり)はローカルで実行する。
# 状態・生成指示は手元（git）が唯一の正。S3 にはログと実行メタだけを写す（2026-10-27〜。以前は Fargate と共有するため S3 と双方向同期していた）。
set -uo pipefail
export TZ=Asia/Tokyo
export PATH="/usr/local/bin:/usr/bin:/bin:$HOME/local/bin:$PATH"

REPO=/home/yuzuki/aws-quiz-app
AWS=/home/yuzuki/local/bin/aws
ACCT=$("$AWS" sts get-caller-identity --query Account --output text 2>/dev/null)
S3="mugenknock-fargate-state-${ACCT}"
SC="$REPO/prompts/night-prompts/scripts"

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }

mkdir -p "$SC/state" "$SC/instructions" "$SC/logs" "$REPO/prompts/logs"

# ── pull: 実行メタをS3から ──
for f in .last_run .claude_history .night_history; do
  "$AWS" s3 cp "s3://$S3/meta/$f" "$REPO/prompts/$f" --quiet 2>/dev/null || true
done
# .last_run_date は二重実行防止の要。S3で盲目上書きせずローカル/S3の新しい方を残す
# (他プロセスが直前にローカルへ書いた"本日"がS3の古い値で消されるのを防ぐ)
_S3_LRD=$("$AWS" s3 cp "s3://$S3/meta/.last_run_date" - --quiet 2>/dev/null | tr -d '\n')
_LOCAL_LRD=$(cat "$REPO/prompts/.last_run_date" 2>/dev/null || echo "")
if [ -n "$_S3_LRD" ] && { [ -z "$_LOCAL_LRD" ] || [ "$_S3_LRD" \> "$_LOCAL_LRD" ]; }; then
  echo "$_S3_LRD" > "$REPO/prompts/.last_run_date"
fi

# ── 実行: ping抑止・夜間強制・自己スケジュール抑止 ──
log "夜間バッチ実行 (SKIP_PING/FORCE_NIGHT)..."
cd "$REPO"
FARGATE_MODE=1 SKIP_PING=1 FORCE_NIGHT=1 bash prompts/run-prompts.sh --run
EC=$?
log "夜間バッチ完了 (exit $EC)"

# ── push: ログ・実行メタをS3へ ──
"$AWS" s3 sync "$SC/logs/"         "s3://$S3/night-logs/"   --quiet 2>/dev/null || true
"$AWS" s3 sync "$REPO/prompts/logs/" "s3://$S3/run-logs/"   --quiet 2>/dev/null || true
for f in .last_run .last_run_date .claude_history .night_history; do
  [ -f "$REPO/prompts/$f" ] && "$AWS" s3 cp "$REPO/prompts/$f" "s3://$S3/meta/$f" --quiet 2>/dev/null || true
done
bash "$REPO/scripts/commit-night-assets.sh" || true
exit $EC
