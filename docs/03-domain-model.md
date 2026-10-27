# 03. ドメインモデル

## 3.1 DynamoDB テーブル一覧

すべて `ap-northeast-1` / オンデマンド課金（PAY_PER_REQUEST）。

`-dev` / `-prod` 接尾辞が付くのは `lambda/src/app.js` の `SPLIT_TABLES` に列挙されたテーブルのみ。
本人のアカウントだけは毎晩、検証→本番へ写している（`docs/07-operations.md`「本人のアカウントの成績の同期」）。

| テーブル | PK | SK | 分離 | 内容 |
|---|---|---|---|---|
| `Questions` | `questionId` | — | 共有 | 問題本体（約4,900件） |
| `QuestionTagRelations` | `tagId` | `questionId` | 共有 | 旧タグ紐付け（**現在は書き込まれない・削除時に掃除のみ**） |
| `Tags` | — | — | 共有 | 旧タグマスタ（**未使用**） |
| `Reports` | `questionId` | `reportId` | 共有 | ユーザー通報 |
| `Tips` | `tipId` | — | 共有 | 演習中に出るコラム |
| `ColumnIdeas` | `ideaId` | — | 共有 | コラムのネタ（管理者投稿→Tips化） |
| `Releases` | `releaseId` | — | 共有 | リリースノート |
| `Announcements` | `announcementId` | — | 共有 | お知らせ |
| `ContactMessages` | `messageId` | — | 共有 | 問い合わせ |
| `DailyServices` | `serviceId` | — | 共有 | 日めくりAWSサービス記事 |
| `CheatSheetDeletions` | `itemKey` | — | 共有 | チートシート項目の削除予定フラグ（オーバーレイ） |
| `AppSettings` | `settingId` | — | 共有 | **汎用KVS**（後述） |
| `Sessions{-env}` | `userId` | `sessionId` | 分離 | 演習/模試セッション |
| `UserAnswers{-env}` | `userId` | `questionIdTimestamp` | 分離 | 回答ログ |
| `UserQuestionStats{-env}` | `userId` | `questionId` | 分離 | 問題別の正誤カウント・ブックマーク |
| `UserTagStats{-env}` | `userId` | `tagId` | 分離 | ドメイン別の直近正誤 |
| `UserPoints{-env}` | `userId` | — | 分離 | ポイント残高 |
| `EncyclopediaUnlocks{-env}` | `userId` | — | 分離 | 図鑑の解放状況 |
| `UserEntitlements{-env}` | `userId` | — | 分離 | おひねり購入（`ohineri`, `stripeSessionId`, `amount`, `purchasedAt`）。**アカウント削除でも消さない**（決済記録のため）。specs/006 |
| `UserDailyCounts{-env}` | `userId` | `date`（JST `YYYY-MM-DD`） | 分離 | 1日の演習回答数 `answered`。`expiresAt`（TTL・3日）で自動削除 |

### GSI

| テーブル | GSI | キー | 射影 |
|---|---|---|---|
| `Questions` | `examType-index` | `examType` (HASH) | ALL |

**GSI はこれ1本だけ。** 他のアクセスパターンは Scan + FilterExpression か、
テーブル Query + クライアント側フィルタで実装されている。

## 3.2 Questions

出題プールの中核。**`validityCheckedAt` が付いていない、または `isHidden` の問題は出題されない。**

```
items.filter(q => !q.isHidden && !!q.validityCheckedAt)
```

