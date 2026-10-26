# 05. 画面仕様

## 5.1 ルーティング一覧

`app/` 配下の `page.tsx` は薄いラッパーで、実体は `src/views/`。
アプリ本体（`/aws/*`）はすべて `dynamic(..., { ssr: false })` でクライアント専用。

| URL | View | SSR | 認証 | 概要 |
|---|---|---|---|---|
| `/` | `Portal.tsx` | ✅ | 不要 | LP（サービス紹介） |
| `/aws/` | `Home.tsx` | ❌ | 不要 | **アプリのホーム。演習の起点** |
| `/aws/practice` | `Practice.tsx` | ❌ | 不要 | トレーニング（演習/模試のカスタム設定） |
| `/aws/exercise/session` | `ExerciseSession.tsx` | ❌ | 不要 | 演習の解答画面（即時採点） |
| `/aws/exam/setup` | `ExamSetup.tsx` | ❌ | 不要 | 模試の設定 |
| `/aws/exam/session` | `ExamSession.tsx` | ❌ | 不要 | 模試の解答画面（時間制限） |
| `/aws/result` | `Result.tsx` | ❌ | 不要 | 採点結果 |
| `/aws/mypage` | `MyPage.tsx` | ❌ | **要** | 学習状況・苦手分析・ブックマーク |
| `/aws/stats` | `Stats.tsx` | ❌ | **要** | 成績・履歴 |
| `/aws/encyclopedia` | `ServiceEncyclopedia.tsx` | ❌ | 不要 | AWSサービス図鑑（解放制） |
| `/aws/cheatsheet` | `CheatSheet.tsx` | ❌ | 不要 | 資格別チートシート（静的データ） |
| `/aws/exam-dashboard` | `ExamDashboard.tsx` | ❌ | 不要 | 全資格の進捗ダッシュボード |
| `/aws/announcements` | `Announcements.tsx` | ❌ | 不要 | お知らせ |
| `/aws/release-notes` | `ReleaseNotes.tsx` | ❌ | 不要 | リリースノート |
| `/aws/others` | `Others.tsx` | ❌ | 不要 | その他メニュー・問い合わせ。**最下部**に「おひねり」ボタン（ログイン中かつ機能が有効なときだけ） |
| `/aws/ohineri` | `Ohineri.tsx` | ✅ | 必須 | おひねりの案内・購入（1日の上限の残り表示・Stripe 決済へ遷移・決済後の確認）。specs/006 |
| `/login` | `LoginPage.tsx` | ❌ | 不要 | Amplify Authenticator |
| `/account` | `Account.tsx` | ❌ | 不要 | アカウント設定・データ削除 |
| `/about` | `About.tsx` | ✅ | 不要 | サイト情報 / プライバシー / 利用規約 / 運営者情報 |
| `/architecture` | `ArchitecturePage.tsx` | ✅ | 不要 | サイト構成図（技術紹介） |
| `/privacy-policy` | (inline) | ✅ | 不要 | SEO 用プライバシーポリシー |
| `/admin` | `Admin.tsx` | ❌ | **管理者** | 管理画面 |
| `/admin-login` | `AdminLogin.tsx` | ❌ | 不要 | 管理者ログイン |

### レイアウト

`app/aws/layout.tsx` が `src/components/Layout.tsx` を適用する（クライアント側は `app/aws/AwsShell.tsx`）。`/aws/*` 以外は素の画面。

**タブ名（`<title>`）**: ルートの `app/layout.tsx` は `'use client'` で metadata を書けないため、
`app/aws/layout.tsx`（サーバーコンポーネント）が `template: '%s | 無限ノック'` を持ち、
各ルートの `layout.tsx` が画面名だけを `title` に書く（例: `app/aws/practice/layout.tsx` → 「トレーニング | 無限ノック」）。
`/login`・`/account`・`/about`・`/architecture` も同様に `layout.tsx` で付ける。新しいルートを足すときは `layout.tsx` も足す。

`Layout.tsx`（1,288行）の責務:
- デスクトップ: 左サイドナビ（ホーム / トレーニング / マイページ + 図鑑・チートシート・お知らせ・リリースノート）
- モバイル: 下部タブバー（ホーム / トレーニング / マイページ）
- ヘッダー（ロゴ・お知らせベル・アカウント）、パンくず、フッター
- キーボードナビゲーション、問い合わせモーダル、AI（ChatGPT/Gemini/Claude）へのリンク
- 画面の見出し（h1）: スマホはヘッダー左に画面名を表示、PC はパンくずに出るので読み上げ用に視覚的に隠す（資格ダッシュボードは自前の h1）
- サイドバーの開閉はパンくずバー左のメニューボタン（≡）だけ。開いていても×にしない
- `<main>` は縦の flex で、中身が短い画面でもフッターを下端に置く
- オーバーレイ（`data-kbscope`）は `role="dialog" aria-modal="true"`。Cookie バナーは `role="region"`

