# 設計: 解いた問題の「もっと知りたい」質問

## データ

`Questions` に2つの属性を足す。

- `followUpQuestions`: `[{ angle: 'term'|'diff'|'whatif'|'why'|'limits', text: string, createdAt: ISO }]`（最大3）
- `followUpBasis`: 質問を作ったときの選択肢のハッシュ。FNV-1a 32bit を、`choices` を `\n` でつないだ文字列の UTF-8 に掛けた16進8桁。
  画面とスクリプトの両方で同じ計算をし、今の選択肢と合わなければ古い質問として扱う（画面は出さない・スクリプトは捨てて付け直す）。

Lambda は変えない。`GET /questions` は内部項目（`INTERNAL_QUESTION_FIELDS`）を除いて属性をそのまま返すため、新しい属性も画面に届く。
問題の更新（管理画面・02 の修正）は `SET` で個別の項目を書くので、`followUpQuestions` は消えない。古くなったかどうかはハッシュで分かる。

## スクリプト `prompts/night-prompts/scripts/11-add-follow-up-questions.py`

1. `Questions` を走査する（出題対象 = `!isHidden && validityCheckedAt`）。
2. 有効な質問の数（ハッシュが合わなければ0）が最も少ない問題から、`-n` 問を選ぶ。同じ数の中ではランダム。3つある問題は対象外。
3. `-c` 問ずつまとめて Haiku に渡す（`--model haiku --tools "" --strict-mcp-config`）。各問に、問題文・選択肢（正解の印）・既存の質問と角度を渡し、
   **まだ使っていない角度で1つだけ**質問を作らせる。合う角度がなければ `skip`。出力は JSON の配列。
4. 機械的に検査し、通ったものだけ書く。
   - 角度が5つのどれかで、その問題でまだ使っていない
   - 1行・12〜120文字・「？」で終わる
   - 「この問題」「選択肢」「上記」「正解」「誤り」「問題文」を含まない（それだけで意味が通るように）
   - オリジナル資格（ML/DB/NW/SEC）は `AWS`・`Amazon` を含まない
   - 既存の質問と同じ文でない
5. 書き込みは `update_item`。条件 `choices = :ch`（作っている間に選択肢が直されたら書かない）。ハッシュが合わなかった問題は、既存の質問を捨てて新しい1つにする。
6. `-D HH:MM`（JST）を過ぎたら、次のチャンクに進まずに終わる。`--dry-run` は書かずに結果を出す。

Haiku に足りない場合でも、検査が内容の体裁を保証する。中身の正しさまでは保証しない（質問なので、誤っていても利用者に誤った知識は渡らない。答えは利用者の AI が出す）。

## 起動

- 使い切りモードのフック: `~/.config/claude-timer/hooks.d/mugenknock.conf` に `-25|scripts/local-followup-hook-run.sh|…` を足す（`require=hooks_enabled` の下）。
  中身は検証フックと同じ形で、締切（次のピンの数分前）まで `-n 1000` で動かす。
- 手動: エイリアス `afq`（`~/.bashrc`、`cval` などと同じ場所）。

## 画面

`ExerciseSession` の回答後、コラムの直前に置く。見出し「もっと知りたいとき」と、質問ごとに1行（質問文＋コピーボタン）。
コピーボタンは既存の `CopyButton`（解説下のコピーと同じ見た目）を使う。ハッシュが合わない質問・質問がない問題は何も出さない。
