# 04. API 仕様

ベースURL: `https://a0q3656qw4.execute-api.ap-northeast-1.amazonaws.com/{dev|prod}`
実装: `lambda/src/app.js`（express アプリを `lambda/src/index.js` が serverless-express でラップ）

## 4.1 認証モデル

ミドルウェアは**パスの接頭辞で一括適用**される。

| 接頭辞 | ミドルウェア | 挙動 |
|---|---|---|
| `/admin/*` | `requireAdmin` | Cognito idToken を検証し、email が `ADMIN_EMAIL` または `AppSettings.admins` に含まれること。失敗は 401/403 |
| `/users/me/*` | `requireUser` | idToken を検証し、**`req.query.userId` / `req.body.userId` をトークンの `sub` で強制上書き**（IDOR 防止） |
| それ以外 | なし | `userId` はクライアントの申告をそのまま信用する |

> **注意**: `/sessions/*`、`/questions/:id/bookmark`、`/announcements/mark-read`、`/contact` は
> 認証なしで `userId` を受け取る。他人の `userId` を指定した書き込みが理論上可能
> （→ [08-refactor-plan.md](08-refactor-plan.md) の Sec-1）。

**1日の演習上限（おひねり・specs/006）**: 管理設定 `AppSettings.ohineri.enabled` が true の間だけ働く
（既定は無効＝何も変わらない）。有効かつ**有効なトークンの sub がある**ときに限り:
- `POST /sessions`: 通常演習（`mode !== 'exam' && !isMini`）で今日の残りが 0 なら `429 { code: 'DAILY_LIMIT', … }`
- `POST /sessions/:id/answers`: 上限対象のセッションなら、同じトランザクションで `UserDailyCounts` に `ADD answered 1`
  （回数の加算に失敗しても回答の記録は止めない）。セッションの `mode` はサーバが `Sessions` を読んで判定する
- この2本は従来ログイン検証が無い。上記のときだけトークンの sub を本人として扱う（他人の回数を増やせない）。
  トークン無し（ゲスト）・無効なトークンは従来どおり素通し

エラーレスポンスは一貫して `{ "error": "..." }`。想定外の例外はすべて
`500 { error: 'Internal server error' }` に潰される（詳細は CloudWatch Logs）。

---

## 4.2 問題（公開）

### `GET /questions`

出題プールの取得。**このAPIが最も多機能で、フロントの出題フローの中心**。

常に `!q.isHidden && !!q.validityCheckedAt` でフィルタされる（＝検証ゲート）。

**クエリパラメータ**

| 名前 | 説明 |
|---|---|
| `examType` | 資格。指定時は `examType-index` GSI + 10分キャッシュ経由 |
| `ids` | カンマ区切りの questionId。**指定時は個別 GetItem を並列実行**（問題数に依存しない） |
| `tagId` | `QuestionTagRelations` 経由（レガシー） |
| `domain` | カンマ区切りの**整数 index**。名前は受け付けない |
| `keyword` | カンマ区切り。全キーワードが問題文/選択肢/IDのいずれかに含まれる AND 検索 |
| `shuffle` | `'true'` でシャッフル |
| `offset` / `limit` | ページング |
| `metaOnly` | `'true'` で `{questionId, domain, examType, aiVerified}` のみ返す（ペイロード約1/10） |
| `idsOnly` | `'true'` で `questionIds` のみ返す。**フィルタ＋ドメイン均等化が効く**（下記） |
| `withAnswers` | `'true'` で `correctAnswers` / `explanation` を含める。省略時は伏せる |
| `bookmarkOnly` / `unansweredOnly` / `incorrectOnly` | `idsOnly` 時のみ有効な優先フィルタ |
| `userId` | `idsOnly` 時。**フィルタ無しでも渡すとドメイン均等化が効く** |
| `includeCompanion` | `'true'` で対応する前提知識(オリジナル資格)の問題を合流。**完全にオプトイン**（省略時は現行と同一挙動）。`domain` 指定時は無視される。対応表・詳細は [06-exercise-logic.md](06-exercise-logic.md) §6.1 |

**レスポンス**

```jsonc
// 通常
{ "items": [ /* 問題 */ ], "count": 10, "total": 342 }
// metaOnly=true
{ "items": [{"questionId":"saa-...", "domain":0, "examType":"SAA", "aiVerified":null}], "count": 342, "total": 342 }
// idsOnly=true
{ "questionIds": ["saa-...", ...], "total": 342 }
```