### ブレークポイント

`window.innerWidth < 768` が `isMobile`。**各画面が個別に resize リスナーを持っている**
（`src/hooks/useWindowWidth.ts` はあるが、多くの画面が使っていない）。

---

## 5.2 Home（`/aws/`）— 3,217行

**アプリの中心。ここから全ての演習が始まる。**

### セクション構成

```
[ゲストバナー]（未ログイン時）
[オンボーディングモーダル]（targetExam 未設定時）
─────────────────────────
 モバイル: 縦1列
 デスクトップ: 2カラム（左 2fr / 右 1fr）
─────────────────────────
 デスクトップは役割で左右を分ける（タブによる出し分けはしない）
 左カラム 2fr =「成績」これまでの結果を見る
   実力の現在地   … CombinedDetailModal `inline="score"`
     予想スコアとドメイン別内訳は同じデータの粒度違いなので、サマリー(バー)と
     内訳(ノード)を二重に出さずこの1パネルに統合している
   推移と記録     … CombinedDetailModal `inline="trend"`
     セッション別推移・日次最高点・ハイスコア記録を縦に並べる
     日次最高点は「その日の最高値」なので、ホームの現在値より高いのは仕様

     ■ スコア履歴の記録ルール（グラフと実データをずらさないための決まり）
     ・記録は成績の再取得(statsSynced)が終わってから行う。待たずに書くと、ページを
       開いた時点の古いキャッシュから計算した点が残り、ホームの表示とグラフがずれる
       （実際に、その日に取っていない点が日次最高点になる事故が 2026-10-20 に発生）
     ・各記録は「直近N問」設定を w として一緒に残す。予想スコアは N で計算が変わるので、
       N の違う点を同じ線に並べない。グラフは現在の N と一致する点だけを描く
       （w の無い古い記録は判別できないため現在の N とみなす）
     ・セッション別推移は sessionScoreLog から取る。sessionScoreHistory は素の数値配列で
       記録時の N を判別できないため。両者の中身は一致する（log の末尾10件）
     ・日次最高点の横軸は日付に比例させる。演習しなかった日は履歴に行が無いので、
       等間隔に描くと 2日空きが1日分と同じ幅になり時間軸が歪む
 右カラム 1fr =「今日の行動」今日やること
   目標演習量
   今日のサービス（日めくり）
   苦手分析（ログイン専用。ゲストは非表示）
     マイページ苦手分析タブの要約（苦手ドメイン上位2件・頻出ミス問題2件）。
     20問未満は「あとX問でアンロック」。クリックで /aws/mypage（苦手分析タブ）へ
     右カラムを flexDirection:'column' にし、苦手分析カードに flex:1 を付けて
     左カラムの下端（ページ最下部）までパネルの底を揃える

 モバイルは従来どおり縦一列（変更なし）
   目標演習量 → 予想スコア + ドメイン別正答率 → 今日のサービス
   サマリーをタップで CombinedDetailModal（タブ付きモーダル）
─────────────────────────
 プライマリ演習ボタン
   ├ サクッと演習（quick）        … 常時
   └ しっかり対策（focused）      … ログイン + 20問解答で解放
   （再開ドラフトがあれば「再開する」表示）
─────────────────────────
```

### 主要 state

| state | 由来 | 説明 |
|---|---|---|
| `targetExam` | `localStorage.targetExam_<uid>` | 未設定ならオンボーディング表示 |
| `quickDraft` / `focusedDraft` | `localStorage.*Draft_<uid>` | 起動時に `hydrateDraftsFromServer()` でサーバ分を補完 |
| `answeredCount` | `GET /users/me/question-stats` | Focused 解放判定（20問） |
| `domainStats` | `GET /users/me/stats` | stale-while-revalidate（sessionStorage キャッシュ） |
| `estimatedScore` | `domainStats` から算出 | → [06-exercise-logic.md](06-exercise-logic.md) |
| `lastMode` | `localStorage.lastQuickMode_<uid>` | どちらをプライマリに出すか |

### 起動時のデータ取得

