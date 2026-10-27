# プロジェクトルール

## ドキュメントの構成（最初に読む）

| 置き場所 | 内容 | 更新タイミング |
|---|---|---|
| `CLAUDE.md`（本ファイル） | **守るべきルール**（デプロイ手順・デザイン規約・確定方針） | 方針が確定したとき |
| `docs/` | **現状の実装仕様（as-is）** | 実装を変えたら同じコミットで |
| `specs/` | **これから作るものの仕様（to-be）** | 機能に着手するとき |
| `docs/website-manifest.txt` | 作者の制作意図・哲学（最上位の判断基準） | ほぼ不変 |

**実装に着手する前に `docs/README.md` の索引から該当章を読む。**
とくに以下を変更するときは対応する章を必ず読むこと。

| 変更対象 | 読む |
|---|---|
| 出題・採点・スコア・ポイント | `docs/06-exercise-logic.md` |
| Lambda / API | `docs/04-api.md` |
| DynamoDB・localStorage | `docs/03-domain-model.md` |
| 画面 | `docs/05-screens.md` |
| 夜間バッチ・systemd | `docs/07-operations.md` |

### 仕様駆動開発

新しい画面・新しいAPI・データモデルの変更・出題や採点のロジック変更・
ゲスト/ログイン境界に触れる変更は、**先に `specs/NNN-機能名/` を切ってから実装する**。
手順は `specs/README.md`。誤字修正・明らかなバグ修正・スタイル調整は spec 不要。

実装が完了したら **`docs/` へ反映してから spec をクローズする**。
これを飛ばすと `docs/` が腐る（`docs/archive/` がその実例）。

## 画面種別の指示の適用範囲

指示に画面種別が明示されている場合は、その画面にのみ適用する。

| 指示の表現 | 適用対象 |
|---|---|
| 「Web版」「デスクトップ」「PC版」 | デスクトップ（`!isMobile` ブランチ）のみ |
| 「スマホ版」「モバイル」「スマホ」 | モバイル（`isMobile` ブランチ）のみ |
| 画面種別の指定なし | 両方に適用 |

### ブレークポイント
- モバイル：`window.innerWidth < 768`（`isMobile === true`）
- デスクトップ：`window.innerWidth >= 768`（`isMobile === false`）

### 実装の注意点
- モバイル限定の変更は `{isMobile && ...}` または `isMobile ? ... : ...` で分岐する
- デスクトップ限定の変更は `{!isMobile && ...}` または `!isMobile ? ... : ...` で分岐する
- 両方に適用する変更はブランチを分けずに共通のスタイル・ロジックとして実装する

---

## 環境構成

| 環境 | Gitブランチ | フロントエンド URL | バックエンド Lambda | API エンドポイント |
|------|------------|-----------------|-------------------|-----------------|
| **検証（ステージング）** | `develop` | Cloudflare Pages preview URL | `awsquizHandler-dev` | `.../dev` |
| **本番** | `master` | https://mugenknock.com | `awsquizHandler-prod` | `.../prod` |

- API Gateway: `a0q3656qw4`（ap-northeast-1）。ステージ変数 `lambdaFn` で Lambda を切り替える
- DynamoDB: 両環境で共通テーブルを使用
- フロントエンド: **Next.js 15 + Cloudflare Pages（Static Export）**
- Cloudflare Pages ビルド設定: Build command = `npm run build`, Output dir = `out`

### 環境変数の切り替え（Cloudflare Pages ダッシュボード設定）
ビルド時の `NEXT_PUBLIC_API_ENDPOINT` は Cloudflare Pages の環境変数で分岐する。

| Cloudflare Pages 環境 | `NEXT_PUBLIC_API_ENDPOINT` |
|----------------------|--------------------------|
| Production（master） | `https://a0q3656qw4.execute-api.ap-northeast-1.amazonaws.com/prod` |
| Preview（develop 等）| `https://a0q3656qw4.execute-api.ap-northeast-1.amazonaws.com/dev` |

ローカル開発は `.env.local`（gitignore 済み）で dev エンドポイントを指定する。

---

## ゲスト / ログインの機能境界（重要）

未ログイン（ゲスト）とログインで提供機能を明確に分ける。**迷ったらログイン専用にする。**

### 原則
- **ゲスト = その場で完結する体験のみ。** 演習を解く／その場の採点結果（Result）／図鑑・各種閲覧。**日をまたいで蓄積する永続データをローカルに溜めない。**
- **ログイン = 蓄積・横断・パーソナライズ。** 複雑・大量・日またぎのデータは**すべてサーバ側で管理**する。

