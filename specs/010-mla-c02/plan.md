# MLA を新版 MLA-C02 に合わせる — 設計

## 参照した既存仕様

- `docs/06-exercise-logic.md` §予想スコア — `DOMAIN_WEIGHTS[examType]`（公式の配点）で重み付けする
- `docs/07-operations.md` §生成指示 — `instructions/*.txt` は `scripts/gen-original-instructions.mjs` が prebuild で
  `src/data/originalInstructions.ts` に書き出す。Cloudflare のビルドはコミット済みの `.txt` から作る
- `docs/03-domain-model.md` — 問題のドメインは番号（`domain`）で持ち、名前は `src/data/examDomains.json` が単一マスタ
- 公式: [MLA-C02 試験ガイド](https://docs.aws.amazon.com/aws-certification/latest/machine-learning-engineer-associate-02/machine-learning-engineer-associate-02.html)、
  [C01 と C02 の比較](https://docs.aws.amazon.com/aws-certification/latest/machine-learning-engineer-associate-02/mla-02-comparison.html)、
  [対象サービス](https://docs.aws.amazon.com/aws-certification/latest/machine-learning-engineer-associate-02/mla-02-in-scope-services.html)、
  [対象外サービス](https://docs.aws.amazon.com/aws-certification/latest/machine-learning-engineer-associate-02/mla-02-out-of-scope-services.html)、
  [試験ガイド一覧](https://docs.aws.amazon.com/aws-certification/latest/examguides/aws-certification-exam-guides.html)

## アプローチ

### 採用案

- ドメインの並び（1:データ準備 2:モデル開発 3:デプロイ 4:運用）は C01 と C02 で同じなので、**番号はそのまま・名前と配点だけ変える**。
  既存問題・統計（`domain` 番号・`recentResults`）の移行は要らない。
- 生成 AI の問題は、`01-generate-questions.sh -e MLA -d <ドメイン>` を手動で回し、`02-check-validity.sh` で検証する。
  生成の指示に「C02 で追加された範囲（現状ほぼ 0 問）を優先」を書いて寄せる。ドメインごとの配分は、C02 の追加タスク数の比
  （D1:7 / D2:11 / D3:15 / D4:8）に合わせて約 20/25/35/20 問。
- 版の検出は、公式の試験ガイド一覧（docs.aws.amazon.com）から資格ごとの現行コードを取り、`src/constants.ts` の `examCode` と
  比べて違えばレポートに出す（自動で書き換えない。版の切り替えは spec を切って人が確認する）。

### 却下した案

| 案 | 却下理由 |
|---|---|
| 生成 AI の問題を AIP（生成 AI プロ）から複製する | 難易度・観点が違う。重複コンテンツは 2026-09 に整理した方針に反する |
| 既存の SageMaker 問題を削って比率を合わせる | 問題として正しく、C02 でも範囲内。足すほうが安全 |
| refresh が版の変化を見つけたら instructions を自動で書き換える | 配点・ドメイン名・画面に波及するので、人の確認が要る |

## 変更するファイル

| ファイル | 変更内容 |
|---|---|
| `src/data/examDomains.json`（→ `lambda/src/examDomains.json` はデプロイ時に同期） | MLA の4ドメインの名前（日・英）・配点・代表サービス |
| `src/constants.ts` | MLA の `examCode`、説明文（日英）、試験ガイドの URL |
| `prompts/night-prompts/scripts/instructions/MLA.txt` | C02 の公式タスク全文、優先範囲、対象外 |
| `prompts/night-prompts/scripts/{01,02,03,99}*` の埋め込みドメイン名 | C02 の名前（examDomains.json と一致） |
| `prompts/night-prompts/scripts/refresh-exam-guide.sh` | 試験ガイド一覧から現行コードを取り、`examCode` と違えば警告 |
| `docs/` | 07-operations（版の検出）、必要に応じて資格一覧 |

## データモデルの変更

なし（`domain` は番号のまま）。

**既存データの移行が必要か**: いいえ

## API の変更

なし。