```
authLoading 解除
  → targetExam を localStorage から読む（無ければオンボーディング）
  → hydrateDraftsFromServer(userId)     … GET /users/me/active-sessions + GET /questions?ids=
  → GET /users/me/question-stats        … answeredCount（Focused 解放判定）
  → GET /users/me/stats                 … domainStats（SWR: キャッシュ即表示→背後で更新）
  → GET /users/me/score-history         … スコア推移
  → GET /daily-service?userId=          … 今日のサービス
```

### 注意点

- 目標資格の選択（`ExamSelectOverlay`）の決定は、文字入りの主ボタン「<資格> を目標にする」。
  押すとパーティクルを出し「<資格> を学習中」に変わって反映する（以前のアイコンだけのフリップボタンと、動き続ける矢印は廃止）
- 予想スコアが未算出（未演習）のときは、大きな「—」ではなく「演習すると予想スコアが表示されます」と出す
- 右カラムの「苦手分析」は、未解放のときは縦に伸ばさない
- `uid` は `user?.userId ?? 'guest'`。**認証確定前は `'guest'` で localStorage を読んでいる**ため、
  `user` 確定時に正しい uid で再読込する `useEffect` が必要（既にある）
- 演習開始時は `autoScoreAndClearDrafts(userId, [quick, focused])` で**プライマリ枠2種のみ**確定。
  practice / exam のドラフトは残す
- ドラフト破棄と `targetExamChanged` / `pointsChanged` / `kvSynced` の CustomEvent 購読が多数ある
- サクッと演習・しっかり対策の設定モーダルには、対応する前提知識(オリジナル資格)がある
  targetExam（AIF/MLA/AIP/DEA/ANS/SCS）の時のみ「前提知識を含める」トグルが出る（既定ON）。
  出題プールへの混在の仕組みは → [06-exercise-logic.md](06-exercise-logic.md) §6.1・
  `specs/003-original-exam-blend`

---

## 5.3 Practice（`/aws/practice`）— トレーニング

タブで「演習」と「模試」を切り替える。**オリジナル（非AWS）カードでは模試タブを出さない**
（`isNonAwsExam(targetExam)` なら `tab === 'exam'` を強制的に `'exercise'` へ戻す）。

### 演習タブ

設定: 資格 / ドメイン選択 / 問題数 / 回答状況フィルタ（未回答・不正解・未正解）/ ブックマーク優先 /
前提知識を含める（対応資格があり、全ドメイン選択時のみ表示・既定ON）。
設定は `localStorage.exercisePrefs_<uid>` に保存され kvSync で同期される。

目標資格が未設定のとき（ゲストが直接 URL を開いた場合など）は、設定欄の代わりに
「まだ目標資格が選ばれていません」と「目標資格を選ぶ」ボタン（ホームへ遷移し、選択オーバーレイが開く）を出す。模試タブも同じ。

開始時のフロー:
```
GET /questions?examType=&idsOnly=true&domain=&<filters>&userId=
  → 先頭 count 件を採用（サーバ側でフィルタ優先＋ドメイン均等化済み）
  → 足りなければ フィルタ無しで再取得して補充
GET /questions?ids=<1問目>&withAnswers=true
  → navigate('/aws/exercise/session', { state: { createSession, questions, questionIds, ... } })
```

### 模試タブ

`EXAM_CONFIGS[examType]` の問題数・制限時間が既定。ミニ模試（`isMini`）も選べる。
`navigate('/aws/exam/session', { state: { sessionId, questions, timeLimitMin, isMini } })`。

---

## 5.4 ExerciseSession（`/aws/exercise/session`）— 1,658行

演習（quick / focused / practice）共通の解答画面。**1問ずつ即時採点・解説表示。**

### 起動

`location.state` から受け取る:

| キー | 説明 |
|---|---|
| `createSession` | `POST /sessions` のリクエストボディ。**遷移先で非同期に作成**（体感速度のため） |
| `questions` | 最初に表示する問題（1問だけのこともある） |
| `questionIds` | 全問のID。残りはプログレッシブロード |
| `spareQuestionIds` | 予備ID。削除済み等で読めないIDが出ても問題数を満たすため |
| `isQuick` / `isFocused` / `isMini` | 種別フラグ |

state が無ければ `localStorage` のドラフトから復元。それも無ければ `/aws/` へ戻る。

### 見出し「問題 N」の∞バッジ

公式資格の演習（例: MLA）には、既定で基礎知識資格（ML/DB/NW/SEC）の問題が混ざる
（[06-exercise-logic.md](06-exercise-logic.md) §6.1）。解いている最中にどちらの資格の問題か
分かるよう、**基礎知識資格の問題のときだけ**「問題 N」の右に∞アイコン（`IconInfinity`）を出す。

