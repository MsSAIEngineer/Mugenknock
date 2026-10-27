#!/bin/bash
# ct — mugenknock スケジュール管理コマンド
#
# 構成(2026-10〜): 5時間ごとのピンはユーザー共通のタイマー claude-timer
#   (~/.local/share/claude-timer。どのプロジェクトにも属さない)が回す。mugenknock は
#   ~/.config/claude-timer/hooks.d/mugenknock.conf にフック(ピンのN分前の検証・生成)を登録しているだけ。
#   ct のピン関連の操作(set/resume/cancel/sync/run/log)は claude-timer に委ねる。
#
#   ・ピンは常時稼働(全プロジェクト共通)。完全停止は ct cancel(= claude-timer cancel)。
#   ・ct on/off は mugenknock のフックだけを切替(hooks_enabled フラグ。conf の require= が見る)。
#
# usage: ct [command]
#   (なし)        状況表示
#   on / off     mugenknock のフック(検証・生成)の有効/無効 (ピンは常時)
#   set HH:MM    次回ピン時刻を HH:MM に変更 (以降は/usage回復時刻で自動追従)
#   resume       ピン再開 (次回=now+5h。ct cancel からの復帰)
#   cancel       完全停止 (ピンもフックも止める)
#   sync         時計に合わせてローカルタイマーを再同期
#   skip         次回の mugenknock のフックを今回だけスキップ
#   run          今すぐローカルピンを実行
#   log [-f|-n|-d DATE]   履歴/ログ表示
#   -l 最終実行  -n 次回予定  -h ヘルプ

set -uo pipefail

REPO=/home/yuzuki/aws-quiz-app
PROJECT=mugenknock
UNIT_DIR="$HOME/.config/systemd/user"
CFG="$HOME/.config/mugenknock"
HOOKS_FLAG="$CFG/hooks_enabled"
CT="$HOME/.local/bin/claude-timer"
CT_DISABLED_FLAG="$HOME/.config/claude-timer/disabled"
SELF="$REPO/scripts/ct.sh"
MODE_RESET_ONCALENDAR="Sat *-*-* 03:00:00"

mkdir -p "$CFG"
# フック設定の共有ライブラリ(hooks.conf の読み書き)
MK_REPO="$REPO"
source "$REPO/scripts/mk-hooks-lib.sh"
_hooks_on()  { [ -f "$HOOKS_FLAG" ]; }
_disabled()  { [ -f "$CT_DISABLED_FLAG" ]; }
_get_next()  { "$CT" next 2>/dev/null | tr -d '\n'; }
_sync()      { "$CT" sync 2>&1 | sed 's/^/  /'; }
[ -x "$CT" ] || { echo "❌ claude-timer がありません: $CT (~/.local/share/claude-timer/install.sh で設置)" >&2; exit 1; }

# ── 週次リセットタイマー: 土曜03:00に ct off(フックのみ) ──
_install_mode_reset_timer() {
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/${PROJECT}-mode-reset.service" << EOF
[Unit]
Description=mugenknock weekly reset to hooks-off (ct off)

[Service]
Type=oneshot
ExecStart=/bin/bash -lc '${SELF} off'
EOF
  cat > "$UNIT_DIR/${PROJECT}-mode-reset.timer" << EOF
[Unit]
Description=mugenknock weekly hooks-off timer (${MODE_RESET_ONCALENDAR})

[Timer]
OnCalendar=${MODE_RESET_ONCALENDAR}
Persistent=true

[Install]
WantedBy=timers.target
EOF
  systemctl --user daemon-reload 2>/dev/null || true
  systemctl --user enable --now "${PROJECT}-mode-reset.timer" >/dev/null 2>&1 || true
  loginctl enable-linger "$USER" 2>/dev/null || true
}

# ── 状況表示 ──
show_status() {
  "$CT" status | sed -n '1,/^── フック/p' | sed '$d'

  echo "── mugenknock のフック (ct on/off で切替 / ct hooks で編集) ──"
  if _hooks_on; then
    echo "  hooks on (有効)"
    local n=0
    while IFS="$(printf '\t')" read -r _m _s _l; do
      [ -n "$_m" ] || continue
      n=$((n+1))
      printf "    %d. ピン%s分前  %s\n" "$n" "$_m" "${_l:-$_s}"
    done < <(hooks_list)
    [ "$n" -eq 0 ] && echo "    (hooks.d/mugenknock.conf に有効な行なし)"
    local reset_next
    reset_next=$(systemctl --user list-timers "${PROJECT}-mode-reset.timer" --all --no-legend 2>/dev/null | awk '{print $1" "$2" "$3}')
    [ -n "$reset_next" ] && printf "  reset %s に自動 off(フックのみ)\n" "$reset_next"
  else
    echo "  hooks off (無効 — ct on で有効化)"
  fi

  echo "── systemd タイマー ──"
  systemctl --user list-timers \
    'claude-timer-ping.timer' 'claude-timer-hook-mugenknock-*.timer' \
    'mugenknock-canary.timer' \
    --all --no-legend 2>/dev/null \
    | awk '{printf "  %-40s next %s %s\n", $NF, $2, $3}' \
    || echo "  (タイマー未設定 — ct sync で作成)"
}

