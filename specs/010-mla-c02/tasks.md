# MLA を新版 MLA-C02 に合わせる — 実装タスク

## 実装

- [x] 1. examDomains.json・constants.ts を C02 に（コード・名前・配点・説明・URL）
- [x] 2. 01/02/03/99 の埋め込みドメイン名を C02 に
- [x] 3. instructions/MLA.txt を C02 に書き換え、originalInstructions.ts を再生成
- [x] 4. refresh-exam-guide.sh に版の検出を追加
- [x] 5. docs 反映
- [ ] 6. 生成 AI の問題を手動で生成（約 100 問）→ 検証(02)

## テスト

- [ ] tsc・lint:tokens・lambda/test
- [ ] 画面で MLA の資格情報・ドメイン名を確認
- [ ] 生成後に、生成 AI 範囲が正解に入る問題数を集計して受入条件を確認

## デプロイ

- [ ] develop へ push・ビルド確認
- [ ] `./scripts/deploy-lambda.sh dev`
- [ ] 本番（master・prod Lambda）は確認してから