### ログイン専用（ゲストには実装しない）
- ブックマーク、解答/誤答履歴、未回答/誤答/ブックマーク優先フィルタ
- 統計・履歴・**苦手分析**、Focusedモード、予想スコア、ポイント
- その他、問題ID集合や履歴など**累積して増える／端末間で同期したいデータ**全般

### なぜ
- ゲストのローカル累積はエラーの温床（問題IDの入れ替わりで不整合・localStorage肥大化・サーバ状態との乖離）
- ログインの価値（差別化）が薄れる
- 実装が単純になり壊れにくい

### 実装ルール
- ゲスト向けにローカルで上記機能を再現しない。`localStorage` に累積する新データを増やさない。
- これらの機能・画面は `user` が居る時だけ表示・動作させる（`{user && ...}` / 早期リターン）。ゲストには簡潔な案内かログイン導線を出す。
- ゲストへ機能を開放したくなったら、まずこの原則に反しないか確認する。

---

## ブランチ・デプロイルール

### 基本方針
- **作業ブランチは常に `develop`**。ファイル編集・コミットはすべて `develop` で行う。
- **実装完了後は `develop` にプッシュして検証環境で確認する。**
  ビルドは Cloudflare Pages 側でほぼ無料なので、変更のたびに push してよい。
- **`master` ブランチへのマージ・プッシュは、ユーザーから明示的な指示があった場合のみ。**
  「本番にリリース」「master にマージ」などの指示がない限り絶対に行わない。
- セッション開始時に `git branch` で現在のブランチを確認し、`develop` でなければ `git checkout develop` してから作業を始める。

### 検証（develop）への commit / push は自動で行ってよい（2026-10-01 確定）

グローバルの「コミット/プッシュは明示指示があったときのみ」に対する、**このプロジェクトの例外**。
実装が終わったら、ユーザーの個別指示を待たずに `develop` へ commit し、`git push github develop` してよい。

**自動で行う条件（すべて満たしてから）**:
1. 実装とローカル検証が済んでいる。`npx tsc --noEmit` と `npm run lint:tokens`（デザイントークン違反が増えていないか）が通り、UI の変更はブラウザで動作確認済み。
2. docs の更新が要る変更は、同じコミットに docs を含めている。
3. コミットは**自分の変更だけ**。`git diff` で中身を確認し、ファイル名を指定して add する
   （`git add -A` / `git add <dir>` は使わない）。夜間バッチが自動更新する
   `instructions/*.txt`・`state/service-catalog.json` や、他セッションの作りかけは含めない
   （これらはバッチが `scripts/commit-night-assets.sh` で自分でコミットする。それ以外の `state/` は gitignore 済み）。
4. push したら、次の「ビルドは成功まで見届ける」に従う。

**自動にしない（従来どおりユーザーの明示指示が必要）**:
- 本番に関わること全般 → 次の「本番に関わることは、必ず人間に確認する」
- force push、履歴の書き換え（amend・rebase）、ブランチ削除
- このリポジトリ以外（記事プロジェクトなど）への push

### 本番に関わることは、必ず人間に確認する（2026-10-01 確定）

検証への push が自動でよいのに対し、**本番は毎回、実行する前に人間へ確認する。**

**対象**:
- `master` へのマージ・push（Cloudflare Pages の本番ビルドが走る）
- `./scripts/deploy-lambda.sh prod`
- DynamoDB の既存データの削除・上書き（テーブルは dev/prod 共通なので、そのまま本番に効く）

**確認のしかた**:
- `AskUserQuestion` で、**何が本番に出るか**を示して選んでもらう
  （master に未反映のコミット一覧、Lambda の変更の有無とその内容、データなら対象の件数と内容）。
- 検証で動いたこと・テストが通ったことを、確認の代わりにしない。
- **過去の承認を引き継がない。** 「本番マージしていい」は、その時点で示した内容に限った承認。
  次のリリースでは、同じ手順でもう一度確認する。
- 本番への反映で迷ったら、実行せずに確認する。

### ビルドは成功まで見届ける（検証・本番とも／2026-10-01 確定）

`develop`（検証）でも `master`（本番）でも、**push したら Cloudflare のビルドが終わるまで待ち、
成功を確認してから完了とする。** 「push した」を完了報告にしない。

- **自分のコミットのビルドを待つ。** `./prompts/night-prompts/scripts/cf-deploy-status.sh wait`
  は HEAD のビルドを名指しで待つ（SHA を指定する場合は第2引数）。最大10分（実測の約5倍）。
  push 直後は前回の成功ビルドが最新に見えて「成功」と誤報しやすいので、
  **「最新のデプロイ」ではなく「自分のコミット」で判定する**（旧実装はこれで誤報した）。
