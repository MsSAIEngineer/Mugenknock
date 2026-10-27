# 06. 出題・採点ロジック

このアプリで**最も壊しやすく、壊れたことに気づきにくい**部分。変更前に必ず読むこと。

## 6.1 出題プールの決定（不変条件）

```js
// lambda/src/app.js — GET /questions
items.filter(q => !q.isHidden && !!q.validityCheckedAt)
```

**この1行が全ての母集団を決める。** 既習数・未回答数・ドメイン別統計はすべてこの母集団を前提に
計算されるため、他の箇所で違う条件を使うと数字が合わなくなる。

サーバ側の各所（`getExamQuestionIdSet(poolOnly: true)` など）が同じ条件を使うのはこのため。

### 前提知識(オリジナル資格)の混在（`includeCompanion`）

`GET /questions` に `includeCompanion=true` を渡すと、対応する前提知識(オリジナル資格)の
問題も母集団に合流する（`specs/003-original-exam-blend`）。**完全にオプトイン**で、
パラメータを渡さない既存の呼び出し元（Stats/Admin/SSG/模擬試験など）には影響しない。

| 公式資格 | 前提知識(オリジナル資格) |
|---|---|
| AIF / MLA / AIP | ML |
| DEA | DB |
| ANS | NW |
| SCS | SEC |

- `lambda/src/app.js` の `COMPANION_EXAM` が対応表の正本（FE側 `src/constants.ts` にも同名で複製）
- `domain`（ドメイン絞り込み）を同時指定した場合は `includeCompanion` を無視する
  （絞り込んだ公式ドメインに対応するオリジナル資格のドメインは存在しないため）
- `GET /users/me/question-status` にも同じ `includeCompanion` があり、出題プールと
  母集団（未回答数等の分母）を一致させるために使う
- `UserTagStats` のキー `tagId = ${question.examType}_${domainIdx}` は常に
  **問題自身の examType** を基準とする設計（セッションの target examType ではない）。
  これにより「targetExam側のドメイン統計に不算入」かつ「companion(オリジナル資格)自身の
  ドメイン統計には正しく算入」の両方が両立する
  （AIF演習中にML問題へ回答しても `ML_*` の tagId に記録され、AIF側の画面は `AIF_*` のみ読む）
- ただし**この設計の実現には `src/utils/domainStats.ts` の `recordSessionDomainStats` 側で
  対応が必要だった**（当初「追加実装なしで成立する」と見込んでいたが誤りだった・2026-09-16訂正）。
  同関数はセッション完了時に `answeredPerDomain`/`UserTagStats` 更新用の delta を組み立てる際、
  **セッションの target examType を全回答に一律適用**していたため、companion 問題を回答すると
  `targetExam_<companionのdomain index>` という誤った tagId（例: AIFの5ドメインしか
  無いのに companion側の6番目のdomain indexが渡ると意味不明な組み合わせになる）で記録され、
  (a) targetExam側の統計を汚染し (b) companion自身の統計には一切反映されない、という
  二重の不具合があった。**修正: 回答結果を「回答した問題自身の examType」でグループ化してから
  domain_history/domain_results(localStorage)・UserTagStats(サーバー)を記録する**よう変更。
  `PUT /users/me/domain-results` はtagIdをキーに汎用マージするだけで examType 自体は使わないため、
  1回のリクエストに複数examType分のtagIdが混在してもサーバー側の変更は不要だった。
- 模擬試験（`ExamSetup.tsx` / `Practice.tsx` の模試タブ）は `includeCompanion` を渡さない
  （現状維持・対象外）

---

## 6.2 ドメイン均等化（deficit round-robin）

**確定方針**（`CLAUDE.md` にも明記）: 無フィルタの通常演習のドメイン配分は
**deficit round-robin（累積是正）を維持する**。

### アルゴリズム（`domainBalancedOrder`）

```
1. 問題をドメイン別のバケットに分ける
2. 各バケット内をシャッフル
3. running[d] = ユーザーの既回答数 answeredPerDomain[d]（ゲストは全0）
4. 空でないバケットのうち running が最小のドメインから1問取り出す
5. running[d] += 1 して 4 に戻る
```