- 条件: `isNonAwsExam(問題.examType) && 問題.examType !== 演習の資格`
- **基礎知識資格そのものの演習（ML を解いているとき）は出さない。** 全問が該当して意味がないため
- 色は資格カードと同じ `EXAM_LEVEL_COLORS[EXAM_LEVEL[examType]]`（Additional = ティール）
- `title` / `aria-label` に「基礎知識資格の問題（機械学習）」。モバイルではタップしても title は出ない
- デスクトップ・モバイル共通（分岐なし）

### プログレッシブロード

```
1問目を表示 → 背後で GET /questions?ids=<次のバッチ>&withAnswers=true
```
問題数が増えても開始が一定時間で済むようにするための根本対策。

### 解答時

```
選択 → 採点（correctAnswerIndices と比較）
     → 即時に正誤・解説・choiceExplanations を表示
       （各選択肢の右に「✓ 正解」「✓ 正解（あなたの回答）」「✗ あなたの回答」を出す。色だけで正誤を示さない）
     → POST /sessions/:id/answers（非同期・待たない）
     → PUT /sessions/:id/progress でドラフト保存
```

回答/次へボタンは画面下に固定（PCは右下、スマホは下部タブの上の帯）。どちらもオレンジの主ボタンで、
回答できない間は灰色の塗り（半透明にしない。下の選択肢が透けて文字が重なったため）。
スマホの帯は白背景＋上向きの影。本文の最後に固定ボタンぶんの余白を入れ、解説・コラムに重ならないようにする。

### 完了時

```
score = 正解数 / 問題数 * 100
isPassed = score >= PASS_RATE[examType]（ミニ模試は 1/5 に緩和）
PUT /sessions/:id { status:'completed', score, isPassed }
recordSessionDomainStats()  → localStorage + PUT /users/me/domain-results
incrementDailyProgress()    → POST /users/me/daily-progress
addPoints()                 → PUT /users/me/points
localStorage からドラフト削除・activeExerciseDraft ポインタ削除
navigate('/aws/result', { state: { results, questions, score, ... } })
```

`activeExerciseDraft`（uid 無しの単一キー）は「今どの種別のドラフトがアクティブか」を指すポインタ。

### その他の機能

- **アクション列** `[👍][👎][コピー][♡][⋮]`（左揃え） — 回答前は選択肢の下、
  回答後は解説の下に同じ並びで表示する（`renderActionRow()`）。回答の前後で
  ♡等の位置が変わらないようにするため、共通関数で描画している。
  - **コピー** — 回答前＝問題文＋選択肢、回答後＝問題文＋選択肢＋解答解説をクリップボードへ
  - **♡（ブックマーク）** — `POST/DELETE /questions/:id/bookmark`。旧・見出し右の☆から移動。
    ONにした瞬間だけピンクのパーティクルバースト（`ConfirmBurst` 流用）
  - **👍👎（リアクション）** — `PUT /questions/:id/reaction`。ログイン専用・1ユーザー1問1票
    （`UserQuestionStats(userId,questionId)` の単一属性上書きで構造的に保証）。
    ONにした瞬間だけポップ演出、色は「しっかり対策」開始ボタンと同じ青緑(`--color-points`)。
    詳細は `docs/04-api.md` §4.3b、`specs/002-question-reactions/`
  - **⋮** — 「この問題を通報」（`ReportModal` → `POST /questions/:id/report`）／
    「ここまでで採点」（`setShowAbortConfirm`）のメニューを開く
  - **送信はデバウンス**: ♡/👍👎はクリックのたびに送信せず、UIだけ即時反映して
    実送信は①回答確定②別の問題へ移動③画面離脱、のいずれか最初のタイミングで
    まとめて1回行う（`pendingBookmarkRef`/`pendingReactionRef` + `flushBookmark`/
    `flushReaction`）。同一セッション内で前の問題に戻って評価を変更するケースは
    ②（`currentQuestion.questionId` の変化を監視するeffect）で拾う。
    詳細は `docs/04-api.md` §4.3b
- **PromptMenu（質問プロンプト生成）** — 2026-09-15 廃止。`specs/002-question-reactions/` 参照
- **コラム** — `GET /tips?examType=` を問題間に挟む
- **「わからない」** — 選択肢とは別の回答（`WAKARANAI` 定数）

---

## 5.5 ExamSetup / ExamSession（模試）