- **ビルド対象外のコミットは「⏭ ビルド対象外」で完了。** Cloudflare Pages の Build watch paths で、docs・specs・`*.md`・`*.sh`・
  夜間のログや state だけの変更はビルドしない（2026-10-27〜。一覧は `docs/07-operations.md`）。`wait` は `is_skipped` を見てすぐ返る。
- **バックグラウンドで待つ。** 完了通知を受けて結果を確認する。`sleep` でのポーリングはしない。
- **続けて push しない。** 前のビルドが終わる前に次を push すると、実行中のビルドが取り消されて
  検証が曖昧になる。まとめて push するか、完了を待ってから次を push する。
- **失敗・取り消し・タイムアウトは完了にしない。** ビルドログで、コードのエラーか環境要因
  （Cloudflare 側の一時的要因・並行ビルドの競合）かを切り分け、結果を報告する。
  再 push は、検証なら自動でよい。**本番（master）の再 push は、本番の確認ルールに従って確認する。**
- 本番は、`master` の push → `deploy-lambda.sh prod`（必要時）→ **ビルド成功の確認** → `develop` へ戻す、の順
  （「本番リリース」の手順どおり）。ビルド成功を確認するまで `develop` へ戻さない。

### リモートリポジトリ

| リモート名 | URL | 用途 |
|-----------|-----|------|
| `github` | `git@github.com:MsSAIEngineer/Mugenknock.git` | GitHub（Cloudflare Pages 連携） |

---

## 開発フロー

### 通常の開発（フロントエンドのみ変更）
```
1. develop ブランチで作業・ファイル編集
2. git add / git commit
3. git push github develop   # Cloudflare Pages が検証環境を自動ビルド・デプロイ
4. ./prompts/night-prompts/scripts/cf-deploy-status.sh wait   # ビルド完了を待って結果確認
```

### Lambda も変更した場合
```
1. develop ブランチで作業・ファイル編集
2. ./scripts/deploy-lambda.sh        # develop → awsquizHandler-dev に自動デプロイ
3. git add / git commit
4. git push github develop
5. ./prompts/night-prompts/scripts/cf-deploy-status.sh wait   # ビルド完了を待って結果確認
```

### 本番リリース（ユーザーから明示的な指示があった場合のみ）
```
1. git checkout master
2. git merge develop
3. git push github master            # Cloudflare Pages が本番を自動ビルド・デプロイ
4. ./scripts/deploy-lambda.sh prod   # Lambda も本番に反映
5. ./prompts/night-prompts/scripts/cf-deploy-status.sh wait   # ビルド完了を待って結果確認
6. git checkout develop              # 作業ブランチを戻す
```

### Lambda デプロイスクリプト
- スクリプト: `./scripts/deploy-lambda.sh`
- 引数なし: 現在のブランチを見て自動判定（develop→dev、master→prod）
- `./scripts/deploy-lambda.sh dev`: 強制的に dev へデプロイ
- `./scripts/deploy-lambda.sh prod`: 強制的に prod へデプロイ

### Lambda 更新ルール（必須・厳守）
- **Lambda を変更したら `awsquizHandler-dev` と `awsquizHandler-prod` の両方を必ずデプロイする。** これは「原則」ではなく必須。`lambda/` 配下を1行でも変更したコミットは、dev・prod 両方に反映するまで作業完了としない。
  ```
  ./scripts/deploy-lambda.sh dev    # 検証
  ./scripts/deploy-lambda.sh prod   # 本番反映（※本番反映はユーザーの明示指示がある時のみ）
  ```
  ※ prod への反映自体は「ブランチ・デプロイルール」に従いユーザーの明示指示が必要。ただし **dev だけ出して prod を出し忘れる／その逆で片側が旧コードのまま放置するのを禁止**する、という意味。prod 反映指示が出たら dev も揃っているか必ず確認する。
- **`git push` では Lambda は一切更新されない。** push は Cloudflare のフロントビルドのみ。Lambda は必ず `deploy-lambda.sh` で手動デプロイする。**「git にマージ済み＝本番反映済み」ではない**点に注意。
- 各 Lambda の利用者:
  - **`awsquizHandler-prod`（/prod）**: 本番 mugenknock.com。**加えて現状は検証(develop preview)のフロントも /prod を叩く**（`.env.production` が全ビルドで効くため）。デプロイ済みフロントは両環境ともこれを使用。
  - **`awsquizHandler-dev`（/dev）**: ローカル開発（`.env.local`）と**夜間スクリプト**（`01-generate-questions.sh` 等の問題生成・取込）。