# ── ct set / resume / cancel は claude-timer に委ねる(ピンは全プロジェクト共通) ──
set_schedule()    { "$CT" set "$1"; }
resume_schedule() { "$CT" resume; }
cancel_schedule() {
  echo "⚠️ ピンは全プロジェクト共通です。止めると他のプロジェクトのフックも止まります。"
  "$CT" cancel
}

# ── ピン稼働を保証(停止中なら復帰) ──
_ensure_ping_enabled() {
  if _disabled; then
    rm -f "$CT_DISABLED_FLAG"
    echo "  ピンを再開(停止解除)"
  fi
}

# ── ct on (フック有効) ──
mode_on() {
  echo "▶ フック ON — mugenknock のフック(hooks.d/mugenknock.conf の検証・生成)を有効化します"
  touch "$HOOKS_FLAG"
  _ensure_ping_enabled
  _install_mode_reset_timer
  echo "タイマーを同期中(フック有効で再アーム)..."; _sync
  local next_reset
  next_reset=$(systemctl --user list-timers "${PROJECT}-mode-reset.timer" --all --no-legend 2>/dev/null | awk '{print $1" "$2" "$3}')
  echo "  自動リセット: ${next_reset:-土曜 03:00} に ct off(フックのみ) へ戻します"
}

# ── ct off (フック無効) ──
mode_off() {
  echo "⏸ フック OFF — mugenknock のフックを停止します。ピン(共通)は常時稼働のまま。"
  rm -f "$HOOKS_FLAG"
  echo "タイマーを同期中(mugenknock のフックを外す)..."; _sync
}

# ── ct run (今すぐピン実行) ──
run_now() { "$CT" run; }

# ── ct skip (次回の mugenknock のフックを今回だけスキップ) ──
skip_hooks() { "$CT" skip mugenknock; }

# ── ct hooks [list|add|rm] (フックの設定) ──
hooks_cmd() {
  local sub="${1:-list}"; shift || true
  case "$sub" in
    list|"")
      echo "── フック設定 (~/.config/claude-timer/hooks.d/mugenknock.conf) ──"
      echo "  実行はピンの指定分前。ct on のとき有効。"
      local n=0 clk; clk=$(_get_next)
      printf "  %-3s %-6s %-28s %s\n" "#" "分前" "スクリプト" "ラベル / 次回発火"
      while IFS="$(printf '\t')" read -r m s l; do
        [ -n "$m" ] || continue
        n=$((n+1))
        local when=""
        if [ -n "$clk" ]; then
          when=$(python3 -c "from datetime import datetime,timedelta; print((datetime.strptime('$clk','%Y-%m-%dT%H:%M:%S')-timedelta(minutes=$m)).strftime('%H:%M'))" 2>/dev/null)
        fi
        printf "  %-3s %-6s %-28s %s\n" "$n" "$m" "$(basename "$s")" "${l:-}${when:+  (次回 $when)}"
      done < <(hooks_list)
      [ "$n" -eq 0 ] && echo "  (有効な行なし)"
      echo "  操作: ct hooks add <分前> <スクリプト> [ラベル...] / ct hooks rm <#>"
      ;;
    add)
      local minb="${1:-}" script="${2:-}"; shift 2 2>/dev/null || true
      local label="$*"
      if ! [[ "$minb" =~ ^[0-9]+$ ]] || [ -z "$script" ]; then
        echo "❌ 使い方: ct hooks add <分前(正整数)> <スクリプト> [ラベル...]"; return 1
      fi
      local abs; abs=$(hooks_resolve "$script")
      [ -f "$abs" ] || echo "⚠️ 警告: スクリプトが見つかりません: $abs (登録は続行)"
      hooks_seed_defaults
      printf -- '-%s|%s|%s\n' "$minb" "$abs" "$label" >> "$HOOKS_CONF"
      echo "✓ 追加: ピン${minb}分前  ${label:-$script}"
      echo "同期中..."; _sync
      ;;
    rm|del|remove)
      local target="${1:-}"
      if ! [[ "$target" =~ ^[0-9]+$ ]]; then echo "❌ 使い方: ct hooks rm <#>  (# は ct hooks list の番号)"; return 1; fi
      # 先に全行を配列へ読み切る(同一ファイルの読みながら書き=競合を避ける)
      local _lines; mapfile -t _lines < <(hooks_list)
      local total=${#_lines[@]}
      if [ "$target" -lt 1 ] || [ "$target" -gt "$total" ]; then
        echo "❌ #${target} は存在しません (ct hooks list で確認)"; return 1
      fi
      local removed; removed=$(printf '%s' "${_lines[$((target-1))]}" | cut -f3)
      local i=0
      { for ln in "${_lines[@]}"; do
          i=$((i+1))
          [ "$i" -eq "$target" ] && continue
          printf '%s\n' "$ln"
        done; } | hooks_rewrite
      echo "✓ 削除: #${target} ${removed}"
      echo "同期中..."; _sync
      ;;
    edit)
      hooks_seed_defaults; "${EDITOR:-vi}" "$HOOKS_CONF"; echo "同期中..."; _sync ;;
    *)
      echo "ct hooks: 不明なサブコマンド: $sub (list|add|rm|edit)"; return 1 ;;
  esac
}