`withAnswers` 無しの場合も `correctAnswerCount`（正解の個数）は返る（UI が「2つ選べ」を出すため）。

**返さないフィールド**（`GET /questions` と `GET /questions/:id` 共通・`stripInternalFields`）:
`validityEditLog` `formatCheckedAt` `linebreakCheckedAt` `translationCheckedAt` `sourceQuestionId`
`auditNote` `auditFlaggedAt` `isResolved` `resolvedAt` `questionTextEn` `choicesEn` `explanationEn`
`choiceExplanationsEn`。内部・運用メタデータで、出題画面は使わない。とくに `validityEditLog`
（検証での修正前後の全文）は1問あたり1.7〜2.9KB あり、除去前は応答の約3割を占めていた。
`*En` は英語対応の廃止後（`lang` は `'ja'` 固定）に参照されない。管理画面は `/admin/questions` 系
から取得するので影響しない。新しい内部フィールドを DB に足したら、`INTERNAL_QUESTION_FIELDS`
（`lambda/src/app.js`）にも足すこと（足さないと公開 API にそのまま出る）。

**`idsOnly` の並び順**（重要 → [06-exercise-logic.md](06-exercise-logic.md)）:
1. `bookmarkOnly` / `unansweredOnly` / `incorrectOnly` が指定されていれば、
   一致数（0〜3）をスコアとする階層に分ける（**フィルタ一致が先頭**）
2. 各階層の中で `domainBalancedOrder` によるドメイン均等化（deficit round-robin）
   - `includeCompanion` で基礎知識が混ざる場合は、公式と基礎知識を**問題数比でランダムに混ぜる**
     （各側の内部はドメイン均等化。フィルタ時も同じ。→ [06 §6.2](06-exercise-logic.md)、specs/005）
3. フィルタ無しなら純粋にドメイン均等化のみ（基礎知識が混ざる場合は上記のランダム混在）

### `GET /questions/:id`

問題1件。ラベル接頭辞を除去して返す（`normalizeQuestion`）。404 あり。

### `GET /questions/growth-stats`

問題の生成・検証状況の日次（直近14日）/月次（直近6ヶ月）集計。累積値も返す。
全件 Scan だが 10分のウォームキャッシュ付き。

### `POST /questions/:id/report`

通報。**認証は任意**。

- `Authorization` があれば検証して `sub` を通報者に、無効/無しなら `'anonymous'`
- **クライアントが送った `userId` は使わない**
- `category` は `question_error` / `choice_error` / `explanation_error` / `other` のみ許可（他は `other`）
- `message` は1000文字で切り詰め
- ログインユーザーの同一問題への重複通報は排除 → `{ success: true, deduped: true }`

---

## 4.3 ブックマーク

| メソッド | パス | 認証 | 説明 |
|---|---|---|---|
| POST | `/questions/:id/bookmark` | なし（body.userId） | `UserQuestionStats.bookmarked = true`。`lastAnsweredAt` は `if_not_exists` |
| DELETE | `/questions/:id/bookmark?userId=` | なし | `bookmarked = false`（行は残る） |
| GET | `/users/me/bookmarks?userId=` | ✅ user | `{ questionIds: [...] }` |

## 4.3b 問題へのリアクション（👍👎）

1ユーザー1問1票。`UserQuestionStats.reaction`（`'up' | 'down'`、未設定=無反応）が正。
合計集計は `Questions.reactionUp` / `reactionDown`（`globalAttempts` と同じく本体書き込みとは
別トランザクションの条件付き加算）で、**ユーザー向けAPIには合計を出さない**（管理画面専用）。

- **1人1票の保証はアプリ側のチェックではなく構造で担保する**: `UserQuestionStats` は
  `(userId, questionId)` を主キーとする単一項目で、`reaction` はその項目の1属性
  （`SET reaction = :r` で毎回上書き）。同じユーザー・同じ問題で複数の評価を同時に
  持つことがデータ構造上できない。
- **問題との紐付けは questionId 単位**で、どのセッション・どの出題経路
  （通常演習・しっかり対策・ブックマークフィルタ等）で出会った問題でも同じ状態が
  復元される。演習画面はセッション起動のたびに `GET /users/me/bookmarks` /
  `GET /users/me/question-status` を取得し直す（`docs/05-screens.md` §5.4）。