- したがって **prod だけ更新すると夜間生成・ローカルが旧コード / dev だけ更新すると本番が旧コード**になる。手順は「dev に出して検証 → （指示後）prod に反映」の二段で必ず両方更新する。
- DynamoDB は dev/prod 共通テーブルのためデータは同じ。dev/prod Lambda の違いは「どちらのコードで処理するか」だけ。
- **デプロイ漏れの実害例（再発防止）**: 出題ドメイン均等化コード（`domainBalancedOrder`, 2026-06-29 に git 追加）を **prod Lambda へ反映し忘れ**、prod が均等化前の旧コードで約1か月ランダム出題を続けた結果、ユーザーの累積ドメイン分布が大きく偏った（最少1問 vs 最多12問）。git にはあるのに本番未デプロイ、が原因。Lambda ロジック変更は「git 反映」で終わらせず必ず **稼働中の Lambda 実機で挙動を確認**する。
- **検証環境で「新規Lambdaエンドポイントが動かない」ように見えるが実は仕様通りのケース（2026-09-15発覚）**: 検証(develop preview)のフロントは上記の通り `/prod` を叩くため、**dev にだけ新規デプロイしたエンドポイントは検証環境からは404/失敗になる**。実際に問題の👍👎リアクション機能で「保存直後は反映されるがリロードすると消える」という一見バグに見える挙動が起きたが、原因は prod Lambda に未反映なだけだった。新規Lambda機能を検証環境（`https://develop.mugenknock.pages.dev` 等のpreview URL）で確認する際は、**まずローカル（`.env.local`→dev Lambda）で動作確認してから**、検証環境での不一致が「機能のバグ」か「prod未反映という既知の仕様」かを切り分けること。焦って安易に prod デプロイをしない（prod反映はユーザーの明示指示が必要）。

---

## ローカルでの本番ビルド再現（トラブルシュート）

Cloudflare Pages のビルドが失敗した際、原因切り分けのためローカルで `npm run build`（`next build`）を
再現することがある。静的ページは25件で、ビルドは**ローカルで約30秒**（実測 26.6秒・最大メモリ約800MB）、
Cloudflare Pages 上でも**1.5〜2分**（直近10回の実測 84〜137秒。clone と install 込み）。
（以前は SEO 用の動的ルートで静的ページが4000件超あり数分〜10分かかったが、2026-09-20 に撤去済み。）

- **同時に複数の `next build`/`next dev` を起動しない。** 同じ `.next` ディレクトリを競合して
  壊し、`ENOENT: .next/server/pages-manifest.json` のような**実際の原因と無関係なエラー**が出る
  （2026-09-15に発生・原因特定に時間を浪費した）。ビルドを再実行する前に
  `pkill -f "next build"` `pkill -f "next dev"` で全プロセスを止め、`rm -rf .next` してから
  **1回だけ**実行する。
- 実行は `run_in_background: true`（またはBashの`run_in_background`）で1回だけ起動し、
  完了通知を待つ。`sleep` を挟んで手動でポーリングしない（無駄に長い待ち時間になりやすい）。
- ビルド成功（exit code 0）でも Cloudflare 側が失敗している場合、**ローカルのコードは問題なく
  Cloudflare側の一時的要因（API呼び出し過多・タイムアウト等）である可能性が高い**。再push すれば
  通ることが多いので、コードを疑って延々と原因探しをする前に、まずローカルビルド成功を確認し
  再pushを試す。

---

## 技術スタック

| レイヤー | 技術 |
|---------|------|
| フロントエンド | Next.js 15 + React 19 + TypeScript（Static Export） |
| ホスティング | Cloudflare Pages |
| バックエンド | AWS API Gateway + Lambda（Node.js） |
| DB | Amazon DynamoDB |
| 認証 | AWS Amplify（Cognito） |
| AWS CLI | `/home/yuzuki/local/bin/aws`（グローバル未インストール） |

### ディレクトリ構成メモ
- `app/` — Next.js App Router のルート定義（page.tsx は薄いラッパー）
- `src/views/` — 実際の画面コンポーネント（旧 src/pages/ からリネーム済み）
- `src/compat/react-router-dom.tsx` — React Router v6 → Next.js App Router 互換レイヤー