### ExamSetup（`/aws/exam/setup`）

ステップ形式（`StepRow`）で設定:
1. 資格
2. 出題ドメイン（任意）
3. 問題数・制限時間（`EXAM_CONFIGS` 既定 or ミニ）
4. フィルタ（未回答 / 不正解 / ブックマーク）

`GET /users/me/stats` でドメイン別正答率を表示し、`GET /users/me/sessions` で過去の模試結果を見せる。

### ExamSession（`/aws/exam/session`）

- **時間制限あり**（`timeLeft` をカウントダウン。0で自動提出）
- **即時採点しない**。全問解いてから一括提出
- 問題一覧パネルで未回答・フラグ付きを俯瞰できる
- `PUT /sessions/:id/progress` で `{ currentIndex, answers, timeLeft }` を定期保存
- 提出時に全問の `POST /sessions/:id/answers` を送ってから `PUT /sessions/:id`

`location.state` が無ければ `/aws/exam/setup` へ `replace` で戻る。

---

## 5.6 Result（`/aws/result`）

`location.state` で結果を受け取る（**API 再取得しない**）。

表示: スコア / 合否 / 獲得ポイント / 日次ボーナス / 問題別の正誤と解説。

「もう一度」ボタンの遷移先が種別で分岐する:
- `isFocused` → `/aws/` に `{ startFocused: true }` を渡して再開
- `isQuick` → 同じ条件で `GET /questions?idsOnly=true` して `/aws/exercise/session`
- 模試（`isExam && !isQuick`）→ `/aws/exam/setup`

---

## 5.7 MyPage（`/aws/mypage`）— 1,544行・**ログイン必須**

| セクション | データ源 |
|---|---|
| 目標資格・受験日・カウントダウン | `GET /users/me/preferences` |
| 日次目標の達成率 | `GET /users/me/daily-progress` |
| 演習量・解放状況 | `GET /users/me/question-stats` |
| **苦手分析**（ドメイン別・直近10/20/30問） | `GET /users/me/stats` の `recentResults` |
| 頻出ミス問題 | `GET /users/me/weak-questions?minIncorrect=2` |
| ブックマーク一覧 | `GET /users/me/bookmarks` → 個別 `GET /questions/:id` |
| 直近セッション | `GET /users/me/sessions?limit=200` |

「しっかり対策を開始する」ボタンは `/aws/` へ `{ startFocused: true }` を渡して遷移し、Home 側で自動起動する。

`tab` の初期値は `location.state?.tab`（`'analysis' | 'history'`）で外部から指定できる。
Home の「苦手分析」カード（デスクトップ）は `navigate('/aws/mypage', { state: { tab: 'analysis' } })` で
このタブへ直接遷移する。

---

## 5.8 Stats（`/aws/stats`）— **ログイン必須**

- スコア推移チャート（`ScoreLineChart`）
- 活動量チャート（`ActivityChart`）
- ドメイン別正答率（`STATS_GOOD_RATE=70` / `STATS_FAIR_RATE=50` で色分け）
- セッション履歴 → 展開して `GET /sessions/:id/answers` で問題別の正誤を表示
- 履歴からその場でブックマーク操作ができる

---

## 5.9 ServiceEncyclopedia（`/aws/encyclopedia`）— 図鑑

日めくりで解放したサービスのコレクション。

- 母数: `GET /daily-service?list=1`（`isServiceUnlockable` を満たすものだけ）
- 解放状況: `GET /users/me/encyclopedia-unlocks`（ログイン時）/ `localStorage`（ゲスト）
- 未解放は伏せ字表示、解放済みはアイコン・説明・豆知識・公式ドキュメントリンク
- 「解放済み」タブが0件のときは、空白にせず「まだ解放したサービスはありません」と「一覧を見る」ボタンを出す
- 詳細は必要時に `GET /daily-service?serviceId=` で取得

**アイコン解決**は `ServiceIconImg`（`src/components/Icons.tsx`）が
`public/icons/aws/` の SVG（80×80）を優先し、無ければ PNG（64×64）にフォールバックする。

---

## 5.10 CheatSheet（`/aws/cheatsheet`）— 1,768行

**データがコンポーネント内の静的定数 `CHEAT_DATA` に直書きされている**（DBではない）。
DB 側は `CheatSheetDeletions` テーブルが「削除予定フラグ」のオーバーレイを持つだけで、
`GET /cheatsheet-deletions` の `deleteDate` を過ぎた項目をフロントが非表示にする。

### 用語の記述ルール（`CLAUDE.md` にも規定）