| 属性 | 型 | 説明 |
|---|---|---|
| `questionId` | S | `` `${examType.toLowerCase()}-${uuid8}` `` 例: `saa-3f2a1b9c` |
| `examType` | S | `CLF` 〜 `SEC`（16種） |
| `domain` | N | **整数 index。** `EXAM_DOMAINS[examType][domain]` が表示名 |
| `questionText` | S | 問題文 |
| `choices` | L(S) | 選択肢。**`"A. "` 等のラベル接頭辞は保存時に除去される** |
| `correctAnswerIndices` | L(N) | **正解の正準キー。** `choices` のインデックス |
| `correctAnswers` | L(S) | `correctAnswerIndices` から**派生**（選択肢テキスト編集時のドリフト防止） |
| `choiceExplanations` | L(S) | 選択肢ごとの解説。**存在するなら `choices` と同数** |
| `explanation` | S | 全体解説 |
| `isMultiple` | BOOL | 複数選択問題か（未指定なら `indices.length > 1`） |
| `questionTextEn` / `choicesEn` / `explanationEn` | S/L | 英語版（任意）。**英語対応は廃止済みのため現在は表示されない**。データは残存 |
| `createdAt` / `updatedAt` | S | ISO8601 |
| `globalAttempts` / `globalCorrect` | N | 全ユーザー累計の試行/正解数（ゲスト含む）。正解・選択肢を編集すると**リセットされる** |

### 品質管理フラグ（夜間バッチが操作）

| 属性 | 付ける人 | 意味 |
|---|---|---|
| `validityCheckedAt` | `02-check-validity.sh` | **事実正確性の検証済み＝出題プール入場券** |
| `validityRating` | 同上 | 1〜5。`<= 2` は管理画面「要確認」に出る |
| `validityNote` | 同上 | 検証コメント |
| `validityEditLog` | 同上 | AI が修正した履歴。存在＝「AI修正済み」バッジ |
| `fixProposalJson` | 同上 | 未適用の修正案。管理画面から apply / reject。2026-10-28〜、**正解の位置が変わる修正**は自動で反映せずここに入る |
| `humanReviewRequestedAt` / `reviewReason` | 02・`sample-human-review.py` | **人の確認待ち**。`answer-change`（AI が正解を変えようとした。非表示）/ `ai-delete`（AI が削除を提案。非表示）/ `sample`（月1回の抜き取り検査）/ `answer-changed-past`（2026-10-27 以前に AI が正解を変えた問題） |
| `humanReviewedAt` / `humanReviewResult` / `humanReviewReason` / `humanReviewNote` | 管理者 | 人の確認の結果。`ok` / `ng` / `fix-applied` / `fix-rejected`。抜き取りの不良率は `humanReviewReason=sample` の ok/ng から出す（日次レポート） |
| `formatCheckedAt` | （旧 `06-fix-format.sh`・2026-10-27 削除。既存データに残るだけ） | 体裁チェック済み |
| `linebreakCheckedAt` | `09-check-linebreaks.sh` | 改行整形済み（Haiku・非空白文字の変化は破棄） |
| `translationCheckedAt` | （旧 `03-check-translation.sh`・2026-10-27 削除。既存データに残るだけ） | 翻訳チェック済み |
| `auditNote` / `auditFlaggedAt` | `audit-questions.sh` | 監査で「易しすぎ・模試不適」等を指摘（事実誤りではないので自動修正されない＝人の判断が要る） |
| `isHidden` | 管理者 | 非表示（出題プールから除外） |
| `scheduledDeletionReason` / `scheduledDeletionDate` | 管理者 | 予約削除。`check-scheduled-deletions.sh` が当日以前を実削除 |

### 書き込み時の不変条件（`buildQuestionWriteFields`）

インポート（`POST /admin/questions`）と更新（`PUT /admin/questions/:id`）で共通。破ると 400。

1. `choices.length >= 2`
2. `correctAnswerIndices` を正準として決定（明示指定 > `correctAnswers` からの逆引き）
3. 重複除去・範囲チェック・ソート後、`length === 0` ならエラー
4. `correctAnswers` は `indices` から**再生成**（渡された値は捨てる）
5. `choiceExplanations` があるなら `choices` と同数
6. `isMultiple` 未指定なら `indices.length > 1`

## 3.3 ユーザーデータ

### Sessions