バケットキー `d` は `${examType}:${domain}` の複合キー（`domainBucketKey`）。
単一examTypeの呼び出しでは常に同じ examType なので従来と挙動は変わらないが、
`includeCompanion` で公式資格とオリジナル資格の問題を混在させたとき、
両者の `domain`（整数インデックス）は別体系なのに同じ数値を取りうるため、
examType を含めないと誤って同一ドメイン扱いになってしまう。

- **過去の回答が少ないドメインが優先される**＝累積の偏りが是正される
- **1セッション内で特定ドメインが多くなる / 0問になるのは許容する**
  （「各ドメイン最低1問保証」は検討のうえ**不採用**）

### フィルタとの組み合わせ（`selectionOrder`）

フィルタ（未回答/不正解/ブックマーク）が指定されている場合:

```
scoreFn(q) = (bookmarkOnly && bookmarked ? 1 : 0)
           + (unansweredOnly && !answered ? 1 : 0)
           + (incorrectOnly && incorrect ? 1 : 0)

1. scoreFn の値で階層（tier）に分ける
2. スコアが高い階層から順に出力
3. 各階層の中で companionMixedOrder を適用（下記「公式と基礎知識の混ぜ方」）
```

つまり**フィルタ一致が最優先、その中でドメイン均等化**という2段構成。
「未正解（未回答 or 不正解）」は `unansweredOnly` と `incorrectOnly` の**両方を立てる**ことで、
scoreFn の加算により和集合として機能する。

### 公式と基礎知識の混ぜ方（`companionMixedOrder`、specs/005）

`includeCompanion` で基礎知識(companion)が混ざるとき、公式と基礎知識は**1問ごとに、残り問題数に比例した確率で
ランダムに**選ぶ（`interleaveByPool`）。

```
P(基礎知識を取る) = 基礎知識の残り / (公式の残り + 基礎知識の残り)
```

- 期待される基礎知識の割合はプール（フィルタ時は階層）の問題数比と一致する
  （例: MLA は公式314・基礎166 → 平均 約35%）。試行ごとにばらつき、先頭がどちらかも毎回ランダム
- **フィルタ有効時も同じ**。各スコア階層の中で、その階層の問題数比で混ぜる
  （specs/004 の「公式を先に使い切ってから基礎知識で埋める」は廃止）
- 各側の内部は従来どおり `domainBalancedOrder`（deficit round-robin）で並べ、相対順序を保つ
- 片側が空（基礎知識が混ざらない資格・階層）なら従来と同じ単発の `domainBalancedOrder`
- しっかり対策（`Home.tsx` の `startFocusedExercise`）は、フロントで公式と基礎知識を**同じプールから重み付き抽出**する
  （フィルタ有効時に公式を先に抽出する分岐は廃止）
- 旧実装は、バケット（ドメイン）数が公式側4・基礎側6のとき同値が公式優先で解決され、
  先頭が `MLA 20%/60%`（固定）になっていた。テスト: `lambda/test/selection.test.js`（`node --test 'lambda/test/*.test.js'`。Node 22 ではディレクトリ指定だとテストを見つけられない）

### 実装が2箇所にある

| 場所 | 使われるフロー |
|---|---|
| `lambda/src/selection.js` の `domainBalancedOrder` / `selectionOrder`（`app.js` が require） | `GET /questions?idsOnly=true` — サクッと演習・演習・模試 |
| `src/utils/domainBalance.ts` の `domainBalancedOrder` | `idsOnly` を通らないフォールバック経路 |

**片方だけ直すと挙動が食い違う。** → [08-refactor-plan.md](08-refactor-plan.md) の Dup-1

> `includeCompanion` 対応のバケットキー複合化（`domainBucketKey`）は **lambda 側のみ**実施した。
> `src/utils/domainBalance.ts` 側は `getPrefetchA`/`getPrefetchC`（現状スタブで常に `null` を返す
> ＝プリフェッチ機能自体が無効化済み）経由でのみ使われるため、混在プールがこの実装に渡ることは
> 現状無い。**将来プリフェッチを復活させる場合は同じ複合キー化が必要**（そうしないと
> `includeCompanion` 使用時にドメイン偏り是正が壊れる）。

> 実害の記録: この均等化コードを prod Lambda へ反映し忘れ、約1か月ランダム出題が続いた結果、
> ユーザーの累積ドメイン分布が最少1問 vs 最多12問まで偏った。

