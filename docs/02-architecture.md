# 02. アーキテクチャ

## 2.1 全体構成

```
                          ┌──────────────────────────────┐
   ブラウザ                │  Cloudflare Pages            │
   （静的 HTML/JS/CSS） ←──│  Next.js 15 static export    │
                          │  out/ を配信                  │
                          └──────────────────────────────┘
        │  fetch (HTTPS)                    ↑ git push (GitHub 連携で自動ビルド)
        ↓                                   │
 ┌──────────────────────────┐        ┌──────────────┐
 │ API Gateway a0q3656qw4   │        │   GitHub     │
 │  ステージ /dev  /prod     │        │ MsSAIEngineer│
 │  変数 lambdaFn で分岐     │        │  Mugenknock  │
 └──────────┬───────────────┘        └──────────────┘
            ↓
 ┌──────────────────────────┐
 │ Lambda                   │   awsquizHandler-dev  (ENV=dev)
 │ express on serverless    │   awsquizHandler-prod (ENV=prod)
 │ lambda/src/{index,app}.js│
 └──────────┬───────────────┘
            ↓
 ┌──────────────────────────┐   ┌────────────────────────┐
 │ DynamoDB                 │   │ Cognito User Pool      │
 │ コンテンツ系: 共有        │   │ ap-northeast-1_KIOFciGhQ│
 │ ユーザー系: -dev / -prod  │   │ idToken を Lambda が検証 │
 └──────────────────────────┘   └────────────────────────┘

 ── 別系統（開発者ローカル PC・AWS 課金なし）────────────────
 systemd user timer ──► 夜間バッチ（Claude CLI）──► DynamoDB / SES(Gmail SMTP)
                    └─► Playwright canary ──► S3 (mugenknock-error-logs)
```

**重要**: フロントは完全な静的エクスポート（`output: 'export'`）。SSR は無い。

### 過去の Google AdSense 収益化施策（2026-09-20 全撤去）

Web版は元々「過去問道場」を参考に、AdSense 収益化のためのコンテンツページ群を持っていた。
以下をすべて撤去済み（履歴として記録）:

- `app/questions/[examType]/[questionId]/` — 試験×問題数で**4,000件超**に膨れ、ビルドが
  タイムアウトする一因になっていた問題個別ページ（アプリ内導線なし）
- `app/services/[name]/` `app/services/` — サービス解説ページ（アプリ内導線なし）
- `app/encyclopedia/` と `src/views/PublicEncyclopedia.tsx` — ログイン不要の公開版サービス図鑑
  （ログイン後の本物の図鑑は `/aws/encyclopedia` = `src/views/ServiceEncyclopedia.tsx` で別物・存続）
- `app/exam-guide/[type]/` `app/exam-guide/` — 資格別攻略ガイド（アプリ内導線なし）
- `app/layout.tsx` の `AD_CONTENT_PREFIXES` / `showAds` ロジックと adsbygoogle.js 読み込み
- `src/components/ui/AdPlaceholder.tsx`（未使用の広告枠プレースホルダー）

撤去理由: ①サイトの実態（AWS認定演習アプリ）と乖離した閲覧専用ページで、いずれもアプリ内に
導線を持たない孤立SEOページだった（「アプリ導線のない独立SEOページは作らない」方針。
2026-07-22 の `/compare` 撤去と同じ理由）、②静的ページ数の肥大化がビルド時間・タイムアウトの
主因になっていた。
`/about`（プライバシーポリシー・利用規約）と `/architecture`（サイト構成図）はアプリ内から
実際にリンクされて機能しているため**ページ自体は存続**、AdSense 広告読み込みだけを削除した。
プライバシーポリシー（`app/privacy-policy/page.tsx` / `src/views/About.tsx`）と Cookie バナー
（`Layout.tsx` / `Portal.tsx`）に残っていた広告（AdSense・AdMob）の記述も、2026-10-05 に削除した
（アプリ版はストア未公開で、AdMob の SDK も `android/` に存在しない。現在は Web・アプリとも広告なし）。

## 2.2 環境

| 環境 | Gitブランチ | フロント URL | Lambda | API ステージ |
|---|---|---|---|---|
| 検証 | `develop` | Cloudflare Pages preview | `awsquizHandler-dev` | `.../dev` |
| 本番 | `master` | https://mugenknock.com | `awsquizHandler-prod` | `.../prod` |

### 環境変数

| ファイル | 用途 |
|---|---|
| `.env.local` | ローカル開発（gitignore 済み）。dev エンドポイントを指す |
| `.env.development` | `next dev` 用 |
| `.env.production` | 本番ビルドの API（`/prod`）。Cloudflare Pages の環境変数が無いときの既定 |