| 属性 | 説明 |
|---|---|
| `userId` / `sessionId` | PK / SK（sessionId は UUID・**時系列順ではない**） |
| `mode` | `'exercise'` \| `'exam'` |
| `examType` | 対象資格 |
| `questionIds` | 出題した問題ID配列 |
| `status` | `'active'` \| `'completed'` |
| `sessionType` | `'quick'`\|`'focused'`\|`'practice'`\|`'exam'`\|`'mini'`（再開の4種独立に使う） |
| `isMini` / `isFocused` | 旧来のフラグ（`sessionType` 未設定の行の判別用） |
| `startedAt` / `lastAnsweredAt` / `endedAt` | ISO8601 |
| `score` / `isPassed` | 完了時に確定 |
| `draft` / `draftSavedAt` | **中断再開用。完了時に REMOVE される** |

**保持上限**: `SESSION_RETENTION_LIMIT = 365`。セッション完了時に `pruneUserSessions()` が
`endedAt || startedAt` 降順で365件を超える分と、その `UserAnswers` を削除する。

**再開の判定**（`GET /users/me/active-sessions`）:
- `status === 'active'` かつ `draft != null` かつ `endedAt` が無い
- `draftSavedAt` が7日以内（`RESUME_MAX_AGE_MS`）
- 種別ごとに `draftSavedAt` が最新の1件だけ返す

> 7日フィルタは「完了処理を取りこぼした孤児セッションが永久に『演習中』表示される」不具合の対策。

### UserAnswers

SK が `` `${sessionId}#${questionId}#${ISO8601}` `` という**複合文字列**。
`begins_with(questionIdTimestamp, "<sessionId>#")` でセッション単位に絞れる設計。

同じ問題を複数回解けば行が増える（追記型）。

### UserQuestionStats

**演習量・既習判定の唯一の真実源。**

| 属性 | 説明 |
|---|---|
| `correctCount` / `incorrectCount` | 累計（`ADD` でアトミック加算） |
| `lastAnsweredAt` | 最終回答日時 |
| `bookmarked` | BOOL |

- **「既習」= この行が存在すること**（`answered`）
- **「解いた問題数」= `correctCount + incorrectCount` の総和**
  （保存カウンタ方式はトランザクション競合でドリフトしたため廃止。毎回集計する）
- `weak` = `correctCount / (correct+incorrect) <= 0.75`
- ブックマークのみの行は `correctCount`/`incorrectCount` が無い（`lastAnsweredAt` は `if_not_exists` で入る）

### UserTagStats

| 属性 | 説明 |
|---|---|
| `tagId` | **正準キーは `` `${examType}_${index}` ``**（例 `SAA_0`） |
| `recentResults` | 直近**30件**の正誤 boolean 配列（ローリング窓） |

> 旧形式の裸 index（`"0"`, `"1"`…）が残っている可能性がある。これは**全資格で共有されるキー**のため、
> `DELETE /users/me/data` は正準形式のみを削除対象にしている（他資格を巻き込む事故の回避）。

`correctCount` / `incorrectCount` は**このテーブルには書き込まれない**。
`GET /users/me/stats?examType=` は `UserQuestionStats` から集計してマージした値を返す
（別ソースを持つとズレるため、集計元を「未回答フィルタと同じ `UserQuestionStats`」に統一している）。
同じ理由で、`examType` 指定時は `recentResults` も `UserAnswers` から作り直した値で置き換える
（このテーブルの `recentResults` はセッション単位の送信で抜け・二重があった。2026-10-27）。

## 3.4 AppSettings（汎用KVS）

`settingId` 1つで全く異なる用途のレコードが同居している。**実質スキーマレス。**

| settingId | 内容 |
|---|---|
| `admins` | 追加管理者メール（JSON文字列） |
| `theme` | カスタムカラー（`colors` JSON文字列 + `enabled`） |
| `about` | About ページのセクション本文 |
| `passComments` | 資格別の合格コメント |
| `userPrefs_<userId>` | ユーザー設定（後述） |
| `userReset_<userId>` | データ初期化時刻（クライアントの localStorage リセット判定用） |
| `scoreHistData_<userId>_<examType>` | スコア履歴 |
| `dailyProgress_<userId>` | 日次演習カウント（属性名が `<examType>_<YYYY-MM-DD>` と `total_<examType>`） |