有名な別名があれば**必ず併記する**。試験では日本語訳と英語表記が混在して出題されるため。

- `desc`: `和名（English）` — 例「異常検知（Anomaly Detection）」
- `tags`: `和名 / English` — 例「マネージドルール / Managed Rules」

### `desc` の改行ルール

`desc` は `\n` 区切りで1行ずつ描画される（`ItemCard`）。**順序・箇条書き・羅列の内容を書く場合は
1項目1行になるよう適宜 `\n` を入れる。** 1行に詰め込むと画面上で折り返されて読みにくくなるため。

- 先頭 `- ` の行は下位項目（子項目）として「・」付きインデントなしで描画される
  （例: `- Bayesian最適化：...\n- Grid Search：...`）
- `用語：説明` 形式の行は用語部分が自動でティール/黒太字強調される（`◯` 付与は「用語行」判定時）
- ステップや選択肢を「A→B→C」のように1行に詰めず、`- ` 箇条書きで1行ずつ分けるほうが望ましい
- **箇条書きの前には導入ラベル（末尾「：」）を置く**（例: `主な観点：`／`主な種類：`／`2段階：`）。
  ラベルなしでいきなり `- ` 箇条書きに入らず、何の一覧かを一言添えると読みやすい。
- **順序に意味がある手順は丸数字（①②③…）、順不同の選択肢列挙は `- `** で使い分ける。
  例: MLライフサイクル（①データ収集→②前処理→…）は丸数字、Auto Scalingのポリシー種類
  （ターゲット追跡/ステップ/スケジュール、順不同）は `- `。
- **`**強調**` は基本1記事1箇所に絞る**（多くは冒頭文または最初の箇条書き項目の最重要ワード）。
  複数箇所を太字にすると何が一番重要か伝わらなくなる。他の重要語は用語コロン記法
  （上記の自動ティール/黒太字判定）に任せる。

### 太字・ティール（コピー可能語）の装飾ルール（`ItemCard` が自動判定）

装飾は執筆者が手動で付けるのではなく、`desc` の書き方に応じて `ItemCard` が自動判定する。
判定ロジック本体は `isCleanTermLabel` / `topLevelColonIndex` / `isTopTermLine`（`CheatSheet.tsx`）。

**判断の原則（`EXTRA_COPYABLE_TERMS` に語を追加する時や `**`を使う時はこれで判断する）**:
- **ティール＋コピー可能 = 重要な「名詞」＝IT/AWS用語**。ユーザーがコピーして検索・AIに質問する
  ことを想定するため、一般的な日常語ではなく、調べる価値のある技術固有名詞（サービス名・
  専門用語・略語等）だけを対象にする。
- **黒太字（コピー不可） = 重要だが「名詞ではないもの」＝説明・判断基準・文**。用語そのものでは
  なく、文中の強調したい説明的なフレーズ（理由・条件・ポイントの部分文）が対象。

**1. 行頭が `用語：説明` の形（全角コロン、括弧の外側）の場合** — `用語`部分だけが強調される:
- **ティール（`--color-points`）＋タップでコピー**: `用語`にASCII英字を含む（例: `SHAP値：...`）、
  または `EXTRA_COPYABLE_TERMS`（`CheatSheet.tsx` 冒頭の日本語重要語リスト）に載っている場合。
  「試験で調べたくなる・コピーしてAIに聞きたくなる語」が対象。
- **黒太字（コピー不可）**: 上記に該当しないが「用語として綺麗な形」（30字以内・句読点や改行を含まない・
  括弧の開閉が揃っている・末尾が「〜例」でない）の場合。日本語の一般的な見出し語や、
  `SIMPLE_TERMS`（`HTTP`/`JSON`/`ALL`/`Standard`等、ASCIIだが調べる価値が低いとみなした語）はここに落ちる。
- どちらにも当てはまらない（長すぎる・句点を含む等）行は強調なしでそのまま表示。
- 用語部分に `**...**` を書いても自動で除去される（二重強調防止）。**用語ラベルには `**` を使わない。**

**2. 文中で任意の語句を強調したい場合** — `**強調したい語句**` で囲む（`renderRich`が処理）。
黒太字になるだけで、コピー可能にはならない。用語ラベル以外の「文中の重要キーワード」用。
例: `'**TypeScript**・Python...'` → 「TypeScript」だけ黒太字。

