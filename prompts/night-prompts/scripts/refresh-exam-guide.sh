#!/bin/bash
# AWS認定試験ガイド更新スクリプト（手動実行用）
# 公式資格ページをWebFetch経由で取得し、instructions/*.txt を最新情報に更新する
#
# Usage:
#   ./refresh-exam-guide.sh           # 全資格を更新
#   ./refresh-exam-guide.sh SAA       # SAA のみ更新
#   ./refresh-exam-guide.sh SAA CLF   # 複数指定
#   ./refresh-exam-guide.sh -h        # ヘルプ

set -uo pipefail

export PATH="/home/yuzuki/local/bin:$PATH"
unset ANTHROPIC_API_KEY

_find_claude() {
  [ -x /usr/local/bin/claude ] && { echo /usr/local/bin/claude; return; }
  local _cv; _cv=$(command -v claude 2>/dev/null)
  [ -n "$_cv" ] && [ -x "$_cv" ] && { echo "$_cv"; return; }
}
CLAUDE_CMD=$(_find_claude)
if [ -z "${CLAUDE_CMD:-}" ] || [ ! -x "${CLAUDE_CMD:-}" ]; then
  echo "❌ claude コマンドが見つかりません" >&2; exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTRUCTION_DIR="$(dirname "$SCRIPT_DIR")/scripts/instructions"
# ドメイン定義の単一マスタ（DynamoDB の domain インデックスの基準）
EXAM_DOMAINS_JSON="${EXAM_DOMAINS_JSON_PATH:-${SCRIPT_DIR}/../../../src/data/examDomains.json}"

# 全資格の公式URL定義
declare -A EXAM_URLS
EXAM_URLS[CLF]="https://aws.amazon.com/jp/certification/certified-cloud-practitioner/"
EXAM_URLS[AIF]="https://aws.amazon.com/jp/certification/certified-ai-practitioner/"
EXAM_URLS[SAA]="https://aws.amazon.com/jp/certification/certified-solutions-architect-associate/"
EXAM_URLS[DVA]="https://aws.amazon.com/jp/certification/certified-developer-associate/"
EXAM_URLS[SOA]="https://aws.amazon.com/jp/certification/certified-sysops-admin-associate/"
EXAM_URLS[DEA]="https://aws.amazon.com/jp/certification/certified-data-engineer-associate/"
# MLA は資格紹介ページが版の変化（C01→C02）を反映していなかったため、公式の試験ガイド本体を読む（specs/010）
EXAM_URLS[MLA]="https://docs.aws.amazon.com/aws-certification/latest/machine-learning-engineer-associate-02/machine-learning-engineer-associate-02.html"
EXAM_URLS[SAP]="https://aws.amazon.com/jp/certification/certified-solutions-architect-professional/"
EXAM_URLS[DOP]="https://aws.amazon.com/jp/certification/certified-devops-engineer-professional/"
EXAM_URLS[AIP]="https://aws.amazon.com/jp/certification/certified-generative-ai-developer-professional/"
EXAM_URLS[SCS]="https://aws.amazon.com/jp/certification/certified-security-specialty/"
EXAM_URLS[ANS]="https://aws.amazon.com/jp/certification/certified-advanced-networking-specialty/"

ALL_EXAMS=(CLF AIF SAA DVA SOA DEA MLA SAP DOP AIP SCS ANS)

show_help() {
  cat << 'EOF'
usage: refresh-exam-guide.sh [EXAM...] [-h]

  EXAM   更新する資格コード（CLF / SAA / AIP 等）。省略時は全資格を更新
  --max-age-days N  LAST_REFRESHED が N 日以内の資格はスキップ（定期実行の自己スロットル）
  --max-per-run N   1回の実行で更新する資格を古い順に N 件までに制限（複数日へ分散）
  -h     このヘルプを表示

挙動:
  公式資格ページを WebFetch で取得し、出題ドメイン・配点・タスク文を抽出して
  instructions/<EXAM>.txt の内容を更新します。
  # DOMAINS: 行と # LAST_REFRESHED: 行も最新値に書き換えます。
  ドメイン名は DynamoDB タグとして使用されるため、変更時は既存問題のタグも要確認。
EOF
}