---

## 6.3 サクッと演習（quick）の選定

`src/views/Home.tsx` の `startQuickExercise()`。**サーバ側に選定を任せる。**

```
1. localStorage.quickExercisePrefs_<uid> を読む
   { questionCount, domains, bookmarkOnly, priority, includeCompanion }
2. priority を2フラグへ展開
   'unanswered'  → unansweredOnly
   'incorrect'   → incorrectOnly
   'notcorrect'  → 両方（= 和集合）
   'none'        → どちらも false
3. GET /questions?examType=&shuffle=true&idsOnly=true
      &domain=<index,...>&bookmarkOnly=&unansweredOnly=&incorrectOnly=&userId=&includeCompanion=
   ※ userId はフィルタ無しでも必ず渡す（ドメイン均等化のため）
   ※ includeCompanion は「対応資格があり」「ドメイン絞り込み(domain)をしていない」時のみ付与
      （既定 true。§6.1「前提知識の混在」参照）
4. 先頭 count 件を採用
5. 足りなければ フィルタ無しの同条件で再取得し、重複を避けて補充
6. 余ったIDの先頭10件を spareQuestionIds として渡す（読めないIDが出たときの控え）
7. GET /questions?ids=<1問目>&withAnswers=true → 遷移
   ※ includeCompanion 混在時、1問目が companion 側の examType を持ちうるため
      この呼び出しに examType 絞り込みは付けない（付けると誤って0件になる）
```

---

## 6.4 しっかり対策（focused）の選定

`startFocusedExercise()`。**クライアント側で重み付き非復元抽出する。** ログイン必須。

### 入力

```
GET /questions?examType=&metaOnly=true&includeCompanion=         … プール（localStorage キャッシュ10分）
GET /users/me/question-status?userId=&examType=&includeCompanion= … answered / incorrect / weak / bookmarked / acc
domainStats（GET /users/me/stats の recentResults）
localStorage.domain_history_<et>_<uid>          … フォールバック
```

`includeCompanion` は対応資格があり `focusedExercisePrefs_<uid>.includeCompanion !== false`
の時に付与（既定 true）。プールのキャッシュキーは `qlist_<examType>` に `_companion` を
サフィックスし、トグル切替時に混在有無の異なる古いキャッシュを誤って使わないようにしている。

### ドメイン弱点度

```
ドメインの直近正答率 acc を次の優先順で決める:
  1. recentResults の直近10件（記録画面の苦手分析の既定の窓と同じ）
  2. 累計 correctCount / (correct + incorrect)
  3. localStorage の domain_history（直近10セッション）
  4. どれも無ければ null

threshold = focusDomain 設定（既定 'below80' → 0.80）
domainDeficit(d) =
    focusDomain === 'none' → 0
    acc === null           → 1        （未演習を最優先）
    acc >= threshold       → 0
    それ以外               → (threshold - acc) / threshold
```

### 重み

```
W_PRIORITY=8, W_WEAK=8, W_INCORRECT=4, W_DOMAIN=6, W_BOOKMARK=8, BASE=1

w(q) = BASE
     + (回答状況フィルタに一致        ? W_PRIORITY : 0)
     + (ブックマーク優先ON かつ 該当  ? W_BOOKMARK : 0)
     + (正答率フィルタに一致          ? W_WEAK     : 0)
     + (優先度が incorrect/notcorrect ? ミス回数 × W_INCORRECT : 0)
     + (q.examType === targetExam ? domainDeficit(ドメイン名) × W_DOMAIN : 0)
```

`BASE = 1` があるため**条件に合わない問題も混ざる**。これは意図的で、
フィルタが厳しすぎて問題数が足りなくなるのを防いでいる（充足の担保）。

`domainDeficit` 項は `q.examType === targetExam`（公式資格自身の問題）の時のみ加算する。
`qDomainName(q)` は問題自身の examType でドメイン名を解決するため、companion(前提知識)の
問題は targetExam のドメイン名一覧に存在しない名前を返し、ガード無しだと
`domainAcc.get(name) === undefined` → 常に「未演習=最優先(1)」として過大な重みが付いてしまう。
ガードにより companion 問題は `BASE` 基準の中立な重みで参加する（不当な優遇も冷遇もしない）。