| メソッド | パス | 認証 | 説明 |
|---|---|---|---|
| PUT | `/questions/:id/reaction` | なし（body.userId） | `{ userId, reaction: 'up'\|'down'\|null }`。`null`で取り消し。同じ値の再送は無処理 |
| GET | `/users/me/question-status?userId=&examType=` | ✅ user | `reactions: Record<questionId, 'up'\|'down'>` を含む（自分の分のみ） |

**クライアント側はボタン連打のたびに送信しない（デバウンス）**: ♡/👍👎ボタンを押した瞬間は
UI（色・アニメーション）だけ即時反映し、実際の `PUT/POST/DELETE` は以下いずれか最初に
到達したタイミングでまとめて1回だけ送る（詳細は `docs/05-screens.md` §5.4）。

1. その問題の回答確定（スコアのコミット）時
2. 別の問題へ移動する時
3. 画面を離れる時（セッション中断・ホームへ戻る等、コンポーネントのアンマウント）

同じ問題を表示中に何度も押し直しても、最後に確定した値だけが送信される。②が必要なのは、
「前の問題に戻って評価を変更し、また先に進む」場合のように**新たな回答確定イベントが
発生しないケース**があるため（この場合①は発火しない）。

---

## 4.4 セッション

| メソッド | パス | 認証 | 説明 |
|---|---|---|---|
| POST | `/sessions` | なし | セッション作成 → `{ sessionId }` |
| PUT | `/sessions/:id/progress` | なし | 中断再開用ドラフト保存 |
| PUT | `/sessions/:id` | なし | 完了/中断。`status:'completed'` で draft を REMOVE し履歴を剪定 |
| GET | `/sessions/:id?userId=` | なし | セッション1件 |
| POST | `/sessions/:id/answers` | なし | 回答記録 |
| GET | `/sessions/:id/answers?userId=` | なし | セッションの回答明細（問題文付き） |
| GET | `/users/me/active-sessions?userId=` | ✅ user | 再開可能セッション（種別ごとに最新1件） |
| GET | `/users/me/sessions?userId=&limit=&examType=` | ✅ user | 完了セッション履歴（新しい順） |

### `POST /sessions`

```jsonc
// リクエスト
{ "userId": "...", "mode": "exercise"|"exam", "examType": "SAA",
  "questionIds": ["saa-..."], "isMini": false, "isFocused": false,
  "sessionType": "quick"|"focused"|"practice"|"exam"|"mini" }
```

### `POST /sessions/:id/answers`

```jsonc
{ "userId":"...", "questionId":"saa-...", "selectedAnswers":["..."], "isCorrect": true }
```

**トランザクション内**で2件を原子的に書く:
1. `UserAnswers` に Put（SK = `` `${sessionId}#${questionId}#${now}` ``）
2. `UserQuestionStats` を `ADD correctCount|incorrectCount 1, SET lastAnsweredAt`

**トランザクション外**で `Questions` の `globalAttempts`/`globalCorrect` を条件付き加算
（`attribute_exists(questionId)`）。失敗は握りつぶす — 集計失敗が回答記録を巻き添えにしないため。

> 解放カウント（演習量）は**ここで加算しない**。`GET /users/me/question-stats` が
> `UserQuestionStats` から都度集計する。増分方式は並列時に競合してドリフトしたため廃止された。

### `PUT /sessions/:id/progress`

```jsonc
{ "userId":"...", "draft": { /* 種別ごとに構造が違う */ }, "sessionType": "quick" }
```
`draft` は小さく保つこと（currentIndex / answers / results / timeLeft 等）。
`draftSavedAt` と `lastAnsweredAt` も同時に更新される。

### `GET /users/me/active-sessions`

種別判定: `sessionType` があればそれ、無ければ `mode === 'exam' ? (isMini ? 'mini':'exam') : (isFocused ? 'focused':'practice')`。

除外条件（すべて「終わったのに再開表示」の防止）:
- `status !== 'active'` / `draft == null` / `endedAt` が存在する
- `draftSavedAt`（無ければ `startedAt`）が7日より古い

---

