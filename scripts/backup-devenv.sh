#!/usr/bin/env bash
# 開発環境のバックアップスクリプト
# gitignore対象のスクリプト群・systemd設定・ctフック・共通タイマー claude-timer をS3に日次保存する
#
# 使い方:
#   ./scripts/backup-devenv.sh          # 通常バックアップ
#   ./scripts/backup-devenv.sh --restore YYYY-MM-DD  # 指定日のバックアップから復元
set -euo pipefail

AWS="/home/yuzuki/local/bin/aws"
BUCKET="aws-quiz-devenv-backup-202606"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TODAY=$(date +%Y-%m-%d)
ARCHIVE="/tmp/devenv_backup_${TODAY}.tar.gz"

# ────────────────────────────────────────────
# 復元モード
# ────────────────────────────────────────────
if [[ "${1:-}" == "--restore" ]]; then
  RESTORE_DATE="${2:?--restore requires YYYY-MM-DD}"
  S3_KEY="backups/${RESTORE_DATE}/devenv_backup_${RESTORE_DATE}.tar.gz"
  RESTORE_TMP="/tmp/devenv_restore_${RESTORE_DATE}"

  echo "[backup] 復元開始: s3://${BUCKET}/${S3_KEY}"
  mkdir -p "$RESTORE_TMP"
  "$AWS" s3 cp "s3://${BUCKET}/${S3_KEY}" "${RESTORE_TMP}/archive.tar.gz" \
    || { echo "❌ バックアップが見つかりません: ${S3_KEY}"; exit 1; }

  echo "[backup] 展開中..."
  tar xzf "${RESTORE_TMP}/archive.tar.gz" -C "$RESTORE_TMP"

  echo "[backup] ファイルを復元中..."
  # prompts/ を復元（既存ファイルは上書き）
  if [ -d "${RESTORE_TMP}/prompts" ]; then
    rsync -av --ignore-existing "${RESTORE_TMP}/prompts/" "${REPO_DIR}/prompts/"
    echo "  ✓ prompts/ 復元完了"
  fi
  # systemd ユニット復元
  if [ -d "${RESTORE_TMP}/systemd" ]; then
    rsync -av --ignore-existing "${RESTORE_TMP}/systemd/" "${HOME}/.config/systemd/user/"
    systemctl --user daemon-reload
    echo "  ✓ systemd 復元完了"
  fi
  # 共通タイマー claude-timer（本体=独立git / 設定・時計・フック・使用量ログ）を復元し、タイマーを仕込み直す
  if [ -d "${RESTORE_TMP}/claude-timer/share" ]; then
    mkdir -p "${HOME}/.local/share/claude-timer" "${HOME}/.config/claude-timer"
    rsync -a --ignore-existing "${RESTORE_TMP}/claude-timer/share/" "${HOME}/.local/share/claude-timer/"
    rsync -a --ignore-existing "${RESTORE_TMP}/claude-timer/config/" "${HOME}/.config/claude-timer/"
    [ -e "${HOME}/.config/claude-timer/mail.conf" ] || ln -s "${HOME}/.mugenknock_mail.conf" "${HOME}/.config/claude-timer/mail.conf"
    bash "${HOME}/.local/share/claude-timer/install.sh"
    echo "  ✓ claude-timer 復元完了"
  fi
  # 実行権限を再付与
  find "${REPO_DIR}/prompts" -name "*.sh" -exec chmod +x {} \;

  rm -rf "$RESTORE_TMP"
  echo "[backup] 復元完了 (${RESTORE_DATE})"
  exit 0
fi

# ────────────────────────────────────────────
# バックアップモード
# ────────────────────────────────────────────
echo "[backup] 開始: ${TODAY}"

STAGING=$(mktemp -d /tmp/devenv_staging_XXXX)
trap 'rm -rf "$STAGING" "$ARCHIVE"' EXIT

# ── 1. prompts/ （ログ・一時ファイルを除く）
mkdir -p "${STAGING}/prompts"
rsync -a \
  --exclude='logs/' \
  --exclude='tmp-scripts/' \
  --exclude='tmp-texts/' \
  --exclude='*.log' \
  --exclude='.claude_rate_limit_reset' \
  --exclude='.claude/projects/' \
  "${REPO_DIR}/prompts/" "${STAGING}/prompts/"
echo "  ✓ prompts/ ($(find ${STAGING}/prompts -type f | wc -l)ファイル)"

# ── 2. systemd ユニットファイル（claude-cycle系のみ）
mkdir -p "${STAGING}/systemd"
cp ~/.config/systemd/user/claude-cycle*.service \
   ~/.config/systemd/user/claude-cycle*.timer \
   "${STAGING}/systemd/" 2>/dev/null || true
echo "  ✓ systemd ($(ls ${STAGING}/systemd | wc -l)ファイル)"

# ── 3. 共通タイマー claude-timer（プロジェクト外。本体は独立git・リモートなしなのでここで保全する）
#    mail.conf は SMTP 認証情報(~/.mugenknock_mail.conf)へのリンクなので含めない。
#    systemd ユニットは install.sh / claude-timer sync が作り直すので含めない。
if [ -d "${HOME}/.local/share/claude-timer" ]; then
  mkdir -p "${STAGING}/claude-timer/share" "${STAGING}/claude-timer/config"
  rsync -a "${HOME}/.local/share/claude-timer/" "${STAGING}/claude-timer/share/"
  rsync -a --exclude='mail.conf' "${HOME}/.config/claude-timer/" "${STAGING}/claude-timer/config/"
  echo "  ✓ claude-timer ($(find ${STAGING}/claude-timer -type f | wc -l)ファイル)"
fi

# ── 4. バックアップメタ情報
cat > "${STAGING}/backup-info.txt" << INFO_EOF
date: ${TODAY}
hostname: $(hostname)
user: $(whoami)
repo: ${REPO_DIR}
created_at: $(date -Iseconds)

## 復元方法
bash ${REPO_DIR}/scripts/backup-devenv.sh --restore ${TODAY}
INFO_EOF

# ── 5. tar.gz 作成 & S3 アップロード
tar czf "$ARCHIVE" -C "$STAGING" .
SIZE=$(du -sh "$ARCHIVE" | cut -f1)

S3_KEY="backups/${TODAY}/devenv_backup_${TODAY}.tar.gz"
"$AWS" s3 cp "$ARCHIVE" "s3://${BUCKET}/${S3_KEY}" \
  --metadata "date=${TODAY},size=${SIZE}"

echo "[backup] 完了: s3://${BUCKET}/${S3_KEY} (${SIZE})"

# ── 6. 直近のバックアップ一覧を表示
echo ""
echo "[backup] 保存済みバックアップ一覧:"
"$AWS" s3 ls "s3://${BUCKET}/backups/" | awk '{print "  " $0}'