**検証（Preview）のビルドは `/dev` を向く**（2026-10-28〜）。Cloudflare Pages の Preview 環境変数
`NEXT_PUBLIC_API_ENDPOINT` が `.env.production` より優先される。以前は変数名の末尾に空白が入っていて
（`NEXT_PUBLIC_API_ENDPOINT `）名前が一致せず、検証も `/prod` を叩いていた。
Lambda を変更したら dev / prod **両方**にデプロイする必須ルール（`CLAUDE.md`）は変わらない。

### Lambda の利用者

| Lambda | 誰が使うか |
|---|---|
| `awsquizHandler-prod` | 本番サイト + デプロイ済み preview フロント |
| `awsquizHandler-dev` | ローカル開発（`.env.local`）+ **夜間バッチ全般** |

→ prod だけ更新すると夜間生成が旧コード、dev だけ更新すると本番が旧コードになる。

### dev/prod でテーブルが分かれるもの

`lambda/src/app.js` の `SPLIT_TABLES` に列挙されたユーザーデータ系のみ接尾辞が付く。

```js
SPLIT_TABLES = { Sessions, UserAnswers, UserQuestionStats,
                 UserTagStats, UserPoints, EncyclopediaUnlocks }
T(name) → SPLIT_TABLES に含まれれば `${name}-${ENV}`、それ以外はそのまま
```

コンテンツ系（`Questions`, `Tips`, `Releases`, `DailyServices`, `AppSettings`, `Reports` …）は
**dev/prod 共有**。夜間バッチが dev Lambda 経由で書いた問題がそのまま本番に出るのはこのため。

## 2.3 技術スタック

| レイヤー | 技術 | 備考 |
|---|---|---|
| フロント | Next.js 15 + React 19 + TypeScript | App Router / static export |
| ホスティング | Cloudflare Pages | Build: `npm run build`, Output: `out` |
| バックエンド | API Gateway + Lambda (Node.js, express) | 単一 Lambda に全ルート |
| DB | DynamoDB（オンデマンド課金） | 20 テーブル |
| 認証 | AWS Amplify Gen2 (Cognito) | `amplify/auth/resource.ts` |
| E2E | Playwright | `e2e/` |
| モバイル | Capacitor（Android） | `android/`・**現在は未使用の可能性が高い** |
| AWS CLI | `/home/yuzuki/local/bin/aws` | グローバル未インストール |

### 認証フロー

```
LoginPage (Amplify UI Authenticator)
  → Cognito User Pool (ap-northeast-1_KIOFciGhQ, clientId 16jjrj5m28o6s2k84og8kh2vh3)
  → AuthContext.loadUser() が getCurrentUser() / fetchUserAttributes() で user を復元
  → 以降 fetch には userId をクエリ/ボディで渡す
```

**注意**: `/users/me/*` は `requireUser` ミドルウェアが Cognito idToken を検証し、
**クライアントが渡した `userId` を必ずトークンの `sub` で上書きする**（IDOR 防止）。
つまり `/users/me/*` を呼ぶときは `Authorization: Bearer <idToken>` が必須。
一方 `/sessions/*` や `/questions/:id/bookmark` は `userId` をそのまま信用している
（→ [08-refactor-plan.md](08-refactor-plan.md) の指摘事項）。

`AuthContext` には `hadPriorSession()` という補助がある。静的サイトでは認証確定まで
`user === null` のため未ログイン UI が一瞬出る。`localStorage.mk_had_session` を楽観的ヒントにして
これを抑制している。

## 2.4 ディレクトリ構成

```
aws-quiz-app/
├── app/                    Next.js App Router のルート定義（page.tsx は薄いラッパー）
│   ├── aws/                ログイン後のアプリ本体（Layout 付き）
│   ├── about/              プライバシーポリシー・利用規約（アプリ内から実リンク）
│   ├── architecture/       サイト構成図（`src/views/ArchitecturePage.tsx`。アプリ内から実リンク）
│   └── layout.tsx          ルート layout（AuthProvider / ThemeProvider）
│
├── src/
│   ├── views/              実際の画面コンポーネント（旧 src/pages/）
│   ├── components/         共通コンポーネント
│   │   └── ui/             デザイントークン準拠の基本部品（Button/Card/PageLayout/Badge）
│   ├── contexts/           AuthContext / ThemeContext
│   ├── compat/             react-router-dom の互換レイヤー（react-helmet-async スタブは 2026-10-05 に削除。全て no-op だった）
│   ├── utils/              永続化・同期・算出ロジック
│   ├── data/               examDomains.json（ドメイン単一マスタ）/ awsServiceCatalog.ts
│   ├── i18n/               translations.ts
│   ├── constants.ts        資格定義・ドメイン導出関数・API_ENDPOINT
│   └── index.css           デザイントークン（CSS 変数）
│
├── lambda/src/             API 本体（app.js に全ルート・3,300行超）
├── amplify/                Amplify Gen2 バックエンド定義（Cognito）※削除厳禁
├── e2e/                    Playwright テスト
├── scripts/                デプロイ・運用スクリプト（ローカル systemd から呼ばれる）
├── prompts/                夜間バッチ本体（.gitignore 済みだが履歴上は追跡されている）
├── docs/                   本ドキュメント
├── specs/                  これから作るものの仕様
├── android/                Capacitor Android プロジェクト（休眠）
└── build/, out/, .next/    ビルド成果物（追跡外）
```