### compat レイヤー使用上の注意
- **`useNavigate(-1)` は `router.back()` に変換済み**（数値デルタ対応）
- **`useLocation().state`** は同一レンダーサイクルで複数回呼んでも安全（モジュールキャッシュ実装済み）
- **`useLocation().hash`** は `window.location.hash` を返す
- **`useParams()`** は常に `{}` を返す。URL パラメータが必要なページは `app/.../page.tsx` から props として渡すこと（`app/sample/[exam]/page.tsx` → `SampleQuiz` の実装例を参照）

---

## アイコンの取得先

### UIアイコン（Lucide）
- Lucide（https://lucide.dev/icons/）からSVGパスを取得してコンポーネント化する
- 定義場所：`src/components/Icons.tsx`

### AWSサービスアイコン（`public/icons/aws/`）
- **形式**：80×80px SVG（優先） + 64×64px PNG（フォールバック）
- **SVG入手元**：https://github.com/weibeld/aws-icons-svg
- **PNG入手元**：AWS公式アーキテクチャアイコン ZIP（https://aws.amazon.com/architecture/icons/）
- **表示ロジック**：`ServiceIconImg`（`src/components/Icons.tsx`）がSVGを優先しPNGにフォールバック
- **新しいサービスを追加する際**：SVGとPNGの両方を配置し、`awsServiceCatalog.ts` の `icon` フィールドに設定する

---

## ボタンデザインルール

### Buttonコンポーネント（`src/components/ui/Button.tsx`）
テキストを含むボタンはすべて `<Button>` コンポーネントを使う。

| variant | 用途 | 見た目 |
|---|---|---|
| `primary`（デフォルト） | 画面内で最も重要な1つのアクション | オレンジ塗りつぶし |
| `outline` | 補助アクション・キャンセル・ナビゲーション | 青枠・透明背景 |
| `danger` | 削除・破壊的操作の確定 | 赤塗りつぶし |

| size | padding | 用途 |
|---|---|---|
| `sm` | 4px 12px | モーダル内の小さなアクション |
| `md`（デフォルト） | 8px 20px | 通常のボタン |
| `lg` | 12px 24px | 目立たせたい主要アクション |

- `borderRadius` はすべて `var(--border-radius-full)`（pill形）で固定
- `fullWidth` prop で横幅100%になる
- インラインstyleでvariantの色を上書きしない

### ネイティブ `<button>` 要素の許容範囲
以下の用途に限りネイティブ `<button>` をインラインスタイルで直接書いてよい。それ以外は `<Button>` を使う。

- アイコン専用ボタン（テキストなし）
- モーダルの ✕ 閉じるボタン
- 設定項目行（SettingsRow）・選択肢など、リスト内の特殊なクリッカブル要素

### 機能が自明なボタンはアイコンにする（2026-10-27 本人指示）
削除（ゴミ箱）・設定（歯車）・コピー・閉じる（✕）など、アイコンだけで意味が伝わるボタンは文字にせず、
下の「アイコン専用の円形ボタン」にする。`aria-label` と `title` に機能名を必ず書く。
確認ダイアログの「削除する」「キャンセル」「変更する」など、**結果を確定させるボタンは文字のまま**にする。

### アイコン専用の円形ボタン
- 最小サイズ：`width: 44, height: 44`（タッチターゲット確保）
- 形状：`borderRadius: '50%'`
- 枠線：`border: '1px solid var(--color-border)'`（背景なし）
- コンポーネント化はしない（各所でインライン定義でよい）

---

## 余白・間隔・サイズの標準（デザイントークン必須）

画面間のデザイン不統一を防ぐため、**余白・gap・padding・フォントサイズ・影・角丸はインラインの生px値を避け、必ず `src/index.css` のトークンを使う**。

### 機械チェック（2026-10-26〜）
`npm run lint:tokens`（`scripts/check-design-tokens.mjs`）が、スケール外の余白・生のフォントサイズ・生の角丸・生の色コードを数える。
既存の違反はファイルごとの件数を `scripts/design-token-baseline.json` に記録してあり、**増えたら失敗**する。
直して減らしたら `node scripts/check-design-tokens.mjs --update` で基準を下げる（基準を上げる目的で --update しない）。

### スペーシングスケール（4px基準）
`gap` / `margin` / `padding` はこのスケールのトークンのみ使う。`10px` `7px` `14px` `6px` `5px` `13px` など**スケール外の生px値は禁止**（最も近いトークンに丸める）。

| トークン | 値 | 主な用途 |
|---|---|---|
| `--spacing-xs` | 4px | アイコンとテキストの隙間など最小単位 |
| `--spacing-sm` | 8px | 密なリスト・チップ間 |
| `--spacing-md` | 16px | カード内padding・要素間の標準 |
| `--spacing-lg` | 24px | セクション間隔・ページ左右余白 |
| `--spacing-xl` | 32px | ページ上下余白・大きな区切り |