MAX_AGE_DAYS=0   # >0 のとき: LAST_REFRESHED がこの日数以内の資格はスキップ（定期実行の自己スロットル用）
MAX_PER_RUN=0    # >0 のとき: この1回の実行で更新する資格を「最終更新が古い順」に上限件数まで絞る（複数日に分散）
TARGET_EXAMS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) show_help; exit 0 ;;
    --max-age-days) MAX_AGE_DAYS="${2:-0}"; shift 2 ;;
    --max-per-run) MAX_PER_RUN="${2:-0}"; shift 2 ;;
    *) TARGET_EXAMS+=("$1"); shift ;;
  esac
done
[ ${#TARGET_EXAMS[@]} -eq 0 ] && TARGET_EXAMS=("${ALL_EXAMS[@]}")

# 複数日分散: MAX_PER_RUN>0 のとき、更新対象を「最終更新が古い順」に MAX_PER_RUN 件へ絞る。
# 重いWebFetchが1晩に集中しないよう、12資格が同時に陳腐化しても数日かけてローテーション更新する。
# 更新した資格は LAST_REFRESHED が当日=最新になり列の最後尾へ回るため、自然に巡回する。
if [ "$MAX_PER_RUN" -gt 0 ]; then
  _now_epoch=$(date +%s)
  _scored=()   # "epoch<TAB>exam"（未更新/古いほど epoch が小さく先頭に来る）
  for _e in "${TARGET_EXAMS[@]}"; do
    _f="${INSTRUCTION_DIR}/${_e}.txt"
    [ -f "$_f" ] || continue
    _lr=$(grep "^# LAST_REFRESHED:" "$_f" | head -1 | sed 's/^# LAST_REFRESHED: *//')
    _le=$(date -d "${_lr:-1970-01-01}" +%s 2>/dev/null || echo 0)
    # MAX_AGE_DAYS 以内に更新済み（十分新しい）は今回の候補から除外
    if [ "$MAX_AGE_DAYS" -gt 0 ] && [ "$_le" -gt 0 ]; then
      _age=$(( (_now_epoch - _le) / 86400 ))
      [ "$_age" -lt "$MAX_AGE_DAYS" ] && continue
    fi
    _scored+=("${_le}	${_e}")
  done
  if [ ${#_scored[@]} -eq 0 ]; then
    TARGET_EXAMS=()
  else
    mapfile -t TARGET_EXAMS < <(printf '%s\n' "${_scored[@]}" | sort -n | head -n "$MAX_PER_RUN" | cut -f2)
  fi
  echo "分散更新: 古い順 最大${MAX_PER_RUN}件 → ${TARGET_EXAMS[*]:-（今回の対象なし）}"
fi

TODAY=$(date '+%Y-%m-%d')

if [ ${#TARGET_EXAMS[@]} -eq 0 ]; then
  echo "更新対象の資格がありません（すべて ${MAX_AGE_DAYS}日以内に更新済み）。終了します。"
  exit 0
fi

echo "=========================================="
echo "試験ガイド更新: $(date)"
echo "対象: ${TARGET_EXAMS[*]}"
echo "=========================================="

# 版の変化を先に確かめる（specs/010）。アプリが旧版のままの資格は、指示書を自動で書き換えない
# （配点・ドメイン名・画面に波及するので、spec を切って人が切り替える）。改訂の予告は知らせるだけ。
VERSION_REPORT=$(python3 "$SCRIPT_DIR/check-exam-versions.py" --quiet 2>&1)
[ -n "$VERSION_REPORT" ] && echo "$VERSION_REPORT"
OLD_EXAMS=" $(printf '%s\n' "$VERSION_REPORT" | sed -nE 's/^⚠ ([A-Z]{3}):.*/\1/p' | tr '\n' ' ') "

for exam in "${TARGET_EXAMS[@]}"; do
  if [[ "$OLD_EXAMS" == *" $exam "* ]]; then
    echo "⏭  $exam: アプリが旧版のまま（上の警告）→ 自動更新しない"
    continue
  fi
  url="${EXAM_URLS[$exam]:-}"
  if [ -z "$url" ]; then
    echo "⚠️  $exam: URL定義なし（スキップ）"
    continue
  fi

  inst_file="${INSTRUCTION_DIR}/${exam}.txt"
  if [ ! -f "$inst_file" ]; then
    echo "⚠️  $exam: $inst_file が存在しません（スキップ）"
    continue
  fi

  # 定期実行の自己スロットル: MAX_AGE_DAYS 以内に更新済みならスキップ（claude/WebFetch を呼ばない）
  if [ "$MAX_AGE_DAYS" -gt 0 ]; then
    last_ref=$(grep "^# LAST_REFRESHED:" "$inst_file" | head -1 | sed 's/^# LAST_REFRESHED: *//')
    if [ -n "$last_ref" ]; then
      last_epoch=$(date -d "$last_ref" +%s 2>/dev/null || echo 0)
      if [ "$last_epoch" -gt 0 ]; then
        age_days=$(( ( $(date +%s) - last_epoch ) / 86400 ))
        if [ "$age_days" -lt "$MAX_AGE_DAYS" ]; then
          echo "⏭  $exam: ${age_days}日前に更新済み（< ${MAX_AGE_DAYS}日）→ スキップ"
          continue
        fi
      fi
    fi
  fi

  echo ""
  echo "--- $exam: $url ---"

  # 現在の instruction 本文（メタデータ除く）を取得
  CURRENT_BODY=$(grep -v "^# EXAM_GUIDE_URL:\|^# DOMAINS:\|^# LAST_REFRESHED:" "$inst_file")

  PROMPT_FILE=$(mktemp /tmp/refresh_prompt_XXXX.txt)
  cat > "$PROMPT_FILE" << PROMPT
あなたはAWS認定試験の問題生成支援AIです。
以下の公式資格ページを WebFetch で取得し、最新の試験ガイド情報を抽出してください。

【対象資格】${exam}
【公式URL】${url}

【タスク】
1. 上記URLにアクセスして試験ガイドの内容を確認する
2. 以下の情報を日本語で正確に抽出する：
   - 出題ドメイン名（公式表記のまま、カンマ区切り）
   - 各ドメインの配点（%）
   - 主要なタスク文（各ドメイン3〜5個程度）
   - 主要な対象サービス一覧
3. 以下のフォーマットで出力する（前置き・説明文不要）：

---GUIDE_CONTENT---
（既存の instruction 本文を上記の最新情報で更新した全文。
 問題作成者へのシステムプロンプトとして機能する形式を維持すること。
 難易度・スタイル・フォーマット規則・品質基準セクションは以下の現行内容を
 ベースにしつつ、ドメイン配点・タスク文・対象サービスのみ最新情報に更新すること）

【現行の instruction 本文（参考）】
${CURRENT_BODY}
PROMPT

  RESULT=$(timeout -k 30 "${CLAUDE_TIMEOUT:-1800}" "$CLAUDE_CMD" --strict-mcp-config -p --model sonnet --allowed-tools WebFetch < "$PROMPT_FILE" 2>&1)
  EXIT_CODE=$?
  rm -f "$PROMPT_FILE"

  if [ $EXIT_CODE -ne 0 ]; then
    echo "❌ $exam: Claude 実行エラー (exit=$EXIT_CODE)"
    echo "$RESULT" | head -5
    continue
  fi

  # ガイドコンテンツを抽出
  NEW_CONTENT=$(echo "$RESULT" | sed -n '/^---GUIDE_CONTENT---/,$ { /^---GUIDE_CONTENT---/d; p }')

  if [ -z "$NEW_CONTENT" ]; then
    echo "⚠️  $exam: 期待するフォーマットで出力されませんでした（スキップ）"
    echo "--- 生出力（先頭200字）---"
    echo "$RESULT" | head -c 200
    continue
  fi

  # バックアップ
  cp "$inst_file" "${inst_file}.bak"

  # ファイル書き込み
  # ドメイン一覧は src/data/examDomains.json が単一マスタ（DynamoDB の domain は
  # その配列インデックス）。ここで公式ガイドの表記を書き出すとマスタとの二重管理になり、
  # 表記ゆれが毎月持ち込まれるだけなので # DOMAINS: 行は持たない。
  {
    echo "# EXAM_GUIDE_URL: ${url}"
    echo "# LAST_REFRESHED: ${TODAY}"
    echo ""
    echo "$NEW_CONTENT"
  } > "$inst_file"

  echo "✅ $exam: 更新完了"
  echo "   バックアップ: ${inst_file}.bak"

done

echo ""
echo "=========================================="
echo "完了: $(date)"
echo "=========================================="