## 4.5 ユーザー統計

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/users/me/question-stats?userId=&examType=` | **演習量**。`{ answeredCount }` |
| GET | `/users/me/stats?userId=&examType=` | ドメイン別統計 + `resetAt` |
| GET | `/users/me/question-status?userId=&examType=` | **演習フィルタ用の一括取得** |
| GET | `/users/me/answered-questions?userId=&examType=` | `{ questionIds }` |
| GET | `/users/me/incorrect-questions?userId=&examType=` | `{ questionIds, counts }` |
| GET | `/users/me/weak-questions?userId=&examType=&minIncorrect=2` | 頻出ミス上位30件（問題文付き） |
| PUT | `/users/me/domain-results` | ドメイン別直近正誤の**デルタ**を送る |

### `GET /users/me/question-stats`

`answeredCount = Σ(correctCount + incorrectCount)`（正誤・重複問わず解いた延べ数）。
`examType` の判定は **questionId の接頭辞**（`saa-xxx` → `SAA`）。
例外: `gai-` 接頭辞は `AIP` に読み替える（`PREFIX_MAP`）。

### `GET /users/me/question-status`

**しっかり対策・演習・模試のフィルタが必要とする情報を1リクエストにまとめたもの。**

```jsonc
{
  "answered":   ["saa-..."],              // 統計行が存在する = 既回答
  "incorrect":  { "saa-...": 3 },         // incorrectCount > 0 のもの
  "weak":       ["saa-..."],              // 正答率 <= 0.75（後方互換）
  "bookmarked": ["saa-..."],
  "acc":        { "saa-...": 0.5 }        // 問題別の累計正答率
}
```
`examType` 指定時は**出題プールと同じ条件**（`poolOnly`）で絞る。
母集団を `GET /questions` と揃えないと「未回答数 = total − answered」がズレる。

`includeCompanion=true` を同時指定すると、対応する前提知識(オリジナル資格)の
questionId も母集団に合流してから絞る（`GET /questions?includeCompanion=true` と
対になるオプトインパラメータ。§4.2参照）。

### `GET /users/me/stats`

`UserTagStats` の行（`recentResults`）に加え、`examType` 指定時は `UserQuestionStats` から
ドメイン別の `correctCount`/`incorrectCount`/`answeredCount` を集計して
`tagId = ${examType}_${index}` の行へマージして返す。

> `UserTagStats` には累計カウンタが書き込まれたことがない。集計元を `UserQuestionStats` に
> 統一することで既習数と未演習数が構造的に整合する。

`examType` 指定時は `recentResults` も、`UserAnswers`（1問ごとの回答ログ）を回答日時順に並べた
ドメイン別の末尾30件で**置き換える**（出題プールと同じ条件で絞る）。
`UserTagStats` に溜めた `recentResults` は、セッション完了・中断時にしか送られず、破棄・上書き・
送信失敗の分が抜け、再開後の完了で二重にも入って累計とずれていたため（2026-10-27）。
ホーム・記録の苦手分析は必ず `examType` を付けて呼ぶ。

### `PUT /users/me/domain-results`

```jsonc
{ "userId":"...", "domainResults": { "SAA_0": [true, false] } }  // ← セッションの新規分だけ
```
サーバ側で既存 `recentResults` に**マージして末尾30件**に切る。
デルタ送信なので、ローカルが空でもサーバの蓄積は壊れない。
※ 画面は `GET /users/me/stats?examType=` が回答ログから作る `recentResults` を使うため、
ここで溜めた値は `examType` なしで呼んだときにしか返らない（現在は使っていない）。

---

## 4.6 スコア履歴・設定・ポイント

| メソッド | パス | 説明 |
|---|---|---|
| GET/PUT | `/users/me/score-history?userId=&examType=` | スコア履歴（3種の配列） |
| GET/PUT | `/users/me/preferences` | 目標資格・受験日・日次目標・取得済資格・汎用KV |
| GET/PUT | `/users/me/points` | ポイント残高 |
| GET/POST | `/users/me/daily-progress` | 日次演習カウント |
| GET/POST | `/users/me/encyclopedia-unlocks` | 図鑑の解放状況 |
| DELETE | `/users/me/data?examType=` | 資格単位のデータ削除 |
| POST | `/users/me/reset` | 全データ初期化 |

### `PUT /users/me/score-history` の上書きガード

- `scoreHistory` — 日付キーでマージし各日の**最大点**を採用、末尾30件
- `sessionScoreHistory` / `sessionScoreLog` — **受信配列が既存より短ければ無視**

### おひねり（1日の演習上限の撤廃）— specs/006

| メソッド | パス | 認証 | 内容 |
|---|---|---|---|
| GET | `/users/me/limits` | ログイン | `{ enabled, unlimited, applies, limit, used, remaining, purchaseEnabled, priceYen }`。`applies`＝上限が掛かるか |
| POST | `/users/me/checkout` | ログイン | Stripe Checkout セッションを作り `{ url }` を返す。購入済みは 409、無効・決済キー無しは 503 |
| POST | `/users/me/checkout/confirm` | ログイン | `{ sessionId }`。Stripe API で支払いを確認し、本人の支払い済みなら購入を記録（冪等）して `limits` を返す |
| POST | `/webhooks/stripe` | **署名検証のみ** | `checkout.session.completed` 等。生ボディで署名検証し、支払い済み・100円・JPY のものだけ購入を記録 |

- 購入の記録は `UserEntitlements`（`ConditionExpression: attribute_not_exists(userId)` で冪等）。**書くのは Webhook と confirm だけ**
- 戻り先 URL はオリジン許可リスト（`lambda/src/ohineri.js` の `safeOrigin`）で絞る
- 環境変数（Lambda ごと）: `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`。dev はテストキー。本番キーへの差し替えは人間の確認が必要

### `PUT /users/me/preferences`

```jsonc
{ "userId":"...",
  "targetExam": "SAA"|null,
  "examDates": { "SAA": "2026-12-01" },
  "dailyGoal": 20,
  "obtainedCerts": ["CLF"],
  "kvPatch": { "theme_<uid>": { "v": "dark", "t": 1757000000000 } } }