### ページの枠は `PageLayout` を使う（`src/components/ui/PageLayout.tsx`）
各画面が最外周padding・最大幅・センタリングを手書きせず、**`<PageLayout>` で包む**。標準値はトークンで一元管理：

- 左右余白：デスクトップ `24px` / モバイル `16px`
- 上下余白：デスクトップ `32px` / モバイル `16px`
- セクション間隔（`stack` prop）：デスクトップ `24px` / モバイル `16px`
- 最大幅：`900px`（`--page-max-width`）。`maxWidth` propで変更、`false` でフル幅。
  ホームのダッシュボードのみワイドモニタ対応で `1280px`（`HOME_MAX_WIDTH`）

フルブリード（全幅）にしたいブロックがある画面は `noPaddingX` 等で調整する。

### フォントサイズ
`fontSize` は `var(--font-size-*)` トークンを使い、生数値直書きを避ける。階層：
`3xs:9 / 2xs:10 / xs:11 / sm:12 / sm2:13 / base:14 / md:15 / lg:16 / h3:18 / xl:20 / h2:22 / xxl:28`。
装飾用の特大サイズ（アイコン・絵文字の 24〜108px 等）はトークン化しなくてよい。

### 影（box-shadow）
影は用途別の以下トークンを使い、`0 2px 8px rgba(...)` のような独自値を書かない。

| トークン | 用途 |
|---|---|
| `--box-shadow-sm` | カード（標準） |
| `--box-shadow-md` | 浮いたカード・hover |
| `--box-shadow-pop` | ドロップダウン・ポップオーバー |
| `--box-shadow-lg` | モーダル・ダイアログ |
| `--box-shadow-up` | 画面下部に固定するバーの上向き影 |

### 角丸
`14px` 等の生値は使わない。角丸は **AWS Cloudscape の階層に合わせてある**ので、用途でトークンを選ぶ。

| トークン | 値 | 用途（Cloudscape 対応） |
|---|---|---|
| `--border-radius-sm` | 4px | バッジ・ラベル・タグ（Badge） |
| `--border-radius-md` | 8px | 入力欄・ドロップダウン・チップ・リスト項目（Input / Item） |
| `--border-radius-lg` | 16px | モーダル・ダイアログ（Modal） |
| `--border-radius-container` | 16px | カード（Container）。`Card` コンポーネントが使用 |
| `--border-radius-full` | 9999px | ボタン（Button） |

**演習を開始する系のボタン**（モード切替・出題数選択・開始ボタン）は AWS マネジメントコンソールを
意識して `full`（pill）を維持する。バッジ・フィルタチップなど非開始系は上表に従う。

### 色（2026-10-26 確定）
主色は AWS Cloudscape 系のブルー（`--color-primary`）、アクセントはオレンジ。ターコイズはロゴだけに使う。

- 色は `src/index.css` のトークンを使い、`'#009E9E'` のような生の色コードを書かない。
- **文字色は背景に対して WCAG 2.2 AA（4.5:1）を満たす。** トークンの値はこれを満たすように決めてある。
  新しい色を足すときはコントラスト比を計算してから決める。
  ただし**塗り・線・アイコンまで暗くしない**（全部を AA の濃さにしたら画面全体が暗く濁った。2026-10-26 本人指摘）。
  明るい色は塗りに使い、文字だけ濃い別トークンにする。
  例外: ポイント・しっかり対策の青緑 `--color-points`（#009E9E）は、明るさを優先する本人判断で AA 未満のまま使う。
- オレンジの塗り（主ボタン）に載せる文字は `--color-btn-primary-text`（濃色）。白にしない。
- 資格レベル色は `EXAM_LEVEL_COLORS`（`constants.ts`）だけを使い、画面ごとに色表を書かない。
  実体は CSS 変数（`--level-*`）なので、`${color}33` のように hex のアルファを足せない。半透明は `tint(color, pct)`。
  `EXAM_LEVEL_COLORS` は塗り・線用の明るい色。**文字に使うときは `levelText(color)`**（`--level-*-text`）、
  **塗りに文字を載せるときは `levelOn(color)`**（`--level-*-on`。ライトは白で統一、ダークは濃色）を通す。
- 正誤・状態を色だけで示さない。アイコンか文字を添える。

## 出題ドメイン配分の方針（確定）

無フィルタ（ブックマーク/不正解/未回答フィルタなし）の通常演習のドメイン配分は、**deficit round-robin（累積是正）を維持する**。