### compat レイヤー

React Router で書かれた既存画面を、import 文を変えずに App Router へ載せるためのスタブ。

- `useNavigate()` — `router.push` / `router.replace`。数値デルタ（`navigate(-1)`）は `router.back()`
- `useLocation().state` — `sessionStorage.__nav_state__` を経由。**同一レンダーで複数回呼んでも安全**
  （モジュールレベルキャッシュ。読んだ直後に sessionStorage からは消す＝1回限りの受け渡し）
- `useLocation().hash` — `window.location.hash`
- `useParams()` — **常に `{}` を返す。** URL パラメータが必要なページは
  `app/.../page.tsx` から props で渡すこと

**画面間のデータ受け渡しは `navigate(path, { state })` に大きく依存している。**
例えば `ExerciseSession` は state から `questions` / `createSession` / `spareQuestionIds` を受け取る。
state が無い場合はドラフト復元にフォールバックし、それも無ければホームへ戻る。

## 2.5 デプロイ

### 通常（フロントのみ）

```bash
git add . && git commit -m "..."
git push github develop
./prompts/night-prompts/scripts/cf-deploy-status.sh wait   # ビルド完了を待って結果確認
```

### Lambda を変更した場合

```bash
./scripts/deploy-lambda.sh dev     # 検証（引数なしならブランチから自動判定）
# 動作確認後、ユーザーの明示指示があれば
./scripts/deploy-lambda.sh prod
./scripts/deploy-lambda.sh status            # live が指している版とコミット
./scripts/deploy-lambda.sh rollback prod     # 不具合時: live を1つ前の版へ（コードを戻さなくてよい）
```

**版とエイリアス（2026-10-28〜）。** デプロイは `lambda/test` を走らせてから（失敗したら中止）、
`publish-version`（説明に git の SHA）→ エイリアス `live` をその版へ向ける。
API Gateway のステージ変数 `lambdaFn` は `dev:live` / `prod:live` で、エイリアスを呼ぶ。

**`git push` では Lambda は一切更新されない。** 「git にマージ済み＝本番反映済み」ではない。

> 実害の記録: 出題ドメイン均等化（`domainBalancedOrder`, 2026-06-29 追加）を prod Lambda へ
> 反映し忘れ、約1か月ランダム出題が続き累積ドメイン分布が大きく偏った（最少1問 vs 最多12問）。
> Lambda ロジック変更は**稼働中の Lambda 実機で挙動を確認する**こと。

### 本番リリース（ユーザーの明示指示があるときのみ）

```bash
git checkout master && git merge develop && git push github master
./scripts/deploy-lambda.sh prod
./prompts/night-prompts/scripts/cf-deploy-status.sh wait
git checkout develop
```

## 2.6 CORS

`lambda/src/app.js` の `ALLOWED_ORIGINS` + `CF_PAGES_ORIGIN_RE`。

```
http://localhost:3000 / :3001
https://mugenknock.com / https://www.mugenknock.com
https://mugenknock.pages.dev
/^https:\/\/[\w-]+\.pages\.dev$/  （Cloudflare Pages のプレビュー）
```

新しいオリジンからアクセスする場合はここに追加し、**dev/prod 両方の Lambda を再デプロイ**する。

## 2.7 キャッシュ戦略

多層のキャッシュがあり、変更が即時反映されない場面がある。

| 層 | 実装 | TTL | 無効化 |
|---|---|---|---|
| Lambda ウォームインスタンス（問題） | `_examQuestionsCache` | 10分 | 待つしかない |
| Lambda ウォームインスタンス（汎用） | `warmCached()` — growth-stats / tips / releases / announcements | 10分 | 待つしかない |
| Lambda（日めくり） | `_dailyServicesCache` | 5分 | 管理APIの追加/更新/削除で `null` 代入 |
| ブラウザ sessionStorage | `utils/cache.ts` `getCached` | 既定5分 / SHORT 1分 | `deleteCached(ByPrefix)` |
| ブラウザ localStorage | `utils/cache.ts` `getCachedPersist` | 既定4時間（問題プールは10分指定） | `deleteCachedPersist` |
| テーマ | `localStorage.customColors_v2` | 5分 | — |

**管理画面で問題を編集しても最大10分は出題側に反映されない**のはこのため。