**強調範囲は体言止め／連体形／終止形のいずれかで終わるようにする**（助詞・接続助詞で
中途半端に切らない）。「を」「に」「が」「して」「けど」等で終わる強調は避ける。
- OK（体言止め・名詞で終わる）: `'**訓練データに過剰適合**し、未知データで性能が落ちる'`
- OK（終止形で終わる）: `'**限られた帯域で重要な通信を優先する**制御'`
- NG（助詞「を」で途切れる）: `'**予測と正解の誤差を**数値化する'`
- NG（連用形で不自然に切れる）: `'**訓練データに過剰適合し**、未知データで性能が落ちる'`

**3. コピー時に文脈を補いたい場合** — `termKeywords: Record<string, string>` を `Item` に追加すると、
コピー時のテキストをその値に差し替えられる（表示上のラベルは変わらない）。
短く曖昧な用語（例: `L1`）をコピーしたときに文脈（`L1（CDK Construct）`）を付けたい場合に使う。

**4. 必須ルール: 1記事内で最低1箇所は太字またはティール（コピー可能）の装飾を入れる。**
装飾ゼロの記事は「何が重要な箇所か」が伝わらないため、`desc` を書く/直す際は少なくとも1つの
重要語（ティール）または重要フレーズ（`**...**`）を含めること。

**4. `◯` プレフィックス** は「紹介する用語行」（子項目を持つ親行、または上記1のティール/黒太字判定に
該当する行）に自動で付く。執筆者が手動で書く必要はない。

### 記事間リンクの分類（親記事 / 子記事 / 同じサービス / 関連）

`CHEAT_DATA` は `item.name` からサービスの基底名（`serviceKeyOf`）を推定して自動グルーピングし、
各記事カードの下部に最大4種類のリンク欄を出す。分類は `name` と `serviceKey` の一致で決まる：

| 分類 | 条件 | 例 |
|---|---|---|
| **親記事** | 自分が機能記事（`name ≠ serviceKey`）のとき、同じ`serviceKey`の概要記事（`name = serviceKey`） | 「Amazon SageMaker Studio」→「Amazon SageMaker」 |
| **子記事** | 自分が概要記事（`name = serviceKey`）のとき、同じ`serviceKey`の機能記事（`name ≠ serviceKey`） | 「Amazon SageMaker」→「Amazon SageMaker Studio」「…Clarify」等 |
| **同じサービス** | 自分と**完全に同名**の記事が別資格にもある場合 | AIFの「Amazon SageMaker Clarify」↔MLAの「Amazon SageMaker Clarify」 |
| **関連** | `seeAlso` 明示 or 本文中の自動検出で挙がった**他サービス**の記事（同じ`serviceKey`のものは除外） | — |

**執筆ルール（新規記事を追加する時に必ず守る）**:
- **サービス名のみの概要記事（親記事）は全資格を通して1つだけ**にする（例:「Amazon SageMaker」は
  どこか1資格にのみ書き、他資格では書かない。他資格から参照したい場合は機能名を足した子記事側で
  書くか、`親記事`の自動リンクに任せる）。概要記事を資格ごとに重複作成すると「同じサービス」欄に
  概要記事同士が紛れ込み親子関係が壊れる。
- サービス名 + 機能名の記事（子記事、例:「Amazon SageMaker Studio」）は**複数資格にあってよい**。
  親記事は `serviceKey` 一致で自動的に解決されるため、資格をまたいでも正しくリンクされる。

**表示の折りたたみ**: 4分類それぞれ独立して、3件までは常時表示し4件目以降は
「+N件 もっと見る」ボタンで折りたたむ（`ItemCard`内 `LinkChipGroup` / `LINK_GROUP_VISIBLE_MAX`）。

---

## 5.11 Admin（`/admin`）— 3,985行

`AdminLayout` + タブ。タブ状態は `localStorage.adminActiveTab` に保存。

| グループ | タブ |
|---|---|
| コンテンツ | 問題管理 / 問題追加 / 生成状況 / スキャン結果 / コラム管理 / コラムのネタ / 日めくりAWSサービス / リリースノート / 合格コメント |
| 運営 | お知らせ管理 / 通報確認 / メッセージ / データ削除 |
| 設定 | テーマ設定 / 管理者設定 / サイト情報 |

- すべてのリクエストは `adminFetch` が `Authorization: Bearer <idToken>` を付ける
- 「スキャン結果」タブ = `GET /admin/questions/flagged`（妥当性チェックの結果一覧）。
  `filter=flagged|hidden|audit|fixed` で切り替え、修正案の apply / reject ができる
- 「データ削除」タブ = `POST /admin/direct-delete`（メールアドレス指定）