- 実装: `lambda/src/selection.js` の `domainBalancedOrder` / `selectionOrder`（`answeredPerDomain` を使う）。
- ログインユーザーは「過去回答が少ないドメインを優先」して累積の偏りを是正する。
- **1セッション内で特定ドメインが多くなる / 0問になるのは許容する**（「各ドメイン最低1問保証」は検討のうえ不採用）。
- 基礎知識(companion)が混ざるときは、公式と基礎知識を**問題数比でランダムに混ぜ**、各側の内部で deficit round-robin を維持する
  （実装は `lambda/src/selection.js`、specs/005）。フィルタ時も同じ。「公式を先に使い切る」は廃止。

## チートシートの用語は別名を併記する

`src/views/CheatSheet.tsx` の `CHEAT_DATA` に用語を書く/追記するときは、**有名な別名（和名⇄英名）があれば必ず併記する**。

- desc 内: `和名（English）` 形式 — 例: 「異常検知（Anomaly Detection）」
- tags: `和名 / English` 形式 — 例: 「マネージドルール / Managed Rules」
- 理由: 試験では日本語訳と英語表記が混在して出題される。片方だけだと検索・想起できない。ASCII 技術用語は自動ハイライトされる。

## Additional レベル（表示名「オリジナル」）の非AWSカード

AWS 資格が前提とする **AWS 外の土台知識**を補う独自演習（AWS 認定ではない）。2026-08-15 新設・本番反映済み。

- カード = `examType`: `ML`（AIF/MLA/AIP前提）/ `DB`（DEA前提）/ `NW`（ANS前提）/ `SEC`（SCS前提）。
- 判定: `constants.ts` の `NON_AWS_EXAM_TYPES` / `isNonAwsExam()`。
- レベルキーは内部 `'Additional'`、表示は `levelLabel()` で「オリジナル」。
- **問題文に AWS サービス名を出さない**（AWS 非依存の前提知識を問うため）。
- **2026-09-16〜**: 公式資格側にオリジナル資格と重複する内容の問題を複製投入する運用は廃止方針。
  代わりに、対応する公式資格（上記の前提関係）を対象に**通常演習（サクッと演習・しっかり対策・
  トレーニング演習タブ）を行うと、既定でオリジナル資格の問題が出題プールに混ざる**
  （`includeCompanion` パラメータ・オフにするフィルタあり・模擬試験には適用しない）。
  混在した問題への回答は、混ざった先の公式資格側のドメイン別統計・予想スコアには算入しない
  （オリジナル資格自身の統計には従来通り算入）。詳細は `docs/06-exercise-logic.md` §6.1、
  設計判断の経緯は `specs/003-original-exam-blend/`。
  既存の重複コンテンツ（公式資格側にある、オリジナル資格と重複する問題）は2026-09-21に整理済み。
  `questionText`の正規化（空白除去）先頭40文字一致→全文・選択肢一致まで検証した162件
  （AIF→ML 137件・MLA→ML 19件・DEA→DB 6件）をDynamoDB `Questions`・`QuestionTagRelations`
  から削除し、公式資格側の重複を解消した（オリジナル資格側は保持）。

## 夜間バッチ・定期実行スクリプトで claude コマンドを呼ぶ際のルール

**`claude` CLI を呼び出す箇所は、フォールバック・リトライ経路も含めて必ず `--model` を明示指定する。**

- アカウント既定モデルに暗黙で依存すると、既定値がアカウント設定やプラン変更で
  変わった際にスクリプトの挙動（コスト・品質・トークン消費速度）が意図せず変わる。
- とくに「バイナリ再探索後のリトライ」のような**通常パスからのコピペで作る分岐**は
  `--model` を落としやすい。実際に `audit-questions.sh` のリトライ分岐だけ
  `--model opus` が抜けており、フォールバック時のみ既定モデルに落ちる状態だった
  （2026-09-15 発覚・修正済み）。
- 用途別の目安: 生成・要約・判断を伴うタスクは `sonnet`、監査など複雑な推論や
  プロンプト自体を自動改良するタスクは `opus`、改行整形など機械的で軽いタスクは
  `haiku`。新しいスクリプトを追加するときも同じ基準で選ぶ。
- 対象は `prompts/night-scripts.list` に載るスクリプトだけでなく、`prompts/run-prompts.sh`
  の ping・texts/ 実行、`scripts/local-generate-hook-run.sh` / `scripts/local-validity-hook-run.sh` 等から呼ばれる経路もすべて含む。

### MCP: 全ての `claude -p` に `--strict-mcp-config` を付ける（2026-10-02 確定）