### `userPrefs_<userId>`

| 属性 | 説明 |
|---|---|
| `targetExam` | 目標資格 |
| `examDates` | `{ examType: 'YYYY-MM-DD' }` 受験日 |
| `dailyGoal` | 1日の目標問題数 |
| `obtainedCerts` | 取得済み資格の配列 |
| `readAnnouncementIds` | 既読お知らせID |
| `kv` | **汎用KV同期マップ**（後述） |

### `scoreHistData_<userId>_<examType>`

| 属性 | 説明 | 上書きガード |
|---|---|---|
| `scoreHistory` | `[{date, score}]` 日次・最大30件 | 日付でマージし各日の**最大点**を保持 |
| `sessionScoreHistory` | セッション毎スコアの数値配列 | **受信が既存より短ければ無視** |
| `sessionScoreLog` | `[{date, score}]` | 同上 |

> クライアントのレース・キャッシュクリア・別オリジンで蓄積が消えるのを防ぐためのガード。
> 「短い配列で上書きさせない」という防御は API 側にある。

### `dailyProgress_<userId>`

`POST` が `ADD`（`if_not_exists(#k, 0) + n`）でアトミック加算するため、複数デバイスの同日演習が正しく合算される。
属性が100個を超えると `GET` 時に14日より古い日付属性を最大80件ベストエフォートで削除する。

## 3.5 DailyServices

日めくりAWSサービス記事。

| 属性 | 説明 |
|---|---|
| `serviceId` | UUID |
| `name` / `shortName` / `category` | サービス名 |
| `icon` | アイコンファイル名 or 絵文字 |
| `description` / `trivia` / `docUrl` | 本文 |
| `order` | 表示順 |
| `isActive` | false なら抽選・図鑑母数から除外 |
| `deprecationNote` / `deprecationStatus` | 廃止予定の警告（`05-check-daily-services.sh` が付与） |

**抽選対象の条件（`isServiceUnlockable`）**:
```
serviceId !== '_schedule_' && isActive !== false && icon が非空文字列
```
アイコン未設定を抽選すると「解放しても絵が出ない」体験になるため除外。
除外したものは母数（`?list=1`）からも外す（母数に残すと 100% に到達できない）。

### `_schedule_` 特殊レコード

`serviceId = '_schedule_'` の1行が**匿名ユーザー向けの日替わりスケジュール**を保持する。

| 属性 | 説明 |
|---|---|
| `schedule` | `{ "YYYY-MM-DD": serviceId }` JSON文字列。直近90日分のみ保持 |
| `queue` | 全サービスIDをシャッフルした配列（JSON文字列） |
| `pointer` | queue の消化位置。使い切ったら再シャッフル |

キュー方式により全サービスを偏りなく一巡してから繰り返す。

**ログインユーザーは別ロジック**: `userId + JST日付 (+ rerollSeed)` のハッシュで
「まだ解放していないサービス」から選ぶ（常に初めまして）。

## 3.6 クライアント側の永続化

### localStorage（ユーザーID接尾辞付き）