`weightedSampleWithoutReplacement(pool, w, count)` で count 件を抽出。

### 解放条件

```js
FOCUSED_UNLOCK_THRESHOLD = 30
focusedUnlocked = !!user && answeredCount >= 30
```

`answeredCount` は `GET /users/me/question-stats`（= `UserQuestionStats` の
`correctCount + incorrectCount` の総和）。取得完了前は `localStorage.focusedUnlockedCache_<uid>`
を暫定表示に使う。到達の瞬間だけ祝福モーダルを1回出す（`focusedUnlockCelebrated_<uid>`）。

---

## 6.5 採点

```js
// 正解判定（ExerciseSession / ExamSession / sessionUtils で共通の考え方）
const correctIdx = q.correctAnswerIndices;          // 正準
const userIdx = selected.map(t => q.choices.indexOf(t));
isCorrect = correctIdx.length > 0
         && correctIdx.length === userIdx.length
         && correctIdx.every(i => userIdx.includes(i));
```

**完全一致のみ正解**（部分点なし）。複数選択で1つでも違えば不正解。

### 合否

```js
score = Math.round(正解数 / 問題数 * 100)
basePassRate = PASS_RATE[examType] ?? PASS_RATE['SAA'] ?? 72
passRate = isMini ? Math.ceil(basePassRate / 5) : basePassRate
isPassed = score >= passRate
```

> ミニ模試の `/5` は「短い模試で本番と同じ合格ラインを課すと厳しすぎる」ための緩和。

### 中断時の自動採点（`autoScoreAndClearDrafts`）

新しい演習を始めるとき、放置された同種別のドラフトを自動確定する。

```
draft.results があれば         → 正解数 / results.length
draft.answers があれば（模試）  → 回答済み問題だけで採点
どちらも無ければ               → ドラフトを捨てるだけ（セッションは active のまま残る）
```

**`keys` を必ず明示すること。** 省略すると演習3種すべてを確定してしまう。

---

## 6.6 予想スコア（estimatedScore）

`src/views/Home.tsx`。**公式のスケールスコア（100〜1000）に寄せた推定値。**

```js
nodeWindow = 5 or 10   // localStorage.scoreWindow_<uid>

// ドメインごとに直近 nodeWindow 問の正誤を取る
nodeResults[domain] = (server recentResults ?? localStorage domain_results)
                        .slice(-nodeWindow)

weights = DOMAIN_WEIGHTS[examType]   // 公式試験ガイドの配点 %
weightedSum = Σ (該当ドメインの正解数 / nodeWindow) × weights[i]
              ただし nodeResults が空のドメインはスキップ

estimatedScore = Math.round(weightedSum / Σweights × 1000)
全ドメインでデータが無ければ null（'—' 表示）
```

**注意点**: 分母が `nodeResults.length` ではなく **`nodeWindow` 固定**。
つまり窓が埋まっていないドメイン（例: 5問窓で2問しか解いていない）は
最大でも 2/5 = 40% として扱われ、**スコアが低めに出る**。
これは「まだ解いていないドメインを楽観視しない」という意図的な設計。

前回値は `localStorage.score_prev_<examType>_<uid>` に `{ s: score, w: window }` で保存され、
差分表示に使われる（窓を変えたら比較しないよう `w` も持つ）。

---

## 6.7 ポイント

| 獲得条件 | ポイント |
|---|---|
| 正解1問 | Foundational: 1 / Business・Associate・Additional（基礎知識）: 2 / Professional・Specialty: 3 |
| 日次目標の達成（当日1回のみ） | 10 |

```js
// constants.ts の pointsPerCorrect(examType)。回答した問題自身の examType で決める
earnedPts = Σ pointsPerCorrect(question.examType) over 正解した results
```

他の公式資格の演習に基礎知識（ML/DB/NW/SEC、`includeCompanion`）が混ざったときは、混ざった問題を
演習中の資格ではなく基礎知識のレベル（Additional = 2）で数える（2026-10-27）。
模擬試験は全問が同じ資格なので `pointsPerCorrect(examType)` をそのまま使う。

### 日次ボーナスの二重付与ガード（3重）