---

## 5.12 【削除済み】SEO ページ群（旧 AdSense 収益化施策）

**2026-09-20 に全撤去済み。** 以下は履歴としての記録であり、現在は存在しない。

`app/` に直接 JSX を書き `src/views/` を経由しない「閲覧専用SEOページ」として、過去問道場を
参考に AdSense 収益化のために作られていた。

| 旧ページ | 生成元 | `generateStaticParams` |
|---|---|---|
| `/questions/[examType]/[questionId]` | `GET /questions/public?examType=`（ビルド時） | `EXAM_TYPES` × 問題（**4,000件超**） |
| `/exam-guide/[type]` | `src/constants.ts`（`EXAM_CONFIGS` / `EXAM_DOMAINS` / `DOMAIN_WEIGHTS`） | `EXAM_TYPES` |
| `/services/[name]` | `src/data/awsServiceCatalog.ts` + `GET /daily-service?serviceId=` | `CATALOG` |
| `/encyclopedia`（`PublicEncyclopedia.tsx`、ログイン後の `/aws/encyclopedia` とは別物） | `awsServiceCatalog.ts` | — |

あわせて `app/layout.tsx` の AdSense スクリプト読み込み（`AD_CONTENT_PREFIXES` / `showAds` /
adsbygoogle.js）と `src/components/ui/AdPlaceholder.tsx`（未使用）も削除した。

**撤去理由**:
1. アプリ内から辿れる導線を持たない孤立SEOページだった
   （方針: 「アプリ導線のない独立SEOページは作らない」。2026-07-22 の `/compare` 撤去と同じ理由）
2. `/questions` は試験×問題数で静的ページが4,000件超に膨れ、Cloudflare Pages のビルドが
   タイムアウトする一因になっていた（実際にビルド失敗が発生・リトライでようやく成功した）
3. サイトの実態（AWS認定演習アプリ）と乖離した閲覧専用コンテンツだった

**存続したもの**: `/about`（プライバシーポリシー・利用規約）と `/architecture`（サイト構成図）は
アプリ内から実際にリンクされ機能しているため、ページ自体は残し AdSense 広告読み込みのみ削除。
プライバシーポリシー・Cookie バナーの広告の記述も削除済み（2026-10-05）。現在は広告を配信していない。

---

## 5.13 デザインルール（`CLAUDE.md` の要約）

実装時は必ず `CLAUDE.md` の原文を参照すること。要点のみ:

- テキストを含むボタンは `src/components/ui/Button.tsx` を使う（`primary` / `outline` / `danger`）
- ページの枠は `PageLayout` で包む（左右・上下余白と最大幅960pxを一元管理）
- 余白・フォントサイズ・影・角丸は `src/index.css` のトークン（`--spacing-*` / `--font-size-*` /
  `--box-shadow-*` / `--border-radius-*`）を使う。**スケール外の生px値は禁止**
- 画面種別の指示（「Web版」「スマホ版」）は該当ブランチにのみ適用する
- 色はトークンを使う。文字色は背景に対して WCAG 2.2 AA（4.5:1）を満たす値にしてある
  - オレンジの主ボタンの文字は濃色（`--color-btn-primary-text: #16191f`）。白は 2.1:1 で読めない
  - 補足文の薄いグレーは `--color-text-light: #656871`（白地 5.6:1）
  - 資格レベル色は `--level-*`（ライト/ダーク別値）。`constants.ts` の `EXAM_LEVEL_COLORS` はこれを参照する。
    レベル色の塗りに載せる文字は `--color-on-level`。半透明は hex にアルファを足さず `tint(color, pct)` を使う
  - ポイント・しっかり対策のティールは `--color-points`
- 動き: 常時ループする演出は1画面に1つまで（ホームの日めくりカードの光のみ）。ランディングの開始ボタンの脈動は廃止。
  OS の「視差効果を減らす」設定では `index.css` の全体ルールで止める。`button, a` の transition は色と影だけ
- キーボードフォーカスは `:focus-visible` で常に見せる（インラインの `outline: 'none'` より優先）
- トークン違反は `npm run lint:tokens` で検査（増えたら失敗。CLAUDE.md 参照）
- Web フォントは読み込まない。`body` の `font-family` で欧文は OS の UI フォント、和文は
  ヒラギノ / Noto Sans JP / Yu Gothic UI / メイリオを指定する（`next/font` は Google Fonts 取得失敗で
  Cloudflare のビルドを落としたことがあり、しかも `body` 指定に上書きされて使われていなかったため廃止）
