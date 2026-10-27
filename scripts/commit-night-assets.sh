#!/bin/bash
# 夜間バッチが改良する「資産」を、バッチ自身が develop に専用コミットで入れる（2026-10-27〜）。
#   対象: 生成指示 instructions/*.txt、サービスカタログ state/service-catalog.json、
#         そこから作る src/data/originalInstructions.ts（npm run gen:instructions で作り直してから入れる）
# 作業ツリーに夜間バッチの変更を溜めない（手の変更と混ざって巻き込み事故の元になる）ための仕組み。
#
#   - develop にいるときだけ動く（本番リリース作業などで別ブランチにいたら何もしない）
#   - 対象ファイルだけをコミットする（git commit --only。他人がステージ中のものは巻き込まない）
#   - push は「origin/develop に自分のコミットが1つ乗っただけ」のときだけ。
#     手元に未 push の別のコミットがあれば push せず、次に人が push するときに一緒に出る
set -uo pipefail
export TZ=Asia/Tokyo

REPO=/home/yuzuki/aws-quiz-app
SC="prompts/night-prompts/scripts"
log() { printf '[%s] [commit-night-assets] %s\n' "$(date '+%F %T')" "$*"; }

cd "$REPO" || exit 0
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
[ "$BRANCH" = "develop" ] || { log "develop 以外（$BRANCH）にいるためスキップ"; exit 0; }

node scripts/gen-original-instructions.mjs >/dev/null 2>&1 || log "⚠️ gen-original-instructions が失敗（ts は前のまま）"

FILES=()
while IFS= read -r f; do FILES+=("$f"); done < <(
  git status --porcelain -- "$SC/instructions/*.txt" "$SC/state/service-catalog.json" src/data/originalInstructions.ts \
    | awk '{print $NF}')
[ "${#FILES[@]}" -gt 0 ] || { log "変更なし"; exit 0; }

SUMMARY=$(printf '%s\n' "${FILES[@]}" | sed 's#.*/##' | paste -sd ' ')
MSG="chore(night): 夜間バッチの生成指示・サービスカタログの更新を取り込む

${SUMMARY}"

ok=0
for i in 1 2 3; do
  if git add -- "${FILES[@]}" && git commit -q --only -m "$MSG" -- "${FILES[@]}"; then ok=1; break; fi
  log "コミット失敗（${i}回目。index.lock の競合など）→ 再試行"; sleep 5
done
[ "$ok" = 1 ] || { log "⚠️ コミットできなかった（変更は作業ツリーに残る）"; exit 0; }
log "コミット: $(git log --oneline -1)"

git fetch -q github develop 2>/dev/null || true
if [ "$(git rev-parse HEAD~1)" = "$(git rev-parse github/develop 2>/dev/null)" ]; then
  git push -q github develop && log "push 済み" || log "⚠️ push 失敗（次の push で出る）"
else
  log "手元に未 push の別コミットがあるため push しない（次に人が push するときに出る）"
fi