| キー | 用途 | kvSync 同期 |
|---|---|---|
| `targetExam_<uid>` | 目標資格 | ✅（preferences 経由） |
| `examDate_<et>_<uid>` | 受験日 | ✅（preferences 経由） |
| `dailyGoal_<uid>` | 日次目標 | ✅（preferences 経由） |
| `quickExercisePrefs_<uid>` | サクッと演習の設定 | ✅ |
| `focusedExercisePrefs_<uid>` | しっかり対策の設定 | ✅ |
| `exercisePrefs_<uid>` / `examPrefs_<uid>` | 演習・模試の設定 | ✅ |
| `lastQuickMode_<uid>` | ホームの quick/focused トグル | ✅ |
| `dailyGoalReward_<uid>_<date>` | 日次目標報酬の付与済みフラグ | ✅（14日で剪定） |
| `score_prev_<et>_<uid>` | 前回の予想スコア（差分表示用） | ✅ |
| `scoreWindow_<uid>` | 予想スコアの窓（5 or 10） | ✅ |
| `theme_<uid>` | ライト/ダーク | ✅ |
| `sherpaExamHint_<uid>` 等 | ヒント消去フラグ | ✅ |
| `quickExerciseDraft_<uid>` 他3種 | **中断再開ドラフト** | ❌（サーバ `Sessions.draft` が担当） |
| `domain_history_<et>_<uid>` | ドメイン別の直近10セッション成績 | ❌（意図的除外） |
| `domain_results_<et>_<uid>` | ドメイン別の直近30問正誤 | ❌（意図的除外） |
| `dailyQCount_<et>_<uid>_<date>` | 当日演習数のミラー | ❌（サーバがアトミック加算） |
| `userPoints_<uid>` | ポイント残高 | ❌（専用API） |
| `encyclopediaServices` / `encyclopediaUnlocks*` | 図鑑 | ❌（専用API） |
| `focusedUnlockedCache_<uid>` / `focusedUnlockCelebrated_<uid>` | Focused 解放状態 | ❌ |
| `_kvmeta_<uid>` | kvSync の更新時刻メタ | — |

> **`domain_history_` / `domain_results_` を kvSync 対象にしてはいけない。**
> これらは配列を蓄積する「まるごとブロブ」で、キー単位の LWW 上書きだと初回プル時に
> サーバの古い/部分データがローカルの蓄積を消す。ドメイン別成績はサーバの
> `/users/me/stats` + `/users/me/domain-results` で別途同期されている。

### localStorage（ユーザー非依存）

`theme`, `cookie_consent_v1`, `guestBannerHidden`, `adminActiveTab`,
`mk_had_session`, `mk_onboarding_tutorial_done_v1`, `activeExerciseDraft`,
`customColors_v2`, `_lsc_*`（永続キャッシュ）

### sessionStorage

- `_sc_*` — `utils/cache.ts` の短期キャッシュ
- `__nav_state__` — compat 層の画面間 state 受け渡し（読んだら消える）

## 3.7 デバイス間同期（kvSync）

`src/utils/kvSync.ts`。**ログイン時のみ**動作する。

```
localStorage.setItem/removeItem をモンキーパッチ
  → SYNC_PREFIXES に一致し、現在の uid を含むキーの書き込みを検知
  → 1.5秒デバウンス → PUT /users/me/preferences { kvPatch: { key: {v, t} } }

起動時 / 画面復帰時（5分スロットル）
  → GET /users/me/preferences
  → キーごとに Last-Writer-Wins（サーバの t > ローカルの meta[k] なら反映）
  → 反映したキーを CustomEvent('kvSynced', {detail:{keys}}) で通知
```

- `v === null` は**削除トゥームストーン**
- サーバ側の剪定: 日付付きカウンタ系は14日、通常90日、トゥームストーンは30日
- 1キー8KB上限・キー名200文字上限
- メモリ上に状態を持つ購読者（`ThemeContext` など）は `kvSynced` イベントを購読して再読込する

## 3.8 データ削除の3系統

| API | 対象 | 残るもの |
|---|---|---|
| `DELETE /users/me/data?examType=` | **その資格のみ**の統計・セッション・回答・スコア履歴 | 他資格のデータ・ポイント・図鑑 |
| `POST /users/me/reset` | 全資格の演習データ・図鑑・ポイント・設定・日次進捗 | Cognito アカウント（メール・パスワード） |
| `POST /admin/direct-delete` | 管理者がメール指定で全削除（+ 通報も削除） | Cognito アカウント |

いずれも完了時に `AppSettings.userReset_<userId>` に `resetAt` を記録し、
クライアントが localStorage を掃除する判断材料にする。

> `executeUserDataReset`（reset）と `executeUserDataDeletion`（admin）は**別実装**で、
> 消す範囲が微妙に違う（→ [08-refactor-plan.md](08-refactor-plan.md)）。