**`claude` を呼ぶ箇所は、`--model` と同様に `--strict-mcp-config` も必ず付ける。**

- ユーザー/ローカルスコープに登録した MCP（Playwright・Context7・AWS Docs）や、claude.ai の
  コネクタ（Gmail・Drive・Calendar・Notion）は、**`claude -p` 起動のたびに接続される**
  （最大2.3秒かかり、外部サービスへも接続する）。付けないと夜間バッチが毎回これを巻き込む。
- **`--tools` を指定しない起動では、MCP ツールがモデルに渡る**（実測）。つまり Playwright や
  Gmail 等をモデルが呼べる状態になる。`--tools WebFetch` / `--tools ""` では渡らないが、
  これは今の実装の挙動で、仕様としては保証されないので、明示的に塞ぐ。
- `--tools ""`（通報チェック・生成・日めくり）は「ツール権限ゼロ」が設計の意図。
  `--strict-mcp-config` を足して、MCP も含めて何も使えないことを明示的に保証する。

**AWS の最新情報を引けるスクリプト**（すでに WebFetch で調べているもの。02検証・監査・
サービスカタログ更新・日次レポートの2箇所）だけ、AWS ドキュメント MCP を許可する:

```bash
--tools WebFetch,ToolSearch --allowed-tools WebFetch,mcp__aws-docs \
  --strict-mcp-config --mcp-config /home/yuzuki/aws-quiz-app/prompts/night-prompts/scripts/mcp-aws-docs.json
```

- **`ToolSearch` を `--tools` に含めるのが必須。** MCP ツールは遅延ロードで、ToolSearch が無いと
  `--allowed-tools` に書いても渡らない（実測。`--tools WebFetch` のままだと呼べなかった）。
  使わない呼び出しの基本コストはほぼ増えない（17,413→17,495トークン）。引いたときは3ターン約5.6万トークン。
- 組み込みツールは `WebFetch` と `ToolSearch` だけのまま。Bash・Read・他の MCP が使えないことを実測済み。
- 設定ファイルは `uvx` を絶対パスで指定し、バージョンを固定している（`@1.2.2`）。hook の PATH に
  `~/.local/bin` が無いこと、起動のたびに最新コードが自動実行されるのを避けるため。
- 生成（01）・日めくり（04/05）・通報チェック（03）は `--tools ""`（ツールなし）が設計なので、
  AWS Docs も付けない。

## 複数セッション・並行作業時の注意

**このリポジトリは複数の Claude Code セッションが同時に作業していることがある。**
ローカルで `next build` 等の重い処理を行うとき、および作業ツリーを触るときは必ず以下を守る。
（2026-09-15、並行する別セッションと `.next/` を競合させてビルドを壊し、切り分けのつもりで
実行した `rm -rf .next` で別セッションのビルドも壊した実例がある。）

- **ローカルビルド前に他プロセスを確認する。** `npm run build` / `next build` を実行する前に
  `pgrep -f "next build"` で他に実行中のビルドがないか確認する。`.next/` は全セッションで
  共有されるため、二重に実行すると最終段のファイル移動（`.next/export/*.html` の rename 等）が
  競合して失敗する。自分でも「前のビルド完了前に次を起動しない」（`docs`/CLAUDE.md 既述の
  「同時に複数の next build を起動しない」と同じ）。
- **`.next/` 等の共有ディレクトリを `rm -rf` する前にプロセスを確認する。** 削除前に必ず
  `pgrep -f "next build"` 等で別セッションが使用中でないか確認する。実行中のビルドの生成物を
  消すとそのビルドを壊す。自分が起動していないプロセスは勝手に kill しない。
- **ビルド失敗時は exit code だけで判断せず、ログを読んで真因を切り分ける。** `Compiled
  successfully` や `Generating static pages (N/N)` が出ていれば型・コード自体は健全で、失敗は
  最終段のファイル操作（＝並行実行の競合など環境要因）のことがある。コードを疑って延々と
  原因探しをする前に、まず中間ログで「環境要因かコードエラーか」を分ける。
- **`git add` の前に `git diff` で中身を確認する。** 作業ツリーには常時、夜間バッチが自動改良
  する `prompts/**` や他セッションの作りかけなど、無関係な未コミット変更が混在する。ファイル名を
  指定して add する場合でも `git diff <file>` で自分の変更のみか確認してからステージし、
  `git add -A` / `git add <dir>` でまとめて巻き込まない。（Portal.tsx を未確認でステージし、
  作りかけ機能の片側だけを本番へ出して問題数表示が壊れた実例が 2026-09-15 にある。）
