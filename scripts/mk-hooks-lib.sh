#!/bin/bash
# フック設定の共有ロジック(source して使う)。ct が使う。
# mugenknock のフックは共通タイマー claude-timer に登録する。定義ファイル
# ~/.config/claude-timer/hooks.d/mugenknock.conf が唯一の正(ピンの実行・タイマーの仕込みは claude-timer 側)。
#   形式(1行1フック): 符号付き分|スクリプト(絶対パス)|ラベル
#     -N = 次回ピンのN分前 / +N = 直前のピンのN分後
#   workdir= / require= の行は claude-timer への指示(実行ディレクトリ / ct on のときだけ仕込む)。
# ct hooks が扱うのはピン前(-N)の行だけ。分前は正整数で受け渡す。
MK_CFG="${MK_CFG:-$HOME/.config/mugenknock}"
MK_REPO="${MK_REPO:-/home/yuzuki/aws-quiz-app}"
HOOKS_CONF="${HOOKS_CONF:-$HOME/.config/claude-timer/hooks.d/mugenknock.conf}"

_hooks_header() {
  cat << EOF
# mugenknock のフック(claude-timer)。ct hooks add/rm/edit でも編集できる。
# 形式: 符号付き分|スクリプト(絶対パス)|ラベル   -N=次回ピンのN分前 / +N=直前のピンのN分後
workdir=${MK_REPO}
require=${MK_CFG}/hooks_enabled
# 夜間バッチ(ピン+10分・夜間サイクルのみ)。トークン節約のため停止中。再開するときは次の行の # を外す。
# +10|${MK_REPO}/scripts/local-postping-run.sh|夜間バッチ(夜間サイクルのみ)
EOF
}

# 初回のデフォルト: 30分前=検証(最大1000問) / 20分前=生成(累計1000問まで)。どちらもピンの数分前で止まる
hooks_seed_defaults() {
  [ -f "$HOOKS_CONF" ] && return 0
  mkdir -p "$(dirname "$HOOKS_CONF")"
  {
    _hooks_header
    echo "-30|${MK_REPO}/scripts/local-validity-hook-run.sh|妥当性検証(02-check-validity・最大1000問)"
    echo "-20|${MK_REPO}/scripts/local-generate-hook-run.sh|問題生成(01-generate --hard・累計1000問まで)"
  } > "$HOOKS_CONF"
}

# ピン前の有効行を "分前<TAB>スクリプト<TAB>ラベル" で出力(分前の大きい順=実行が早い順)
hooks_list() {
  hooks_seed_defaults
  awk -F'|' '
    /^[[:space:]]*#/ {next} /^[[:space:]]*$/ {next}
    { m=$1; s=$2; l=$3;
      gsub(/^[ \t]+|[ \t]+$/,"",m); gsub(/^[ \t]+|[ \t]+$/,"",s); gsub(/^[ \t]+|[ \t]+$/,"",l);
      if (m ~ /^-[0-9]+$/ && s!="") printf "%s\t%s\t%s\n", substr(m,2), s, l }
  ' "$HOOKS_CONF" | sort -t"$(printf '\t')" -k1,1 -nr
}

# スクリプト名 → 絶対パス
hooks_resolve() {
  case "$1" in
    /*)   echo "$1" ;;
    */*)  echo "$MK_REPO/$1" ;;
    *)    echo "$MK_REPO/scripts/$1" ;;
  esac
}

# ピン後(+N)の有効行(コメントでないもの)をそのまま出す。書き直しで消さないため
_hooks_after_lines() {
  [ -f "$HOOKS_CONF" ] || return 0
  grep -E '^[[:space:]]*\+[0-9]+[[:space:]]*\|' "$HOOKS_CONF" || true
}

# 設定を正規形で書き直す(add/rm用)。stdin から "分前<TAB>script<TAB>label" 行(ピン前)を受ける
hooks_rewrite() {
  local after; after=$(_hooks_after_lines)
  mkdir -p "$(dirname "$HOOKS_CONF")"
  {
    _hooks_header
    [ -n "$after" ] && printf '%s\n' "$after"
    while IFS="$(printf '\t')" read -r m s l; do
      [ -n "$m" ] || continue
      echo "-${m}|$(hooks_resolve "$s")|${l}"
    done
  } > "$HOOKS_CONF.tmp" && mv "$HOOKS_CONF.tmp" "$HOOKS_CONF"
}