```
`kvPatch` はキーごとに Last-Writer-Wins（`t` が新しい方を採用）。`v: null` は削除トゥームストーン。
剪定: 日付付きカウンタ系14日 / 通常90日 / トゥームストーン30日。1キー8KB・キー名200文字上限。

### `POST /users/me/points`（PUT）

`points` は `Math.max(0, Math.round(Number(points)))` に丸められる。
**クライアントが計算した絶対値を送る方式**（加算ではない）。

### `POST /users/me/daily-progress`

```jsonc
{ "userId":"...", "examType":"SAA", "count": 5 }   // 0 < count <= 1000
→ { "count": 25, "total": 300, "date": "2026-09-10" }
```
`AppSettings.dailyProgress_<userId>` の `<examType>_<JST日付>` と `total_<examType>` を
`ADD` 相当でアトミック加算。複数デバイスの同日演習が正しく合算される。

---

## 4.7 コンテンツ（公開）

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/tips?examType=` | 演習中のコラム。`examType` または `'ALL'` に一致するもの |
| GET | `/releases` | リリースノート（日付降順・10分キャッシュ） |
| GET | `/announcements` | 公開済みお知らせ（10分キャッシュ） |
| GET | `/announcements/read-status?userId=` | `{ readIds, hasUnread }` |
| POST | `/announcements/mark-read` | `{ userId, ids }` を既読にマージ |
| GET | `/cheatsheet-deletions` | チートシート項目の削除予定フラグ |
| GET | `/settings/about` | About ページ本文 |
| GET | `/settings/theme` | `{ colors, enabled }` |
| GET | `/settings/pass-comments` | 資格別合格コメント |
| POST | `/contact` | 問い合わせ送信（`message` 必須） |

### `GET /daily-service`

**4つのモードが1エンドポイントに同居している。**

| クエリ | 挙動 |
|---|---|
| `?list=1` | 抽選可能な全サービスの一覧（図鑑の母数）。`isServiceUnlockable` でフィルタ |
| `?serviceId=` | 特定サービス1件（図鑑の on-demand フェッチ・SEO ページ） |
| `?userId=` | **そのユーザーが未解放のサービス**から `hash(userId + JST日付)` で決定 |
| `?userId=&rerollSeed=` | 再抽選。当日解放済みも除外して別の未見サービスを返す |
| （なし） | 匿名向け。`_schedule_` のグローバルキューを消化 |

レスポンス: `{ service, alreadyUnlocked }`（`?list=1` のみ `{ services, total }`）。

---

## 4.8 管理者API（`/admin/*`・全て要 requireAdmin）

