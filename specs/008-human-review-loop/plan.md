# 008 人の確認の経路 — 設計

## 参照した既存仕様

- `docs/03-domain-model.md` §3.2 品質管理フラグ
- `docs/04-api.md` §4.8 管理者API（flagged / apply-fix / reject-fix）
- `docs/05-screens.md` 管理画面
- `docs/07-operations.md` 夜間バッチ

## アプローチ

### 採用案

既存の「修正案（`fixProposalJson`）→ 管理画面で apply / reject」の仕組み（画面のボタンは未実装、02 も出していなかった）を生かし、
「人の確認待ち」の印 `humanReviewRequestedAt` / `reviewReason` を足して、修正案・削除提案・抜き取りを1つの列にまとめる。

### 却下した案

| 案 | 却下理由 |
|---|---|
| 確認待ち用の新テーブル | 問題1件に1つの状態で足りる。Questions の属性なら既存の flagged 一覧にそのまま載る |
| 修正を全部人の承認制にする | AI の修正は3,294問。文言修正まで人に回すと処理しきれない。害の大きい「正解の変更」と「削除」に絞る |

## 変更するファイル

| ファイル | 変更内容 |
|---|---|
| `prompts/night-prompts/scripts/02-check-validity.sh` | 正解の変更・削除提案を `queue_for_review` へ |
| `lambda/src/app.js` | flagged に `filter=review`・`reviewCount`、apply/reject-fix の確認待ち対応、`POST /admin/questions/:id/human-review` |
| `src/views/Admin.tsx` | 「人の確認待ち」フィルタ（既定）とカード |
| `prompts/night-prompts/scripts/sample-human-review.py` | 抜き取り・要約・過去分の登録 |
| `prompts/night-prompts/scripts/99-send-report.sh` | 「0. 人の確認待ち」 |
| `prompts/night-prompts/scripts/audit-questions.sh` | `-i` の生成指示改良を提案のみに |

## データモデルの変更

| テーブル | 属性 | 型 | 既存データの扱い |
|---|---|---|---|
| Questions | `humanReviewRequestedAt` / `reviewReason` | S | 新規。過去分は `--mark-past` で約23問に付ける |
| Questions | `humanReviewedAt` / `humanReviewResult` / `humanReviewReason` / `humanReviewNote` | S | 新規 |

**既存データの移行が必要か**: いいえ（過去分の登録は任意の一度きり）

## API の変更

| メソッド | パス | 認証 | リクエスト | レスポンス |
|---|---|---|---|---|
| GET | `/admin/questions/flagged?filter=review` | admin | — | 既存＋本文一式・`reviewCount` |
| POST | `/admin/questions/:id/human-review` | admin | `{result, note}` | `{success}` / 409 |

**後方互換**: 既存の filter・apply/reject の挙動は、確認待ちでない問題では変わらない。

## テスト方針

- [x] 02 の判定: 擬似データ（正解変更・文言のみ・削除）で update-item の内容を確認
- [x] API: dev に使い捨ての問題を置き、一覧→適用→抜き取り ng→二重記録 409 を確認して削除
- [x] 画面: ローカル（dev API）で管理者ログインし、確認待ちカードと2段階認証欄を目視