# ── ct log ──
show_log() {
  local mode="${1:-history}" date_arg="${2:-}"
  case "$mode" in
    history)
      "$CT" log 30 ;;
    night)
      [ -s "$REPO/prompts/.night_history" ] && tail -n 30 "$REPO/prompts/.night_history" || echo "夜間スクリプト履歴なし" ;;
    full)
      "$CT" log -f 80 ;;
    date)
      local f="$REPO/prompts/logs/run_${date_arg}.log"
      if [ -s "$f" ]; then echo "=== run_${date_arg}.log ==="; cat "$f"
      else echo "ログなし: run_${date_arg}.log"; fi ;;
  esac
}

# ── 引数処理 ──
CMD="status"; LOG_DATE=""; SET_TIME=""; HOOKS_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    set)    CMD="set"; SET_TIME="${2:?ct: set には HH:MM が必要です}"; shift 2 ;;
    on)     CMD="on";     shift ;;
    off)    CMD="off";    shift ;;
    resume) CMD="resume"; shift ;;
    cancel) CMD="cancel"; shift ;;
    sync)   CMD="sync";   shift ;;
    skip)   CMD="skip";   shift ;;
    run)    CMD="run";    shift ;;
    hooks)  CMD="hooks";  shift; HOOKS_ARGS=("$@"); break ;;
    log)
      CMD="log"; shift
      case "${1:-}" in
        -f) CMD="log-full";  shift ;;
        -n) CMD="log-night"; shift ;;
        -d) CMD="log-date"; LOG_DATE="${2:?-d には YYYYMMDD が必要です}"; shift 2 ;;
      esac ;;
    -l) tr 'T' ' ' < "$HOME/.config/claude-timer/last_ping" 2>/dev/null; echo; exit 0 ;;
    -n) _get_next | tr 'T' ' '; echo; exit 0 ;;
    -h|--help) cat << 'EOF'
usage: ct [command]  (ピンは共通タイマー claude-timer。ct はその mugenknock 用の窓口)
  (なし)        状況表示
  on           フック有効 (検証・生成を実行。ピンは常時稼働)
               ※ 土曜03:00に自動で off(フックのみ) へ戻る
  off          フック無効 (検証・生成を停止。ピンは常時稼働)
  hooks        フック設定 (list|add <分前> <script> [label]|rm <#>|edit)
  set HH:MM    次回ピン時刻を変更 (以降は/usage回復時刻で追従)
  resume       ピン再開 (次回=now+5h)
  cancel       完全停止 (ピンもフックも止める。※全プロジェクト共通のピンが止まる)
  sync         タイマーを時計に再同期 (= claude-timer sync)
  skip         次回の mugenknock のフックを今回だけスキップ
  run          今すぐピンを実行 (= claude-timer run)
  log [-f|-n|-d DATE]   ピン履歴/ログ (-f=journal -n=夜間 -d=日付)
  -l 最終実行  -n 次回予定  -h ヘルプ
EOF
      exit 0 ;;
    *) echo "ct: 不明なコマンド: $1" >&2; exit 1 ;;
  esac
done

case "$CMD" in
  status)    show_status ;;
  set)       set_schedule "$SET_TIME" ;;
  on)        mode_on ;;
  off)       mode_off ;;
  resume)    resume_schedule ;;
  cancel)    cancel_schedule ;;
  sync)      _sync ;;
  skip)      skip_hooks ;;
  run)       run_now ;;
  hooks)     hooks_cmd "${HOOKS_ARGS[@]}" ;;
  log)       show_log "history" ;;
  log-full)  show_log "full" ;;
  log-night) show_log "night" ;;
  log-date)  show_log "date" "$LOG_DATE" ;;
esac