### 問題

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/admin/questions` | 一覧（page/pageSize/keyword/tag/domain/sort）。`examType=ALL` は Scan（explanation 等を射影で除外し 6MB 上限回避） |
| GET | `/admin/questions/:id` | フル1件 |
| POST | `/admin/questions` | **一括インポート**。`{ examType, domain, questions: [...] }` → `{ created, count, errors }` |
| PUT | `/admin/questions/:id` | 更新。正解・選択肢が変わると `globalAttempts`/`globalCorrect` を REMOVE |
| DELETE | `/admin/questions/:id` | 削除（`QuestionTagRelations` も掃除） |
| GET | `/admin/questions/summary` | 資格別・ドメイン別件数、検証済み数、演習回数。`?sinceDate=` で増分も |
| GET | `/admin/questions/flagged` | 妥当性タブ。`filter=flagged\|hidden\|audit\|fixed`、limit/offset ページング |
| POST | `/admin/questions/:id/apply-fix` | `fixProposalJson` を適用し REMOVE |
| POST | `/admin/questions/:id/reject-fix` | `fixProposalJson` を REMOVE |
| PUT | `/admin/questions/:id/visibility` | `{ isHidden }` |
| PUT | `/admin/questions/:id/scheduled-deletion` | `{ reason, date }` で予約、省略で解除 |

> `GET /admin/questions/flagged` が limit/offset なのは、全件返していた頃に
> レスポンスが 17MB に達し Lambda の 6MB 上限で常に 413 になったため。
> 一覧に出ない `choices`/`correctAnswers`/`explanation` は返さない（編集時は個別 GET で取り直す）。

### コンテンツ管理

| リソース | エンドポイント |
|---|---|
| Tips | `GET/POST /admin/tips`, `POST /admin/tips/bulk`, `PUT/DELETE /admin/tips/:id` |
| ColumnIdeas | `GET/POST /admin/column-ideas`, `PUT/DELETE /admin/column-ideas/:id` |
| Releases | `GET/POST /admin/releases`, `PUT/DELETE /admin/releases/:id` |
| Announcements | `GET/POST /admin/announcements`, `PUT/DELETE /admin/announcements/:id`, `POST /admin/announcements/:id/publish`, `.../unpublish` |
| DailyServices | `GET/POST /admin/daily-services`, `PUT/DELETE /admin/daily-services/:id`（**キャッシュを無効化する**） |
| Reports | `GET /admin/reports`, `DELETE /admin/reports/:id?questionId=`（複合キーのため questionId 必須） |
| ContactMessages | `GET /admin/messages`, `DELETE /admin/messages/:id` |
| CheatSheetDeletions | `PUT /admin/cheatsheet-deletions/:itemKey`（`{reason, date}` で設定、省略で解除） |

### 設定

| メソッド | パス | 説明 |
|---|---|---|
| GET/PUT | `/admin/settings/admins` | 追加管理者メール（`@` を含む値のみ・小文字化） |
| PUT | `/admin/settings/theme` | `{ colors, enabled }` |
| PUT | `/admin/settings/about` | `{ sections }` |
| PUT | `/admin/pass-comments` | `{ examType, comment }`。`comment` が空/null で削除 |

### 危険な操作

| メソッド | パス | 説明 |
|---|---|---|
| POST | `/admin/direct-delete` | `{ email }` → Cognito から sub を引き、そのユーザーの**全データを削除**（アカウント自体は残る） |

---

## 4.9 パフォーマンス上の設計判断

実装に散らばっている「なぜこう書いてあるか」をまとめる。**単純化する前に読むこと。**

| 実装 | 理由 |
|---|---|
| `queryAll` / `scanAll` / `queryCountAll` でページを全部たどる | 単発 Query は1MB上限で打ち切られる。`examType-index` は射影 ALL・1件平均5.5KB なので MLA 333件中162件しか返らなかった |
| `batchGetQuestions` が BatchGetItem ではなく GetItem 並列 | IAM に BatchGetItem 権限が無い |
| `getExamQuestionIdSet(poolOnly)` | 既習判定の母集団を `GET /questions` と一致させる。ズレると未回答数が過大になる |
| `_examQuestionsCache` / `warmCached` | ウォームインスタンス内メモリ。ユーザー増加時の RCU 削減 |
| `metaOnly` / `idsOnly` / `withAnswers` の3段階 | プログレッシブロード。1問目だけ取って残りは背後で読む |
| `pruneUserSessions` の件数キャップ | UserAnswers の TTL 方式は廃止。Sessions の SK は UUID で時系列順でないため `endedAt` でソートしてから切る |
| `GET /admin/questions/flagged` の `auditCount` 別Scan | filter が audit 以外だと matched に含まれずバッジ件数が出せない |