```js
serverDaily != null            // サーバ確定値がある時だけ判定する
&& newDaily >= dailyGoal       // 目標達成
&& prevDaily < dailyGoal       // 今回初めて跨いだ
&& !localStorage[rewardKey]    // dailyGoalReward_<et>_<uid>_<JST日付>
&& userId !== 'guest'
```

`serverDaily` が null（通信失敗）のときに判定を見送るのは、staleなローカル値で
`prevDaily < goal` が誤成立して同日に重複付与されるため。
`rewardKey` は kvSync で同期されるので**別デバイスでも二重取得しない**。

### 消費

現状の唯一の用途は**日めくりサービスの再抽選（30ポイント）**（`Home.tsx` の `deductPoints(uid, 30)`）。

### 保存方式

`localStorage.userPoints_<uid>` を正とし、変更のたびに `PUT /users/me/points` で**絶対値**を送る。
サーバ側は `Math.max(0, Math.round(n))` に丸めるだけで、加算検証はしない。

---

## 6.8 日次演習カウント

```
セッション完了 → POST /users/me/daily-progress { examType, count }
              → サーバが AppSettings.dailyProgress_<uid> をアトミック加算
              → 加算後の合計を返す
              → localStorage.dailyQCount_<et>_<uid>_<JST日付> にミラー
```

**ミラーは表示用**（既存の読み取り箇所が localStorage を見るため）。
`fetchDailyProgress` は「ローカルの方が大きい場合は上書きしない」
（送信前に落ちた加算がある可能性を考慮）。

**kvSync の同期対象外**。アトミック加算がデバイス間合算を担保しているので同期は不要かつ有害。

---

## 6.9 ドメイン別統計の記録

`src/utils/domainStats.ts` の `recordSessionDomainStats()`。セッション完了時に3つ書く。

```
1. localStorage.domain_history_<et>_<uid>
   { "0": [{correct, total}, ...] }  直近10セッション分（ゲストも保存）

2. localStorage.domain_results_<et>_<uid>
   { "0": [true, false, ...] }       直近30問の個別正誤

3. PUT /users/me/domain-results（ログイン時のみ）
   { "SAA_0": [true, false] }        ← このセッションの新規分（デルタ）だけ
   サーバ側で既存 recentResults にマージし末尾30件に切る
   （画面が使う recentResults は GET /users/me/stats?examType= が UserAnswers から作り直す。
     このデルタは抜け・二重があったため表示には使わない。2026-10-27）
```

- localStorage 側のキーは**裸のインデックス文字列**（`"0"`）
- サーバ側の `tagId` は**正準形式**（`"SAA_0"`）。旧形式の裸indexは全資格で共有されてしまうため廃止
- **デルタ送信**なので、ローカルが空の状態でもサーバの蓄積が壊れない

---

## 6.10 中断と再開

### 保存

```
ExerciseSession / ExamSession が定期的に:
  localStorage.<種別>Draft_<uid> = { sessionId, examType, questions, currentIndex, results, ... }
  localStorage.activeExerciseDraft = { key, sessionId }   ← アクティブなドラフトのポインタ
  PUT /sessions/:id/progress { draft: {...}, sessionType }
```

### 復元

```
Home 起動時:
  hydrateDraftsFromServer(userId)
    → GET /users/me/active-sessions
    → 種別ごとに localStorage にドラフトが無ければサーバ分から復元
      （ローカルがあればローカル優先＝ローカルが最新）
    → GET /questions?ids=<questionIds>&withAnswers=true で問題本体を取り直し、
      questionIds の順序に並べ直す（ids 取得は順不同のため）
```

模試（mini/exam）とそれ以外で `draftObj` の構造が違う点に注意（`utils/sessionResume.ts`）。
特に `selectionHistory` は「回答済み問題を見返したときの選択肢復元用」で、欠けると未回答に見える。

### 完了時のクリーンアップ

```
PUT /sessions/:id { status: 'completed' }  → サーバ側で draft / draftSavedAt を REMOVE
localStorage.<種別>Draft_<uid> を削除
localStorage.activeExerciseDraft を削除
```

サーバ側で draft を消すのは、遅延した `progress` PUT が後から届いて
「終わったのに演習中」表示になるのを防ぐため。それでも取りこぼした行のために
`active-sessions` に7日フィルタと `endedAt` チェックがある（多層防御）。
