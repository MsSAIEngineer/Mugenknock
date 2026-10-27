'use client';
import React, { useState, useMemo, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { EXAM_LEVEL, EXAM_LEVEL_COLORS, API_ENDPOINT, levelLabel, tint, levelText, levelOn } from '../constants';
import { EXAM_ICON_COMPONENTS, IconSearch, IconCopy, IconCheck } from '../components/Icons';
import { useLanguage } from '../contexts/LanguageContext';
import { useAuth } from '../contexts/AuthContext';
import PageLayout from '../components/ui/PageLayout';
import { useIsMobile } from '../hooks/useWindowWidth';
import { useHorizontalScrollHint } from '../hooks/useHorizontalScrollHint';

// ── データ型 ─────────────────────────────────────────────────
interface Item { name: string; desc: string; tags: string[]; keyword?: string; seeAlso?: string[]; termKeywords?: Record<string, string> }
interface Section { title: string; items: Item[] }
type CheatData = Record<string, Section[]>

// ── descのIT用語ハイライト対象（ASCII以外でコピー価値のある用語を網羅）──
const EXTRA_COPYABLE_TERMS = new Set([
  'アイデンティティベースポリシー', 'アウトバウンドエンドポイント', 'アクセスログ', 'アノテーション',
  'アラーム', 'アーカイブ＆リプレイ', 'イベントアーカイブ＆リプレイ', 'イベントパターンマッチング',
  'インスタンスストア', 'インスタンスタイプ', 'インバウンドエンドポイント', 'ウォームアップ期間',
  'ウォームスタート', 'エンタープライズ', 'エンドポイントグループ', 'エンドポイント監視',
  'エンベロープ暗号化', 'エージェント', 'オンデマンド', 'オンラインストア',
  'カスタムイベントバス', 'カスタムオーソライザー', 'カスタムコンテナ', 'カスタムフォーマット',
  'カスタムメトリクス', 'カスタムリソース', 'カスタムルール', 'ガバナンス',
  'ガードレール', 'キャッシュ', 'キーポリシー', 'キーポリシー（リソースベースポリシー）',
  'クエリフェデレーション', 'クックブック', 'クラスタ', 'クロスアカウント/クロスリージョンデプロイ',
  'クロスアカウントアクセス', 'クロスアカウントイベントバス', 'クロスアカウントデプロイ', 'クロスアカウント共有',
  'クロスゾーン負荷分散', 'クローラー', 'グラウンディング', 'グラウンディングチェック',
  'グローバルテーブル', 'グローバル展開', 'ゲートウェイ型', 'コアノード',
  'コンソリデーテッドビリング', 'コンテンツフィルタリング', 'コンピューティング環境', 'コンフォーマンスパック',
  'サブスクリプションフィルタポリシー', 'サブスクリプションフィルター', 'サブネット', 'サブネット分割',
  'サプライチェーンセキュリティ', 'サンプリングルール', 'サーバーレス推論', 'サービスマップ',
  'シャード', 'ジオブロッキング', 'ジョブキュー', 'スケジュール',
  'スケールメリット', 'スコープダウンステートメント', 'スタック', 'ステートフル',
  'ステートフルルール', 'ステートマシン', 'ステートレス', 'ステートレスルール',
  'ストリーミングレスポンス', 'スナップショット', 'スプリットトンネリング',
  'スポットインスタンス', 'スポットトレーニング', 'セキュリティ', 'セッションポリシー',
  'ソートキー', 'タスクノード', 'ターゲット追跡', 'テストレポート',
  'デフォルトイベントバス', 'デベロッパー', 'データイベント', 'データマッピング',
  'データ品質レポート', 'トラフィックダイヤル', 'トレーニングジョブ', 'ドリフト検出',
  'ドロップアウト', 'ネガティブプロンプト', 'バイアスドリフト', 'バイアス検出',
  'バケットポリシー', 'バッファリング', 'バージョニング', 'バージョン番号（バージョン衝突回避）',
  'パーティション', 'パーティションキー設計', 'パーティション設計', 'パートナーイベントバス',
  'ビヘイビア', 'フィルタポリシー', 'フェイルオーバー', 'フェデレーテッドラーニング',
  'プライベートアドレス空間', 'プラットフォーム', 'プロアクティブエンゲージメント', 'プロビジョニドスループット',
  'プロビジョニング済み同時実行', 'ベクトルストア選択', 'ベーシック', 'ポリシー',
  'ポリシー評価順', 'マスターノード', 'マッピングテンプレート', 'マネージドフェイルオーバー',
  'マネージドルール', 'マルチアタッチ', 'マルチエージェントオーケストレーション', 'マルチキャストサポート',
  'マルチパートアップロード', 'マルチリージョンキー', 'ミラーフィルター', 'メタデータ',
  'メトリクス', 'メトリクスフィルター', 'モニターの種類', 'ユースケース',
  'ライフサイクルフック', 'リアルタイムエンドポイント', 'リザーブド', 'リザーブドインスタンス',
  'リソースベースポリシー', 'リージョンの最適化', 'リードレプリカ', 'リードレプリカのプロモーション',
  'ルートテーブル', 'レイテンシ', 'レイヤー', 'レートベースルール',
  'ログアーカイブアカウント', 'ロググループ', 'ログストリーム', 'ロングポーリング',
  'ロールバック', 'ワークグループ', '予測スケーリング', '他ヘルスチェック監視',
  '分離ルーティング', '列・行レベルのきめ細かいアクセス制御', '可視性タイムアウト', '対応フレームワーク',
  '差分プライバシー', '手動承認アクション', '拡張ファンアウト', '推奨フォーマット',
  '推論エンドポイント', '特定トピックの拒否', '管理イベント', '組み込みアルゴリズム',
  '自動クォータリクエスト', '自動ローテーション', '複合アラーム', '説明可能性ドリフト',
  '起動テンプレート', '適切なモデルサイズの選択', '集中型アーキテクチャ',
  '6本柱', 'アクセス制御', 'イベント駆動', 'インシデント管理', 'インシデント調査', 'インメモリキャッシュ', 'ウェルノウンポート', 'オブジェクトストレージ', 'コスト可視化', 'コンテナレジストリ', 'コンテナ管理', 'ストリーム処理', 'セルフサービス', 'ソフト配布', 'ハッシュ関数', 'フルマネージド', 'ベストプラクティス', 'マルウェア', 'マルチアカウント', 'モデルレジストリ', 'モデル評価', 'リスクアセスメント', 'ルーティングテーブル', '一元管理', '予算アラート', '企業内検索', '冗長化', '分離レベル', '専用線', '検索拡張生成', '構成管理', '機密データ検出', '監査ログ', '脅威検出', '脆弱性管理', '設定管理', '認証基盤', '適正サイズ推奨',
  // 昇格: 全記事監査（2026-09-20）で検索・コピー価値ありと判断した用語
  'プロンプトインジェクション', '同時実行制限', '非同期推論', 'バッチ変換', 'マルチモデルエンドポイント',
  'マネージドスポット学習', 'マネージドウォームプール', '分散スタイル', 'ウィンドウ関数', 'サブクエリ', 'データ拡張',
  // 昇格: 調べる価値のある難しい概念（日本語）をティール(コピー可)に
  'スタースキーマ', 'スノーフレークスキーマ', 'レンジパーティション', 'リストパーティション', 'ハッシュパーティション', 'カプセル化', 'ステートフルインスペクション', 'デッドロック', 'ダーティリード', 'ノンリピータブルリード', 'ファントムリード', 'ハイブリッド暗号', 'キーライフサイクル', 'フォレンジック', 'ソーシャルエンジニアリング', 'ハッシュインデックス', '複合インデックス', 'パーセプトロン', '活性化関数', '生成モデル', 'ラベルエンコーディング', 'ターゲットエンコーディング', 'ベイズ最適化', 'グリッドサーチ', 'ランダムサーチ', 'ハイパーパラメータ', '階層的クラスタリング', 'アンサンブル学習', '非正規化', 'サブネットマスク', 'デフォルトゲートウェイ', '静的ルーティング', '動的ルーティング', 'ブロードキャストドメイン', 'ユニキャスト', 'ブロードキャスト', 'マルチキャスト', 'マルチキャストアドレス', 'ジャンボフレーム', 'フラグメンテーション', 'トンネリング', 'デジタル署名', 'デジタル証明書', 'フェデレーション', 'フィッシング', 'ランサムウェア', 'トロイの木馬', 'スパイウェア', 'パッチ管理', '集約関数', '主成分分析',
]);

// 降格: 単純・周知の語（コピー価値が低い）は ASCII でも黒太字にする（ティールにしない）
const SIMPLE_TERMS = new Set<string>([
  'ALL', 'ANALYZE', 'AUTO', 'EVEN', 'KEY', 'WHERE', 'HAVING', 'DISTINCT', 'VACUUM', 'GROUP', 'ORDER', 'LIMIT', 'UNION', 'CHAR',
  'Standard', 'Immutable', 'Canary', 'Linear', 'Rolling', 'All-at-once', 'Task', 'Map', 'Choice', 'Parallel', 'Wait', 'install', 'build', 'Advanced', 'L1', 'L2', 'L3',
  // 基礎的で周知の語（調べる必要が薄い）は黒太字に
  'HTTP', 'HTTPS', 'URL', 'URI', 'JSON', 'XML', 'HTML', 'CSS', 'CSV', 'CPU', 'OS', 'ID', 'FTP', 'SMTP',
]);

// ── 共有アイテム（複数の試験セクションで使い回す場合はここに定義して参照する） ──
// 同じ Item オブジェクトを複数の items 配列に含めることで1箇所の定義を使い回せる
// 例: const ITEM_FOO: Item = { name: 'Foo', desc: '**...**', tags: [] };
//     SOA → items: [..., ITEM_FOO]  /  SCS → items: [..., ITEM_FOO]

// ── 試験別チートシートデータ ──────────────────────────────────
const CHEAT_DATA: CheatData = {
  CLF: [
    {
      title: 'クラウドの概念',
      items: [
        { name: '責任共有モデル', desc: '責任共有モデルは、**AWSと顧客でセキュリティ責任を分担するモデル**（英語名：Shared Responsibility Model）。\n責任の分担：\n- AWS負担：物理インフラ・ホスト・ネットワーク・ストレージハードウェア（Security "of" the Cloud）\n- 顧客負担：OS・ミドルウェア・アプリ・データ・IAM設定（Security "in" the Cloud）', keyword: 'AWS 責任共有モデル', tags: ['分担', 'セキュリティ', 'Shared Responsibility Model'] },
        { name: 'AWS Well-Architectedフレームワーク', desc: 'AWS Well-Architectedフレームワークは、**クラウド設計のベストプラクティスを6本柱で評価する**AWS公式のガイドライン。\n① 運用上の優秀性（変化への対応・自動化）\n② セキュリティ（最小権限・暗号化）\n③ 信頼性（障害自動回復・水平スケール）\n④ パフォーマンス効率（適切なリソース選択）\n⑤ コスト最適化（不要リソース排除）\n⑥ 持続可能性（エネルギー効率）', keyword: 'AWS Well-Architected Framework', tags: ['6本柱', '設計', 'ベストプラクティス'] },
        { name: 'AWS CAF（Cloud Adoption Framework）', desc: 'AWS CAF（Cloud Adoption Framework）は、**クラウド移行を組織全体で成功させる**6つの視点のフレームワーク。\nビジネス：ROI・ビジネスケース\n人：スキル・文化変革\nガバナンス：リスク管理・コンプライアンス\nプラットフォーム：アーキテクチャ基盤\nセキュリティ：セキュリティ管理\n運用：運用モデル', keyword: 'Cloud Adoption Framework', tags: ['移行', '6視点', 'フレームワーク'] },
        { name: 'サービスモデル', desc: 'クラウドは、提供する範囲によってIaaS・PaaS・SaaSに分けられ、この順に利用者が管理する範囲が狭くなる。\nIaaS（Infrastructure as a Service）：EC2のような仮想インフラ。**OS以上は自分で管理**\nPaaS（Platform as a Service）：Elastic Beanstalkのような実行基盤。アプリのみ管理\nSaaS（Software as a Service）：WorkSpacesのような完成品アプリ。設定のみ管理', keyword: 'IaaS PaaS SaaS クラウドサービスモデル', tags: ['IaaS', 'PaaS', 'SaaS'] },
        { name: 'クラウドメリット', desc: 'オンプレミスに比べ、AWSクラウドには俊敏性・弾力性・グローバル展開・コスト面などの利点がある。\n主なメリット：\n- 俊敏性（Agility）：**数分でリソース調達**（オンプレは数週間）\n- 弾力性（Elasticity）：需要に合わせて自動でスケールアップ/ダウン\n- グローバル展開：世界中のリージョンに即座にデプロイ\n- コスト：CAPEX（設備投資）→ OPEX（運用費）に転換し初期投資不要\n- スケールメリット：AWSの大規模調達によりユーザーのコストが下がる', keyword: 'AWSクラウドのメリット', tags: ['俊敏性', '弾力性', 'OPEX'] },
      ],
    },
    {
      title: 'コンピューティング',
      items: [
        { name: 'Amazon EC2', desc: 'Amazon EC2は、**OS・ミドルウェアを自由に選べる仮想サーバー**（Elastic Compute Cloud）。\n購入オプション：\n- オンデマンド：使った秒数だけ課金。短期・不規則な用途に最適\n- スポット：未使用キャパシティを最大90%割引で利用。中断許容が条件\n- リザーブド：1〜3年コミットで最大72%割引。安定した定常ワークロードに最適\n- Savings Plans：利用量をコミットする柔軟な割引プラン', tags: ['オンデマンド', 'スポット', 'リザーブド'] },
        { name: 'AWS Lambda', desc: 'AWS Lambdaは、**サーバー管理不要でコードだけ書けばよいサーバーレス実行環境**（FaaS：Function as a Service）。\nイベント（S3アップロード・API呼び出し・タイマー等）に応じて自動起動し、実行時間のみ課金される。', tags: ['サーバーレス', 'FaaS', 'トリガー'] },
        { name: 'AWS Elastic Beanstalk', desc: 'AWS Elastic Beanstalkは、アプリのコードをアップロードするだけで**Amazon EC2・Elastic Load Balancing（ELB）・AWS Auto Scalingを自動構築するPaaSサービス**。\nインフラを意識せずにアプリを素早くデプロイしたい場合に適している。', tags: ['PaaS', 'デプロイ', '自動設定'] },
        { name: 'Amazon ECS / Amazon EKS', desc: 'Amazon ECS / EKSは、**Dockerコンテナを実行・管理するコンテナオーケストレーション**サービス。\nECS（Elastic Container Service）：AWS独自のコンテナオーケストレーター。シンプルで使いやすい\nEKS（Elastic Kubernetes Service）：Kubernetes（コンテナ管理の業界標準OSS）のマネージドサービス\nどちらもAWS Fargate（サーバーレス起動モード）でAmazon EC2管理を省略できる', tags: ['コンテナ', 'Kubernetes', 'Fargate'] },
        { name: 'Amazon Lightsail', desc: 'Amazon Lightsailは、**固定月額でサーバー・SSD・データ転送量が含まれるシンプルなVPS**（仮想専用サーバー）。料金が予測しやすくWordPress・小規模Web向け。', tags: ['VPS', '固定料金', 'シンプル'] },
      ],
    },
    {
      title: 'ストレージ',
      items: [
        { name: 'Amazon S3', desc: 'Amazon S3は、耐久性99.999999999%（11ナイン）・容量無制限の**オブジェクトストレージ（ファイルをURLで管理する形式）**。\nバケット（≒フォルダのコンテナ）単位でデータを整理し、静的Webサイトのホスティングにも使える。容量無制限で、画像・動画・バックアップ・ログ等の保存に広く使われる。', tags: ['オブジェクト', '11ナイン', '静的ホスティング'] },
        { name: 'Amazon EBS', desc: 'Amazon EBSは、**EC2にアタッチ**して使うブロックストレージ（HDDやSSDのような仮想ディスク）。\ngp3：汎用SSD（デフォルト。コストと性能のバランスが良い）\nio2：プロビジョニドIOPS SSD（高IOPSが必要なDB用途）\nst1：スループット最適化HDD（ログやビッグデータの順次読み書き）\nsc1：コールドHDD（アクセス頻度が低いアーカイブ用途）', tags: ['ブロック', 'EC2', 'gp3'] },
        { name: 'Amazon EFS', desc: 'Amazon EFSは、**複数のEC2から同時マウントでき容量が自動スケールする共有ファイルシステム**（NFS）。', tags: ['NFS', '共有マウント', 'サーバーレス'] },
        { name: 'Amazon S3 Glacier', desc: 'Amazon S3 Glacierは、**長期アーカイブ向け**の低コストストレージ。S3 Standardより保存コストが大幅に安い。\n取得速度の種類：\n- Instant Retrieval：ミリ秒単位で取得可能（月1回程度のアクセスに最適）\n- Flexible Retrieval：数分〜12時間（コスト優先）\n- Deep Archive：最大48時間（最安。7〜10年保持のデータ向け）', tags: ['アーカイブ', '低コスト', '取得遅延'] },
      ],
    },
    {
      title: 'データベース',
      items: [
        { name: 'Amazon RDS', desc: 'Amazon RDSは、**パッチ・バックアップ・フェイルオーバーをAWSが自動管理する**マネージドなリレーショナルDB。\n対応エンジン：MySQL・PostgreSQL・MariaDB・Oracle・SQL Server・Aurora\nMulti-AZ：プライマリDBの変更を別AZ（アベイラビリティゾーン）のスタンバイDBに同期レプリケーションし、障害時に自動フェイルオーバー', tags: ['MySQL', 'Multi-AZ', 'リードレプリカ'] },
        { name: 'Amazon DynamoDB', desc: 'Amazon DynamoDBは、**一桁ミリ秒で自動スケールするフルマネージドなNoSQL DB**（キーバリュー型・ドキュメント型）。\nパーティションキー（+オプションでソートキー）でデータを管理し、一桁ミリ秒の低レイテンシを維持しながら自動でスケールする。', tags: ['NoSQL', '低レイテンシ', 'スケーラブル'] },
        { name: 'Amazon Aurora', desc: 'Amazon Auroraは、**MySQL・PostgreSQL互換で既存アプリを移行しやすいAWS独自設計の高性能RDB**。\nRDSより最大3倍高速で、6コピーのデータを3つのAZ（アベイラビリティゾーン）に自動分散保存して高耐久性を実現。\nAurora Serverless v2はトラフィックに応じてコンピュートを自動スケールする。', tags: ['MySQL互換', '高性能', 'Aurora Serverless'] },
        { name: 'Amazon ElastiCache', desc: 'Amazon ElastiCacheは、**データをメモリ上に保持し超高速アクセスを実現するインメモリキャッシュ**サービス。DBの繰り返し読み取りを代替してレイテンシとDB負荷を削減する。\nRedis：レプリケーション・永続化・Pub/Sub（発行/購読）・Sorted Set（順序付きセット）等の豊富な機能を持つ\nMemcached：シンプルなマルチスレッドキャッシュ。高スループットが必要な場合に適する', tags: ['Redis', 'Memcached', 'インメモリ'] },
        { name: 'Amazon Redshift', desc: 'Amazon Redshiftは、**列指向で大量データの分析クエリ（OLAP）を高速処理するデータウェアハウス**（DWH）。\n列指向ストレージ（同じ列のデータをまとめて圧縮・格納）により集計クエリを高速処理する。TB〜PBスケールのデータ分析に使用する。', tags: ['DWH', '列指向', '分析'] },
      ],
    },
    {
      title: 'ネットワーキング',
      items: [
        { name: 'Amazon VPC', desc: 'Amazon VPCは、**AWSクラウド内に作る仮想プライベートネットワーク**（Virtual Private Cloud）。\nサブネット：VPC内のIPアドレス範囲の分割単位（パブリック/プライベートで用途分け）\nルートテーブル：トラフィックの行き先を定義するルール\nインターネットゲートウェイ（IGW）：VPCとインターネットをつなぐゲートウェイ', tags: ['サブネット', 'ルートテーブル', 'IGW'] },
        { name: 'Amazon Route 53', desc: 'Amazon Route 53は、**ドメイン名をIPアドレスに変換するマネージドDNSサービス**（例：example.com → 1.2.3.4）。\nヘルスチェックでエンドポイントの死活を監視し、フェイルオーバールーティングで正常なリソースへ自動切り替えできる。', tags: ['DNS', 'ヘルスチェック', 'ルーティング'] },
        { name: 'Amazon CloudFront', desc: 'Amazon CloudFrontは、**世界中のエッジロケーションにキャッシュしユーザーに最も近い拠点から低レイテンシで配信するCDN**（Content Delivery Network）。\nオリジン（配信元）にはS3・ALB・EC2・カスタムサーバーを設定できる。', tags: ['CDN', 'エッジ', 'キャッシュ'] },
        { name: 'Elastic Load Balancing（ELB）', desc: 'Elastic Load Balancing（ELB）は、**複数のターゲット（EC2やコンテナ等）にトラフィックを分散するロードバランサー**（負荷分散装置）。\nALB（Application Load Balancer）：HTTP/HTTPS（L7）。URLパスやホストヘッダーでルーティング\nNLB（Network Load Balancer）：TCP/UDP（L4）。固定IP・超低レイテンシが必要な用途向け', tags: ['ALB', 'NLB', 'L7/L4'] },
        { name: 'AWS Direct Connect', desc: 'AWS Direct Connectは、**オンプレミスとAWSをインターネットを経由しない専用線**（物理回線）で接続するサービス。\n安定した帯域幅・低レイテンシ・高セキュリティが実現でき、大容量データ転送や機密性が高いシステムに適している。', tags: ['専用線', 'ハイブリッド', '低レイテンシ'] },
      ],
    },
    {
      title: 'セキュリティ',
      items: [
        { name: 'AWS IAM', desc: 'AWS IAMは、**AWSリソースへのアクセスを制御するサービス**（Identity and Access Management）。\nユーザー：個人のアカウント\nグループ：複数ユーザーへのまとめて権限付与\nロール：EC2やLambdaなどのサービスに一時的に権限を付与する仕組み\nポリシー：「何のリソースに何の操作ができるか」をJSON形式で定義したルール\n最小権限の原則（Least Privilege）：必要最小限の権限だけ付与する', tags: ['ポリシー', 'ロール', '最小権限 / Least Privilege'] },
        { name: 'AWS Shield', desc: 'AWS Shieldは、**DDoS攻撃（大量リクエストによるサービス妨害）を自動で軽減する**サービス。\nStandard：すべてのAWSリソースに無料で自動適用。L3/L4攻撃を防御\nAdvanced：有料オプション。L7攻撃も防御し、AWS Shield応答チーム（SRT）への24時間アクセスとDDoS起因のコスト保護も提供', tags: ['DDoS', 'Standard', 'Advanced'] },
        { name: 'AWS WAF', desc: 'AWS WAFは、SQLインジェクションやXSSなどWebアプリへの**L7（アプリ層）攻撃をフィルタリングするWebアプリケーションファイアウォール**。\nSQLインジェクション（DBへの不正クエリ注入）・XSS（クロスサイトスクリプティング）・ボット等の攻撃をルールでブロックする。Amazon CloudFront・Elastic Load Balancing（ALB）・Amazon API Gatewayに適用できる。', tags: ['Webファイアウォール', 'SQLi', 'XSS'] },
        { name: 'AWS KMS', desc: 'AWS KMS（Key Management Service）は、**暗号化キーを作成・保管・管理するキー管理サービス**。\nS3・EBS・RDS・DynamoDB等のAWSサービスと統合し、データを透過的に暗号化・復号する。CMK（Customer Managed Key）で暗号化ポリシーを細かく制御できる。', tags: ['暗号化', 'CMK', 'キー管理'] },
        { name: 'AWS Trusted Advisor', desc: 'AWS Trusted Advisorは、**AWS環境を5つの観点で診断し改善提案するアドバイザーツール**。\n5つのカテゴリ：\n- コスト最適化\n- パフォーマンス\n- セキュリティ\n- 耐障害性\n- サービス上限\nBasicサポートでも一部のチェックは無料で使用できる。', tags: ['ベストプラクティス', 'コスト', 'セキュリティ'] },
      ],
    },
    {
      title: '管理・監視',
      items: [
        { name: 'Amazon CloudWatch', desc: 'Amazon CloudWatchは、**AWSリソースとアプリを監視するサービス**（メトリクス・ログ・アラーム）。\nメトリクス：CPU使用率・メモリ・ネットワーク等の数値データをグラフで可視化\nログ：アプリやサービスのログを収集・検索\nアラーム：しきい値を超えたらSNS通知やAutoScalingを自動実行', tags: ['メトリクス', 'ログ', 'アラーム'] },
        { name: 'AWS CloudTrail', desc: 'AWS CloudTrailは、アカウントで実行された全APIコール（誰がいつ何をしたか）を**記録する監査ログサービス**。\n誰が・どのリソースに・いつ・何をしたかを追跡でき、デフォルトで90日間保持。S3に証跡を保存すれば無期限に保管できる。', tags: ['監査', 'APIログ', 'コンプライアンス'] },
        { name: 'AWS Config', desc: 'AWS Configは、リソースの設定変更を継続的に記録し、**望ましい状態からの逸脱やコンプライアンス準拠**を評価するサービス。\nルール（例：「S3バケットの公開設定を禁止」）を定義して準拠状況を自動チェックし、違反を通知・自動修復できる。', tags: ['設定管理', 'ルール', 'コンプライアンス'] },
        { name: 'AWS Systems Manager', desc: 'AWS Systems Managerは、**EC2などのインフラを一元管理する**運用サービス群。\nSession Manager：SSHポートを開けずにブラウザからEC2にアクセス\nPatch Manager：OSのセキュリティパッチを自動適用\nParameter Store：設定値・秘密情報を安全に保管\nRun Command：複数EC2に同時コマンド実行', tags: ['パッチ管理', 'Session Manager', '自動化'] },
        { name: 'AWS Organizations', desc: 'AWS Organizationsは、**複数のAWSアカウントを階層的に一元統制する**管理サービス（SCP・一括請求）。\nOU（組織単位）でアカウントをグループ化し、SCP（サービスコントロールポリシー）でOU/アカウントに使用できるサービスや操作を制限できる。請求を一括でまとめられる（コンソリデーテッドビリング）。', tags: ['マルチアカウント', '一括請求', 'SCP'] },
      ],
    },
    {
      title: '料金・サポート',
      items: [
        { name: '料金モデル', desc: '料金モデルは、AWSの課金の基本的な考え方。基本は**「使った分だけ払う」従量課金**（オンデマンド）。\nリザーブドインスタンス：1〜3年コミットで最大72%割引\nSavings Plans：1〜3年間の利用量をコミットする柔軟な割引（EC2・Fargate・Lambdaに適用）\nスポットインスタンス：最大90%割引だが中断あり\nデータ転送：AWSへの受信は無料。送信は有料（リージョン外へ）', keyword: 'AWS 料金 リザーブドインスタンス Savings Plans', tags: ['オンデマンド', 'リザーブド', 'Savings Plans'] },
        { name: 'AWS Cost Explorer', desc: 'AWS Cost Explorerは、過去・現在・将来のAWSコストと使用量を**グラフで可視化・分析・予測する**ツール。\nサービス別・リソース別・タグ別・アカウント別にコストをフィルタリングでき、リザーブドインスタンスやSavings Plansの推奨事項も提示してくれる。', tags: ['コスト分析', '可視化', '予測'] },
        { name: 'AWS Budgets', desc: 'AWS Budgetsは、コスト・使用量・RI/Savings Plansが**しきい値を超えるとメール等で通知する**予算アラートサービス。\n予算の80%・100%に達したらメール通知するよう設定することが多い。', tags: ['予算管理', 'アラート', 'しきい値'] },
        { name: 'サポートプラン', desc: 'サポートプランは、AWSが提供する有償/無償の支援プラン。用途に応じて5段階から選択する。\nベーシック：無料。ドキュメント・フォーラムのみ\nデベロッパー：有料。メールサポート（翌日以内応答）\nビジネス：有料。24時間電話・チャット。信頼できるアドバイザー全チェック\nエンタープライズOn-Ramp：TAM（テクニカルアカウントマネージャー）へのプール制アクセス\nエンタープライズ：専任TAM・15分以内のSLA', keyword: 'AWS サポートプラン TAM テクニカルアカウントマネージャー', tags: ['ベーシック', 'ビジネス', 'エンタープライズ'] },
      ],
    },
  ],

  AIF: [
    {
      title: '生成AIの基礎',
      items: [
        { name: '基盤モデル（FM）', desc: '基盤モデル（FM）は、**大量のテキスト・画像等で事前学習済みの大規模AIモデル**（Foundation Model）。LLM（大規模言語モデル）が代表例。\n様々なタスクにファインチューニング（追加学習）やプロンプト（指示文）だけで適用できる汎用性が特徴。', keyword: 'Foundation Model LLM 大規模言語モデル', tags: ['LLM', '事前学習', 'Foundation Model'] },
        { name: 'プロンプトエンジニアリング', desc: 'プロンプトエンジニアリングは、**FMへの指示（プロンプト）を工夫してより良い出力を引き出す**技術。\nZero-shot：例示なしで直接タスクを指示\nFew-shot：入出力例を数件示して形式を教える\nChain-of-Thought（CoT）：「ステップごとに考えてください」と思考過程を明示させる\nSystem prompt：AIの役割・制約・口調を事前に設定する\nネガティブプロンプト：してはいけない制約を明示的に記述して誤動作を防ぐ（「〜するな」「〜は出力しない」等）\nプロンプトインジェクション：悪意あるユーザーがプロンプトに追加指示を埋め込んでシステムプロンプトを無効化する攻撃。Bedrock Guardrails（有害コンテンツ等を防ぐ防御機能）で対策', keyword: 'プロンプトエンジニアリング Prompt Engineering Chain-of-Thought ネガティブプロンプト プロンプトインジェクション', tags: ['Zero-shot', 'Few-shot', 'ネガティブプロンプト'] },
        { name: 'RAG（検索拡張生成）', desc: 'RAG（検索拡張生成）は、FMが学習していない最新情報や社内情報を検索して回答に活用する仕組み（Retrieval-Augmented Generation）。\n仕組み：ユーザーの質問 → 外部知識ベースをベクトル検索 → 関連情報を取得 → FMへのプロンプトに追加して回答生成\nFMの知識の欠如（学習カットオフ）やハルシネーションを補う', tags: ['検索拡張生成', 'ベクトル検索', '知識ベース'] },
        { name: 'ハルシネーション', desc: 'ハルシネーションは、FMが**事実と異なる情報を自信満々に生成**してしまう問題（幻覚）。\n対策：\n- グラウンディング：回答を引用元のドキュメントに根拠付ける\n- RAG（検索拡張生成）：検索した文書からのみ回答させる\n- 温度パラメータ（Temperature）を低くする：出力をより決定論的にする\n- ガードレール：誤情報に対してチェックを追加する', keyword: 'LLM ハルシネーション 幻覚 グラウンディング', tags: ['幻覚', 'グラウンディング', '正確性'] },
        { name: 'ファインチューニング', desc: 'ファインチューニングは、**事前学習済みFMを特定タスク用のデータで追加学習してカスタマイズする**手法。\nRLHF（Reinforcement Learning from Human Feedback）：人間がFMの出力に評価をつけ、その評価を報酬として強化学習で人間の好みに合わせる手法。ChatGPT等で広く使用されている。', keyword: 'Fine-tuning ファインチューニング RLHF', tags: ['追加学習', 'RLHF', 'カスタマイズ'] },
      ],
    },
    {
      title: 'AWSのAI/MLサービス',
      items: [
        { name: 'Amazon Bedrock', desc: 'Amazon Bedrockは、サーバーレスで複数の基盤モデル（FM）にAPIアクセスできるサービス。\n利用可能モデル：Anthropic Claude・Meta Llama・Amazon Titan・Mistral・Cohere 等\n追加機能：Knowledge Bases（RAG構築）・Agents（自律タスク実行）・Guardrails（有害コンテンツフィルタ）・Model Evaluation', tags: ['Claude', 'Titan', 'サーバーレス'] },
        { name: 'Amazon SageMaker', desc: 'Amazon SageMakerは、**データ準備〜学習〜デプロイ〜監視までML全ライフサイクルをカバーする**統合プラットフォーム。\nデータ準備（Data Wrangler）→ 学習（Training Jobs）→ ハイパーパラメータ調整（AMT）→ モデル登録（Model Registry）→ デプロイ（Endpoints）→ 監視（Model Monitor）まで一気通貫で対応', tags: ['ML全般', 'Studio', 'エンドポイント'] },
        { name: 'Amazon Rekognition', desc: 'Amazon Rekognitionは、**画像・動画を分析する**事前学習済みのコンピュータービジョンAPI。\n主な機能：\n- 顔認識\n- 物体検出\n- シーン検出\n- テキスト抽出\n- コンテンツモデレーション（不適切コンテンツ検出）\n- 有名人認識\n- PPE（個人用保護具）検出', tags: ['画像認識', '顔認識', '物体検出'] },
        { name: 'Amazon Comprehend', desc: 'Amazon Comprehendは、**テキストを分析するNLP**（自然言語処理）API。\n感情分析（ポジティブ/ネガティブ判定）・エンティティ抽出（人名・地名・組織名等）・言語検出・キーフレーズ検出・構文解析\nComprehend Medical：医療テキスト特化版', tags: ['NLP', '感情分析', 'エンティティ'] },
        { name: 'Amazon Polly', desc: 'Amazon Pollyは、**テキストを自然な音声に変換する**TTS（Text-to-Speech）サービス。\n60言語以上・多様な声種（ニューラル音声で自然度が高い）に対応。\nSSML（Speech Synthesis Markup Language）で話速・ポーズ・強調等を細かく制御できる。', tags: ['TTS', '音声合成', 'SSML'] },
        { name: 'Amazon Transcribe', desc: 'Amazon Transcribeは、**音声をテキストに変換する**STT（Speech-to-Text）サービス。\n話者分離（誰が話したかを識別）・カスタム語彙（専門用語の認識精度向上）・リアルタイム文字起こし・Transcribe Medical（医療特化版）', tags: ['STT', '文字起こし', '話者分離'] },
        { name: 'Amazon Lex', desc: 'Amazon Lexは、**Alexaと同じ技術を使った会話型AIボットの構築サービス**（音声・テキスト両対応）。\nインテント（ユーザーの意図）/ スロット（情報の収集項目）/ 発話サンプルを設定してチャットボットを作成し、Lambda関数と連携してバックエンド処理を実行する。', tags: ['チャットボット', '会話AI', 'Alexa'] },
        { name: 'Amazon Kendra', desc: 'Amazon Kendraは、自然言語の質問に対し**S3・SharePoint・Confluence等の社内文書から回答する**企業向けインテリジェント検索エンジン。\nFAQや手順書の検索・社内ポータルのQ&A機能に活用できる。', tags: ['企業検索', 'ナレッジ', 'RAG'] },
        { name: 'Amazon Textract', desc: 'Amazon Textractは、**文書・フォームからテキストやデータを自動抽出する**OCR（光学文字認識）サービス。\n単純なOCRと異なりテーブル構造・フォームのキー・バリュー対・署名等も理解して抽出できる。請求書・契約書・医療フォームの処理に使用。', tags: ['OCR', 'フォーム抽出', '文書解析'] },
        { name: 'IDP（インテリジェントドキュメント処理）', desc: 'IDP（インテリジェントドキュメント処理）は、**OCRとNLPを組み合わせてAIで文書を自動処理する**設計パターン。\nAmazon Textract（OCR・フォーム抽出）→ Amazon Comprehend（NLP・感情分析・エンティティ抽出）→ AWS Lambda（後処理・振り分け）を組み合わせた典型構成。\n請求書・申請書・医療記録等の大量文書を人手介入なしに処理でき、S3をハブとして各サービスを連携させる。', keyword: 'IDP Textract Comprehend 文書処理 インテリジェントドキュメント', tags: ['IDP', 'Textract+Comprehend', '文書自動化'] },
        { name: 'Amazon SageMaker Clarify', desc: 'Amazon SageMaker Clarifyは、**モデルのバイアス検出と説明可能性（XAI）を提供する**SageMakerの機能。\nバイアス検出：訓練データのバイアス（学習前）とモデル予測のバイアス（学習後）を統計指標で測定\nSHAP値：各特徴量が予測に与えた貢献度を定量化する手法（Shapley Additive exPlanations）\nAmazon SageMaker Model Monitorと連携してデプロイ後のバイアスドリフトを継続監視できる', keyword: 'SageMaker Clarify バイアス検出 SHAP 説明可能性', tags: ['バイアス検出', 'SHAP', 'XAI'] },
        { name: 'Amazon Translate', desc: 'Amazon Translateは、**75言語以上に対応するニューラル機械翻訳**API。\nカスタム用語集を設定することで専門用語・ブランド名・製品名を正確に翻訳できる。リアルタイム翻訳とバッチ翻訳の両方に対応。', tags: ['翻訳', '多言語', 'ニューラル'] },
      ],
    },
    {
      title: '責任あるAI・ガバナンス',
      items: [
        { name: '公平性（Fairness）', desc: '公平性（Fairness）は、AIモデルが特定の人種・性別・年齢・地域等に対して**不公平な予測をしないようにする**設計上の考え方。\n訓練データのバイアス（偏り）を検出・除去し、モデルの予測が集団間で均等になるよう評価・調整する。\nAmazon SageMaker Clarifyを使ってバイアスレポートを自動生成できる。', keyword: 'AI 公平性 バイアス SageMaker Clarify', tags: ['バイアス', '公平性', '差別防止'] },
        { name: '説明可能性（XAI）', desc: '説明可能性（XAI）は、「なぜその予測をしたか」を人間が理解できるようにする技術（Explainable AI）。\nSHAP値（Shapley Additive exPlanations）：各特徴量が予測にどれだけ貢献したかを定量的に示す手法。Amazon SageMaker Clarifyで計算できる。ブラックボックスなモデルの透明性を確保するために重要。', keyword: 'Explainable AI XAI SHAP値', tags: ['XAI', 'SHAP', '透明性'] },
        { name: 'プライバシーとセキュリティ', desc: 'プライバシーとセキュリティは、AIの開発・運用で個人情報を保護する観点。**PII（個人識別情報）を訓練データに含めないことが原則**。\n差分プライバシー：個人データを統計的に保護しながら学習する手法\nフェデレーテッドラーニング：データを送らずにモデルの更新情報だけを集めて分散学習する手法\nAmazon Macieを使ってS3上のPIIを自動検出できる。', keyword: 'PII 個人情報 差分プライバシー フェデレーテッドラーニング', tags: ['PII', '差分プライバシー', 'データ保護'] },
        { name: 'AIガバナンス', desc: 'AIガバナンスは、**AIモデルのライフサイクル全体（開発→デプロイ→運用）にわたるリスク管理・監査・ポリシー遵守の枠組み**。\nAWS AI Service Cards：AWSが各AIサービスの設計・用途・評価結果を公開して透明性を確保するドキュメント\nAmazon Bedrock Guardrails：有害コンテンツ・PII・特定トピックのフィルタリングを一元管理', keyword: 'AIガバナンス AWS AI Service Cards Bedrock Guardrails', tags: ['ガバナンス', 'リスク管理', 'コンプライアンス'] },
      ],
    },
  ],

  SAA: [
    {
      title: 'コンピューティング',
      items: [
        { name: 'AWS Fargate', desc: 'AWS Fargateは、EC2インスタンスを管理せずコンテナを**起動できるサーバーレスコンテナ**実行基盤。\nECS・EKS の起動タイプとして選択（EC2起動タイプとの対比）\nタスク/Pod 単位で必要なvCPU・メモリを指定し使った分だけ課金\nサーバー管理・パッチ・スケーリングが不要でオーバーヘッドを削減', keyword: 'AWS Fargate サーバーレスコンテナ ECS EKS 起動タイプ', tags: ['サーバーレスコンテナ', 'ECS/EKS起動タイプ', '管理不要'], seeAlso: ['Amazon ECS / Amazon EKS'] },
        { name: 'Amazon EC2', desc: 'EC2はワークロード特性に応じてインスタンスタイプを選択する。\nインスタンスタイプ：汎用（M系）・コンピュート最適化（C系）・メモリ最適化（R系）・GPU（P・G系）\n配置グループ（Placement Group）：\n- クラスタ（Cluster）：同一ラック内に密集配置（超低レイテンシ・HPC向け）\n- 分散（Spread）：各インスタンスを別ラックに分散（可用性向上）\n- パーティション（Partition）：ラックをグループ化して大規模分散DB向け\nインスタンスストア：EC2に物理的に接続されたNVMe SSD（**停止/終了するとデータ消失**）', tags: ['インスタンスタイプ', '配置グループ / Placement Group', 'スポット'] },
        { name: 'AWS Auto Scaling', desc: 'AWS Auto Scalingは、需要に応じてEC2インスタンス数などを**自動で増減させる**サービス。\nスケーリングポリシーの種類：\n- ターゲット追跡（Target Tracking）：CPU使用率50%などのメトリクスを目標値に自動調整\n- ステップ（Step Scaling）：メトリクスの値の幅に応じてスケール量を段階的に設定\n- スケジュール（Scheduled）：特定の日時に事前にスケール\n- 起動テンプレート（Launch Template）：インスタンスタイプ・AMI・セキュリティグループ等の構成を定義したテンプレート\n- ウォームアップ期間（Instance Warmup）：新インスタンスが安定するまでメトリクスへの影響を除外する時間', tags: ['ターゲット追跡 / Target Tracking', '起動テンプレート / Launch Template', 'ウォームアップ'], termKeywords: { 'ターゲット追跡（Target Tracking）': 'ターゲット追跡（AWS Auto Scaling）', 'ステップ（Step Scaling）': 'ステップスケーリング（AWS Auto Scaling）', 'スケジュール（Scheduled）': 'スケジュールスケーリング（AWS Auto Scaling）', 'ウォームアップ期間（Instance Warmup）': 'ウォームアップ期間（AWS Auto Scaling）' } },
        { name: 'AWS Lambda', desc: 'イベント駆動型サーバーレス実行環境。最大実行時間15分・最大メモリ10GB。\n同時実行制限：デフォルト1アカウントあたり1000（緩和申請可）\nプロビジョニング済み同時実行：**コールドスタートを防ぐために事前にインスタンスを起動する**機能\nレイヤー：共通ライブラリを複数のLambda関数で共有する仕組み\nDestinations：非同期呼び出しの成功/失敗時に別サービスへ結果を転送', tags: ['同時実行', 'レイヤー', 'デスティネーション'] },
        { name: 'Amazon ECS / Amazon EKS', desc: 'ECSとEKSはどちらもコンテナをオーケストレーションするマネージドサービス。\nコンテナ管理：**ECS（AWS独自）**とEKS（Kubernetes）\nECS（Elastic Container Service）：\n① TaskDefinition（コンテナ定義）\n② Service（実行台数管理）\n③ Cluster（実行環境全体）\nの構成\nFargate起動タイプでサーバー管理不要、EC2起動タイプでカスタマイズ可能\nEKS（Elastic Kubernetes Service）：\nKubernetes（大規模コンテナ管理のOSS）のマネージドクラスタ。eksctlやkubectlでクラスタ管理', tags: ['Fargate', 'TaskDefinition', 'Kubernetes'] },
        { name: 'AWS Batch', desc: 'AWS Batchは、スポットEC2やAWS Fargate上で**バッチ処理ジョブを効率的に実行する**サービス。\nジョブキュー：ジョブの待ち行列。優先度を設定できる\nコンピューティング環境：使用するEC2タイプ・スポット率・上限vCPU数等を設定\nジョブ依存関係：依存するジョブが完了してから実行する順序制御が可能', tags: ['バッチ', 'スポット', 'ジョブキュー'] },
      ],
    },
    {
      title: 'ストレージ',
      items: [
        { name: 'Amazon S3', desc: 'S3はアクセス頻度に応じてストレージクラスを使い分ける。\nストレージクラス（**アクセス頻度に応じて選択**）：\n- Standard：高頻度アクセス向け（デフォルト）\n- IA（Infrequent Access）：低頻度アクセス。取得時に追加課金\n- One Zone-IA：単一AZで低コスト。再作成可能なデータ向け\n- Intelligent-Tiering：アクセスパターンを自動学習してクラスを切り替え\n- Glacier系：アーカイブ（取得時間とコストがトレードオフ）\nCRR（Cross-Region Replication）：別リージョンへの自動レプリケーション\nSRR（Same-Region Replication）：同リージョン内の別バケットへのレプリケーション', tags: ['ストレージクラス', 'ライフサイクル', 'レプリケーション'] },
        { name: 'Amazon EBS', desc: 'EBSは性能とコストの要件に応じてボリュームタイプを選べる。\ngp3：汎用SSD。**IOPSとスループットを独立して設定可能**\nio2：プロビジョニドIOPS SSD。高IOPS・高耐久性。マルチアタッチ対応\nst1：スループット最適化HDD。ログ・ビッグデータの順次読み書き向け\nsc1：コールドHDD。アクセス頻度が最も低いデータ向け\nマルチアタッチ：同一AZ内の複数EC2に同時接続（io1/io2のみ）', tags: ['gp3', 'io2', 'マルチアタッチ'] },
        { name: 'Amazon EFS', desc: 'EFSは容量に応じて**自動スケールする共有ファイルシステム**（NFS：Network File System）。\nInfrequent Accessストレージクラスで低頻度アクセスのファイルを自動的に低コストのクラスに移動してコスト削減できる。EC2・ECS・Lambda・SageMakerなどから同時マウント可能。', tags: ['NFS', 'InfrequentAccess', '自動スケール'] },
        { name: 'Amazon FSx', desc: 'Amazon FSxは、用途特化型のフルマネージドなファイルシステム（Windows/Lustre等）。\n主な種類：\n- FSx for Windows File Server：**SMBプロトコル対応**。Active Directory統合。Windowsアプリ・共有フォルダ向け\n- FSx for Lustre：高性能並列ファイルシステム。HPC（高性能コンピューティング）・ML学習向け。S3と統合してデータセットを自動読み込み可能', tags: ['Windows', 'Lustre', 'HPC'] },
        { name: 'Amazon S3 Glacier', desc: 'S3 Glacierは取得速度とコストのトレードオフで取得オプションを選べる。\nInstant Retrieval：**ミリ秒で取得**。月1回程度のアクセスに最適\nFlexible Retrieval：数分〜12時間（Bulk選択で最安）\nDeep Archive：最大48時間。7〜10年保持が義務付けられたデータ向けで最安ストレージ', tags: ['Instant', 'Flexible', 'Deep Archive'] },
        { name: 'AWS Storage Gateway', desc: 'AWS Storage Gatewayは、オンプレミスとAWSストレージを**ブリッジする**サービス。\nFile Gateway：NFS/SMBでオンプレからS3にファイル保存。S3のキャッシュをローカルに保持\nVolume Gateway（キャッシュ型）：S3にデータを格納しよく使うデータをローカルキャッシュ\nVolume Gateway（ストア型）：ローカルにデータを保持しS3に非同期バックアップ\nTape Gateway：バックアップソフトからS3 Glacierにテープを仮想化', tags: ['File GW', 'Volume GW', 'ハイブリッド'] },
      ],
    },
    {
      title: 'データベース',
      items: [
        { name: 'Amazon RDS', desc: 'RDSはMulti-AZ構成で高可用性を確保する。\nMulti-AZ：**プライマリDBの変更をスタンバイDBへ同期レプリケーション**。障害時に自動フェイルオーバー（Failover・60-120秒程度）。スタンバイは読み取り不可\nリードレプリカ（Read Replica）：非同期レプリケーションで読み取りをスケールアウト。最大5台。マスター昇格も可能\nポイントインタイムリカバリ（PITR：Point-in-Time Recovery）：任意の時点のデータに最大35日前まで復元可能', tags: ['Multi-AZ', 'リードレプリカ / Read Replica', 'フェイルオーバー / Failover'] },
        { name: 'Amazon Aurora', desc: '**最大15台のリードレプリカをサポート**（RDSは最大5台）\nAurora Global Database：1プライマリリージョン＋最大5セカンダリリージョン。RPO 1秒・RTO 1分以内のDR\nAurora Serverless v2：トラフィックに応じてコンピュートを自動スケール。コスト効率が高い\nストレージ：6コピーを3つのAZに自動分散。10GBから自動拡張', tags: ['Global Database', 'Serverless v2', '15リードレプリカ'] },
        { name: 'Amazon DynamoDB', desc: 'DynamoDBはセカンダリインデックスで多様なクエリを可能にする。\nGSI（グローバルセカンダリインデックス）：別のパーティションキーで**クエリを可能にする**。非同期で更新\nLSI（ローカルセカンダリインデックス）：同一パーティション内で別のソートキーを使用。テーブル作成時のみ定義可能\nDAX（DynamoDB Accelerator）：マイクロ秒レイテンシのインメモリキャッシュ。APIを変えずに使用可能\nStreams：テーブルの変更をリアルタイムにLambdaへ配信\nグローバルテーブル：マルチリージョンのアクティブ-アクティブ構成', tags: ['GSI/LSI', 'DAX', 'グローバルテーブル'] },
        { name: 'Amazon ElastiCache', desc: 'ElastiCacheはRedisとMemcachedの2エンジンでインメモリキャッシュを提供する。\nインメモリキャッシュ：Redis / Memcached で**高速アクセス**\nRedis：\n- レプリケーション・クラスタモード（シャーディングで水平スケール）\n- Sentinel（高可用性）・Pub/Sub（発行/購読）・Sorted Set（順序付きセット）等の高度なデータ構造\n- 永続化（AOF：操作ログ方式 / RDBスナップショット方式）でデータを保持\nMemcached：\n- マルチスレッドで高スループット。シャーディングで水平スケール\n- シンプルなKVストアのみ。永続化なし', tags: ['Redis', 'Memcached', 'クラスタモード'] },
        { name: 'Amazon Redshift', desc: '列指向ストレージのDWH（データウェアハウス）。**TB〜PBスケールの分析に使用**。\nRedshift Spectrum：S3上のデータをRedshiftの外部テーブルとして直接クエリ可能。ETLなしでS3のデータを分析\nAQUA（Advanced Query Accelerator）：専用ハードウェアでクエリを最大10倍高速化する機能', tags: ['列指向', 'Spectrum', 'AQUA'] },
        { name: 'Amazon Neptune', desc: 'Amazon Neptuneは、ノードとエッジで**関係性を管理するグラフデータベース**。\n対応クエリ言語：\n- Gremlin：Property Graphモデル（汎用グラフ）\n- SPARQL：RDF（Resource Description Framework）形式の知識グラフ\n- OpenCypher：Cypherクエリ言語\nユースケース：ソーシャルネットワーク・不正検知・レコメンデーション・ナレッジグラフ', tags: ['グラフDB', 'Gremlin', 'SPARQL'] },
      ],
    },
    {
      title: 'ネットワーキング',
      items: [
        { name: 'Amazon VPC基礎', desc: 'VPCはNACLとセキュリティグループの2層でトラフィックを制御する。\nアクセス制御：**NACL（ステートレス）**とSG（ステートフル）\nNACL（ネットワークアクセスコントロールリスト）：\nステートレス（行き・戻り両方を明示的に許可必要）\nサブネットに適用。番号が小さいルールから順に評価\nSG（セキュリティグループ）：\nステートフル（戻りパケットは自動許可）\nENI（ネットワークインターフェース）に適用。全ルールを評価', keyword: 'Amazon VPC セキュリティグループ NACL', tags: ['NACL', 'セキュリティグループ', 'ステートレス'] },
        { name: 'Amazon VPCピアリング / AWS Transit Gateway（TGW）', desc: '複数のVPCをつなぐには、1対1で接続するVPCピアリングと、ハブとして多数を集約するTransit Gateway（TGW）がある。\n2つの接続方式：\n- VPCピアリング：**2つのVPCを1対1で接続**。推移的ルーティング不可（A-B-CでAからCには直接ピアリングが必要）\n- Transit Gateway（TGW）：ハブ&スポーク型でN個のVPCを一元接続。各VPCはTGWにアタッチするだけでN対N接続が実現。アタッチメント種別：VPC・Site-to-Site VPN・Direct Connect', tags: ['ピアリング', 'TGW', 'ハブ&スポーク'] },
        { name: 'Amazon VPCエンドポイント', desc: 'Amazon VPCエンドポイントは、インターネットを経由せず**AWSサービスにプライベートアクセスする**仕組み。\nゲートウェイ型：S3・DynamoDBのみ対応。ルートテーブルにエントリを追加。追加料金なし\nインターフェース型（PrivateLink）：その他多数のAWSサービスに対応。ENIをサブネットに作成。時間課金あり', tags: ['ゲートウェイ型', 'PrivateLink', 'インターフェース型'] },
        { name: 'ALB / NLB', desc: 'ELB（ロードバランサー）には、HTTP/HTTPSを扱うALB（L7）と、TCP/UDPを低遅延で捌くNLB（L4）があり、用途で使い分ける。\nALB（Application Load Balancer）：HTTP/HTTPS（L7）\nURLパス・ホストヘッダー・HTTPメソッドで**コンテンツベースルーティング**\nターゲットグループにEC2・ECS・Lambda・IPを登録\nNLB（Network Load Balancer）：TCP/UDP（L4）\n固定IPを提供（ElasticIPを割り当て可能）\n超低レイテンシ・大量同時接続。TLSパススルーが可能', tags: ['ALB', 'NLB', 'ターゲットグループ'] },
        { name: 'Amazon Route 53 ルーティング', desc: 'Route 53は用途に応じてルーティングポリシーを選べる。\nルーティングポリシー（7種類・状況に応じて使い分ける）：\n- シンプル（Simple）：**1つのリソースに転送**\n- 重み付け（Weighted）：複数リソースに比率を指定して分散\n- レイテンシ（Latency）：最もレイテンシが低いリージョンへ転送\n- フェイルオーバー（Failover）：ヘルスチェック失敗時にセカンダリへ切り替え\n- 地理的（Geolocation）：ユーザーの所在地（国・州）に基づいて転送\n- 地理的近接性（Geoproximity）：ユーザーとリソースの物理的距離に基づいて転送\n- 多値応答（Multivalue Answer）：複数のIPを返し、ヘルスチェックで正常なもののみ返す', tags: ['フェイルオーバー / Failover', 'レイテンシ / Latency', '地理的近接性 / Geoproximity'] },
        { name: 'Amazon CloudFront', desc: 'グローバルCDN。**AWSバックボーン経由で低レイテンシ配信**。\nOAC（Origin Access Control）：CloudFrontを経由したアクセスのみS3バケットに許可する仕組み\nビヘイビア：URLパスパターンごとにオリジン・キャッシュポリシー・関数を設定\nLambda@Edge：CloudFrontのイベント（Viewer Request/Response・Origin Request/Response）でLambdaを実行\nCloudFront Functions：JavaScriptでHTTPヘッダー書き換えやURL変換を低コスト・低レイテンシで実行', tags: ['OAC', 'Lambda@Edge', 'ビヘイビア'] },
        { name: 'AWS Global Accelerator', desc: 'AWS Global Acceleratorは、Anycast IPで世界中のユーザーを最寄りのAWSエッジに誘導し、**AWSバックボーン経由で高速転送する**サービス。\n2つの固定グローバルIPを提供（ホワイトリスト管理が容易）。非HTTPプロトコル（TCP/UDP）にも対応。CloudFrontはHTTPコンテンツキャッシュ向けで用途が異なる。', tags: ['Anycast', '固定IP', 'バックボーン'] },
        { name: 'AWS Direct Connect / VPN', desc: 'オンプレミスとAWSの接続には、専用線のDirect Connectと、インターネット経由で暗号化するVPNという2つの主要な方式がある。\n主な接続方式：\n- Direct Connect：**物理専用線でオンプレ↔AWSを接続**。BGP（Border Gateway Protocol）でルートを交換。最長一致ルールで転送先を決定。冗長化は複数接続を推奨\n- Site-to-Site VPN：インターネット経由の暗号化接続（IPsec）。カスタマーゲートウェイ（CGW）と仮想プライベートゲートウェイ（VGW）を接続\n- 最大冗長化：Direct ConnectとVPNの両方を組み合わせて使用', tags: ['BGP', '専用線', '冗長化'] },
      ],
    },
    {
      title: 'セキュリティ・IAM',
      items: [
        { name: 'AWS IAM', desc: 'IAMは明示的な拒否を最優先にポリシーを評価する。\nポリシー評価順：\n**① 明示的な拒否（Deny）**\n② 許可（Allow）\n③ 暗黙の拒否\nクロスアカウントアクセス：AssumeRoleでロールを引き受け一時的な認証情報を取得\nリソースベースポリシー：S3バケットポリシー・KMSキーポリシー等。リソース側に直接付与\nアイデンティティベースポリシー：IAMユーザー・グループ・ロールに付与', tags: ['ポリシー評価', 'クロスアカウント', 'リソースベース'] },
        { name: 'AWS KMS', desc: 'KMSは管理主体に応じてキーの種類を使い分ける。\nAWSマネージドキー：**AWSが自動作成**・管理。キーポリシーのカスタマイズ不可\nCMK（カスタマーマネージドキー）：ユーザーが作成・管理。キーポリシーで細かいアクセス制御が可能\nエンベロープ暗号化：データキー（DEK）でデータを暗号化し、DEK自体をCMKで暗号化する二層構造。大きなデータを効率よく暗号化する仕組み', tags: ['CMK', 'エンベロープ暗号化', 'キーポリシー'] },
        { name: 'AWS Secrets Manager', desc: 'AWS Secrets Managerは、パスワード・APIキー・DB認証情報等のシークレットを**安全に保管・管理する**サービス。\n自動ローテーション：Lambda関数を使ってRDS・Redshift・DocumentDB等のパスワードを定期的に自動更新\nSSM（AWS Systems Manager） Parameter Store との違い：Parameter Storeはシークレットの自動ローテーション機能がない。Secrets Managerはローテーションが必要なDB認証情報に適している', tags: ['自動ローテーション', 'DB認証情報', 'Lambda'] },
        { name: 'Amazon Cognito', desc: 'Amazon Cognitoは、Web・モバイルアプリにユーザー認証と認可を提供するサービス。\n2種類のプール：\n- User Pool：**ユーザー認証（サインアップ・サインイン）を管理するIDプロバイダー**。認証成功時にJWT（IDトークン・アクセストークン・リフレッシュトークン）を発行\n- Identity Pool：フェデレーション（Google・Facebook・User Pool等）した認証情報をもとに一時的なAWS認証情報（IAMロールの権限）を払い出してAWSリソースに直接アクセスさせる', tags: ['User Pool', 'Identity Pool', 'フェデレーション'] },
        { name: 'AWS Organizations / SCP', desc: 'Organizationsでは、配下のアカウントにガードレールを課せる。SCPは使える権限の上限を、RCP（リソースコントロールポリシー）はリソース側の上限を設定する。\nSCP（サービスコントロールポリシー）：OU（組織単位）やアカウントに**適用するガードレール**。\n最大権限の上限を設定するだけで権限を付与する機能はない（IAM許可とのAND評価）\n例：「このOUでは東京リージョン以外のEC2起動を禁止」というルールを一括適用できる', tags: ['SCP', 'OU', 'ガードレール'], seeAlso: ['AWS Organizations（マルチアカウント管理）'] },
      ],
    },
    {
      title: '統合・メッセージング',
      items: [
        { name: 'Amazon SQS', desc: 'Amazon SQSは、アプリ間を疎結合にするフルマネージドなメッセージキューサービス。\nキューの種類と主な機能：\n- 標準キュー：**順序不保証・少なくとも1回配信**・ほぼ無制限スループット\n- FIFOキュー：順序保証・1回のみ配信・最大3000msg/s（バッチ使用時）\n- 可視性タイムアウト：メッセージ取得後に他のConsumerから見えなくする時間（処理中の二重処理防止）\n- DLQ（Dead Letter Queue）：最大受信回数を超えた処理失敗メッセージを退避するキュー', tags: ['標準', 'FIFO', '可視性タイムアウト'] },
        { name: 'Amazon SNS', desc: 'Amazon SNSは、Pub/Sub（パブリッシュ/サブスクライブ）型のメッセージング。\nトピックに複数のサブスクライバー（SQS・Lambda・HTTP・メール・SMS）を**登録してファンアウト（1対多配信）を実現する**。\nフィルタポリシー：サブスクライバーごとに受信するメッセージをフィルタリングできる', tags: ['Pub/Sub', 'ファンアウト', 'フィルタポリシー'] },
        { name: 'Amazon EventBridge', desc: 'Amazon EventBridgeは、AWSサービス・SaaSアプリ・カスタムアプリのイベントを**ルールでターゲットに転送する**イベントバスサービス。\nイベントパターンマッチングで条件にあうイベントだけ転送。スケジューラとしてcron式での定期実行も可能。\nEventBridge Pipes：以下のパイプラインを簡潔に構築\n① ソース\n② フィルタ\n③ 変換\n④ ターゲット', tags: ['イベントバス', 'ルール', 'スケジューラ'] },
        { name: 'AWS Step Functions', desc: 'AWS Step Functionsは、Lambda・ECS・DynamoDB等を**組み合わせたワークフローをステートマシン（状態遷移図）として定義・実行・可視化する**サービス。\nStandardワークフロー：最大1年・正確に1回実行・実行履歴を保持\nExpressワークフロー：最大5分・高スループット（1秒間に10万実行）', tags: ['ステートマシン', 'ワークフロー', 'サーバーレス'] },
        { name: 'Amazon API Gateway', desc: 'Amazon API Gatewayは、**REST・HTTP・WebSocket APIを構築・管理・公開する**フルマネージドサービス。\nLambdaプロキシ統合でサーバーレスAPIを構築。スロットリング（レート制限）・APIキー・使用量プラン・カスタムオーソライザー（Lambda関数で認証）が重要。\nHTTP APIはREST APIより低コスト・低レイテンシだが機能が限定的', tags: ['REST', 'WebSocket', 'スロットリング'] },
        { name: 'Amazon Kinesis Data Streams', desc: 'Amazon Kinesis Data Streamsは、リアルタイムのストリーミングデータを**収集・処理する**サービス。\nシャード：データを分散して処理する単位。1シャード = 1MB/s書き込み・2MB/s読み取り。シャード数でスループット調整\n保持期間：デフォルト24時間、最大365日まで延長可能\n拡張ファンアウト：複数のConsumerが各自2MB/sで同時読み取り可能', tags: ['シャード', 'リアルタイム', '保持期間'] },
      ],
    },
    {
      title: '分析・管理',
      items: [
        { name: 'Amazon Athena', desc: 'Amazon Athenaは、**S3上のデータをサーバーレスSQLで直接クエリする**サービス。インフラ管理不要でスキャンしたデータ量に応じて課金。\nGlueデータカタログと組み合わせてスキーマを管理。Parquet・ORC形式にすると圧縮率が高くスキャン量を削減できてコスト削減になる。', tags: ['サーバーレス', 'S3クエリ', 'Glueカタログ'] },
        { name: 'AWS Glue', desc: 'AWS Glueは、サーバーレスなETL（Extract・Transform・Load：**データの抽出・変換**・格納）サービス。\nクローラー：S3・RDS等のデータソースを自動スキャンしてGlueデータカタログにスキーマを登録する\nETLジョブ：SparkまたはPythonベースで変換処理を定義・実行する\nGlueデータカタログ：スキーマ・場所・メタデータを一元管理するメタデータリポジトリ', tags: ['ETL', 'クローラー', 'データカタログ'] },
        { name: 'Amazon CloudWatch', desc: 'CloudWatchは標準では収集されない指標をカスタムメトリクスとして収集できる。\nカスタムメトリクス：EC2のメモリ等、デフォルトで収集されないメトリクスを**PutMetricDataAPIで送信**\nLogs Insights：ログをSQLライクなクエリで分析するツール\n複合アラーム（Composite Alarms）：複数アラームをAND/ORで組み合わせた条件でアクション実行\n異常検知（Anomaly Detection）：機械学習でメトリクスの異常を自動検出\nSynthetics Canary：スクリプトでエンドポイントを定期監視する合成監視', tags: ['カスタムメトリクス', 'Logs Insights', '異常検知 / Anomaly Detection'] },
        { name: 'AWS CloudFormation', desc: 'AWS CloudFormationは、YAML/JSONテンプレートでAWSリソースを**定義・管理するIaC**（Infrastructure as Code）サービス。\nスタック：CloudFormationで一括管理するリソースのグループ\n変更セット（Change Set）：変更を実際に適用する前に影響範囲を確認\nStackSets：複数のAWSアカウント・リージョンに同一スタックを一括展開\nカスタムリソース：Lambda関数を使ってCloudFormationに対応していないリソースも管理', tags: ['IaC', 'スタック', 'StackSets'] },
        { name: 'AWS Lake Formation', desc: 'AWS Lake Formationは、データレイク（大量の生データを一元格納するS3ベースのストア）の**構築・管理・セキュリティを一元化する**サービス。\nAWS Glue・Amazon S3・Amazon Athena・Amazon Redshiftとの統合で列/行レベルのきめ細かいアクセス制御が可能。\nBlueprint：S3やRDBのデータを定期的にGlueワークフローでデータレイクに取り込む設定を自動生成', tags: ['データレイク', '列/行レベル', 'アクセス制御'] },
      ],
    },
  ],

  DVA: [
    {
      title: 'コアサービス',
      items: [
        { name: 'AWS Amplify', desc: 'AWS Amplifyは、**フルスタックなWeb/モバイルアプリを素早く構築・ホスティングする**サービス。\nAmplify Hosting：GitリポジトリからCI/CDで静的サイト・SPAを自動ビルド/デプロイ（PRプレビュー対応）\nバックエンド：認証（Cognito）・API（AppSync/API Gateway）・ストレージ（S3）をコマンドで自動構築\nフロント開発者がインフラを意識せずフルスタック開発できるのが特徴', keyword: 'AWS Amplify フルスタック ホスティング CI/CD フロントエンド', tags: ['フルスタック', 'Amplify Hosting', 'CI/CD'] },
        { name: 'AWS AppSync', desc: 'AWS AppSyncは、**マネージドなGraphQL APIを構築する**サービス。単一エンドポイントで複数データソースを集約。\nデータソース：DynamoDB・Lambda・RDS・HTTP をリゾルバで接続\nSubscription：WebSocketでデータ更新をクライアントへリアルタイムにプッシュ\nオフライン同期：モバイルのオフライン対応に強い\nRESTとの違い：必要なデータだけを1リクエストで取得でき過剰/不足取得を回避', keyword: 'AWS AppSync GraphQL マネージド Subscription オフライン同期', tags: ['マネージドGraphQL', 'Subscription', 'オフライン同期'] },
        { name: 'AWS Lambda', desc: '**最大実行時間15分**・最大メモリ10GB。CPU性能はメモリ量に比例して割り当てられる。\n同時実行制限：デフォルト1アカウント1000（申請で緩和可）。超えると429エラー\nプロビジョニング済み同時実行：あらかじめインスタンスを起動してコールドスタートを防ぐ\nレイヤー：共通ライブラリ・依存関係を複数関数で共有できる仕組み\nDestinations（送信先）：非同期呼び出しの成功/失敗時にSQS・SNS・Lambda・EventBridgeへ自動転送', tags: ['同時実行', 'レイヤー', 'Destinations'] },
        { name: 'Amazon API Gateway', desc: 'API Gatewayは、マッピングテンプレートでリクエスト/レスポンスの形式を変換できる。\nマッピングテンプレート：VTL（Velocity Template Language）を使った**変換ロジックを定義**\nLambdaプロキシ統合：リクエスト全体をLambdaに渡し、Lambdaがレスポンス全体を組み立てる\n使用量プラン＋APIキー：クライアントごとのスロットリング（レート制限）とクォータ（月次制限）を設定\nカスタムオーソライザー：Lambda関数で独自の認証ロジックを実装する\nキャッシュ：ステージごとにレスポンスキャッシュを設定してバックエンドの負荷軽減', tags: ['マッピングテンプレート', 'カスタムオーソライザー', 'キャッシュ'] },
        { name: 'Amazon DynamoDB', desc: 'DynamoDBはパーティションキー設計で性能とスケーラビリティを引き出す。\nパーティションキー設計：**特定のキーにアクセスが集中する**「ホットパーティション」を回避するため、カーディナリティの高いキー設計が重要\nGSI（グローバルセカンダリインデックス）：別パーティションキーでのクエリを可能にする\nLSI（ローカルセカンダリインデックス）：同一パーティション内での別ソートキーを使用\nDAX（DynamoDB Accelerator）：マイクロ秒レイテンシのインメモリキャッシュ\nStreams：テーブルの変更を24時間保持してLambdaでリアルタイム処理\nTTL（Time To Live）：有効期限を設定して期限切れアイテムを自動削除', tags: ['パーティション設計', 'DAX', 'Streams'] },
        { name: 'Amazon S3', desc: 'S3は署名付きURLで一時的なアクセス権を付与できる。\nプレサインドURL：一時的なアクセス権限をURLに埋め込み、**未認証ユーザーがS3に安全にアクセスできる**仕組み\nマルチパートアップロード：大きなファイルを分割してアップロードし、失敗時のリトライが部分的になるため大容量ファイルに推奨\nS3イベント通知：オブジェクトのPUT/DELETEなどのイベントをLambda・SQS・SNSに転送\nCORS（Cross-Origin Resource Sharing）：異なるオリジンからのブラウザアクセスを許可する設定', tags: ['プレサインドURL', 'マルチパート', 'CORS'] },
        { name: 'Amazon Cognito', desc: 'CognitoのUser Poolはサインアップ・サインインを担う認証基盤。\n**User Pool**（ユーザー認証）：\nサインアップ・サインイン・MFA（多要素認証）・パスワードポリシー管理\nトリガーLambda：サインアップ前・認証後等のタイミングでカスタム処理を実行\nIdentity Pool（AWSアクセス）：\nGoogle・Facebook・User Pool等でフェデレーションして一時的なIAM認証情報を払い出す\nロールマッピングで認証済み/未認証ユーザーに異なる権限を付与', tags: ['User Pool', 'Identity Pool', 'MFA'] },
        { name: 'Amazon ElastiCache', desc: 'ElastiCacheは用途に応じてキャッシュ戦略を選ぶ。\n**キャッシュ戦略**：\n- Lazy Loading（キャッシュに無ければDBから取得してキャッシュに保存）：キャッシュミス時のみDBアクセスが発生\n- Write-Through（DB書き込みと同時にキャッシュも更新）：データの鮮度が高いが書き込みのオーバーヘッドあり\nRedis：セッションストア・リアルタイムランキング・Pub/Subに適する\nMemcached：シンプルなキャッシュ・マルチスレッドでの高スループット向け', tags: ['Lazy Loading', 'Write-Through', 'セッション'] },
        { name: 'AWS App Runner', desc: 'AWS App Runnerは、コンテナイメージまたはソースコードから直接Webアプリ・APIをデプロイできるフルマネージドサービス。LB・オートスケール設定も不要。\nデプロイトリガー：「自動」に設定するとECRイメージの更新やソースリポジトリのプッシュを検知して自動再デプロイ\n用途：EC2やECSほどの制御は不要で、素早くコンテナ化Webアプリを公開したい場合に適する', tags: ['コンテナ', 'フルマネージド', '自動デプロイ'] },
      ],
    },
    {
      title: 'CI/CDとデプロイ',
      items: [
        { name: 'AWS CodeCommit', desc: 'AWS CodeCommitは、**IAMでアクセス制御できるAWSマネージドのプライベートGitリポジトリ**。', tags: ['Git', 'IAM認証', 'プライベートリポジトリ'] },
        { name: 'AWS CodeBuild', desc: 'AWS CodeBuildは、**buildspec.ymlでビルド手順を定義する**サーバーレスのビルドサービス。\nフェーズ：\n① install（ランタイム・依存インストール）\n② pre_build\n③ build\n④ post_build\nキャッシュ：ローカルキャッシュ（同一ビルドホスト）またはS3キャッシュで依存関係の再ダウンロードを省略\nDockerイメージのビルド・ECRへのプッシュもbuildspec.ymlで記述できる', tags: ['buildspec.yml', 'ビルドフェーズ', 'キャッシュ'] },
        { name: 'AWS CodeDeploy', desc: 'AWS CodeDeployは、EC2・オンプレ・Lambda・ECSへのアプリのデプロイを自動化するサービス。**ライフサイクルフックで各段階に任意処理を挿入できる**。\nEC2/オンプレ：\n① BeforeInstall\n② AfterInstall\n③ ApplicationStart\n④ ValidateService\nLambda/ECS（Blue/Green）：\n① BeforeAllowTraffic（切替前にスモークテスト）\n② AfterAllowTraffic（切替後に本番検証）\nトラフィック移行：\n- Canary（一部を先行し問題なければ残り）\n- Linear（一定割合ずつ）\n- All-at-once（一斉）\nロールバック：CloudWatchアラームのトリガーで自動', tags: ['Blue/Green', 'Canary', 'ライフサイクルフック'] },
        { name: 'AWS CodePipeline', desc: 'AWS CodePipelineは、**ソースコードの変更を検知して自動でビルド・テスト・デプロイを行う**CI/CDパイプライン。\nステージ：\n① Source（CodeCommit/S3/GitHub）\n② Build（CodeBuild）\n③ Test\n④ Deploy（CodeDeploy/ECS/CloudFormation）\n手動承認アクション：本番デプロイ前に人間の承認を必須にするステップを挿入できる\nクロスアカウントデプロイ：別AWSアカウントへのデプロイも可能（KMS・S3バケットポリシー設定が必要）', tags: ['ステージ', '手動承認', 'クロスアカウント'] },
        { name: 'AWS SAM（Serverless Application Model）', desc: 'AWS SAM（Serverless Application Model）は、サーバーレスアプリ（Lambda・API Gateway・DynamoDB等）を**CloudFormationの拡張構文で簡潔に定義する**IaCフレームワーク。\nsam local invoke / sam local start-api：LambdaとAPI Gatewayをローカル環境でエミュレートして開発・テストが可能\nGlobals セクション：全Lambda関数に共通のタイムアウト・メモリ等を一括設定', tags: ['サーバーレス', 'sam local', 'テンプレート'] },
        { name: 'AWS Elastic Beanstalk', desc: 'Elastic Beanstalkはダウンタイムとリスクのトレードオフでデプロイポリシーを選べる。\n**デプロイポリシー**（デプロイ中のダウンタイムとリスクのトレードオフ）：\n- All-at-once：最速だがデプロイ中にダウンタイムあり\n- Rolling：少数ずつ順次更新。容量が一時的に減少\n- Rolling with additional batch：余分なインスタンスを追加してから更新。容量を維持\n- Immutable：新インスタンス群を並行起動してから切り替え。最も安全\n.ebextensions：リソースや設定をYAMLで追加カスタマイズするファイル（.ebextensions/xxx.config）', tags: ['デプロイポリシー', '.ebextensions', 'Immutable'] },
      ],
    },
    {
      title: 'メッセージング・統合',
      items: [
        { name: 'Amazon SQS', desc: 'SQSは可視性タイムアウトで処理中メッセージの二重処理を防ぐ。\n可視性タイムアウト（Visibility Timeout）：**メッセージ取得後に他のConsumerから一定時間隠す**仕組み。処理が長引く場合はChangeMessageVisibility APIで延長\nDLQ（Dead Letter Queue：デッドレターキュー）：最大受信回数（maxReceiveCount）を超えた処理失敗メッセージを退避するキュー。原因調査に使用\nロングポーリング：最大20秒間メッセージが届くまで待機。空のレスポンスを削減してコスト削減', tags: ['可視性タイムアウト', 'DLQ', 'ロングポーリング'] },
        { name: 'Amazon SNS', desc: 'サブスクリプションフィルタポリシー：トピックの**サブスクライバーごとに受信するメッセージの属性を絞り込むフィルタを設定できる**。\n例：「注文イベント」トピックで「注文確定」だけ受け取るLambdaと「キャンセル」だけ受け取るSQSを別々に設定できる\nSNS（Simple Notification Service） FIFOトピック：SQS FIFOと組み合わせて順序保証・重複排除のファンアウトを実現', tags: ['フィルタポリシー', 'ファンアウト', 'FIFO'] },
        { name: 'Amazon Kinesis', desc: 'Kinesisは用途に応じて複数のサービスを使い分ける。\n主なサービス：\n- Data Streams：シャードベースのストリーミング。KCL（Kinesis Client Library）でConsumerを実装。**カスタムな処理・複雑なロジックに向く**\n- Firehose（Data Firehose）：自動スケールのマネージド配信サービス。S3・Redshift・OpenSearch・Splunkへのデータ配信に特化。Lambda変換とバッファリングが可能\n- Data Analytics（for Apache Flink）：ストリームデータをSQLまたはFlinkコードでリアルタイム分析', tags: ['シャード', 'Firehose', 'KCL'] },
        { name: 'Amazon EventBridge', desc: 'EventBridgeはイベントパターンでイベントを条件フィルタする。\nイベントパターンマッチング：イベントの**JSON属性でフィルタリングして条件に合うものだけターゲットに転送**\nスケジュール：cron式（例：毎日9時）またはrate式（例：5分ごと）でターゲットを定期実行\nイベントアーカイブ＆リプレイ：イベントを保存しておいて後からリプレイできる（障害時の再処理に便利）\nクロスアカウントイベントバス：別アカウントのイベントバスにイベントを送信できる', tags: ['イベントパターン', 'スケジュール', 'アーカイブ'] },
        { name: 'AWS Step Functions', desc: 'Step Functionsはワークフロー種別で実行特性を選べる。\nStandardワークフロー：**最大1年実行・正確**に1回実行保証・実行履歴をCloudWatchに保存。長期バッチ処理向け\nExpressワークフロー：最大5分・高スループット（秒間10万実行）・少なくとも1回実行。高頻度のイベント処理向け\nステートマシン：ステートをJSONで定義して並列・条件分岐・エラーハンドリング・リトライを視覚化', tags: ['Express', 'Standard', 'ステートマシン'] },
      ],
    },
    {
      title: '監視・トレーシング',
      items: [
        { name: 'AWS X-Ray', desc: 'AWS X-Rayは、**アプリのリクエストをエンドツーエンドでトレーシングする**サービス。\nサービスマップ：各サービス間の依存関係とレイテンシを視覚化\nアノテーション：インデックス化される任意のキーバリュー（フィルタリング・グループ化に使用）\nメタデータ：インデックス不要の追加情報（デバッグ詳細情報）\nサンプリングルール：トレースするリクエストの割合を設定してコストを調整\nX-Rayデーモン：EC2やECSにインストールしてトレースデータを収集するプロセス', tags: ['トレーシング', 'サービスマップ', 'アノテーション'] },
        { name: 'Amazon CloudWatch Logs', desc: 'CloudWatchは複数の構成要素で監視を実現する。\n主な構成要素：\n- ロググループ：**ログを管理**するコンテナ（保持期間を設定）\n- ログストリーム：同一リソース（EC2インスタンス等）からのログの流れ\n- メトリクスフィルター：ログのパターンに一致した件数をカスタムメトリクスとして記録（アラームのトリガーに使用）\n- サブスクリプションフィルター：ログをリアルタイムでLambda・Firehose・OpenSearchに転送する仕組み', tags: ['ロググループ', 'メトリクスフィルター', 'サブスクリプション'] },
        { name: 'Amazon CloudWatch Embedded Metrics（EMF）', desc: 'CloudWatchはEMFでログにメトリクスを埋め込める。\nEMF（Embedded Metric Format）：**ログにJSONでメトリクスを埋め込む**形式\nLambdaのログ内に特定のJSON構造でメトリクスデータを埋め込む形式。\nPutMetricData APIを呼び出さずにカスタムメトリクスを記録できるため、Lambdaの実行時間削減とコスト削減が可能。AWS提供のEMFライブラリ（Python・Node.js等）を使うと実装が容易。', tags: ['EMF', '構造化ログ', 'カスタムメトリクス'] },
      ],
    },
    {
      title: 'セキュリティ',
      items: [
        { name: 'AWS IAM', desc: 'アプリからAWSサービスへのアクセスには**必ずロールを使用し、アクセスキーのハードコードを避ける**。\nEC2インスタンスプロファイル：EC2にIAMロールを付与するコンテナ。EC2上のアプリが自動的にロールの認証情報を取得できる\nLambda実行ロール：LambdaがアクセスできるリソースをIAMロールで定義\n一時認証情報：AssumeRoleで取得した有効期限付きの認証情報（アクセスキー・シークレット・セッショントークン）', tags: ['インスタンスプロファイル', '実行ロール', '一時認証情報'] },
        { name: 'AWS KMS', desc: 'KMSはエンベロープ暗号化のためのデータキーを払い出す。\nGenerateDataKey API：**データ暗号化キー（DEK）を生成するAPI**。平文のDEKでデータを暗号化し、暗号化済みDEKと暗号化データをセットで保存するエンベロープ暗号化に使用\nAWS Encryption SDK：エンベロープ暗号化をコードで簡単に実装できるライブラリ\nDecrypt API：暗号化済みDEKを復号して元のデータを復元', tags: ['GenerateDataKey', 'エンベロープ暗号化', 'SDK統合'] },
        { name: 'AWS SSM Parameter Store', desc: 'AWS SSM Parameter Storeは、**アプリの設定値・秘密情報を安全に保管・取得する**サービス。\nString/StringList：平文のパラメータ\nSecureString：KMSで暗号化して保管する秘密情報（DBパスワード・APIキー等）\n/path/key形式の階層化でサービス・環境ごとに整理し、IAMポリシーで階層単位のアクセス制御が可能\nバージョニング：パラメータの変更履歴を保持', tags: ['SecureString', '階層化', 'バージョニング'] },
      ],
    },
  ],

  SOA: [
    {
      title: 'モニタリング・ロギング',
      items: [
        { name: 'Amazon CloudWatch', desc: 'CloudWatchは、標準以外の独自メトリクスも収集できる。\nカスタムメトリクス：**PutMetricData APIで独自メトリクスを送信**。高解像度（1秒）まで対応\nLogs Insights：ロググループに対してSQLライクなクエリで分析するツール\nContributor Insights：上位N件のトラフィックソース・エラー原因を特定する分析機能\n異常検知（Anomaly Detection）：機械学習でメトリクスの異常（季節性考慮）を自動検出してアラーム。英語名「CloudWatch Anomaly Detection」で問われることも多い\n複合アラーム（Composite Alarms）：複数アラームをAND/ORで組み合わせた複合条件でアクション実行', tags: ['高解像度', 'Logs Insights', '異常検知 / Anomaly Detection'] },
        { name: 'AWS CloudTrail', desc: '**AWSリソースへのAPIコールを記録する**監査ログサービス。\nイベントの種類\n- 管理イベント：AWSリソースの作成・削除・設定変更。デフォルトで有効\n- データイベント：S3オブジェクト操作・Lambda関数実行。明示的に有効化が必要\n- Insightsイベント：通常と異なるAPI呼び出しパターン（突然の大量呼び出し等）を自動検出', tags: ['管理イベント', 'データイベント', 'Insights'] },
        { name: 'AWS Config', desc: '**リソースの設定変更を時系列で記録し、ルールへの準拠状況を継続的に評価する**サービス。\nマネージドルール（Managed Rules）：AWSが事前定義した150以上のコンプライアンスルール\nカスタムルール：Lambda関数で独自のルールを定義\nコンフォーマンスパック（Conformance Packs）：複数のConfigルールをまとめてパッケージ化して一括展開\n自動修復（Auto Remediation）：ルール違反を検出したらSSM Automationで自動修正', tags: ['設定変更', 'マネージドルール / Managed Rules', '自動修復 / Auto Remediation'] },
        { name: 'AWS Health Dashboard', desc: 'AWS Health Dashboardは、AWSサービスの稼働状況と自分のアカウントへの影響を確認できるダッシュボード。\nService Health Dashboard（サービス全体の障害ステータス）：AWSサービス全体の**稼働状況を公開している**ページ\nPersonal Health Dashboard（個人用ヘルスダッシュボード）：自分のアカウントのリソースへの影響をお知らせするサービス\nEventBridgeと連携してHealth通知を受けたらSlack/SNSに自動転送するパターンが頻出', tags: ['サービス障害', 'アカウント影響', 'EventBridge連携'] },
        { name: 'CloudWatch 基本監視 vs 詳細監視 / EC2メトリクス', desc: 'CloudWatchの基本監視と詳細監視は、**EC2メトリクスの収集間隔（5分 vs 1分）が異なる**。\n基本監視（Basic）：5分間隔。デフォルトで無効課金なし\n詳細監視（Detailed）：1分間隔。有効化で追加課金。Auto Scaling/障害対応で素早く反応したい場合に有効化\nEC2が標準で送るのはCPU使用率・ネットワーク・ディスクI/O・ステータスチェックまで。メモリ使用率とディスク空き容量(ゲストOS内部の値)は標準メトリクスに含まれず、CloudWatchエージェント(またはprocstat)を入れて初めて取得できる\nステータスチェック：システムステータス(AWS基盤側)とインスタンスステータス(OS/設定側)の2種類。自動復旧(recover)アクションと組み合わせる', tags: ['基本5分', '詳細1分', 'メモリはエージェント'] },
      ],
    },
    {
      title: '自動化・運用',
      items: [
        { name: 'AWS Systems Manager', desc: 'Systems Managerは複数の機能でインフラ運用を一元化する。\n主要機能：\n- Session Manager：**SSHポートを開けずにブラウザまたはCLIからEC2にセキュアに接続**\n- Run Command：複数EC2に対して同時にシェルコマンドやスクリプトを実行\n- Patch Manager：OSのセキュリティパッチを自動適用するスケジュール管理\n- State Manager：設定の継続的な適用・維持（例：特定のソフトウェアが常にインストール済みであることを保証）\n- Inventory：EC2のソフトウェア・設定情報を収集\n- OpsCenter：運用上の問題（OpsItem）を一元管理してRunbookで解決\n- Automation：複数ステップの運用タスクを自動化するRunbook（ドキュメント）を定義・実行', tags: ['Session Manager', 'Patch Manager', 'Automation'] },
        { name: 'Amazon EventBridge（運用自動化）', desc: 'EventBridgeは、AWSサービスのイベントをトリガーに運用タスクを自動化するパターンで使われる。\nイベント駆動：**AWSイベントを起点に運用を自動化**\n例：\nAWS Config違反 → EventBridge → Lambda（自動修復）\nAmazon GuardDuty脅威検出 → EventBridge → SNS通知・Lambda隔離\nEC2インスタンス起動 → EventBridge → AWS Systems Manager Automation\nスケジュール → EventBridge → Lambda（定期バックアップ）', tags: ['自動修復', 'Config連携', 'スケジュール'] },
        { name: 'AWS OpsWorks', desc: 'AWS OpsWorksは、Chef（Rubyベースの設定管理ツール）またはPuppet（宣言型設定管理ツール）を**使ったインフラ自動化サービス**。\nレシピ：ChefでEC2の設定を定義する手順書\nクックブック：レシピのコレクション\nレイヤー：同じ役割を持つEC2グループ（Webレイヤー・DBレイヤー等）', tags: ['Chef', 'Puppet', '設定管理'] },
        { name: 'AWS Elastic Beanstalk（SOA観点）', desc: 'Elastic Beanstalkは無停止性と安全性の要件に応じてデプロイ方式を選べる。\n主なデプロイ方式：\n- Rolling with additional batch：追加インスタンスを起動してからローリング更新。**容量を全量維持したまま更新できる**\n- Immutable：新インスタンスを別オートスケーリンググループで起動してから入れ替え。最も安全だが時間がかかる\n- DNS（Domain Name System） CNAME Swap（環境スワップ）：新旧環境のCNAMEを瞬時に入れ替えるブルーグリーンデプロイ', tags: ['Rolling', 'Immutable', 'DNS CNAME Swap'] },
        { name: 'SSM Distributor', desc: 'SSM Distributorは、ソフトウェアパッケージをバージョン管理し、**マネージドインスタンス群へ一括インストール/更新する**Systems Managerの機能。\nAWS提供パッケージ（CloudWatchエージェント等）と自作パッケージの両方を配布可能\nState Manager と組み合わせて「常に最新版がインストールされている状態」を維持できる\nRun Command で即時配布、または定期スケジュール配布', tags: ['パッケージ配布', 'バージョン管理', 'SSM'] },
        { name: 'EC2 Image Builder', desc: 'EC2 Image Builderは、AMIやコンテナイメージの**ビルド・テスト・配布を自動化する**パイプラインサービス。手動でのゴールデンAMI作成・パッチ当てを自動化する。\nレシピ（Recipe）：「ベースイメージ＋コンポーネント(インストール/設定/テストの手順)＋バージョン」の組み合わせ定義。イメージの中身を決める設計図\nコンポーネント：ソフトのインストールや設定、テストを行う個々のステップ\nパイプライン：レシピを元に定期/オンデマンドでビルド→テスト→指定リージョン/アカウントへ配布・共有\nメリット：常に最新パッチ適用済みのAMIを自動生成し、脆弱性のある古いAMIの手動運用を排除', tags: ['ゴールデンAMI自動化', 'レシピ', 'コンポーネント'] },
        { name: 'AMI 管理・コピー（クロスリージョン）', desc: 'AMI(Amazonマシンイメージ)は**EC2の起動テンプレートとなるスナップショットの集合**。\ncopy-image（AMIコピー）の用途：別リージョン/別アカウントへ横展開、DR用にリージョン間複製、暗号化の付与・KMSキーの切替\nクロスリージョンコピーの注意点：\n- AMI ID はリージョン固有。コピー先で新しいAMI IDが払い出される（既存IDをそのまま参照不可）\n- 紐づくEBSスナップショットも一緒にコピーされ、データ転送・保管コストが発生\n- 暗号化AMIはコピー先リージョンのKMSキーで再暗号化が必要（送信元キーはリージョンをまたげない）\n- 起動権限・タグは自動では引き継がれない（別途設定）\nEC2 Image Builder のパイプライン配布でも複数リージョンへ展開できる', tags: ['copy-image', 'AMI IDはリージョン固有', 'KMS再暗号化'] },
        { name: 'CloudFormation 削除時のリソース保持', desc: 'CloudFormationの削除時リソース保持は、**スタックを削除**しても特定リソース（DB・S3等）を残すための設定。\nDeletionPolicy：Retain：DynamoDB/RDS/S3などデータ保持に多用される保持指定\nDeletionPolicy：Snapshot：削除前にスナップショットを取得（RDS/EBS/Redshift等の対応リソース）\nRetainExceptOnCreate：作成に失敗したロールバック時は削除、通常削除時は残す\nUpdateReplacePolicy：更新でリソースが置換される際の旧リソースの扱い（Retain/Snapshot）\n※終了保護(Termination Protection)はスタック自体の誤削除防止で、リソース保持とは別物', tags: ['DeletionPolicy Retain', 'Snapshot', '誤削除防止'] },
      ],
    },
    {
      title: '信頼性・可用性',
      items: [
        { name: 'AWS Backup', desc: 'AWS Backupは、**一元的なバックアップを複数サービス横断で自動化・管理する**フルマネージドサービス。\n対応：EBS・RDS・DynamoDB・EFS・FSx・Storage Gateway 等\nバックアッププラン：スケジュール・保持期間・ライフサイクル（コールドストレージ移行）をポリシーで定義\nBackup Vault：保管先。Vault Lock（WORM）で削除・改ざんを防止\nクロスリージョン/クロスアカウントコピー：DRや組織横断のバックアップ集約', keyword: 'AWS Backup 一元バックアップ Backup Vault Vault Lock クロスリージョン', tags: ['一元バックアップ', 'Backup Vault', 'Vault Lock / WORM'] },
        { name: 'AWS Auto Scaling', desc: 'Auto Scalingはライフサイクルフックで起動・終了時に任意処理を挿入できる。\nライフサイクルフック（Lifecycle Hook）：インスタンスの起動時（設定完了まで待機）・終了時（データ退避処理）に**カスタムスクリプトを挿入する**仕組み\n予測スケーリング（Predictive Scaling）：過去のメトリクスパターンをMLで学習して事前にスケールアウト\nウォームアップ期間（Instance Warmup）：新インスタンスが準備できるまでメトリクスへの影響を除外する時間', tags: ['ライフサイクルフック / Lifecycle Hook', '予測スケーリング / Predictive Scaling', 'ウォームアップ'] },
        { name: 'Elastic Load Balancing（ELB）', desc: 'ELBはヘルスチェックのパラメータで異常なターゲットを検出・除外する。\n**ヘルスチェック**設定パラメータ：\n- 正常しきい値（HealthyThreshold）：正常と判断するまでの連続成功回数\n- 異常しきい値（UnhealthyThreshold）：異常と判断するまでの連続失敗回数\n- アクセスログ：ELBのアクセスログをS3に保存（デフォルト無効）\n- クロスゾーン負荷分散（Cross-Zone Load Balancing）：複数AZにまたがってトラフィックを均等に分散\n- Connection Draining（登録解除の遅延 / Deregistration Delay）：登録解除中のターゲットへの既存接続を安全に完了させる猶予時間', tags: ['ヘルスチェック', 'クロスゾーン / Cross-Zone', 'Connection Draining'] },
        { name: 'Amazon RDS（可用性）', desc: 'RDSは複数の機能で可用性と復旧性を高める。\n可用性の主な機能：\n- Multi-AZフェイルオーバー：**60〜120秒が目安**。プライマリ障害時にスタンバイが自動でプライマリに昇格\n- スナップショット：自動（0〜35日間保持）と手動（明示的に削除するまで保持）の2種類\n- PITR（ポイントインタイムリカバリ）：最大35日前の任意の時点のデータに5分以内の精度で復元可能\n- リードレプリカのプロモーション：読み取りレプリカを独立したDBインスタンスに昇格（手動操作）', tags: ['フェイルオーバー', 'ポイントインタイム', 'リードレプリカ'] },
        { name: 'Amazon Route 53（DR構成）', desc: 'Amazon Route 53（DR構成）は、ヘルスチェックとフェイルオーバールーティングで**災害対策（DR）を実現する**構成。\nヘルスチェックの種類\n- エンドポイント監視：HTTP/HTTPS/TCPでエンドポイントの死活を監視\n- 他ヘルスチェック監視：複数ヘルスチェックのAND/OR評価\n- CloudWatchアラーム監視：アラームの状態に連動\nフェイルオーバールーティングと組み合わせてプライマリ障害時にセカンダリサイトに自動切り替え', tags: ['ヘルスチェック', 'フェイルオーバー', 'DR構成'] },
        { name: 'Amazon Route 53 Resolver エンドポイント（ハイブリッドDNS）', desc: 'Route 53 Resolver エンドポイントは、**オンプレミスとVPC間で相互にDNS名前解決するための仕組み**（VPN/Direct Connect接続環境で使う）。向きに注意。\nインバウンドエンドポイント：オンプレDNS → AWS への問い合わせを受ける。オンプレからVPC内の名前(privateホストゾーン/AWSリソース)を解決したいとき\nアウトバウンドエンドポイント：AWS(VPC) → オンプレDNS へ転送する。VPC内のリソースからオンプレのドメイン名を解決したいとき（Resolver ルールで転送先を指定）\n覚え方：「AWSに入ってくる問い合わせ＝インバウンド」「AWSから出ていく問い合わせ＝アウトバウンド」', tags: ['ハイブリッドDNS', 'インバウンド=オンプレ→AWS', 'アウトバウンド=AWS→オンプレ'] },
        { name: 'S3 レプリケーション（RTC / ライブ vs バッチ）', desc: 'S3レプリケーションは、S3のオブジェクト複製機能。CRR（クロスリージョン）/SRR（同一リージョン）がある。\nライブレプリケーション：レプリケーション設定後に**「新規に作成/更新される」オブジェクトを継続的に自動複製**（既存オブジェクトは対象外）\nS3（Simple Storage Service） バッチレプリケーション：設定より前から存在する「既存オブジェクト」や複製失敗分を遡って複製する（S3 Batch Operations ジョブ）。初回移行・後追い複製に使う\nS3 RTC（Replication Time Control）：99.99%のオブジェクトを15分以内に複製するSLA付きの機能。複製の遅延をCloudWatchメトリクス(OperationsPendingReplication等)で監視でき、RPO（Recovery Point Objective：目標復旧時点）要件が厳しいDRで使う（追加料金）\n使い分け：\n- 通常の継続複製：ライブ\n- 既存分の穴埋め：バッチ\n- 時間保証が要る：RTC', tags: ['CRR/SRR', 'RTC=15分SLA', 'バッチ=既存複製'] },
      ],
    },
    {
      title: 'セキュリティ・コスト',
      items: [
        { name: 'Amazon GuardDuty', desc: 'Amazon GuardDutyは、CloudTrail・VPCフローログ・DNSクエリログを機械学習と脅威インテリジェンスで分析し、**脅威を自動検出する**サービス。\nEC2のポートスキャン・認証情報の外部への漏洩・S3への不正アクセス等を検出。\nEventBridge → Lambda で自動隔離・通知のパターンが頻出。マルチアカウント（Organizations）にも一括適用可能。', tags: ['脅威検出', '機械学習', '自動応答'], seeAlso: ['AWS Security Hub'] },
        { name: 'AWS Security Hub', desc: 'AWS Security Hubは、GuardDuty・Inspector・Macie等の検出結果をASFF形式で集約し、セキュリティ状況を一元管理するサービス。\nコンプライアンス基準への準拠状況：\nCIS AWS Foundations Benchmark・PCI-DSS・NIST 800-53 への自動チェックが可能', tags: ['集約', 'ASFF', '準拠状況'], seeAlso: ['Amazon GuardDuty', 'Amazon Inspector', 'Amazon Macie'] },
        { name: 'AWS Cost Explorer', desc: 'Cost Explorerは、AWSのコストと使用量を可視化・分析するツール。\nコスト可視化：サービス別・リソース別・タグ別・リンクアカウント別に**フィルタリング・グループ化が可能**\nRI（リザーブドインスタンス）やSavings Plansの利用率・カバレッジ分析と推奨事項を提示してくれる。', tags: ['コスト可視化', 'RI推奨', 'Savings Plans'] },
        { name: 'AWS Compute Optimizer', desc: 'AWS Compute Optimizerは、EC2・Lambda・EBS等の使用状況を機械学習で分析し、**適正なリソースサイズを推奨する**サービス。\nオーバープロビジョニング（無駄なリソース）とアンダープロビジョニング（性能不足）の両方を検出してコスト削減と性能改善を同時に達成できる。', tags: ['適正サイズ', 'EC2推奨', 'コスト最適化'] },
      ],
    },
  ],

  DOP: [
    {
      title: 'CI/CD・SDLC自動化',
      items: [
        { name: 'AWS CodePipeline', desc: '**ソース変更を検知**して自動でビルド・テスト・デプロイを実行するCI/CDパイプライン。\nアーティファクト（Artifact）：ステージ間で受け渡すビルド成果物（S3に保存）\n手動承認アクション：本番デプロイ前に承認者のメール確認を必須にする\nクロスアカウント/クロスリージョンデプロイ：KMS・S3バケットポリシー設定で別アカウントへのデプロイが可能\nEventBridgeトリガー：CodeCommitプッシュ・ECRイメージプッシュ等のイベントで自動起動', tags: ['クロスアカウント', '手動承認', 'アーティファクト'] },
        { name: 'AWS CodeBuild', desc: 'CodeBuildは、buildspec.ymlで**フェーズごとにビルド手順を定義する**。\n主なフェーズ：\n① install：ランタイム・依存パッケージをインストール\n② pre_build：ビルド前の準備（ECRログイン等）\n③ build：コンパイル・テスト実行・Dockerイメージビルド\n④ post_build：ECRへのプッシュ・通知\nテストレポート：JUnit・Cucumberなどのテスト結果をCodeBuildに取り込んで可視化\nVPC統合：プライベートリソース（RDS等）へのアクセスが必要な場合にVPC内でビルドを実行', tags: ['buildspec.yml', 'Docker', 'テストレポート'] },
        { name: 'AWS CodeDeploy', desc: 'CodeDeployはライフサイクルフックで各段階に任意処理を挿入する。\n**ライフサイクル**イベントフック（EC2/オンプレ向け）：\n① BeforeInstall\n② AfterInstall\n③ ApplicationStart\n④ ValidateService\nライフサイクルイベントフック（Lambda Blue/Green）：\n① BeforeAllowTraffic：トラフィック切替前にLambda関数でスモークテストを実行\n② AfterAllowTraffic：トラフィック切替後にLambda関数で本番検証を実行\nライフサイクルイベントフック（ECS Blue/Green）：\n① BeforeInstall\n② AfterInstall\n③ AfterAllowTestTraffic\n④ BeforeAllowTraffic\n⑤ AfterAllowTraffic\nBlue/Greenのトラフィック移行設定：\n- Canary：最初に一部（例：10%）を流し問題なければ残りを移行（LambdaCanary10Percent5Minutes 等）\n- Linear：一定割合ずつ段階的に移行（LambdaLinear10PercentEvery1Minute 等）\n- All-at-once：一斉に全トラフィックを新バージョンへ\nロールバック：CloudWatchアラームのトリガーで自動ロールバックも設定可能', keyword: 'CodeDeploy ライフサイクルフック BeforeAllowTraffic AfterAllowTraffic Lambda ECS Blue/Green', tags: ['ライフサイクルフック', 'Blue/Green', 'Lambda/ECS'] },
        { name: 'AWS CodeArtifact', desc: 'AWS CodeArtifactは、**npm/PyPI/Maven/NuGet/Swift対応のプライベートパッケージリポジトリ**。\nUpstream接続：npmjs.com・PyPI・Maven Centralなどのパブリックリポジトリをプロキシして内部からセキュアに利用\n構造：ドメイン（組織単位）→ リポジトリ → パッケージ の3層\nサプライチェーンセキュリティ：内部でパッケージを管理してバージョン固定や監査が可能', tags: ['パッケージ管理', 'Upstream', 'npm/PyPI'] },
      ],
    },
    {
      title: 'IaC・構成管理',
      items: [
        { name: 'AWS CloudFormation', desc: 'CloudFormationは変更セットで適用前に影響範囲を確認できる。\n変更セット（Change Set）：**スタック変更を実際**に適用する前に影響範囲を確認・レビューできる\nドリフト検出（Drift Detection）：実際のリソース設定とCloudFormationテンプレートの差分を検出（手動変更の発見に使用）\nカスタムリソース：Lambda関数でCloudFormationが対応していないリソースを管理する仕組み\nStackSets：複数のAWSアカウント・リージョンに同一スタックを一括展開\nCloudFormation Hooks：リソース変更前にカスタムバリデーションを実行してポリシー違反を防止', tags: ['変更セット', 'ドリフト検出', 'StackSets'] },
        { name: 'AWS CDK（Cloud Development Kit）', desc: 'AWS CDK（Cloud Development Kit）は、TypeScript・Python・Java・C#等のプログラミング言語で**CloudFormationテンプレートを生成するIaCフレームワーク**。\nConstruct（コンストラクト）は3層構造。\n- L1：CloudFormationリソースを直接ラップ（低レベル）\n- L2：AWSサービスを使いやすくした高レベル抽象（セキュアなデフォルト付き）\n- L3：複数サービスを組み合わせた完全なパターン（例：Static Website Hosting）\nCDK Pipelines：CDKアプリ自体をCI/CDパイプラインで自動デプロイするライブラリ', tags: ['CDK', 'Construct', 'CDK Pipelines'], termKeywords: { 'L1': 'L1（CDK Construct）', 'L2': 'L2（CDK Construct）', 'L3': 'L3（CDK Construct）' } },
        { name: 'AWS Systems Manager（DOP観点）', desc: 'Systems Managerは複数の機能で運用タスクを自動化する。\n主な機能：\n- Automation Runbook（旧Document）：複数ステップの運用タスクを**YAMLで定義して自動実行**\n- State Manager：EC2の設定が常に望ましい状態に保たれることを保証する（設定ドリフトの自動修正）\n- Run Command：複数EC2に対して一括でコマンド実行（パッチ確認・ログ収集等）\n- Parameter Store：階層的な設定値・秘密情報の管理。CDK/CloudFormationとの統合でシームレスに利用', tags: ['Automation Runbook', 'State Manager', '設定継続適用'] },
        { name: 'AWS OpsWorks', desc: 'OpsWorksは、Chef（Rubyベース）またはPuppet（宣言型）を使ったサーバー設定管理サービス。\n構成管理：**Chef / Puppet でサーバー設定を自動化**\nDOPでは複雑な設定管理シナリオや既存のChef/Puppetコードベースを継続利用するケースで登場する。', tags: ['Chef', 'Puppet', '設定管理'] },
      ],
    },
    {
      title: '監視・インシデント対応',
      items: [
        { name: 'Amazon CloudWatch（DOP観点）', desc: 'CloudWatchは高度な監視機能で運用を支援する。\n高度な監視機能：\n- Contributor Insights：**ネットワーク・APIの上位N件のアクセス元・エラー原因を特定するルールベース分析**\n- Synthetics Canary（合成監視）：ヘッドレスブラウザのスクリプトでAPIやWebUIの死活・レスポンスを定期チェック\n- EventBridge Pipes：EventBridgeのソース→フィルタ→変換→ターゲットをシンプルなパイプとして構築\n- 複合アラーム：複数アラームのAND/OR条件で不要なアラートを減らす', tags: ['Contributor Insights', 'Synthetics', 'EventBridge Pipes'] },
        { name: 'AWS X-Ray（DOP観点）', desc: 'X-Rayは複数の機能で分散トレーシングを支援する。\n主な機能：\n- サービスマップ：**マイクロサービス間の依存関係・レイテンシ・エラー率を視覚化してボトルネックを特定**\n- アノテーション：インデックス化されるキーバリュー。フィルタクエリでトレースを絞り込める\n- サンプリングルール：デフォルト（5%）を変更してコスト・データ量を調整\n- グループ：フィルタ式でトレースのサブセットを定義して別々にCloudWatchアラームを設定', tags: ['サービスマップ', 'サンプリング', 'グループ'] },
        { name: 'Amazon EventBridge（イベントバス）', desc: 'EventBridgeはイベント源に応じてイベントバスを使い分ける。\nイベントバスの種類：\n- デフォルトイベントバス：**AWSサービスのイベントを受信**\n- カスタムイベントバス：アプリや外部システムのカスタムイベントを管理\n- パートナーイベントバス：Datadog・SaaSパートナーのイベントを受信\n- アーカイブ＆リプレイ：イベントを保存しておき障害時の再処理（リプレイ）が可能\n- EventBridge Pipes：SQS/DynamoDB Streams/Kinesis → フィルタ → エンリッチ → Lambda/Step Functions への一連のパイプを簡潔に構築', tags: ['カスタムバス', 'アーカイブ/リプレイ', 'Pipes'] },
        { name: 'AWS Incident Manager', desc: 'AWS Incident Managerは、インシデントを体系的に管理するSystems Managerの一機能（検知→対応計画→Runbook→エスカレーション）。\nフロー：インシデント検出（CloudWatchアラーム等）→ 対応計画（Response Plan）の自動起動 → Runbookで対応手順を実行 → エスカレーション（担当者通知） → PIR（事後分析：Post-Incident Review）\n対応計画：インシデント発生時に誰が・何をすべきかを定義', tags: ['インシデント管理', '対応計画', 'Runbook'] },
      ],
    },
    {
      title: '弾力性・セキュリティ',
      items: [
        { name: 'AWS Auto Scaling（DOP観点）', desc: 'Auto Scalingはライフサイクルフックなどでスケーリングを細かく制御する。\n**ライフサイクルフック**（Lifecycle Hook）：\n- 起動時フック（Launching）：インスタンス起動後にアプリ設定・エージェントインストールが完了するまで待機\n- 終了時フック（Terminating）：ログ退避・セッション切断などの後処理が完了するまで終了を待機\n予測スケーリング（Predictive Scaling）：過去2週間のメトリクスパターンをMLで学習して事前にスケールアウト\nウォームプール（Warm Pool）：停止済みEC2をプールして起動時間を短縮する仕組み', tags: ['ライフサイクルフック / Lifecycle Hook', '予測スケーリング / Predictive Scaling', 'ウォームプール'] },
        { name: 'AWS Service Quotas', desc: 'AWS Service Quotasは、AWSサービスの**上限値（クォータ）を一元的に確認・申請するサービス**。\nCloudWatchアラームとの統合でクォータ使用率が閾値を超えたら事前に通知\n自動クォータリクエスト：Lambda・Fargateなど一部サービスは使用量に応じて自動で上限引き上げを申請できる', tags: ['上限値', 'クォータ管理', '申請'] },
        { name: 'AWS IAM高度管理', desc: 'Permissions Boundaryで権限の上限を定めたり、ABACでタグベースに制御したりと、IAMには権限を精密に扱う高度な機能がある。\nPermissions Boundary（アクセス許可の境界）：**IAMユーザー/ロールに付与できる権限の最大上限を設定するポリシー**。開発者が自分より強い権限を持つロールを作れないよう制限する\nABAC（Attribute-Based Access Control：属性ベースのアクセス制御）：IAMロール・リソースのタグを使って動的にアクセス許可を決定する仕組み。チーム・環境別の権限管理に有効', keyword: 'IAM Permissions Boundary ABAC 属性ベースアクセス制御', tags: ['Permissions Boundary', 'ABAC', '最小権限'] },
        { name: 'AWS Config + AWS Security Hub（DOP）', desc: 'AWS Configで設定のコンプライアンスを評価し、Security Hubで検出結果を集約して、ガバナンスを自動化する。\n主な機能：\n- Configコンフォーマンスパック：複数のConfigルールを**まとめてYAMLでパッケージ化し、組織全体に一括展開できる**\n- Security Hub CIS/PCI自動チェック：CIS AWS Foundations Benchmark（セキュリティのベースライン）やPCI-DSS（クレジットカード業界基準）への準拠状況をAWS Configと連携して自動評価\n- 自動修復：違反検出時にSSM Automationで自動修正するパターンが頻出', keyword: 'AWS Config コンフォーマンスパック Security Hub', tags: ['コンフォーマンスパック', 'CISベンチマーク', '自動修復'], seeAlso: ['Amazon Inspector / Amazon GuardDuty / AWS Security Hub 使い分け', 'Amazon GuardDuty（脅威検出）', 'AWS Systems Manager'] },
        { name: 'AWS Organizations（マルチアカウント管理）', desc: 'Organizationsは複数の機能でマルチアカウントを統制する。\n主な機能：\n- SCP（サービスコントロールポリシー）：OU（組織単位）やアカウントに適用するガードレール。**IAM許可とのAND評価で最大権限を制限するだけで権限を付与しない**\n- OU設計：開発・ステージング・本番アカウントを別OUで分離し、誤操作・権限逸脱を組織レベルで防ぐ\n- StackSets：CloudFormationテンプレートを複数アカウント・リージョンに一括デプロイする仕組み\n- Config組織アグリゲーター：全アカウント・全リージョンのConfig設定データを1か所に集約して一元監視\n- 委任された管理者（Delegated Administrator）：管理アカウント以外のメンバーアカウントにSecurity Hub・GuardDuty・Inspector等の管理権限を委任できる仕組み。セキュリティ専用アカウントに集約して管理アカウントとの職務分離を実現', keyword: 'AWS Organizations SCP OU 委任された管理者 Delegated Administrator マルチアカウント', tags: ['SCP', 'StackSets', '委任された管理者'], seeAlso: ['AWS IAM Identity Center（SSO）+ AWS Organizations'] },
        { name: 'AWS IAM Identity Center（SSO）+ AWS Organizations', desc: 'AWS IAM Identity Center（SSO）は、複数のAWSアカウントへの**シングルサインオン（SSO）をOrganizations全体で一元管理するサービス**（旧AWS SSO）。\nアイデンティティソース（認証先の選択）：\n- AWS組み込みIDストア：Identity Centerが管理するユーザー/グループ（シンプルな構成）\n- 外部IdP（SAML 2.0）：Okta・Azure AD等のIdPと連携。SCIM（外部ディレクトリとの自動プロビジョニング規格）で自動プロビジョニング\n- Active Directory：AWS Managed Microsoft ADまたはAD Connectorで社内ADと同期\n- Cognito User Pool連携：CognitoをOIDCアイデンティティソースとしてIdentity Centerに登録することでアプリのユーザーにAWSアカウントアクセスを付与するパターン\n- 権限セット（Permission Set）：アカウントごとに付与するIAMポリシーの組み合わせを定義して一元管理\n- Cognitoとの違い：CognitoはB2Cアプリのエンドユーザー認証（ユーザープール）/ Identity CenterはAWSアカウントへの社員アクセス管理', keyword: 'IAM Identity Center AWS SSO Organizations SSO 権限セット Cognito SAML SCIM', tags: ['SSO', '権限セット', 'SAML/SCIM'], seeAlso: ['AWS Organizations（マルチアカウント管理）'] },
        { name: 'Amazon Inspector / Amazon GuardDuty / AWS Security Hub 使い分け', desc: '脆弱性を見るInspector、脅威を検知するGuardDuty、検出結果を集約するSecurity Hub。役割の異なる3つを組み合わせて使う。\n**3サービスの役割**の違い：\n- GuardDuty（脅威検出）：CloudTrail・VPCフロー・DNSログをML+脅威インテリジェンスで分析して「今起きている脅威」を検出。ポートスキャン・クレデンシャル漏洩・クリプトマイニングを発見\n- Inspector（脆弱性管理）：EC2・ECR・Lambdaの既知脆弱性（CVE）を継続スキャンして「これから起きうる弱点」を予防的に発見。CVSSスコアで優先順位付け\n- Security Hub（統合・コンプライアンス）：GuardDuty・Inspector・Macie等の検出結果をASFF形式で集約し優先順位付け。CIS AWS Foundations Benchmark・PCI-DSSへの準拠状況を自動評価\n- 典型的な連携パターン：GuardDuty（脅威を検出）→ EventBridge → Lambda（EC2を自動隔離）+ Security Hub（全体の状態を追跡・管理）+ Inspector（悪用された脆弱性を特定）', keyword: 'GuardDuty Inspector Security Hub 使い分け 脅威検出 脆弱性管理 コンプライアンス', tags: ['GuardDuty', 'Inspector', 'Security Hub'], seeAlso: ['Amazon Inspector（脆弱性管理）', 'Amazon GuardDuty（脅威検出）', 'AWS Config + AWS Security Hub（DOP）'] },
        { name: 'Amazon Inspector（脆弱性管理）', desc: 'Amazon Inspectorは、脆弱性（セキュリティの弱点）を**継続的にスキャンして優先順位付けするサービス**。\nスキャン対象：\n- EC2インスタンス：SSMエージェント経由でエージェントレスにOSの既知脆弱性を検出\n- ECRコンテナイメージ：プッシュ時に自動スキャンして脆弱なイメージのデプロイを防ぐ\n- Lambda関数：コードと依存パッケージの脆弱性をスキャン\nCVSSスコアでリスク優先順位付けし、Security Hubに集約してDOP全体のセキュリティ可視化に活用', tags: ['CVE', 'CVSS', 'コンテナスキャン'], seeAlso: ['Amazon GuardDuty（脅威検出）', 'Amazon Inspector / Amazon GuardDuty / AWS Security Hub 使い分け'] },
        { name: 'Amazon GuardDuty（脅威検出）', desc: 'Amazon GuardDutyは、CloudTrail・VPCフローログ・DNSクエリログを**機械学習と脅威インテリジェンスで自動分析して脅威を検出するサービス**。\n検出例：EC2のポートスキャン・IAMクレデンシャルの外部漏洩・S3への不正アクセス・クリプトマイニング\nOrganizations連携：全アカウントにGuardDutyを一括有効化し、管理アカウントで検出結果を集約\nEventBridge → Lambda で自動隔離・SNS通知の自動応答パターンが頻出', tags: ['脅威検出', '機械学習', '自動応答'], seeAlso: ['Amazon Inspector（脆弱性管理）', 'Amazon Inspector / Amazon GuardDuty / AWS Security Hub 使い分け'] },
      ],
    },
  ],

  DEA: [
    {
      title: 'データの取り込み',
      items: [
        { name: 'Amazon Kinesis Data Streams', desc: '**リアルタイムストリーミングデータの取り込みサービス**。\nシャード：スループットの単位。1シャード = 1MB/s書き込み・2MB/s読み取り\n拡張ファンアウト（Enhanced Fan-Out）：各ConsumerアプリがシャードごとにDedicatedで2MB/sで同時読み取り可能にする機能\nKCL（Kinesis Client Library）：複数のConsumerが協調してシャードを処理するためのConsumer側ライブラリ\nKPL（Kinesis Producer Library）：Producer側ライブラリ。複数レコードのバッチ化・集約(aggregation)・非同期送信でスループットとコスト効率を大幅に高める（PutRecords効率化）。トレードオフで若干のレイテンシ増\n保持期間：デフォルト24時間〜最大365日（延長は課金）', tags: ['シャード', '拡張ファンアウト', 'KCL', 'KPL'] },
        { name: 'Amazon Kinesis Data Firehose', desc: 'Amazon Kinesis Data Firehoseは、**自動でスケールするマネージドなストリーム配信サービス**。シャード管理不要で手軽にデータ配信できる。\n配信先：S3・Redshift・Amazon OpenSearch・Splunk・HTTP エンドポイント\nLambda変換：配信前にデータをリアルタイムで変換（JSONからParquet変換等）\nバッファリング：サイズ（1〜128MB）または時間（60〜900秒）でまとめて配信', tags: ['自動スケール', 'Lambda変換', 'バッファリング'] },
        { name: 'Amazon MSK（Managed Streaming for Apache Kafka）', desc: 'Amazon MSKは、フルマネージドなApache Kafkaサービス。**既存のKafkaのプロデューサー・コンシューマーAPIをそのまま使えるため移行しやすい**。\nKafka Connect：外部システム（RDS・S3等）とKafkaを接続するコネクタフレームワーク\nKafka Streams：Kafka内でリアルタイム処理を行うストリーム処理ライブラリ\nMSK（Managed Streaming for Apache Kafka） Serverless：キャパシティ管理不要の自動スケール版\nMSK Replicator：クラスタ間・リージョン間でトピックを非同期レプリケーション（MirrorMaker 2ベースをフルマネージド化）。クロスリージョンDR・地理冗長・移行に使う', tags: ['Kafka', 'MSK Serverless', 'Replicator'] },
        { name: 'AWS DMS（Database Migration Service）', desc: 'AWS DMS（Database Migration Service）は、**ソースDBからターゲットDBへのデータ移行サービス**。\n対応：同種DB間（Oracle→Oracle）と異種DB間（Oracle→Aurora）の両方\nCDC（Change Data Capture）：ソースDBの変更をリアルタイムで継続的にキャプチャしてターゲットに適用\nSCT（Schema Conversion Tool）：異種DB間でSQLスキーマを自動変換するツール', tags: ['DB移行', 'CDC', 'SCT'] },
        { name: 'Amazon AppFlow', desc: 'Amazon AppFlowは、Salesforce・SAP・Slack等のSaaSアプリとAWSサービス（S3・Redshift等）間で**ノーコードでデータを転送・変換するマネージドサービス**。\nトリガー：スケジュール・イベント・オンデマンドの3種類\nデータマッピング：フィールドの変換・フィルタリングをGUIで設定', tags: ['SaaS連携', 'ノーコード', 'フロー'] },
        { name: 'AWS DataSync', desc: 'AWS DataSyncは、オンプレミスのNFS/SMBファイルサーバー、S3、EFS、FSx間のデータを**高速・自動転送するエージェント型サービス**。\nエージェント：オンプレ側に仮想アプライアンスをインストールしてAWSと安全に通信\nTLS暗号化・チェックサム検証でデータの整合性を保証。帯域制御とスケジュールも設定可能', tags: ['オンプレ転送', 'エージェント', '自動化'] },
        { name: 'ゼロETL統合（Zero-ETL）', desc: 'ゼロETL統合（Zero-ETL）は、**ETLパイプラインを自前で構築せずソースの変更をほぼリアルタイムで分析先へ自動連携するマネージド統合**。\n代表例：\n- Aurora / RDS（MySQL・PostgreSQL） → Redshift：トランザクションデータを数秒でDWHへ反映し即分析\n- DynamoDB → Redshift / OpenSearch：KVデータを分析・全文検索へ連携\nメリット：Glue等のETLジョブ・CDC基盤の構築/運用が不要。「分析のためにパイプラインを作りたくない」要件で第一候補\n注意：変換ロジックが必要な複雑処理には不向き（その場合はGlue/EMR）', tags: ['Zero-ETL', 'Aurora→Redshift', 'ニアリアルタイム'] },
      ],
    },
    {
      title: 'データの変換・処理',
      items: [
        { name: 'Amazon QuickSight', desc: 'Amazon QuickSightは、サーバーレスBI（ビジネスインテリジェンス）サービス。**データを可視化しダッシュボードを作成・共有する**。\nSPICE：インメモリの高速計算エンジン。データを取り込み高速に集計\nデータソース：S3・Athena・Redshift・RDS・各種DBを接続\nQ：自然言語の質問からグラフを生成する生成AI機能\nセッション課金で多数の閲覧者にも低コスト', keyword: 'Amazon QuickSight BI ダッシュボード SPICE 可視化', tags: ['サーバーレスBI', 'SPICE', 'ダッシュボード'] },
        { name: 'AWS Glue', desc: 'サーバーレスETL（Extract・Transform・Load）サービス。**インフラ管理不要で大規模データ処理が可能**。\nクローラー：S3・RDS・DynamoDB等のデータを自動スキャンしてGlue Data Catalogにスキーマを登録\nETLジョブ：SparkまたはPython ShellベースでデータをS3やRedshiftに変換・格納\nGlue Studio：ビジュアルなUIでETLジョブを構築できるツール\nGlue DataBrew：SQLやコードなしでデータをクリーニング・変換できるノーコードツール', tags: ['ETL', 'クローラー', 'Spark'] },
        { name: 'Amazon EMR（Elastic MapReduce）', desc: 'Amazon EMRは、Apache Spark・Hive・Presto・HBase等のビッグデータフレームワークを**EC2/Fargate上で実行するマネージドクラスタサービス**。\nノードの役割：\n- マスターノード：クラスタ全体を管理・調整\n- コアノード：データ処理＋HDFSデータを保持（削除すると不可）\n- タスクノード：データ処理のみ（HDFS保持なし）。スポットEC2を使うことでコスト削減', tags: ['Spark', 'Hive', 'スポット'] },
        { name: 'AWS Lambda（データ処理）', desc: 'Lambdaはストリームをトリガーにレコードをリアルタイム処理できる。\nストリーム処理：**Streamsトリガーでリアルタイム変換**\nKinesis Data StreamsやDynamoDB Streamsのトリガーで起動してリアルタイムにデータを処理・変換するサーバーレス関数。\n軽量な変換処理やイベント駆動のデータパイプライン（フィルタリング・エンリッチメント・ルーティング）に適している。', tags: ['リアルタイム', 'ストリーム処理', 'イベント駆動'] },
        { name: 'AWS Step Functions（データパイプライン）', desc: 'AWS Step Functions（データパイプライン）は、AWS Glue・Amazon EMR・Lambda・Athena等を**組み合わせた複雑なETLパイプラインのオーケストレーション（実行順序・状態管理）サービス**。\nステートの種類：\n- Task：1つの処理（Lambda・Glueジョブ等）を実行\n- Choice：条件分岐（if/else）\n- Map：配列の各要素に同じ処理を繰り返す（動的並列。Distributed Mapで大規模並列）\n- Parallel：複数ブランチを同時並行実行\n- Wait/Pass/Succeed/Fail：待機・受け渡し・終了\nvs Glue Workflow：Glue Workflowは「Glueのクローラー/ジョブ/トリガーだけ」を束ねる軽量オーケストレーション。複数AWSサービス横断・条件分岐・リトライ・人手承認など高度な制御が要るなら Step Functions を選ぶ', tags: ['ステート', 'Map/Parallel', 'vs Glue Workflow'], seeAlso: ['AWS Glue', 'Amazon EMR（Elastic MapReduce）'] },
        { name: '基礎SQL構文（分析でよく問われる）', desc: '基礎SQL構文は、**Athena/Redshift/Sparkでの集計・整形で頻出のSQL**。\nUNION / UNION ALL：複数クエリ結果を縦に結合。UNIONは重複排除、UNION ALLは重複そのまま（高速）\nEXCEPT（=MINUS） / INTERSECT：差集合 / 積集合\nGROUP BY … HAVING：集約後の条件絞り込み（WHEREは集約前）\nウィンドウ関数：ROW_NUMBER() / RANK() OVER(PARTITION BY … ORDER BY …) で順位付け・重複排除\nCTE（WITH句）：中間結果に名前を付けて可読性向上\nJOIN種別：INNER / LEFT / FULL OUTER の使い分け\n※SELECTで一部列だけ除外したい場合、標準SQLに列のEXCLUDEは無い（列を明示列挙）。Sparkの一部方言に EXCEPT/EXCLUDE 構文あり', tags: ['UNION', 'ウィンドウ関数', 'JOIN'] },
      ],
    },
    {
      title: 'データストア',
      items: [
        { name: 'Amazon S3（データレイク）', desc: 'Amazon S3（データレイク）は、**あらゆる形式のデータを生のまま保存するデータレイクの基盤**として最も多く使われる。\nパーティション設計：データをyear=xxx/month=xxx/day=xxx等のフォルダ構造で分割しAthena・Sparkのフィルタ高速化に活用\n推奨フォーマット：Parquet（列指向・高圧縮）/ ORC（Hive向け列指向）/ Avro（スキーマ進化に強い）\nS3（Simple Storage Service） Select：S3オブジェクト内の一部データのみをSQLで取得してネットワーク転送量を削減\nObject Lock（WORM）：書き込み後の変更・削除を防ぐコンプライアンス要件向けの機能', tags: ['パーティション', 'Parquet/ORC', 'データレイク'] },
        { name: 'Amazon Redshift', desc: '**列指向ストレージのDWH（データウェアハウス）**。\n分散スタイル：各ノードへのデータ配置方式\n- KEY：特定カラムの値が同じ行を同じノードに配置（JOINでの結合高速化）\n- ALL：全行を全ノードにコピー（小テーブル向け）\n- EVEN：ラウンドロビンで均等分散\n- AUTO：Redshiftが最適な方式を自動選択\nソートキー：よく使うWHERE条件カラムに設定してゾーンマップ（各ブロックの最小値/最大値を記録し不要ブロックの読込を回避する仕組み）によるスキャン削減\nメンテナンス処理：\n- VACUUM：削除マーク行の物理削除＋ソートキー順に再整列（recluster＝再クラスタ化）してスキャン効率を回復\n- VACUUM REINDEX：インターリーブソートキーの再インデックス（分布が偏ったら実行）\n- ANALYZE：テーブルの統計情報を更新し、クエリプランナが最適な実行計画を選べるようにする（VACUUMとは別物）\n※ 新しめのRedshiftは自動VACUUM/自動ANALYZE/自動テーブル最適化(ATO)で多くが自動化\nRedshift Spectrum：S3上のデータを直接クエリ（ロード不要）', tags: ['分散スタイル', 'VACUUM/ANALYZE', 'Spectrum'] },
        { name: 'AWS Lake Formation', desc: '**データレイクの構築・管理・セキュリティを一元管理するサービス**。\n列・行レベルのきめ細かいアクセス制御：Athena・GlueからS3のデータへのアクセスをカラム・行単位で制限できる\nBlueprint（ブループリント）：S3やRDBのデータを定期的にGlueワークフローでデータレイクに取り込むパイプラインを自動生成する機能', tags: ['列/行レベル', 'Blueprint', 'アクセス制御'] },
        { name: 'Amazon Athena', desc: '**S3上のデータをサーバーレスSQLでクエリするサービス**。\nワークグループ：チーム・プロジェクト別にクエリを分離してコスト制御・アクセス制御を行う仕組み\nクエリフェデレーション：Lambda Connectorを使ってS3以外のRDS・CloudWatch・DynamoDBのデータも横断的にクエリ可能\nIcebergテーブル：SCHEMAの変更やタイムトラベル（過去の状態をクエリ）・UPDATEをサポートするテーブル形式', tags: ['ワークグループ', 'クエリフェデレーション', 'Iceberg'] },
        { name: 'Amazon DynamoDB（DEA観点）', desc: 'Amazon DynamoDB（DEA観点）は、**大規模なリアルタイムアクセスに適したKV（キーバリュー）ストア**。\nパーティションキー設計：ホットパーティション（特定キーへのアクセス集中）を避けるため書き込みシャーディング（サフィックス追加）等を使用\nDAX（DynamoDB Accelerator）：マイクロ秒レイテンシのインメモリキャッシュ。API互換でアプリ変更が最小限\nTTL（Time to Live）：有効期限付きアイテムを自動削除してストレージコストを削減', tags: ['KVストア', 'DAX', 'TTL'] },
        { name: 'S3 Storage Lens vs S3 Inventory', desc: 'S3 Storage Lensは利用状況を可視化する分析ダッシュボード、S3 Inventoryはオブジェクト一覧を出力する棚卸し機能で、用途が異なる。\nS3（Simple Storage Service） Storage Lens：組織/アカウント横断のストレージ利用状況を可視化する「分析ダッシュボード」。使用量・リクエスト傾向・コスト最適化やデータ保護のレコメンド（未使用・非暗号化の検出など）を集計指標で提供\nS3 Inventory：指定バケットの「オブジェクト一覧レポート」をCSV/ORC/Parquetで定期出力。各オブジェクトのサイズ・暗号化・レプリケーション状況・ストレージクラス等を列挙。Athenaでクエリして棚卸し・監査・大量オブジェクトの一括処理入力に使う\n覚え方：傾向の「分析・指標」=Storage Lens / 1個1個の「明細リスト」=Inventory', tags: ['Storage Lens', 'Inventory', '使い分け'] },
        { name: 'JDBC / ODBC（BI・アプリ接続）', desc: 'JDBC / ODBCは、**Redshift・AthenaにBIツールやアプリから接続する際のドライバ規格**。\nJDBC（Java Database Connectivity）：Java系アプリ・多くのETL/BIツール（Java実装）向け\nODBC（Open Database Connectivity）：C/C++系・Windows系アプリ・一部BIツール向け\n使い分け：接続元の言語/ツールが何を要求するかで選ぶ（Java=JDBC、ネイティブ/Windows=ODBC）。AWSはRedshift・Athena双方に専用JDBC/ODBCドライバを提供\nサーバーレスに繋ぐなら：AthenaのJDBC/ODBCでS3データをSQL接続、RedshiftはRedshift Data API(HTTPS)でドライバ無し接続も可', tags: ['JDBC', 'ODBC', 'ドライバ'] },
      ],
    },
    {
      title: 'データセキュリティ・ガバナンス',
      items: [
        { name: 'AWS KMS（データ暗号化）', desc: 'AWS KMS（データ暗号化）は、S3・Redshift・Glue・Athena等のデータサービスと**統合して保存データを暗号化するサービス**。\nキーポリシー：KMSキーへのアクセスをJSON形式で制御するリソースベースポリシー\nグラント（Grant）：特定の操作（Decrypt等）を特定のAWSプリンシパルに委譲する一時的なアクセス許可の仕組み', tags: ['暗号化', 'キーポリシー', 'グラント'] },
        { name: 'Amazon Macie', desc: 'Amazon Macieは、S3バケット内のPII（Personally Identifiable Information：個人識別情報）・認証情報・金融データ等の機密データを**機械学習で自動検出・分類するサービス**。\nバケットの公開設定ミスも検出する。GDPR・HIPAAなどのコンプライアンス対応に活用される。', tags: ['PII検出', 'S3スキャン', 'データ分類'] },
        { name: 'AWS Glue Data Catalog', desc: 'Glueはデータカタログでメタデータを一元管理する。\nメタデータ：**テーブル定義・場所・統計を一元管理するカタログ**\nデータのスキーマ（テーブル定義・カラム型）・場所（S3パス等）・メタデータを一元管理するメタデータリポジトリ。\nAthena・Redshift Spectrum・EMR・Lake Formationと連携してデータソースのスキーマを共有する。クローラーで自動登録が可能。', tags: ['メタデータ', 'スキーマ管理', 'データカタログ'] },
      ],
    },
  ],

  MLA: [
    {
      title: 'SageMaker - データ準備',
      items: [
        { name: 'Amazon SageMaker Data Wrangler', desc: 'Amazon SageMaker Data Wranglerは、S3・Redshift・Athena等から**300以上のデータ変換をGUIで実行できる**データ準備ツール。\nデータ品質レポート：欠損値・外れ値・クラス不均衡を自動で可視化\n変換したフローをGlue ETLジョブやSageMaker Processingジョブとしてエクスポートできる', tags: ['データ変換', 'GUI', 'データ品質'] },
        { name: 'Amazon SageMaker Feature Store', desc: 'Amazon SageMaker Feature Storeは、特徴量（モデルの入力データ）を**管理・共有するリポジトリ**。\nオンラインストア：低レイテンシ（ミリ秒）でリアルタイム推論用の最新特徴量を取得\nオフラインストア（S3）：バッチ学習用に特徴量の履歴を蓄積\n複数チーム・モデルで特徴量を再利用することでデータパイプラインの重複を排除', tags: ['オンラインストア', 'オフラインストア', '特徴量共有'] },
        { name: 'Amazon SageMaker Ground Truth', desc: 'Amazon SageMaker Ground Truthは、**機械学習用のデータラベリング（教師ラベルの付与）を管理するサービス**。\nAmazon Mechanical Turk・専門ラベリング会社・プライベートチームにラベリングを依頼できる\nActive Learning（自動ラベリング）：信頼度が高いデータは自動でラベル付けし、信頼度が低いデータのみ人間がレビューすることでコストと時間を削減', tags: ['ラベリング', 'Active Learning', '自動ラベリング'] },
      ],
    },
    {
      title: 'SageMaker - モデル開発',
      items: [
        { name: 'Amazon SageMaker Studio', desc: 'Amazon SageMaker Studioは、Jupyter Notebookを拡張した**ML開発のための統合IDE**（Webベースの開発環境）。\n主な機能：\n- Experiments：複数の学習実行の条件・メトリクスを比較管理\n- Pipelines：MLパイプラインの定義・実行・可視化\n- Model Registry：モデルのバージョン管理・承認\n- Clarify：バイアス・説明可能性の分析', tags: ['IDE', 'Experiments', '統合環境'] },
        { name: 'Amazon SageMaker Training', desc: 'Amazon SageMaker Trainingは、**マネージドなMLモデル学習サービス**。\n組み込みアルゴリズム：XGBoost（勾配ブースティング）/ Linear Learner（線形モデル）/ DeepAR（時系列予測）/ BlazingText（テキスト分類）等\nカスタムコンテナ：独自のTensorFlow・PyTorch等のコードをDockerイメージで実行\n分散学習（Distributed Training）：データ並列（大量データを複数GPU/インスタンスで分割学習）とモデル並列（大規模モデルを複数GPUに分割）\nスポットトレーニング：EC2スポットインスタンスで最大90%コスト削減（中断を考慮してチェックポイント設定が必要）', tags: ['組み込みアルゴリズム', '分散学習', 'スポット'] },
        { name: 'Amazon SageMaker Automatic Model Tuning（AMT）', desc: 'Amazon SageMaker AMTは、ハイパーパラメータ（学習率・バッチサイズ等）を**自動探索してモデルを最適化するHPO（Hyperparameter Optimization）機能**。\n探索戦略：\n- Bayesian最適化：過去の試行結果を学習して効率的に次のパラメータ候補を選択\n- Grid Search：指定した全パラメータ組み合わせを網羅的に試行\n- Random Search：ランダムにパラメータを選択\nウォームスタート：前回のチューニング結果を引き継いで効率化', tags: ['HPO', 'Bayesian最適化', 'ウォームスタート'] },
        { name: 'Amazon SageMaker Clarify', desc: '**学習前後のバイアス検出と説明可能性の分析を行うサービス**。\nバイアス検出：訓練データのバイアス（学習前）とモデルの予測バイアス（学習後）を統計指標で測定\nSHAP（Shapley Additive exPlanations）値：各特徴量が予測に与えた貢献度を定量化するFeature Importance（特徴量重要度）手法\nAmazon SageMaker Model Monitorと統合してデプロイ後のバイアスドリフトも継続監視', tags: ['バイアス検出', 'SHAP', '説明可能性'] },
      ],
    },
    {
      title: 'SageMaker - デプロイ・MLOps',
      items: [
        { name: 'Amazon SageMaker Endpoints（推論）', desc: 'SageMakerは要件に応じて推論エンドポイントの方式を選べる。\n**推論エンドポイントの5種類**：\n- リアルタイムエンドポイント：同期API。低レイテンシが必要な場合\n- 非同期推論：リクエストをキューに積んでバックグラウンドで処理。大きなペイロードや処理時間が長い推論向け\n- サーバーレス推論：トラフィックがゼロの間はコストゼロ。断続的なトラフィック向け\n- バッチ変換：S3のデータをバッチ処理。推論エンドポイントの常時起動不要\n- マルチモデルエンドポイント（MME）：1つのエンドポイントで複数モデルをホスティングしてコスト削減', tags: ['リアルタイム', '非同期', 'バッチ変換'] },
        { name: 'Amazon SageMaker Pipelines', desc: 'SageMaker Pipelinesは、MLワークフロー（データ処理→学習→評価→モデル登録→デプロイ）をDAG（有向非巡回グラフ）として定義してCI/CD化するサービス。\nMLパイプライン：**前処理〜デプロイをDAGでCI/CD化**\n各ステップはProcessing・Training・Evaluation・Condition・Register等のタイプから選択。\nExperimentsと自動統合して実行履歴・メトリクスを管理する。', tags: ['MLパイプライン', 'CI/CD', 'DAG'] },
        { name: 'Amazon SageMaker Model Registry', desc: 'SageMaker Model Registryは、モデルのバージョン管理・メタデータ（精度・訓練データ・パラメータ）・承認ワークフローを管理するカタログ。\nモデルレジストリ：**バージョン・メタデータ・承認を管理**\n承認（Approved）/拒否（Rejected）のステータスを管理し、承認済みモデルのみをCodePipeline・Lambda経由で自動デプロイするパターンが重要。', tags: ['モデル管理', 'バージョン管理', '承認ワークフロー'] },
        { name: 'Amazon SageMaker Model Monitor', desc: 'SageMakerはデプロイ済みモデルを継続的に監視する。\n監視の4種類：\n- データ品質：入力データの統計的特性がベースラインから逸脱していないか（データドリフト）\n- モデル品質：予測精度が劣化していないか\n- バイアスドリフト：特定グループへの偏りが増加していないか\n- 説明可能性ドリフト：Feature Importance（特徴量重要度）が変化していないか', tags: ['データドリフト', 'モデル品質', '継続的監視'] },
      ],
    },
    {
      title: 'MLインフラ・セキュリティ',
      items: [
        { name: 'Amazon ECR（Elastic Container Registry）', desc: 'Amazon ECRは、**Dockerコンテナイメージを保存・バージョン管理する**AWSのプライベートコンテナレジストリ。\nSageMakerのカスタムTraining Job・Inference Jobでは独自のMLライブラリや依存関係を含んだコンテナイメージをECRに保存して使用する。\nECRのイメージスキャン機能でコンテナの脆弱性を検出できる。', tags: ['コンテナ', 'カスタムイメージ', 'バージョン管理'] },
        { name: 'Amazon CloudWatch + Amazon SageMaker', desc: 'SageMakerは**トレーニング・推論のメトリクスをCloudWatchに自動送信する**。\nトレーニングジョブ：CPU/GPU使用率・メモリ使用率・学習損失（カスタムメトリクス）\n推論エンドポイント：Invocations（呼び出し回数）/ Latency（レイテンシ）/ ModelLatency / 4xx・5xxエラー数\nこれらにCloudWatchアラームを設定してスケーリング・通知を自動化する', tags: ['GPU監視', 'レイテンシ', 'アラーム'] },
        { name: 'AWS IAM + Amazon VPC統合（SageMaker）', desc: 'SageMakerのジョブをVPC内で実行することで**インターネットアクセスを遮断してネットワーク分離を実現**。\n実行ロール（Execution Role）：SageMakerがS3・ECR・CloudWatch等にアクセスするためのIAMロール。最小権限の原則で必要なリソースのみに限定する。\nVPCエンドポイント：VPC内からS3・SageMaker APIにプライベートアクセスするために設定', tags: ['VPC統合', '実行ロール', 'ネットワーク分離'] },
      ],
    },
    {
      title: '推論・自動化・コスト',
      items: [
        { name: '推論オプションの選択', desc: 'SageMakerの推論は、用途に応じてリアルタイム・サーバーレス・非同期・バッチの4方式から選ぶ。\nリアルタイム推論：低レイテンシで常時稼働（オンライン予測）\nサーバーレス推論：トラフィックに応じ自動スケール、アイドル時は課金なし（間欠負荷向け）\n非同期推論（Asynchronous）：大きな入力や長い処理をキュー経由で処理\nバッチ変換（Batch Transform）：大量データをまとめてオフライン推論', keyword: 'リアルタイム推論 サーバーレス推論 非同期推論 バッチ変換 SageMaker 推論オプション', tags: ['リアルタイム / サーバーレス', '非同期 / バッチ', '推論方式の選択'] },
        { name: 'エンドポイント運用', desc: 'SageMakerの推論エンドポイントを本番運用するには、Auto Scalingやデプロイ戦略といった実務的な工夫が必要になる。\nAuto Scaling：リクエスト数などのメトリクスでインスタンス数を自動増減\nマルチモデルエンドポイント：1エンドポイントに多数モデルを載せコスト削減\nA/Bテスト（本番バリアント）：複数モデルにトラフィックを比率配分して比較\nシャドウテスト：本番トラフィックを複製し新モデルを無影響で検証', keyword: 'Auto Scaling マルチモデルエンドポイント A/Bテスト 本番バリアント シャドウテスト', tags: ['Auto Scaling', 'マルチモデル', 'A/B・シャドウテスト'] },
        { name: 'SageMaker JumpStart / Autopilot', desc: 'JumpStartは事前学習済みモデルをすぐ使える機能、AutopilotはAutoMLでモデル作成を自動化する機能で、どちらもML開発を高速化する。\nJumpStart：事前学習済みモデルやソリューションテンプレートをすぐ利用\nAutopilot：データを渡すだけで**前処理・アルゴリズム選択・調整を自動化するAutoML**\n生成物（ノートブック等）を確認・カスタマイズできる', keyword: 'SageMaker JumpStart Autopilot AutoML 事前学習モデル 自動機械学習', tags: ['JumpStart', 'Autopilot / AutoML', 'ノーコード寄り'] },
        { name: '学習コストの最適化', desc: 'モデルの学習コストは、スポットインスタンスの活用や適切なインスタンス選択などで抑えられる。\nマネージドスポット学習：スポットで学習し最大90%割引（中断はチェックポイントで再開）\nマネージドウォームプール：インスタンス再利用で起動待ちを短縮\n分散学習（Distributed Training）：データ並列・モデル並列で大規模学習を高速化', keyword: 'マネージドスポットトレーニング ウォームプール 分散学習 データ並列 モデル並列', tags: ['スポット学習', 'ウォームプール', '分散学習'] },
      ],
    },
  ],

  SAP: [
    {
      title: '組織とガバナンス',
      items: [
        { name: 'AWS Organizations', desc: '複数のAWSアカウントを**OU（組織単位）で階層的に管理するサービス**。\nSCP（サービスコントロールポリシー）：OU/アカウントに適用するガードレール。IAM許可との AND評価で最大権限を制限するだけで権限を付与する機能はない\nコンソリデーテッドビリング：全アカウントの請求を1つにまとめてスケールメリットで割引を受けられる', tags: ['SCP', 'OU', 'ガードレール'] },
        { name: 'AWS Control Tower', desc: 'AWS Control Towerは、AWS Organizationsの上でマルチアカウント環境の推奨構成（ランディングゾーン）を**自動セットアップするサービス**。\nGuardrails（ガードレール）：予防的（SCPで禁止）と検出的（Configルールで違反を検出）の2種類\nAccount Factory：新しいAWSアカウントを承認済み設定で自動プロビジョニング\nログアーカイブアカウント：CloudTrail・Configのログを集約保存する専用アカウント', tags: ['ランディングゾーン', 'Guardrails', 'Account Factory'] },
        { name: 'AWS RAM（Resource Access Manager）', desc: 'AWS RAM（Resource Access Manager）は、AWS Organizationsやアカウント間で**AWSリソースを共有するサービス**。\n共有可能なリソース例：VPCサブネット・Transit Gateway・Route 53 Resolverルール・ライセンス\nVPCサブネット共有：別アカウントのリソースを同一VPCのサブネットに配置できる。VPCピアリングやTGWなしで済む', tags: ['リソース共有', 'VPC共有', 'クロスアカウント'] },
        { name: 'AWS Service Catalog', desc: 'AWS Service Catalogは、承認済みのITサービス（リソース構成）をカタログ化し、**ユーザーにセルフサービスで提供する**サービス。\nCloudFormationテンプレートをベースに「製品」を定義し、ユーザーが承認済み製品だけをデプロイできるガバナンスを実現。コスト管理・コンプライアンス維持に有効。', tags: ['セルフサービス', 'カタログ', 'ガバナンス'] },
        { name: 'AWS Config + AWS Organizations', desc: 'AWS ConfigをOrganizationsと組み合わせ、組織全体のリソース設定を集約・一括管理する。\n主な機能：\n- Config組織アグリゲーター：全アカウント・全リージョンの設定データを**1か所に集約して一元管理する機能**\n- コンフォーマンスパック：複数のConfigルールをまとめてYAMLでパッケージ化し、Organizationsを通じて全アカウントに一括展開する', keyword: 'AWS Config 組織アグリゲーター コンフォーマンスパック', tags: ['アグリゲーター', 'コンフォーマンスパック', '一元管理'] },
      ],
    },
    {
      title: '移行・モダン化',
      items: [
        { name: 'AWS Application Migration Service（MGN）', desc: 'AWS MGN（Application Migration Service）は、オンプレミスや他クラウドのサーバーを**AWSにリフト＆シフト（そのまま移行）する**サービス。\nエージェントをソースサーバーにインストールして継続的にAWSへレプリケーション。カットオーバー時のダウンタイムを最小限（分単位）に抑えられる。', tags: ['リフト&シフト', 'エージェント', 'レプリケーション'] },
        { name: 'AWS DMS（Database Migration Service）', desc: '**ソースDBからターゲットDBへのマイグレーションサービス**。\n同種DB移行：Oracle→Oracle / MySQL→MySQL\n異種DB移行：Oracle→Aurora / SQL Server→PostgreSQL\nCDC（Change Data Capture）：移行後もソースの変更をリアルタイムで継続レプリケーションして最終カットオーバーのダウンタイムを最小化', tags: ['DB移行', 'CDC', '異種DB'] },
        { name: 'AWS Snow Family（オフラインデータ転送）', desc: 'AWS Snow Familyは、**ネットワーク経由のデータ転送が現実的でない場合に使うオフライン転送デバイス群**。\nSnowcone：小型（8TB）。エッジコンピューティングにも対応\nSnowball Edge Storage Optimized：大容量（80TB）\nSnowball Edge Compute Optimized：EC2・Lambda機能付き（エッジ処理向け）\nSnowmobile：トラックで運搬する100PBの超大規模転送', tags: ['オフライン転送', 'エッジコンピュート', 'ペタバイト'] },
        { name: 'AWS Migration Hub', desc: 'AWS Migration Hubは、Application Migration Service・DMS等のAWS移行ツールの進捗を**一元的に追跡・管理する**ダッシュボード。\nMigration Hub Refactor Spaces：マイクロサービスへのリファクタリング移行を支援するサービス', tags: ['移行追跡', 'ダッシュボード', '一元管理'], seeAlso: ['AWS Application Migration Service（MGN）', 'AWS DMS（Database Migration Service）'] },
        { name: 'AWS DataSync', desc: 'オンプレのNFS/SMBサーバー・S3・EFS・FSx・他クラウド間で**データを高速転送・同期するエージェント型サービス**。\nTLS暗号化によるセキュアな転送・転送データのチェックサム検証・帯域制御・スケジュール実行が可能。DataSync vs DMS：DataSyncはファイル/オブジェクト転送、DMSはDBレコード移行', tags: ['高速転送', '同期', 'TLS'], seeAlso: ['AWS DMS（Database Migration Service）'] },
      ],
    },
    {
      title: '高度なネットワーキング',
      items: [
        { name: 'AWS Transit Gateway（TGW）', desc: 'AWS Transit Gateway（TGW）は、VPC・Site-to-Site VPN・AWS Direct Connectを**集約してハブ&スポーク型で接続する**サービス。\nTGWルートテーブル：アタッチメント間のルーティングを制御。同一ルートテーブルに置かないと通信不可\nリージョン間TGWピアリング：別リージョンのTGWとピアリングしてマルチリージョン構成を実現\nマルチキャストサポート：マルチキャストトラフィック（1対多の同時配信）をサポート', tags: ['ハブ&スポーク', 'リージョン間ピアリング', 'ルートテーブル'] },
        { name: 'AWS Direct Connect', desc: 'オンプレとAWSを**インターネットを経由しない物理専用線で接続するサービス**。\nLAG（Link Aggregation Group）：複数の物理回線を束ねて帯域幅を増加・冗長化する仕組み\nMACsec（Media Access Control Security）：L2（データリンク層）での暗号化。通信の盗聴防止\nVIFの種別：\n- プライベートVIF：VPC内のプライベートリソースへ接続\n- パブリックVIF：S3・DynamoDB等のAWS公開エンドポイントへ接続\n- トランジットVIF：TGW経由で複数VPCへ接続', tags: ['LAG', 'MACsec', 'VIF種別'] },
        { name: 'AWS Network Firewall', desc: 'AWS Network Firewallは、VPCに集中型のマネージドIPS/IDS（侵入防止/検知システム）を**デプロイするサービス**。\nステートフルルール：接続状態を追跡した上でトラフィックを検査\nステートレスルール：個々のパケットを条件でフィルタリング\nSuricata互換エンジン：オープンソースのSuricataルール形式でL7（アプリ層）まで詳細なトラフィック検査が可能', tags: ['Suricata', 'IPS', 'ステートフル'] },
        { name: 'Amazon VPC共有（AWS RAM）', desc: 'VPCはRAMでアカウント間でサブネットを共有できる。\nRAM（Resource Access Manager）：**アカウント間でVPCサブネットを共有**\nAWS RAMを使ってアカウント間でVPCサブネットを共有する機能。\n複数アカウントのリソースを同一VPC内のサブネットに配置できるため、TGWのような追加のルーティング設定が不要でネットワーク管理をシンプルに保てる。ホストアカウントがVPCを所有し、参加者アカウントがリソースをデプロイする。', tags: ['サブネット共有', 'TGW不要', '一元管理'] },
      ],
    },
    {
      title: '弾力性・DR・コスト最適化',
      items: [
        { name: 'Amazon Aurora Global Database', desc: 'Amazon Aurora Global Databaseは、**1つのプライマリリージョン（読み書き）＋最大5つのセカンダリリージョン（読み取り専用）で構成するマルチリージョンDR構成**。\nRPO（Recovery Point Objective：目標復旧時点）1秒：1秒以内のデータ損失に抑えられる\nRTO（Recovery Time Objective：目標復旧時間）1分以内：障害発生から1分以内にセカンダリをプライマリに昇格できる\nマネージドフェイルオーバー：GUIまたはAPIで自動的にセカンダリをプライマリに昇格', tags: ['マルチリージョン', 'RPO/RTO', 'フェイルオーバー'] },
        { name: 'Amazon DynamoDB Global Tables', desc: 'Amazon DynamoDB Global Tablesは、**マルチリージョンのアクティブ-アクティブ（全リージョンで読み書き可能）なDynamoDB構成**。\n競合解決：Last-Write-Wins（LWW）方式。最後に書き込んだデータが優先される\nバージョン番号（バージョン衝突回避）：タイムスタンプベースで競合を検出して最新の書き込みを保持\nReplicasに複数リージョンを指定するだけで自動的に双方向レプリケーションが設定される', tags: ['アクティブ-アクティブ', 'Last-Write-Wins', 'マルチリージョン'] },
        { name: 'AWS Elastic Disaster Recovery（DRS）', desc: 'AWS Elastic Disaster Recovery（DRS）は、ソースサーバーを継続的にAWSへレプリケーションし、**PITR（ポイントインタイムリカバリ）で復旧する**DRサービス。\nRTO（目標復旧時間）数分・低コスト（平常時はストレージのみ課金）のDRソリューション。フェイルオーバー時にEC2を起動してすぐに業務継続できる。', tags: ['PITR', '低コストDR', 'エージェント'] },
        { name: 'AWS Compute Optimizer', desc: 'EC2・Lambda・EBS・ECS・Auto Scalingのリソース使用状況を**機械学習で分析してオーバープロビジョニングを検出し適正サイズを推奨するサービス**。\n過去14日間（Extended：93日間）のCloudWatchメトリクスを分析してコスト削減率とパフォーマンスリスクを表示する。', tags: ['適正サイズ', 'ML分析', 'コスト削減'] },
        { name: 'AWS Cost Anomaly Detection', desc: 'AWS Cost Anomaly Detectionは、機械学習で**AWSコストの異常（突然の急増等）を検出してSNS・メールで通知するサービス**。\nモニターの種類：AWSサービス別・リンクアカウント別・コストカテゴリ別・タグ別に設定できる\n設定したしきい値（金額または割合）を超えた異常のみアラートするため不要な通知を削減できる', tags: ['異常検出 / Anomaly Detection', 'ML', 'SNS通知'] },
      ],
    },
  ],

  AIP: [
    {
      title: 'Amazon Bedrock - コア',
      items: [
        { name: 'Amazon Bedrock 基盤モデル', desc: 'Amazon Bedrock 基盤モデルは、**単一のAPIで複数の基盤モデル（FM）を呼び出せる**サービス。サーバー管理不要。\n利用可能モデル例：\n- Amazon Titan：AWSが独自開発したテキスト・エンベディング・画像生成モデル\n- Anthropic Claude：テキスト理解・生成・コーディング・分析に優れた大規模言語モデル\n- Meta Llama：オープンソースベースの高性能テキスト生成モデル\n- Mistral：軽量・高速・多言語対応の高コスパモデル\n- Cohere：エンタープライズ向けテキスト分類・エンベディング特化モデル\n- Stability AI：画像生成（Stable Diffusion系）モデル', keyword: 'Amazon Bedrock 基盤モデル Claude Titan', tags: ['Claude', 'Titan', 'マルチモデル'] },
        { name: 'Amazon Bedrock Knowledge Bases', desc: 'Amazon Bedrock Knowledge Basesは、RAG（検索拡張生成）を**簡単に構築するマネージドサービス**。\n仕組み：\n① S3のドキュメントを適切なサイズの「チャンク」に分割\n② エンベディングモデルで各チャンクをベクトル（数値ベクトル）に変換\n③ ベクトルストアに格納して類似度検索を可能にする\n④ ユーザーの質問ベクトルと近いチャンクを取得してFMへのプロンプトに追加\nベクトルストア選択：OpenSearch Serverless・Aurora PostgreSQL（pgvector）・Pinecone等', tags: ['RAG', 'ベクトルストア', 'チャンキング'] },
        { name: 'Amazon Bedrock Agents', desc: 'Amazon Bedrock Agentsは、FMをオーケストレーターとして**複数のツールを使い複雑なタスクを自律実行するサービス**。\nAction Groups（アクションのグループ）：Lambda関数でバックエンドAPIを呼び出す能力を定義\nKnowledge Base連携：必要に応じて社内ドキュメントを検索\nReActアーキテクチャ：推論（Reason）→行動（Act）→観察（Observe）のループでゴールに向かって自律的に進む\nメモリ：セッション内の会話履歴をコンテキストとして保持するマルチターン対応', tags: ['Action Groups', 'ReAct', 'マルチターン'] },
        { name: 'Amazon Bedrock Guardrails', desc: 'Amazon Bedrock Guardrailsは、FMの出力を**ポリシーに従ってフィルタリングする安全機能**。\nコンテンツフィルタリング：暴力・ヘイトスピーチ・性的コンテンツ・誤情報を自動ブロック\nPII（個人識別情報）検出・マスキング：名前・メールアドレス・クレジットカード番号等を検出して匿名化\nグラウンディングチェック：参照ドキュメントに根拠のない回答（ハルシネーション）を検出・ブロック\n特定トピックの拒否：扱ってはいけないテーマ（競合他社の製品等）を定義して拒否', tags: ['コンテンツフィルタ', 'PII', 'グラウンディング'] },
        { name: 'Amazon Bedrock Model Customization', desc: 'BedrockはFMを自社データでカスタマイズできる。\n主な手法：\n- ファインチューニング（Fine-tuning）：ラベル付きの入出力ペアで追加学習してタスク特化したモデルを作成\n- 継続事前学習（Continued Pre-training）：ドメイン固有の大量テキストでFMを追加学習して知識を拡充\n- Distillation（知識蒸留）：大きなモデル（教師）の出力を使って小さなモデル（生徒）を学習してコンパクト化', tags: ['ファインチューニング', '継続事前学習', 'Distillation'] },
        { name: 'Amazon Bedrock Model Evaluation', desc: 'Bedrock Model Evaluationは、モデルを評価・比較してユースケースに最適なモデルを選定するサービス。\nモデル評価：自動/人手で比較し**最適なFMを選定**\n自動評価：精度・堅牢性・毒性等の組み込みメトリクスでモデルをベンチマーク評価\n人間評価：Mechanical Turkや社内チームが出力品質を評価するHuman Evaluationワーカーチームを設定\n評価結果を基に各タスク（要約・分類・Q&A等）に最適なモデルを選定する', tags: ['モデル評価', '自動評価', '比較'] },
      ],
    },
    {
      title: '生成AIアーキテクチャパターン',
      items: [
        { name: 'RAGパターン', desc: 'RAG（検索拡張生成）を実装する代表的な構成。質問を受けて外部知識を検索し、その根拠をプロンプトに足して回答を生成する。\n検索拡張生成：**質問→検索→根拠付き生成の実装フロー**\n① ユーザーの質問をエンベディングモデルでベクトルに変換\n② ベクトルDBで類似度検索して関連チャンクを取得\n③ 取得したチャンクをコンテキストとしてプロンプトに追加\n④ FMが根拠のある回答を生成\n精度向上のポイント：チャンクサイズの調整（小さすぎると文脈不足・大きすぎると雑音）/ ハイブリッド検索（ベクトル＋キーワード）/ リランキング（再順位付け）', keyword: 'RAG 検索拡張生成 Retrieval-Augmented Generation', tags: ['チャンキング', 'エンベディング', 'ランク付け'] },
        { name: 'プロンプトエンジニアリング（AIP）', desc: 'プロンプトエンジニアリングは出力品質を高める技法を体系化する。\n主な技法：\n- System prompt：AIの役割・制約・口調を定義する（「あなたは医療専門家です」等）\n- Few-shot：入出力例を3〜5件示してフォーマットや判断基準を教える\n- Chain-of-Thought：「ステップごとに考えてください」で複雑な推論精度を向上\n- XML構造：タグでセクションを区切って指示を明確化（Claudeに特に有効）\n- ネガティブプロンプト：してはいけないことを明示して誤動作を防止', keyword: 'プロンプトエンジニアリング Few-shot Chain-of-Thought', tags: ['System prompt', 'Few-shot', 'Chain-of-Thought'] },
        { name: 'エージェントパターン', desc: 'FMが自律的にタスクを実行するエージェントを組むためのアーキテクチャパターン。\nReActフレームワーク：Reason（推論）→ Act（行動）→ Observe（観察）のループを繰り返してゴールに到達する\nFunction Calling（ツール呼び出し）：FMが外部ツール（天気API・DBクエリ等）をいつ・どのように呼ぶかを決定する能力\nマルチエージェントオーケストレーション：複数のFMエージェントが協調してより複雑なタスクを分担して実行する', keyword: 'AI エージェント ReAct Function Calling Bedrock Agents', tags: ['ReAct', 'Function Calling', 'マルチエージェント'] },
        { name: 'ベクトルDB選択', desc: 'RAGでは、文章をベクトル化して検索するベクトルDBが必要になる。用途や規模に応じて選ぶ。\n主な候補：\n- Amazon OpenSearch Serverless（ベクトルエンジン）：サーバーレスで管理不要。大規模対応\n- Aurora PostgreSQL（pgvector拡張）：既存のRDSとの統合・SQLでベクトル検索が可能\n- Amazon MemoryDB（Redis互換）：低レイテンシのインメモリベクトル検索\n- Pinecone・Weaviate・Qdrant：外部マネージドベクトルDBサービス。高精度・高機能', keyword: 'ベクトルデータベース Vector Database pgvector OpenSearch', tags: ['OpenSearch', 'pgvector', 'MemoryDB'], seeAlso: ['Amazon Bedrock Knowledge Bases', 'RAGパターン'] },
      ],
    },
    {
      title: '責任あるAI・ガバナンス',
      items: [
        { name: '安全とコンテンツポリシー', desc: '生成AIアプリでは、有害な出力・PII・不適切なトピックを防ぐ必要がある。Amazon Bedrock Guardrailsをモデルとアプリに横断して適用する。\nモデル提供者（Anthropic・Meta等）のUsage Policy（利用規約）への遵守が義務付けられる。\nAWS AI Service Cards：各AIサービスの設計意図・評価方法・想定外の使い方を公開して透明性を確保するドキュメント', keyword: 'Bedrock Guardrails コンテンツポリシー AWS AI Service Cards', tags: ['ガードレール', 'Usage Policy', '透明性'] },
        { name: 'データプライバシー', desc: '生成AIの利用では、入力したプロンプトや出力データの扱いに注意し、プライバシーを保護する必要がある。\nBedrockは**デフォルトでユーザーのプロンプト・レスポンスをモデル学習に使用しない**（データはAWSに保持される）。\nVPCエンドポイント：インターネットを経由せずBedrockのAPIにアクセスしてデータをAWS内に留める\nKMS暗号化：知識ベースのデータやモデルカスタマイズ用データを顧客管理キーで暗号化', keyword: 'Amazon Bedrock データプライバシー KMS暗号化', tags: ['データ保護', 'VPCエンドポイント', 'KMS'] },
        { name: 'モニタリングと監査', desc: '生成AIアプリは、CloudTrailなどで利用状況やAPIコールを記録し、監査証跡を残す。\nCloudTrail：**BedrockのすべてのAPIコール（InvokeModel・RetrieveAndGenerate等）を記録して監査証跡を保持**\nCloudWatch メトリクス：\n- InvocationCount：モデル呼び出し回数\n- InvocationLatency：呼び出しから応答までの時間\n- InputTokenCount / OutputTokenCount：トークン使用量\n- ModelInvocationThrottledRequests：スロットリングされたリクエスト数', keyword: 'Bedrock CloudTrail CloudWatch 監視 監査', tags: ['CloudTrail', 'CloudWatch', 'APIログ'] },
      ],
    },
    {
      title: '最適化・運用',
      items: [
        { name: 'コスト最適化', desc: '生成AIアプリの費用は、料金モデルの選択やモデル・トークンの使い方を工夫して抑える。\n**料金モデルの選択**：\n- オンデマンド：APIコールごとに課金。小規模・不定期な利用に適する\n- プロビジョニドスループット：一定スループットを月/6か月/1年コミットで割引購入。大規模・定常的な利用に適する\n- プロンプトキャッシュ（Prompt Caching）：同じプレフィックスのプロンプト部分をキャッシュして再利用するとトークンコストを削減できる機能', keyword: 'Bedrock コスト プロビジョニドスループット Prompt Caching', tags: ['プロビジョニドスループット', 'プロンプトキャッシュ', 'コスト'] },
        { name: 'レイテンシ最適化', desc: '生成AIアプリの応答遅延は、モデル選択・ストリーミング・キャッシュなどで短縮する。\n主な手法：\n- ストリーミングレスポンス：**応答を生成しながらトークン単位で逐次返す**。TTFT（Time to First Token：最初のトークンが届くまでの時間）の体感を改善\n- 適切なモデルサイズの選択：タスクの複雑さに応じて大きなモデルと小さなモデルを使い分け（小モデルの方が速くコストも安い）\n- リージョンの最適化：ユーザーに近いリージョンのBedrockを使用して物理的レイテンシを削減', keyword: 'Bedrock レイテンシ ストリーミングレスポンス TTFT', tags: ['ストリーミング', 'TTFT', 'モデルサイズ'] },
        { name: 'Amazon Q', desc: 'Amazon Qは、**AWSが提供するAIアシスタント製品ファミリー**。\nQ Business：企業の社内ドキュメント（Confluence・Slack・S3等）に接続して自然言語でナレッジを検索・回答するチャットボット\nQ Developer：コード生成・補完・デバッグ・変換・セキュリティスキャンを行うAIコーディングアシスタント（IDE・AWSコンソール統合）\nQ in Amazon QuickSight：BIダッシュボードのNL2SQL（自然言語からSQLを生成して自動でグラフを作成）', tags: ['Q Business', 'Q Developer', 'NL2SQL'] },
      ],
    },
  ],

  AIB: [
    {
      title: 'AI戦略とビジネス価値',
      items: [
        { name: 'ROI・KPI・ベースライン', desc: 'AI投資の価値は、**導入前のベースライン（基準値）を測り**、KPIの変化で示す。\nROI（投資収益率）＝（便益 − コスト）÷ コスト。便益は売上増だけでなく、工数削減・エラー削減・対応時間短縮など運用KPIで測る\nベースライン：施策前の現状値を必ず記録し、導入後との差分で効果を評価する（比較対象がないと価値を主張できない）\n代表KPI例：一次対応解決率・平均処理時間（AHT）・コンバージョン率・離脱率・不良検出率', keyword: 'ROI KPI ベースライン 投資収益率', tags: ['ROI / Return on Investment', 'KPI', 'ベースライン / Baseline'] },
        { name: 'build-buy-partner判断', desc: 'AI機能を「自作（build）／購入（buy）／協業（partner）」のどれで実現するかを、差別化度合いとコスト・スピードで判断する。\n主な選択肢：\n- build（自作）：競争優位の核になる独自機能。コスト・時間・人材が必要\n- buy（購入）：汎用機能はSaaSやマネージドサービスで即時調達（例 Amazon Q・Bedrock）。**AWS Marketplaceでモデル・SaaSを評価調達**\n- partner（協業）：専門ベンダーやコンサルと組んで不足を補う\n判断軸：差別化への寄与・Time to Value（価値創出までの時間）・総所有コスト（TCO）・内製スキルの有無', keyword: 'build buy partner 内製 購入 協業', tags: ['build-buy-partner', 'AWS Marketplace', 'TCO'] },
        { name: 'AI料金モデルとコスト最適化', desc: 'AIサービスの課金は主に3方式。ワークロード特性に合わせて選ぶとコスト最適化できる。\n3つの方式：\n- 消費ベース（トークン/リクエスト単位）：Bedrock等の生成AI。試作・変動負荷向き\n- インスタンスベース（時間単位）：SageMaker等の常時稼働・大量推論向き。Savings Plans（一定利用量をコミットして割引を受けるプラン）で割引\n- シートベース（ユーザー単位）：Amazon Q Business等のSaaS型\nコスト可視化・見積り：AWS Pricing Calculator（事前見積り）・**Cost Explorerによる実績分析を実施**', keyword: '料金モデル 消費 インスタンス シート Savings Plans', tags: ['消費ベース / Consumption', 'Savings Plans', 'Pricing Calculator'] },
      ],
    },
    {
      title: 'ビジネス視点のAWS AIサービス',
      items: [
        { name: 'Amazon Bedrock（ビジネス観点）', desc: 'Amazon Bedrockは、**複数の基盤モデル（FM）を単一APIで利用できる**フルマネージドの生成AI基盤。インフラ運用不要で素早く生成AIを事業に組み込める。\nビジネス価値：Time to Value短縮（サーバ管理不要）・モデル選択の柔軟性（用途別に最適モデル）・従量課金で初期投資を抑制\nガバナンス：Guardrailsで有害出力やPII漏えいを抑止、Knowledge Basesで自社データに基づく回答（RAG）', keyword: 'Amazon Bedrock 基盤モデル 生成AI', tags: ['基盤モデル / Foundation Model', 'Guardrails', 'RAG'] },
        { name: 'Amazon Q（ビジネス観点）', desc: 'Amazon Qは、業務にすぐ使えるAIアシスタント製品ファミリー。**シートベースで導入しやすい**。\nQ Business：社内ドキュメントに接続し自然言語で検索・回答（ナレッジ活用・問い合わせ削減）\nQ Developer：コード生成・補完で開発生産性を向上\nビジネス価値：現場の生産性向上を「買って」実現できる代表例（build不要のbuy選択肢）', keyword: 'Amazon Q Q Business アシスタント', tags: ['Q Business', 'シートベース', '生産性向上'] },
        { name: 'SageMaker AI（ビジネス観点）', desc: 'Amazon SageMaker AIは、独自のMLモデルを**構築・学習・運用するためのプラットフォーム**。\n使いどころの判断：汎用の生成AIやマネージドAIで足りるなら Bedrock/Q（buy）、自社データで差別化する予測モデルが必要なら SageMaker（build）\nビジネス観点：カスタムMLは効果が大きい反面、データ・人材・運用コストが必要。ユースケースの差別化価値で投資判断する', keyword: 'SageMaker カスタムML 予測モデル', tags: ['カスタムML', 'build判断', '予測モデル'] },
      ],
    },
    {
      title: 'ガバナンスと責任あるAI',
      items: [
        { name: '責任あるAIの原則', desc: '責任あるAIは、事業リスクを抑えつつ信頼を得るための原則群。ビジネス判断でトレードオフを扱う。\n主な原則：公平性（バイアス回避）・透明性/説明可能性（判断根拠を示せる）・プライバシー/セキュリティ・堅牢性・ガバナンス/説明責任\n実務：**Amazon Bedrock Guardrailsで有害出力・PIIを制御**、**Well-Architected 責任あるAIレンズでベストプラクティスを点検**\nトレードオフ例：精度 vs 説明可能性、スピード vs 安全性を、事業影響とリスク許容度で判断する', keyword: '責任あるAI 公平性 透明性 説明可能性 バイアス', tags: ['公平性 / Fairness', '説明可能性 / Explainability', '責任あるAIレンズ'] },
        { name: 'AIリスクと規制コンプライアンス', desc: 'エンタープライズAIのリスクを特定し、緩和策を指示するのがビジネスリーダーの役割。\n代表リスク：ハルシネーション（誤情報）・データ漏えい・著作権/知財・バイアスによる差別・規制違反\n緩和：人間の関与（Human in the Loop）・出力の検証・データ最小化・監査ログ\nコンプライアンス：GDPR等の規制、業界基準、社内ポリシーへの適合。**共有責任モデル（クラウドの責任分界）を前提にガバナンスを設計**', keyword: 'AIリスク ハルシネーション コンプライアンス 共有責任モデル', tags: ['ハルシネーション対策', '共有責任モデル', 'コンプライアンス'] },
      ],
    },
    {
      title: '組織のAI変革',
      items: [
        { name: 'AI成熟度評価とCAF', desc: 'AI導入は、組織の準備状況（人・プロセス・技術・ガバナンス）を評価してから進める。\n**AWS Cloud Adoption Framework（CAF）**：ビジネス・人材・ガバナンス・プラットフォーム・セキュリティ・運用の観点で、AI/クラウド導入の計画とスケールを支援するフレームワーク\n成熟度評価：現状のケイパビリティを可視化し、ギャップを埋めるロードマップを描く\nデータ/インフラ基盤：AI活用にはデータの質・アクセス性・基盤整備が前提条件', keyword: 'CAF Cloud Adoption Framework 成熟度 AI変革', tags: ['CAF', 'AI成熟度', 'データ基盤'], seeAlso: ['AWS CAF（Cloud Adoption Framework）'] },
        { name: 'チェンジマネジメントとスケール', desc: 'AIを全社に定着させるには、技術だけでなく人と組織の変革が必要。\nチェンジマネジメント：経営の後押し・現場の巻き込み・AIリテラシー教育・スキル育成で抵抗を減らす\nスケール戦略：**小さくパイロットで検証** → 効果を測定 → 反復改善しながら全社展開（一気に広げない）\n人材育成：AI-ready な組織へ、役割別のリスキリングと責任あるAI教育を進める', keyword: 'チェンジマネジメント パイロット スケール 人材育成', tags: ['パイロット / Pilot', 'チェンジマネジメント', 'スケール'] },
      ],
    },
  ],

  ANS: [
    {
      title: 'VPC詳細',
      items: [
        { name: 'Amazon VPC設計', desc: 'VPCは、IPアドレス範囲（CIDR）・サブネット・ルーティングを設計して構築する。CIDRブロックの設計が基本。\nプライベートアドレス空間：10.0.0.0/8・172.16.0.0/12・192.168.0.0/16 の3範囲\nサブネット分割：VPCの/16 CIDR → AZごとに/24サブネット等に分割してパブリック/プライベートに分ける\nセカンダリCIDR：VPCに後からCIDRを追加して既存サブネットと合わせて使用できる\nIPv6（Internet Protocol version 6）：VPCに/56を割り当て、サブネットに/64を割り当てるデュアルスタック構成', keyword: 'VPC CIDR サブネット設計 IPv6', tags: ['CIDR設計', 'IPv6', 'セカンダリCIDR'] },
        { name: 'セキュリティグループ vs NACL', desc: 'VPCのトラフィック制御には、インスタンスに付くセキュリティグループと、サブネットに付くNACLの2種類があり、適用範囲とステート保持が異なる。\nSG（セキュリティグループ）：ENI（インスタンス）に適用\n- ステートフル：**戻りパケットは自動許可**（行きを許可すれば戻りは自動）\n- 全ルールを評価してから許可/拒否を決定\nNACL（ネットワークアクセスコントロールリスト）：サブネット境界に適用\n- ステートレス：行き・戻りを両方とも明示的に許可が必要\n- 番号の小さいルールから順に評価し最初にマッチを適用', keyword: 'セキュリティグループ NACL ステートフル ステートレス 違い', tags: ['ステートフル', 'ステートレス', '評価順序'] },
        { name: 'Amazon VPCフローログ', desc: 'Amazon VPCフローログは、VPC内のENI（ネットワークインターフェース）を通過するIPトラフィックを**記録するログ機能**。\n取得レベル：ENI単位・サブネット単位・VPC単位\n送信先：CloudWatch Logs または S3\nカスタムフォーマット：送信元IP・宛先IP・ポート・プロトコル・許可/拒否等に加えて追加フィールド（pkt-src-aws-service等）を選択できる\nネットワークトラブルシューティング・セキュリティ分析に活用', tags: ['フローログ', 'カスタムフォーマット', 'トラブルシュート'] },
        { name: 'Amazon VPCトラフィックミラーリング', desc: 'Amazon VPCトラフィックミラーリングは、ENIのインバウンド/アウトバウンドトラフィックを**コピーして別のENI（モニタリングアプライアンス）に転送する機能**。\nDPI（Deep Packet Inspection）：パケットの内容まで詳しく検査してセキュリティ分析や侵入検知に活用できる。\nミラーフィルター：特定のプロトコル・ポート・方向のみミラーリングするようフィルタを設定できる', tags: ['ミラーリング', 'DPI', 'ネットワーク分析'] },
      ],
    },
    {
      title: '接続・ルーティング',
      items: [
        { name: 'AWS Transit Gateway（ANS観点）', desc: 'Transit Gatewayは複数の機能でネットワークをハブ集約する。\n主な機能：\n- TGWルートテーブル：アタッチメント（VPC/VPN/DC）ごとに**ルーティングを制御**。同一ルートテーブルに関連付けないと通信不可\n- 分離ルーティング：本番VPCと開発VPCを別ルートテーブルに入れて相互通信を禁止する設計\n- TGWピアリング：別リージョンのTGWとピアリングしてマルチリージョン接続\nVPN/Direct Connectアタッチメントも統合して中央集権的なハブを実現', tags: ['TGWルートテーブル', 'リージョン間', 'アタッチメント'] },
        { name: 'AWS Direct Connect（ANS詳細）', desc: 'Direct Connectは帯域や契約形態に応じて接続の種類を選べる。\n**Direct Connect接続の種類**：\n- ホスト型：Direct Connectパートナー経由。1/10Gbps等の共有帯域\n- 専用型：AWSのDirect Connect施設に直接接続。1/10/100Gbpsの専用回線\nVIF（Virtual Interface：仮想インターフェース）の種別：\n- プライベートVIF：VPCのプライベートリソースへ接続（VGWまたはTGWに接続）\n- パブリックVIF：S3・DynamoDB等のAWSパブリックエンドポイントへ接続\n- トランジットVIF：Transit Gateway経由で複数VPCへ接続', tags: ['ホスト型', '専用型', 'VIF'] },
        { name: 'AWS Direct Connect 冗長化', desc: 'Direct Connectは複数接続やVPN併用で冗長化して可用性を高められる。\n冗長化：**DC複数やDC+VPNで可用性を高める構成**\nDirect Connectの冗長性レベル（AWS推奨）：\n- 最大冗長性：2つのDirect Connectロケーション × 2接続 = 4接続。シングルポイント障害なしの最高冗長\n- 高冗長性：2つのロケーション × 1接続 = 2接続。ロケーション障害に耐性あり\n- 開発/テスト用：1接続のみ。冗長性なし。本番では非推奨', tags: ['最大冗長性', '高冗長性', 'HA'] },
        { name: 'AWS Site-to-Site VPN', desc: 'AWS Site-to-Site VPNは、オンプレとAWS VPCを**インターネット経由のIPsec暗号化トンネルで接続するサービス**。\nCGW（カスタマーゲートウェイ）：オンプレ側のVPN機器を定義するAWSリソース\nVGW（仮想プライベートゲートウェイ）：VPCにアタッチするAWS側のVPNエンドポイント\nBGP動的ルーティング：ルートを自動的に交換・フェイルオーバー\n加速VPN（Accelerated VPN）：AWS Global Acceleratorでバックボーン経由の高速接続', tags: ['CGW', 'VGW', '加速VPN'], seeAlso: ['AWS Global Accelerator'] },
        { name: 'AWS Client VPN', desc: 'AWS Client VPNは、リモートワーカーのPCから**AWS VPCへのOpenVPNプロトコルによるVPN接続サービス**。\n認証方式：\n- 相互TLS認証：クライアント証明書とACM証明書で認証\n- Active Directory認証：AWS Managed Microsoft ADと連携\n- SAML（IdP）認証：OktaやAzure ADなどのSAML 2.0準拠IdPと連携\n- スプリットトンネリング：VPC宛のトラフィックのみVPN経由にしてインターネットトラフィックは直接送信（帯域節約）', tags: ['相互TLS', 'AD認証', 'スプリットトンネル'] },
      ],
    },
    {
      title: 'DNS・コンテンツ配信',
      items: [
        { name: 'Amazon Route 53詳細', desc: 'Amazon Route 53詳細は、Route 53の7種類のルーティングポリシーを**状況に応じて使い分ける観点**（詳細はSAAの Amazon Route 53 ルーティング参照）。\nDNSSEC（DNS Security Extensions）：DNS応答にデジタル署名を付加してDNSキャッシュポイズニング攻撃を防止する仕組み\nResolver DNS Firewall：悪意のあるドメイン（C2サーバー・マルウェア配布元）へのDNS解決をブロックする機能', tags: ['DNSSEC', 'Resolver', 'DNS Firewall'] },
        { name: 'Amazon Route 53 Resolver（ハイブリッドDNS）', desc: 'Amazon Route 53 Resolverは、オンプレとAWS間のDNS名前解決を**統合するサービス**。\nインバウンドエンドポイント（Inbound Endpoint）：オンプレのDNSサーバーからAWS（VPC）のDNSを解決できるようにする\n→ オンプレのサーバーがec2.internal等のAWSのホスト名を解決したい場合\nアウトバウンドエンドポイント（Outbound Endpoint）：VPC内からオンプレのプライベートDNS（example.internal等）を解決できるようにする\n→ AWS上のアプリがオンプレのDBサーバー名を解決したい場合', tags: ['インバウンド / Inbound', 'アウトバウンド / Outbound', 'ハイブリッドDNS'] },
        { name: 'Amazon CloudFront詳細（ANS）', desc: 'CloudFrontは複数の構成要素で配信を制御する。\n主な構成要素：\n- Origins：S3・ALB・EC2・カスタムHTTPサーバー を**配信元として設定**\n- ビヘイビア：URLパスパターン（/api/*・/images/*等）ごとにオリジン・キャッシュ・関数を個別設定\n- OAC（Origin Access Control）：S3バケットをCloudFront経由アクセス専用に制限する仕組み\n- Lambda@Edge：CloudFrontの4つのイベント（Viewer Request/Response・Origin Request/Response）でLambdaを実行\n- Field-Level暗号化：機密フィールド（クレカ番号等）をエッジで非対称暗号化してバックエンドまで保護', tags: ['OAC', 'Lambda@Edge', 'Field-Level暗号化'] },
        { name: 'AWS Global Accelerator', desc: 'Anycast IP（複数拠点が同一IPを持つ技術）で**ユーザーを自動的に最寄りのAWSエッジポイントに誘導し**、AWSバックボーン経由でエンドポイントに転送。\nエンドポイントグループ：リージョンごとにリソース（ALB・EC2等）をグループ化\nトラフィックダイヤル：グループへのトラフィック割合を0〜100%で調整（Blue/Greenデプロイに活用）', tags: ['Anycast', 'エンドポイントグループ', 'トラフィックダイヤル'] },
      ],
    },
    {
      title: 'セキュリティ・監視',
      items: [
        { name: 'AWS Network Firewall（ANS）', desc: 'AWS Network Firewall（ANS）は、VPCに**集中型ファイアウォールサブネットを作成してデプロイするマネージドIPS/IDS**（侵入防止/検知システム）。\nSuricata互換エンジン：オープンソースのSuricataルール形式でL7アプリケーション層のトラフィックを詳細検査\nステートフルルール：接続状態を追跡しながら深い検査\nステートレスルール：パケット単位の高速フィルタリング\n集中型アーキテクチャ：TGW経由で全VPCのトラフィックを集中ファイアウォールに通す設計が推奨', tags: ['Suricata', 'L7フィルタ', '集中型'] },
        { name: 'AWS WAF（ANS観点）', desc: 'AWS WAF（ANS観点）は、ロードバランサーやCloudFrontに関連付けてWebアプリのL7（アプリ層）攻撃を**防御するWAFの観点**。\nAWS管理ルールグループ：IPレピュテーションリスト（既知の悪意IPをブロック）/ Amazonマネージドルール（OWASP：Webアプリのセキュリティ基準団体が定めるトップ10攻撃）\nBot Control：ボットのスクレイピング・スキャン・ログイン試行を検出・ブロック\nCAPTCHA：疑わしいリクエストに対してチャレンジを要求\nジオブロッキング：特定の国・地域からのアクセスをブロック', tags: ['管理ルールグループ', 'Bot Control', 'CAPTCHA'] },
        { name: 'AWS Shield Advanced', desc: 'AWS Shield Advancedは、有料のDDoS高度保護サービス。**L3（IP層）〜L7（アプリ層）のDDoS攻撃を包括的に保護する**。\nSRT（Shield Response Team）：AWSのDDoS専門チームへ24時間365日アクセスして攻撃への対応サポートを受けられる\nヘルスベースDDoS検出：CloudWatchのヘルスチェックと連動して正常時のベースラインから検出\nコスト保護：DDoS攻撃起因のEC2・CloudFront・Route 53等のスパイクコストを保護', tags: ['SRT', 'L3-L7保護', 'コスト保護'] },
        { name: 'AWS Firewall Manager', desc: 'AWS Firewall Managerは、Organizations全体にWAF・Shield・セキュリティグループ等のポリシーを**一元管理・強制適用するサービス**。\n管理対象：WAF・Shield Advanced・Network Firewall・セキュリティグループ・Route 53 Resolver DNS Firewall\n新しいリソースが作成された際に自動的にポリシーを適用する「自動適用」機能が重要', tags: ['一元管理', '自動適用', 'Organizations'] },
        { name: 'Amazon VPCフローログ分析', desc: 'VPCフローログは、AthenaやCloudWatchなどの分析ツールと組み合わせてトラフィックを可視化できる。\nAthena：S3に保存したフローログをSQLでアドホッククエリ（特定IPへの通信量を集計等）\nCloudWatch Logs Insights：リアルタイムに近い分析。メトリクスフィルターでアラームにも使用可能\nAmazon OpenSearch：Kibanaダッシュボードでリアルタイム可視化・異常検知', tags: ['Athena', 'Logs Insights', 'OpenSearch'] },
      ],
    },
  ],

  SCS: [
    {
      title: '脅威検出・インシデント対応',
      items: [
        { name: 'Amazon GuardDuty', desc: 'Amazon GuardDutyは、複数のデータソースを機械学習と脅威インテリジェンスフィードで分析して脅威を自動検出するサービス。\n脅威検出：複数ログを機械学習で分析し**脅威を自動検出**\n分析対象：CloudTrail（APIコール）・VPCフローログ（ネットワーク）・DNSログ・S3データイベント・EKS監査ログ\n検出例：EC2のポートスキャン・クレデンシャルの外部漏洩・S3への不正アクセス・マイニングマルウェア\nEventBridge → Lambda で自動隔離・SNS通知のパターンが頻出', tags: ['脅威検出', '機械学習', '自動修復'], seeAlso: ['Amazon Inspector', 'AWS Security Hub', 'Amazon Detective'] },
        { name: 'Amazon Macie', desc: 'Amazon Macieは、S3バケット内の機密データを機械学習で自動検出・分類するデータセキュリティサービス。\n機密データ検出：**S3のPIIを機械学習で自動分類**\n検出対象：PII（Personally Identifiable Information：個人識別情報）・認証情報・金融データ・医療情報\nバケットの公開設定ミス（パブリックアクセスが開いているバケット）も検出して通知\nGDPR・HIPAAなどのコンプライアンス対応に活用される', tags: ['PII検出', 'S3スキャン', 'データ分類'] },
        { name: 'Amazon Detective', desc: 'Amazon Detectiveは、ログからグラフを自動構築し、**セキュリティインシデントの根本原因を可視化して調査する**サービス。\n「このEC2インスタンスへの不審な接続はどこから来ているか？」「このIAMユーザーはどのリソースにアクセスしたか？」という調査クエリに素早く回答できる。', tags: ['グラフ分析', 'インシデント調査', '可視化'], seeAlso: ['Amazon GuardDuty'] },
        { name: 'AWS Incident Manager', desc: 'AWS Systems Managerの機能で**インシデントを体系的に管理する**サービス。\nフロー：インシデント検出（CloudWatchアラーム等） → 対応計画（Response Plan）の自動起動 → Runbook（対応手順）の実行 → エスカレーション（担当者通知） → PIR（Post-Incident Review：事後分析）\nRunbook：Systems Manager Automationドキュメントで対応手順を自動実行', tags: ['対応計画', 'Runbook', 'PIR'] },
        { name: 'Amazon Security Lake', desc: 'Amazon Security Lakeは、**AWSと外部のセキュリティデータを一元的に収集・正規化**してS3データレイクに格納するサービス。\nOCSF（Open Cybersecurity Schema Framework）：セキュリティデータの共通スキーマ規格。異なるソースのデータを統一フォーマットに変換することで横断的な分析が可能\n収集元：CloudTrail・VPCフローログ・GuardDuty・Security Hub・Route 53・外部SIEMツール', tags: ['OCSF', 'データ集約', 'セキュリティログ'] },
      ],
    },
    {
      title: 'セキュリティ監視・ログ',
      items: [
        { name: 'AWS Security Hub', desc: 'GuardDuty・Inspector・Macie・Firewall Manager等の検出結果をASFF（Amazon Security Finding Format：**セキュリティ検出結果の標準形式**）で集約・優先順位付けするサービス。\nコンプライアンス基準への自動チェック：\n- CIS（Center for Internet Security） AWS Foundations Benchmark：AWSのセキュリティ設定ベースライン\n- PCI（Payment Card Industry） DSS：クレジットカード業界のデータセキュリティ基準\n- NIST（米国国立標準技術研究所） 800-53：米国政府のセキュリティフレームワーク', tags: ['ASFF', 'CIS', 'PCI DSS準拠'], seeAlso: ['Amazon GuardDuty', 'Amazon Inspector', 'AWS Audit Manager'] },
        { name: 'AWS CloudTrail（SCS観点）', desc: 'AWS CloudTrail（SCS観点）は、全APIコールを記録するCloudTrailを**セキュリティ監査の中核として使う**観点。証跡の保護・整合性検証が要点。\nイベントの種類：\n- 管理イベント：リソースの作成・削除・IAM変更等（デフォルト有効）\n- データイベント：S3オブジェクト操作・Lambda実行等（明示的に有効化が必要）\n- Insightsイベント：異常なAPI呼び出しパターンを自動検出\nS3証跡保護：証跡をS3に保存する場合に有効化することが重要：\n- MFAによる削除防止\n- KMS暗号化\n- ログファイル整合性検証（改ざん検出）', tags: ['管理イベント', 'データイベント', '整合性検証'] },
        { name: 'Amazon Inspector', desc: 'Amazon Inspectorは、脆弱性（セキュリティの弱点）を**継続的にスキャンして優先順位付けするサービス**。\nスキャン対象：\n- EC2インスタンス：エージェント不要でSSMエージェント経由。OSの既知脆弱性を検出\n- ECRコンテナイメージ：プッシュ時に自動スキャン\n- Lambda関数：コードと依存パッケージの脆弱性をスキャン\n- CVE（Common Vulnerabilities and Exposures）：既知の脆弱性のIDデータベースと照合してリスクスコア（CVSS）で優先順位付け', tags: ['脆弱性スキャン', 'CVE', 'コンテナ'], seeAlso: ['Amazon GuardDuty', 'AWS Security Hub'] },
        { name: 'AWS Config（SCS観点）', desc: 'AWS Config（SCS観点）は、**リソース設定変更の継続的記録とコンプライアンス評価**を、セキュリティ統制の観点で使う。\nルール評価：マネージドルール（AWS事前定義）またはカスタムルール（Lambda）でリソースの準拠状況を常時評価\nコンフォーマンスパック：複数のConfigルールをまとめて一括適用。CIS・PCIに対応したパックが利用可能\n自動修復：ルール違反検出時にSSM Automationを起動してリソースを自動修正', tags: ['設定記録', 'ルール評価', '自動修復'] },
      ],
    },
    {
      title: 'インフラセキュリティ',
      items: [
        { name: 'AWS WAF（SCS観点）', desc: 'AWS WAF（SCS観点）は、SQLi（SQLインジェクション）/ XSS（クロスサイトスクリプティング）等のL7攻撃を**ブロックする**WAFをセキュリティ運用の観点で扱う。\nIPレピュテーションリスト：既知の悪意あるIPからのリクエストをブロック\nレートベースルール：一定時間内に同一IPから閾値を超えたリクエストをブロック（DDoS軽減）\nAWSマネージドルールグループ：AWSが管理する事前定義ルールの集合\nスコープダウンステートメント：ルールが評価される対象を特定条件に絞り込んでパフォーマンスとコストを最適化', tags: ['SQLi/XSS', 'レートベース', 'スコープダウン'] },
        { name: 'AWS Shield Advanced（SCS）', desc: 'AWS Shield Advanced（SCS）は、L3（IP）〜L7（アプリ）のDDoS攻撃を**包括的に保護する**有料サービス（SCS観点）。\nSRT（Shield Response Team）：AWSのDDoS専門エンジニアチームに24時間アクセスして攻撃対応サポートを受けられる\nプロアクティブエンゲージメント：SRTがヘルスチェック異常を検知したら自動的に顧客に連絡してサポートを開始する設定\nコスト保護：DDoS攻撃によるEC2・CloudFront等のスケールアウトコストをAWSが補填', tags: ['SRT', 'プロアクティブ', 'コスト保護'] },
        { name: 'AWS Network Firewall + AWS Firewall Manager', desc: 'Network Firewallでトラフィックを検査し、Firewall Managerで組織全体にポリシーを強制する。この2つで多層防御を実現する。\nNetwork Firewall：VPCに集中型ファイアウォールをデプロイ。Suricata互換エンジンでL7まで詳細検査\nFirewall Manager：AWS Organizations全体にNetwork Firewallポリシーを一元配布して強制適用\n→ セキュリティポリシーを組織全体で均一に適用でき、新規リソースにも自動適用される', tags: ['多層防御', 'Suricata', '一元配布'], seeAlso: ['AWS Network Firewall', 'AWS Firewall Manager'] },
        { name: 'AWS ACM Private CA（プライベート認証局）', desc: 'AWS ACM Private CAは、プライベートPKI（Public Key Infrastructure：公開鍵基盤）を構築して内部サービス・デバイス向けの**TLS証明書を発行する**サービス。\nインターネット向けの公開証明書ではなく、社内マイクロサービス間・VPN・IoTデバイス等の内部TLS通信に使用する。ACMと統合して証明書の自動更新を管理できる。', tags: ['プライベートCA', 'PKI', 'TLS'] },
      ],
    },
    {
      title: 'IAM・アイデンティティ',
      items: [
        { name: 'AWS IAM高度な管理', desc: 'Permissions Boundary・ABAC・信頼ポリシーなど、IAMには権限を精密に制御する高度な機能がある。\nPermissions Boundary（アクセス許可の境界）：**IAMエンティティが持てる権限の最大上限を設定する**ポリシー。IAM許可とのAND評価\nセッションポリシー：AssumeRoleで取得した一時認証情報のセッションにさらに制限を加えるポリシー\nSCP（サービスコントロールポリシー）：Organizations OU/アカウントへの最大権限制限（ガードレール）\nRCP（リソースコントロールポリシー）：S3・KMS等のリソース側への横断的アクセス制限。SCP と組み合わせて使用\n優先順位：明示的Deny > SCP > RCP > Permissions Boundary > IAMポリシー', keyword: 'IAM Permissions Boundary SCP RCP セッションポリシー', tags: ['Permission Boundary', 'SCP', 'RCP'] },
        { name: 'AWS IAM Identity Center', desc: 'AWS IAM Identity Center（SSO）は、複数のAWSアカウントとSaaSアプリへのシングルサインオン（SSO）を**一元管理する**サービス。\n外部IdP連携：Okta / Azure AD等のSAML 2.0準拠のIdP（アイデンティティプロバイダー）とフェデレーション\n権限セット（Permission Set）：アカウントごとに付与するIAMポリシーの集合を定義して一元管理\nSCIM（System for Cross-domain Identity Management）プロトコルでユーザー/グループを外部ディレクトリから自動プロビジョニング', tags: ['SSO', 'SAML', '権限セット'] },
        { name: 'Amazon Cognito詳細（SCS）', desc: 'Cognitoは認証のUser Poolと認可のIdentity Poolで構成する。\n認証基盤：**User Pool（認証）とIdentity Pool（認可）**\nUser Pool：\n- OpenID Connect（OIDC）準拠のIDプロバイダー\n- JWT（JSON Web Token）形式のIDトークン・アクセストークンを発行\n- MFA（多要素認証）・高度なセキュリティ機能（不審なサインインを検知・ブロック）\nIdentity Pool：\n- フェデレーションされた認証情報（User Pool JWT・Google・Facebook等）をもとにSTS（Security Token Service）から一時的なAWS認証情報を払い出す\n- ロールマッピングで認証済み/未認証ユーザーに異なるIAMロールを割り当て', tags: ['OIDC', 'JWT', '高度なセキュリティ'] },
        { name: 'AWS Organizations SCP/RCP', desc: 'Organizationsでアカウントに課すガードレール。SCPは使える権限の上限を、RCPはリソース側の上限を設定する。\nSCP（サービスコントロールポリシー）：アカウント/OUが持てる**最大権限の上限を設定**\n→ IAMの許可とのAND評価。SCPが許可していないとIAMで許可しても実行できない\nRCP（リソースコントロールポリシー）：S3・KMS・SQS等のリソース側にOrganizations横断で制限を適用\n→ 「このS3バケットにはOrganization外からのアクセスを禁止」といった制御が可能\n2つのアプローチ：\n- Denyリスト方式：全てを許可してから禁止事項を明示（デフォルト）\n- 許可リスト方式：全てを禁止してから許可事項を明示（より厳格）', keyword: 'AWS Organizations SCP RCP サービスコントロールポリシー', tags: ['SCP', 'RCP', 'Denyリスト'] },
      ],
    },
    {
      title: 'データ保護',
      items: [
        { name: 'AWS KMS詳細', desc: 'KMSは複数の機能で暗号化とキー管理を担う。\n主な機能：\n- キーポリシー（リソースベースポリシー）：**KMSキーへのアクセスを定義**。IAMポリシーとのAND評価\n- マルチリージョンキー：同一のキーIDを複数リージョンでレプリケーション。リージョン間で暗号化したデータを別リージョンで復号可能\n- XKS（External Key Store）：AWS外部のHSM（ハードウェアセキュリティモジュール）でキーを管理して規制要件を満たす\n- エンベロープ暗号化：DEK（Data Encryption Key）でデータを暗号化し、DEK自体をCMK（カスタマーマネージドキー／KMSキー）で暗号化する2層構造', keyword: 'AWS KMS キーポリシー マルチリージョンキー エンベロープ暗号化', tags: ['キーポリシー', 'マルチリージョンキー', 'XKS'] },
        { name: 'AWS Secrets Manager', desc: 'DBパスワード・APIキー・OAuthトークン等のシークレットを**安全に保管・管理する**サービス。\n自動ローテーション：Lambda関数でRDS・Redshift・DocumentDB等のパスワードを定期的に自動更新（組み込みサポートあり）\nクロスアカウント共有：リソースベースポリシーで別アカウントからのアクセスを許可\nVPCエンドポイント経由：インターネットを経由せずシークレットにアクセスして安全性を高める', tags: ['自動ローテーション', 'クロスアカウント', 'VPCエンドポイント'] },
        { name: 'Amazon S3データ保護', desc: 'S3は複数の機能を組み合わせてデータを保護する。\n主な保護機能：\n- バケットポリシー：**JSON形式でバケット・オブジェクトへのアクセスを細かく制御**\n- ACL無効化：推奨設定。バケットポリシーのみで一元管理するシンプルな構成\n- S3ブロックパブリックアクセス：設定ミスによる意図しない公開を防ぐ4つのブロック設定\n- Object Lock（WORM：Write Once Read Many）：一度書いたオブジェクトを一定期間変更・削除できないように保護。コンプライアンス要件に使用\nサーバーサイド暗号化：\n- SSE-S3：AWSがキーを管理する最もシンプルな暗号化\n- SSE-KMS：KMSキーを使用。アクセスログとキーポリシーで細かい制御が可能\n- SSE-C：顧客がキーを管理してAWS側には渡さない（最高の機密性）', keyword: 'S3 Object Lock WORM SSE-KMS バケットポリシー', tags: ['Object Lock', 'WORM', 'SSE-KMS'] },
        { name: 'AWS Audit Manager', desc: 'AWS Audit Managerは、AWSの利用状況から**証拠を自動収集**して、コンプライアンスフレームワークへの準拠状況をレポート化するサービス。\n対応フレームワーク：PCI DSS・HIPAA・GDPR・ISO 27001・NIST 等\n証拠収集：Config・CloudTrail・Security Hub・IAM等からデータを自動取得してフレームワーク要件にマッピング\n監査担当者に証拠レポートを提出するまでのプロセスを簡素化する', tags: ['コンプライアンス', 'PCI DSS', '証拠収集'] },
      ],
    },
  ],

  // ── オリジナル基礎演習（非AWS・前提知識カード）────────────────
  ML: [
    {
      title: 'AI・MLの基礎',
      items: [
        { name: '機械学習の種類', desc: '機械学習は、学習の仕方で3つに大別される。正解ラベルで学ぶ教師あり学習、ラベルなしで構造を見つける教師なし学習、報酬を頼りに試行錯誤する強化学習がある。\n教師あり学習（Supervised Learning）：**正解ラベル付きデータで学習**\n- 分類：カテゴリを予測（二項分類=2クラス・多クラス分類）\n- 回帰：数値（連続値）を予測\n教師なし学習（Unsupervised Learning）：ラベルなしデータからパターンを発見\n- クラスタリング（グループ化）・次元削減 が代表\n強化学習（Reinforcement Learning）：報酬を最大化する行動を試行錯誤で学習。ゲームAI・ロボット制御に使用', keyword: '機械学習 教師あり学習 教師なし学習 強化学習 二項分類 決定木', tags: ['教師あり', '教師なし', '強化学習'] },
        { name: 'モデル評価指標', desc: '学習したモデルの性能は、数値の指標で評価する。回帰では誤差の大きさ、分類では正解率などを用い、タスクによって使う指標が異なる。\n分類の主な指標：\n- Accuracy（精度）：全予測中の正解率。**クラス不均衡時は注意**\n- Precision（適合率）：「陽性」と予測した中で実際に陽性の割合（偽陽性を減らしたい時に重視）\n- Recall（再現率）：実際の陽性のうち正しく検出できた割合（見逃しを減らしたい時に重視）\n- F1スコア：PrecisionとRecallの調和平均\n- AUC-ROC：閾値変化に対するモデルの識別能力を示す（1に近いほど優秀）\n回帰の主な指標：\n- MAE（平均絶対誤差）：予測と実測の絶対誤差の平均。外れ値に頑健\n- MSE（平均二乗誤差）/ RMSE：誤差を二乗して平均（RMSEは平方根で元の単位に戻す）。大きな誤差を強く罰する\n- R²（決定係数）：目的変数の分散をどれだけ説明できるか（1に近いほど良い）', keyword: 'F1スコア Precision Recall AUC-ROC 機械学習評価指標', tags: ['Accuracy', 'F1スコア', 'AUC-ROC'], seeAlso: ['分類モデルの評価'] },
        { name: '過学習と正則化', desc: 'モデルが訓練データに過剰適合すると、未知データで精度が落ちる過学習という問題が起きる。それを抑えるために、正則化という手法を用いる。\n過学習（Overfitting）：**訓練データに過剰適合**し、未知データで性能が落ちる問題。\n対策手法：\n- L1正則化（Lasso）：不要な特徴量の重みをゼロにして特徴量選択の効果\n- L2正則化（Ridge）：重みを小さく抑えてモデルを単純化\n- ドロップアウト：ニューラルネットのニューロンをランダムに無効化して汎化性能を向上\n- データ拡張：学習データを水増しして多様性を高める', keyword: '過学習 Overfitting L1正則化 L2正則化', tags: ['過学習', 'L1/L2正則化', 'ドロップアウト'] },
        { name: 'MLのライフサイクル', desc: '機械学習プロジェクトは、データ収集→前処理→学習→評価→デプロイ→監視という一連の工程を繰り返して進める。\n工程：\n① データ収集：ソースから学習データを取り込む\n② データ前処理：クリーニング・正規化・欠損値処理\n③ 特徴量エンジニアリング：モデルの入力に適した形へ変換\n④ モデル学習：アルゴリズムを選びパラメータを調整\n⑤ 評価：テストデータで指標を計測\n⑥ デプロイ：本番環境へ公開\n⑦ 監視：**性能劣化を検出し再学習**（→②へ戻り反復改善）', keyword: 'MLOps 機械学習ライフサイクル', tags: ['MLOps', 'ライフサイクル', 'パイプライン'] },
        { name: '転移学習の仕組み', desc: '転移学習は、**事前学習済みモデルを別タスクに流用して少ないデータで高精度を得る**手法。次の2段階で行う。\n2段階：\n① 事前学習（Pre-training）：大規模データで汎用的な基盤モデルを作る（前段）\n② ファインチューニング（Fine-tuning）：その基盤モデルを特定タスクのデータで追加学習して適応（＝転移学習の代表的な実現方法。FTはTLの一手法で並列ではない）', keyword: '転移学習 Transfer Learning ファインチューニング 事前学習', tags: ['転移学習', 'ファインチューニング', '事前学習'] },
        { name: '生成AIの評価指標', desc: '生成AIの出力品質は、BLEUやROUGEといった指標や、人手評価で測る。\n評価指標：\n- BLEU（Bilingual Evaluation Understudy）：機械翻訳の品質評価。参照訳とのn-gram（隣接するn個の単語・文字の並び）一致率で測定\n- ROUGE：要約品質の評価。参照要約とのn-gram再現率で測定\n- BERTScore：BERTの埋め込みを使った意味的類似度評価。表面一致だけでなく意味の近さも考慮\n- F1・Precision・Recall：分類タスクの標準指標\n- コンバージョン率：AIを活用したマーケティング・レコメンドの最終ビジネス成果を測定するKPI', keyword: 'BLEU ROUGE BERTScore F1 コンバージョン率 生成AI 評価指標', tags: ['BLEU/ROUGE', 'BERTScore', 'ビジネスKPI'] },
      ],
    },
    {
      title: '学習アルゴリズム',
      items: [
        { name: '回帰（Regression）', desc: '回帰は、数値（連続値）を予測する教師あり学習。\n線形回帰（Linear Regression）：**入力と出力の関係を直線で近似**。最小二乗法で誤差を最小化\nロジスティック回帰（Logistic Regression）：名前は回帰だが分類に使う。シグモイド関数で0〜1の確率を出力\n評価指標：MSE（平均二乗誤差）・RMSE・MAE（平均絶対誤差）・決定係数R²', keyword: '線形回帰 ロジスティック回帰 Linear Regression 最小二乗法 RMSE', tags: ['線形回帰 / Linear Regression', 'ロジスティック回帰', 'RMSE / R²'] },
        { name: '決定木とアンサンブル学習', desc: '決定木は、条件分岐を繰り返してデータを予測するモデル。複数の木などを組み合わせて精度を高める手法をアンサンブル学習という。\n主な手法：\n- 決定木（Decision Tree）：**条件分岐を木構造で表現**。解釈しやすいが単体では過学習しやすい\n- アンサンブル学習：複数のモデルを組み合わせて精度を高める手法\n- バギング（Bagging）：復元抽出で並列に多数モデルを学習（例：ランダムフォレスト）\n- ブースティング（Boosting）：前の誤りを次が補正して直列学習（例：勾配ブースティング / XGBoost・LightGBM）', keyword: '決定木 ランダムフォレスト 勾配ブースティング XGBoost バギング ブースティング アンサンブル', tags: ['ランダムフォレスト', '勾配ブースティング / Boosting', 'バギング'], seeAlso: ['主要な分類アルゴリズム'] },
        { name: '主要な分類アルゴリズム', desc: 'データをカテゴリに振り分ける分類には、ロジスティック回帰・決定木・SVM・k近傍法など、いくつかの代表的なアルゴリズムがある。\n主なアルゴリズム：\n- SVM（Support Vector Machine）：**クラス間のマージン（余白）を最大化する**境界線を引く分類器。カーネル法で非線形分離も可能\n- k近傍法（k-NN）：予測対象に近いk個のデータの多数決で分類する遅延学習\n- ナイーブベイズ（Naive Bayes）：ベイズの定理を用い、特徴量が独立と仮定する確率的分類器。スパム判定・テキスト分類で高速', keyword: 'SVM サポートベクターマシン k近傍法 kNN ナイーブベイズ Naive Bayes カーネル', tags: ['SVM', 'k近傍法 / k-NN', 'ナイーブベイズ'], seeAlso: ['決定木とアンサンブル学習'] },
        { name: '教師なし学習の手法', desc: '正解ラベルを使わずにデータの構造を見つけるのが教師なし学習で、クラスタリングや次元削減などの手法がある。\nk-meansクラスタリング：データをk個のグループに分割。各クラスタの重心を反復更新（エルボー法でk決定）\n階層的クラスタリング：近いデータを順に結合してデンドログラム（樹形図）を作る\n主成分分析（PCA）：分散が最大になる軸へ射影して次元を削減し、可視化・ノイズ除去に使う', keyword: 'k-means クラスタリング 主成分分析 PCA 次元削減 階層的クラスタリング エルボー法', tags: ['k-means', 'PCA / 主成分分析', '次元削減'] },
      ],
    },
    {
      title: '深層学習（ディープラーニング）',
      items: [
        { name: 'ニューラルネットワークの基礎', desc: 'ニューラルネットワークは、脳の神経回路を模した層構造でデータの複雑なパターンを学習するモデル。\n主な構成要素：\n- パーセプトロン：**入力に重みを掛けて合計し、活性化関数で出力する**最小単位（ニューロン）\n- 多層パーセプトロン（MLP）：入力層・隠れ層・出力層を重ねたネットワーク\n- 活性化関数：非線形性を導入する関数。ReLU（勾配消失に強い）・シグモイド・tanh・出力層のSoftmax（多クラス分類の確率化）', keyword: 'ニューラルネットワーク パーセプトロン 活性化関数 ReLU シグモイド Softmax 多層パーセプトロン', tags: ['パーセプトロン', '活性化関数 / ReLU', 'Softmax'] },
        { name: '学習の仕組み（勾配降下法）', desc: 'モデルの学習は、予測の誤差（損失）を最小にするようパラメータを少しずつ調整して進む。この調整に使う代表的な方法が勾配降下法。\n主な要素：\n- 損失関数（Loss Function）：**予測と正解の誤差を数値化**（回帰=MSE、分類=クロスエントロピー）\n- 勾配降下法（Gradient Descent）：損失が小さくなる方向へ重みを更新。学習率 (Learning Rate) が更新幅を決める\n- 誤差逆伝播（Backpropagation）：出力の誤差を逆向きに伝えて各重みの勾配を計算\n- エポック・バッチ・ミニバッチ：学習データを回す単位。勾配消失/爆発に注意', keyword: '勾配降下法 誤差逆伝播 バックプロパゲーション 損失関数 学習率 クロスエントロピー エポック', tags: ['勾配降下法 / Gradient Descent', '誤差逆伝播 / Backpropagation', '学習率'] },
        { name: '画像・系列を扱うニューラルネット', desc: '画像にはCNN、時系列や文章などの系列にはRNNやTransformerといった、扱うデータに適したニューラルネットワークが使われる。\nCNN（Convolutional Neural Network / 畳み込みニューラルネットワーク）：**畳み込み層とプーリング層で画像の局所特徴を抽出**。画像認識・物体検出で主流\nRNN（Recurrent Neural Network / 再帰型ニューラルネットワーク）：時系列・系列データを扱い、過去の状態を記憶\nLSTM（Long Short-Term Memory）・GRU：RNNの長期依存を学習しにくい弱点（勾配消失）をゲート機構で改善した派生', keyword: 'CNN 畳み込みニューラルネットワーク RNN 再帰型 LSTM GRU プーリング 画像認識', tags: ['CNN / 畳み込み', 'RNN', 'LSTM / GRU'] },
        { name: '生成モデルのアーキテクチャ', desc: '新しいデータを生成する生成モデルには、GAN・VAE・拡散モデル・Transformerなど、いくつかの代表的な構造がある。\n主なアーキテクチャ：\n- Transformer：**Attention（自己注意）機構で系列全体の関係を並列に捉える**アーキテクチャ。現代のLLMの基盤\n- Attention：入力のどの部分に注目すべきかを重み付けする仕組み\n- 生成モデル：GAN（生成器と識別器が競い合う）・VAE（変分オートエンコーダ）・拡散モデル (Diffusion) で画像・音声・テキストを生成', keyword: 'Transformer Attention 自己注意 GAN VAE 拡散モデル Diffusion 生成モデル', tags: ['Transformer / Attention', 'GAN', '拡散モデル / Diffusion'] },
      ],
    },
    {
      title: 'データ前処理・特徴量エンジニアリング',
      items: [
        { name: '特徴量のスケーリング', desc: 'モデルが特徴量の大きさに引きずられないよう、数値の範囲をそろえる前処理を特徴量のスケーリングという。\n正規化（Min-Maxスケーリング）：値を0〜1に変換\n標準化（Standardization）：平均0・分散1に変換（Zスコア）\n距離ベースの手法（k-NN・k-means・SVM）や勾配降下法では前処理としてほぼ必須', keyword: '正規化 標準化 スケーリング Min-Max Zスコア 標準偏差', tags: ['正規化 / Normalization', '標準化 / Standardization', 'スケーリング'] },
        { name: 'データクレンジング', desc: 'データクレンジングは、欠損値・外れ値・重複・表記ゆれ等を整えてデータ品質を高める前処理。\n主な観点：\n- 欠損値（Missing Value）：削除（行/列除去）または補完（平均値・中央値・最頻値・予測モデル）で対応\n- 外れ値（Outlier）：極端に外れた値。**四分位範囲(IQR)や標準偏差で検出し、除去・変換・クリッピングする**\n放置するとモデルの精度や統計量が大きく歪む', keyword: '欠損値 外れ値 補完 Imputation Outlier IQR 四分位', tags: ['欠損値補完', '外れ値 / Outlier', 'IQR'] },
        { name: 'カテゴリ変数のエンコーディング', desc: '文字列などのカテゴリ変数は、機械学習で扱えるよう数値に変換する必要がある。この変換をエンコーディングという。\nOne-Hotエンコーディング：各カテゴリを0/1の列に展開（順序のない名義尺度向け）\nラベルエンコーディング：カテゴリに整数を割り当て（順序のある順序尺度向け）\nターゲットエンコーディング：目的変数の平均値で置換（リークに注意）', keyword: 'One-Hotエンコーディング ラベルエンコーディング カテゴリ変数 特徴量エンジニアリング', tags: ['One-Hot', 'ラベルエンコーディング', 'ターゲットエンコード'] },
        { name: 'データ分割と不均衡対策', desc: 'データは訓練・検証・テストに分けて使う。分類でクラスの件数が偏る不均衡には、リサンプリングなどの対策をとる。\nクラス不均衡（Imbalanced Data）：陽性/陰性の件数が偏ると精度指標が当てにならない。\n主な観点：\n- 対策：オーバーサンプリング（SMOTE等）・アンダーサンプリング・クラス重み付け / F1・AUCで評価\n- データ分割：訓練・検証・テストに分ける。**データリーク（学習に未来/正解情報が混入）を防ぐ**\n- 交差検証（Cross Validation）：データをk分割して評価を平均し、汎化性能を安定評価', keyword: '不均衡データ SMOTE オーバーサンプリング 交差検証 クロスバリデーション データリーク', tags: ['不均衡データ / SMOTE', '交差検証 / Cross Validation', 'データリーク'] },
      ],
    },
    {
      title: '評価・チューニングと統計基礎',
      items: [
        { name: '分類モデルの評価', desc: '分類モデルの性能は、予測結果を正解と照らした混同行列をもとに、正解率・適合率・再現率・F値などで評価する。\n混同行列（Confusion Matrix）：**分類結果をTP(真陽性)・FP(偽陽性)・FN(偽陰性)・TN(真陰性)の4象限で表す表**。\nここから Precision = TP/(TP+FP)・Recall = TP/(TP+FN) などを計算する\n閾値（Threshold）：確率をクラスに変換する境界値。下げると再現率↑・適合率↓のトレードオフ\nROC曲線 / PR曲線：閾値を動かした時の性能推移。クラス不均衡では PR曲線 が有用', keyword: '混同行列 Confusion Matrix TP FP FN TN 閾値 Threshold ROC曲線 PR曲線', tags: ['混同行列 / Confusion Matrix', '閾値 / Threshold', 'ROC / PR曲線'] },
        { name: 'ハイパーパラメータチューニング', desc: '学習前に人が決める設定値をハイパーパラメータという。これを調整してモデルの性能を最適化することをハイパーパラメータチューニングという。\nハイパーパラメータ：**学習前に人が決める設定値**（学習率・木の深さ・正則化強度・バッチサイズ等）。学習で得る重み(パラメータ)とは別物。\n探索手法：\n- グリッドサーチ：候補の全組み合わせを総当たり\n- ランダムサーチ：ランダムに試す（高次元で効率的）\n- ベイズ最適化：過去の試行から次の有望な候補を推定して効率探索\n- 早期終了（Early Stopping）：検証スコアが改善しなくなったら学習を打ち切り過学習を防ぐ\n交差検証と組み合わせて汎化性能で選ぶ', keyword: 'ハイパーパラメータ グリッドサーチ ランダムサーチ ベイズ最適化 早期終了 Early Stopping チューニング', tags: ['グリッド / ランダムサーチ', 'ベイズ最適化', '早期終了 / Early Stopping'], seeAlso: ['データ分割と不均衡対策'] },
        { name: '統計・確率の基礎', desc: '機械学習を理解する土台として、平均・分散・確率分布といった統計・確率の基礎が必要になる。\n代表値：平均 (Mean)・中央値 (Median)・最頻値 (Mode)\nばらつき：分散 (Variance)・標準偏差 (Standard Deviation)\n分布：正規分布 (ガウス分布)・一様分布・ロングテール\n相関（Correlation）：2変数の関連の強さ (-1〜1)。相関≠因果 に注意\n確率の基礎：条件付き確率・ベイズの定理', keyword: '統計 平均 中央値 分散 標準偏差 正規分布 相関 ベイズの定理 確率', tags: ['平均 / 分散・標準偏差', '正規分布', '相関≠因果'] },
      ],
    },
  ],

  DB: [
    {
      title: 'リレーショナルDBの基礎',
      items: [
        { name: 'リレーショナルの構成要素', desc: 'リレーショナルデータベース（RDB）は、テーブル・行・列・キーといった要素で構成される。\nリレーショナルDB（RDB）：データを行 (レコード) と列 (カラム) の表で管理するデータベース。\n主な構成要素：\n- 主キー（Primary Key）：各行を一意に識別する列。重複・NULL不可\n- 外部キー（Foreign Key）：他テーブルの主キーを参照して関連付ける列。**参照整合性を保証**\n- 候補キー / 複合キー：一意識別できる列（の組み合わせ）', keyword: 'リレーショナルデータベース 主キー 外部キー Primary Key Foreign Key 参照整合性', tags: ['主キー / Primary Key', '外部キー / Foreign Key', '参照整合性'] },
        { name: '正規化（Normalization）', desc: '正規化は、データの重複と**更新異常を避ける**ためテーブルを分割する設計手法。\n第1正規形（1NF）：繰り返し項目をなくし各セルを単一値にする\n第2正規形（2NF）：主キーの一部にのみ依存する列を分離（部分関数従属の排除）\n第3正規形（3NF）：主キー以外の列に依存する列を分離（推移的関数従属の排除）\n非正規化：性能のため意図的に重複を許して結合を減らすこともある', keyword: '正規化 第1正規形 第2正規形 第3正規形 非正規化 関数従属', tags: ['第1〜第3正規形', '関数従属', '非正規化'] },
        { name: 'ER図とスキーマ設計', desc: 'ER図は、エンティティ（実体）と関連でデータ構造を図示する設計図。これをもとにDBのテーブル（スキーマ）を設計する。\nER図（Entity-Relationship Diagram）：**エンティティ（実体）と関連（リレーション）でデータ構造を図示する**設計図。\nカーディナリティ（多重度）：1対1・1対多・多対多の関係。多対多は中間（連関）テーブルで表現\nスキーマ：テーブル・列・型・制約の定義。制約には NOT NULL・UNIQUE・CHECK・DEFAULT がある', keyword: 'ER図 エンティティ カーディナリティ スキーマ 多対多 中間テーブル 制約', tags: ['ER図', 'カーディナリティ', '制約 / Constraint'] },
        { name: 'データ型', desc: 'データ型は、列に格納する値の種類（整数・小数・文字列・日付時刻・論理値等）。\n整数 (INT/BIGINT)・小数 (DECIMAL・FLOAT)・文字列 (CHAR・VARCHAR・TEXT)・日付時刻 (DATE・TIMESTAMP)・論理値 (BOOLEAN)。\nDECIMAL vs FLOAT：**金額など誤差が許されない値**はDECIMAL（固定小数点）、科学計算はFLOAT（浮動小数点）\nCHAR vs VARCHAR：CHARは固定長、VARCHARは可変長でストレージ効率が良い', keyword: 'データ型 VARCHAR DECIMAL FLOAT TIMESTAMP 固定小数点 浮動小数点', tags: ['DECIMAL / FLOAT', 'CHAR / VARCHAR', 'TIMESTAMP'] },
      ],
    },
    {
      title: 'SQL基礎',
      items: [
        { name: 'SELECT文の基本', desc: 'SELECT文は、**SELECT 列 FROM テーブル WHERE 条件 の順でデータを問い合わせる**SQLの基本構文。\nWHERE：行を絞り込む条件（=, <>, LIKE, IN, BETWEEN, IS NULL）\nORDER BY：並べ替え（ASC昇順 / DESC降順）\nDISTINCT：重複行を除去\nLIMIT / OFFSET：取得件数と開始位置の制御（ページング）', keyword: 'SELECT WHERE ORDER BY DISTINCT LIMIT SQL 問い合わせ', tags: ['SELECT / WHERE', 'ORDER BY', 'DISTINCT / LIMIT'] },
        { name: 'JOIN（テーブル結合）', desc: 'JOINは、複数テーブルを**関連キーで結合してひとつの結果に統合する**SQL操作。\n内部結合（INNER JOIN）：両テーブルで条件が一致する行のみ\n左外部結合（LEFT OUTER JOIN）：左テーブルは全行、右は一致分のみ（無ければNULL）\n右外部結合（RIGHT OUTER JOIN）：右テーブルは全行、左は一致分のみ（無ければNULL）\n完全外部結合（FULL OUTER JOIN）：両テーブルの全行を結合し一致しない側はNULL\nクロス結合（CROSS JOIN）：総当たり（直積）', keyword: 'JOIN 内部結合 外部結合 INNER JOIN LEFT JOIN テーブル結合', tags: ['内部結合 / INNER JOIN', '外部結合 / OUTER JOIN', 'CROSS JOIN'] },
        { name: '集約とグループ化', desc: '**GROUP BYで行をグループ化し、COUNTやSUMなどの集約関数でまとめて集計する**のがSQLの集約処理。\n主な要素：\n- 集約関数：COUNT（件数）・SUM（合計）・AVG（平均）・MAX・MIN\n- GROUP BY：指定列ごとにグループ化して集約する\n- HAVING：集約結果に対する絞り込み（WHEREは集約前、HAVINGは集約後）\n- 実行順序：FROM → WHERE → GROUP BY → HAVING → SELECT → ORDER BY', keyword: 'GROUP BY 集約関数 COUNT SUM AVG HAVING 実行順序', tags: ['集約関数 / COUNT・SUM', 'GROUP BY', 'HAVING'] },
        { name: 'SQLの構成要素', desc: 'SQLは、機能によってDDL（定義）・DML（操作）・DCL（権限）・TCL（トランザクション）に分類される。\n主な要素：\n- サブクエリ：副問い合わせとして**SQL文の中に入れ子にした**別のSELECT文\n- ビュー（View）：問い合わせ結果に名前を付けた仮想テーブル。複雑なクエリを再利用\n- DML（データ操作言語）：SELECT・INSERT・UPDATE・DELETE\n- DDL（データ定義言語）：CREATE・ALTER・DROP・TRUNCATE\n- DCL（データ制御言語）：GRANT / REVOKE（権限管理）', keyword: 'サブクエリ ビュー View DML DDL DCL INSERT UPDATE DELETE CREATE', tags: ['サブクエリ', 'ビュー / View', 'DML / DDL'] },
        { name: '分析向けの応用SQL', desc: '分析クエリでは、ウィンドウ関数・CTE（共通テーブル式）・サブクエリといった応用的なSQLがよく使われる。\nウィンドウ関数（Window Function）：行をグループに畳まず、各行の隣に集計・順位を付ける。OVER(PARTITION BY … ORDER BY …) で範囲を指定\n例：ROW_NUMBER・RANK・DENSE_RANK (順位)・LAG / LEAD (前後行参照)・累計や移動平均 (SUM() OVER)\nCTE（共通テーブル式 / WITH句）：クエリ内に一時的な名前付き結果を定義して可読性を上げる。再帰CTEで階層データも扱える', keyword: 'ウィンドウ関数 Window Function OVER PARTITION BY ROW_NUMBER RANK LAG LEAD CTE WITH句 共通テーブル式 再帰', tags: ['ウィンドウ関数 / OVER', 'ROW_NUMBER / RANK', 'CTE / WITH句'] },
      ],
    },
    {
      title: 'トランザクションと整合性',
      items: [
        { name: 'ACID特性', desc: 'ACID特性は、**トランザクション（一連の処理をまとめた単位）が満たすべき**4つの性質。\n原子性（Atomicity）：全て成功か全て失敗か（中途半端にしない）\n一貫性（Consistency）：整合性制約を常に満たす\n分離性（Isolation）：並行実行しても互いに干渉しない\n永続性（Durability）：コミットした結果は障害後も失われない', keyword: 'ACID 原子性 一貫性 分離性 永続性 トランザクション コミット ロールバック', tags: ['ACID', 'コミット / ロールバック', 'トランザクション'] },
        { name: '分離レベルと並行性の問題', desc: '複数のトランザクションを同時実行すると、ダーティリードなどの不整合が起きる。これを抑えるのが分離レベルで、強くするほど整合性は上がるが並行性能は下がる。\n並行性の問題（分離レベルが低いと発生）：\n- ダーティリード：未コミットの値を読む\n- ノンリピータブルリード：再読で値が変わる\n- ファントムリード：再読で行数が増減する\n分離レベル（弱→強）：READ UNCOMMITTED < READ COMMITTED < REPEATABLE READ < SERIALIZABLE', keyword: '分離レベル Isolation Level ダーティリード ファントムリード SERIALIZABLE 並行性', tags: ['分離レベル', 'ダーティリード', 'SERIALIZABLE'] },
        { name: '同時実行制御', desc: '同時実行制御は、複数トランザクションの同時実行でデータ整合性を保つ仕組み（ロック・MVCC＝複数バージョン同時実行制御 等）。\nロック：**同時更新の競合を防ぐ**ためデータへのアクセスを一時的に制限する仕組み。\n共有ロック（読み取り用・複数で同時取得可）/ 排他ロック（書き込み用・他の取得をブロック）\n楽観ロック vs 悲観ロック：楽観はバージョン番号で競合検出、悲観は先にロック取得\nデッドロック：互いに相手のロック解放を待ち続けて処理が進まない状態。検出して片方をロールバックする', keyword: 'ロック デッドロック 排他ロック 共有ロック 楽観ロック 悲観ロック', tags: ['排他 / 共有ロック', '楽観 / 悲観ロック', 'デッドロック'], seeAlso: ['分離レベルと並行性の問題'] },
      ],
    },
    {
      title: 'インデックスと性能',
      items: [
        { name: 'インデックス（Index）', desc: 'インデックスは、**列の値と行の位置を対応付けて検索を高速化する**データ構造（本の索引に相当）。\nB-tree インデックス：範囲検索・等価検索に強い最も一般的な方式\nハッシュインデックス：等価検索に特化\n複合インデックス：複数列をまとめて張る（左端の列から順に効く）\nトレードオフ：検索は速くなるが、書き込み（INSERT/UPDATE）は遅くなり容量も増える', keyword: 'インデックス B-tree 複合インデックス ハッシュインデックス 索引 高速化', tags: ['B-tree', '複合インデックス', '書き込みコスト'] },
        { name: 'クエリ最適化', desc: 'クエリ最適化は、実行計画を見直してSQLの処理速度を上げる観点。\n主な観点：\n- 実行計画（Execution Plan）：**DBがクエリをどう処理するかの計画**。EXPLAIN で確認する\n- フルスキャン vs インデックススキャン：WHERE句がインデックスを使えず全行走査すると遅い\n- N+1問題：1件取得のたびに関連クエリを繰り返し発行して大量のクエリになる問題（JOINやまとめ取得で解消）\n- スロークエリの発見：実行時間の長いクエリをログで特定して改善', keyword: '実行計画 EXPLAIN フルスキャン N+1問題 クエリ最適化 スロークエリ', tags: ['実行計画 / EXPLAIN', 'フルスキャン', 'N+1問題'], seeAlso: ['インデックス（Index）'] },
        { name: 'NoSQLと分散DB', desc: 'NoSQLは、RDBの表形式にとらわれない柔軟なデータベース群。大規模化のため複数ノードにデータを分散するものが多い。\nNoSQL（Not only SQL）：**RDBの表形式にとらわれない**柔軟なデータベース群。\n主な種類：\n- キーバリュー型：キーで値を出し入れ\n- ドキュメント型：JSON等の文書単位で格納\n- 列指向型：列ごとに格納し集計に強い\n- グラフ型：ノードと辺で関係性を表現\nCAP定理：分散システムは 一貫性(C)・可用性(A)・分断耐性(P) の3つを同時には満たせず、Pを前提にCかAを選ぶ\nBASE：結果整合性を許容する緩い一貫性モデル（ACIDの対比）\n使い分け：厳密な整合性・結合はRDB、スケールと柔軟なスキーマはNoSQL', keyword: 'NoSQL キーバリュー ドキュメント 列指向 グラフDB CAP定理 結果整合性 BASE', tags: ['NoSQLの種類', 'CAP定理', '結果整合性 / BASE'] },
      ],
    },
    {
      title: '分析・データ基盤の基礎（DEA前提）',
      items: [
        { name: '業務系と分析系', desc: 'データベースは、日々の業務トランザクションを処理する業務系（OLTP）と、大量データを集計・分析する分析系（OLAP）に大別される。\nOLTP（Online Transaction Processing）：注文・入出金など小さな更新を大量・高速に捌く業務系。正規化された行指向DBが向く\nOLAP（Online Analytical Processing）：大量データの集計・分析を行う分析系。非正規化・列指向のDWHが向く\n求められるスキーマ・ストレージ・インデックス設計が両者で異なる', keyword: 'OLTP OLAP オンライントランザクション オンライン分析処理 業務系 分析系 DWH データウェアハウス', tags: ['OLTP / 業務系', 'OLAP / 分析系', '行指向 / 列指向'], seeAlso: ['ディメンショナルモデリング'] },
        { name: 'ディメンショナルモデリング', desc: 'ディメンショナルモデリングは、分析（OLAP/DWH）向けのデータモデル（ファクトとディメンションで構成）。\nファクトテーブル（Fact）：売上・数量など測定値(メジャー)を保持する中心テーブル\nディメンションテーブル（Dimension）：日付・商品・顧客など「分析の切り口」を保持\nスタースキーマ：ファクトを中心に**ディメンションを星形に配置**(非正規化で高速)\nスノーフレークスキーマ：ディメンションをさらに正規化して枝分かれさせた形\n粒度（Grain）：ファクト1行が表す詳細さのレベル', keyword: 'ディメンショナルモデリング スタースキーマ スノーフレーク ファクトテーブル ディメンションテーブル 粒度 Grain DWH データモデリング', tags: ['スタースキーマ', 'ファクト / ディメンション', 'スノーフレーク'] },
        { name: 'パーティショニングとデータ分散', desc: '大規模なテーブルは、パーティショニングで分割したり複数ノードにデータを分散したりして、性能と管理性を高める。\nレンジパーティション：日付や数値の範囲で分割(例：月ごと)\nリストパーティション：特定の値(地域等)で分割\nハッシュパーティション：ハッシュ値で均等に分散\nパーティションプルーニング（Pruning）：クエリ条件に該当するパーティションだけ読み、スキャン量を削減\nバケッティング / シャーディング：キーでデータを分散配置してスケールさせる', keyword: 'パーティショニング レンジ リスト ハッシュ パーティションプルーニング Pruning バケッティング シャーディング データ分散', tags: ['レンジ / ハッシュ', 'パーティションプルーニング', 'シャーディング'] },
        { name: 'データ形式（ファイル形式）', desc: 'データ処理では、CSV・JSON・Parquet・Avroといったさまざまなファイル形式を扱う。\n行指向 vs 列指向：行指向は1レコードをまとめて保存(OLTP向け)、列指向は同じ列をまとめて保存(集計・圧縮に強くOLAP向け)\nテキスト系：CSV(単純・非圧縮)・JSON(半構造化・ネスト可)・XML\nバイナリ列指向：**Parquet・ORC(列指向・高圧縮・分析高速)**\n行指向バイナリ：Avro(スキーマ付き・行単位・ストリーミング向け)\n圧縮：gzip・Snappy・Zstd 等でストレージ・転送量を削減', keyword: 'データ形式 CSV JSON Parquet ORC Avro 列指向 行指向 カラムナー 圧縮 Snappy', tags: ['行指向 / 列指向', 'Parquet / ORC', 'CSV / JSON / Avro'] },
      ],
    },
  ],

  NW: [
    {
      title: 'TCP/IPとOSI参照モデル',
      items: [
        { name: 'ネットワーク階層モデル', desc: 'ネットワーク通信は、役割ごとに階層に分けて整理される。代表がOSI参照モデル（7層）とTCP/IPモデル（4層）。\nOSI参照モデル（7層）：物理→データリンク→ネットワーク→トランスポート→セッション→プレゼンテーション→アプリケーション\nTCP（Transmission Control Protocol）/IPモデル（4層）：ネットワークインターフェース→インターネット→トランスポート→アプリケーション\nカプセル化：各層でヘッダーを付けてデータを包む処理', keyword: 'OSI参照モデル TCP/IP 7層 プロトコル カプセル化 レイヤー', tags: ['OSI 7層', 'TCP/IP 4層', 'カプセル化'] },
        { name: 'トランスポート層プロトコル', desc: 'トランスポート層では、信頼性重視のTCPと、速度重視のUDPという2つの代表的なプロトコルを使い分ける。\nTCP（Transmission Control Protocol）：コネクション型。3ウェイハンドシェイクで接続を確立し、再送・順序保証で信頼性が高い（Web・メール・ファイル転送）\nUDP（User Datagram Protocol）：コネクションレス型。確認なしで高速・低遅延だが到達保証なし（動画配信・音声通話・DNS・ゲーム）', keyword: 'TCP UDP 3ウェイハンドシェイク コネクション型 信頼性 トランスポート層', tags: ['TCP / 信頼性', 'UDP / 低遅延', '3ウェイハンドシェイク'] },
        { name: 'ポート番号', desc: 'ポート番号は、**同一ホスト上のどのアプリ宛かを識別する番号**（0〜65535）。\n3つの範囲（用途別）\n- ウェルノウンポート：0-1023番。HTTP=80・HTTPS=443・SSH=22・DNS=53・SMTP=25\n- 登録済みポート（1024-49151）：ソフトに登録された用途\n- 動的ポート（49152-65535）：通信時に一時的に割り当て\nソケット = IPアドレス + ポート番号 で通信の端点を一意に表す', keyword: 'ポート番号 ウェルノウンポート ソケット HTTP HTTPS SSH DNS ポート', tags: ['ウェルノウンポート', 'ソケット', '80 / 443 / 22'] },
      ],
    },
    {
      title: 'ネットワーク性能・QoS',
      items: [
        { name: 'MTUとパケットサイズ', desc: 'MTUは、1フレームで送れるデータの最大サイズ。これを超えるデータは分割され、値が不適切だと通信効率が落ちる。\nMTU（Maximum Transmission Unit）：**1フレームで送れる**最大ペイロードサイズ。イーサネットは標準1500バイト\nジャンボフレーム：MTUを約9000バイトに拡大し、大容量転送のオーバーヘッドを削減(高スループット用途)\nフラグメンテーション：MTUを超えるパケットを分割する処理。分割は性能を落とす\nパスMTUディスカバリ（PMTUD）：経路上の最小MTUを検出して分割を回避。ICMPが遮断されると失敗しブラックホール化する', keyword: 'MTU ジャンボフレーム フラグメンテーション パスMTUディスカバリ PMTUD 最大転送単位', tags: ['MTU / 1500', 'ジャンボフレーム / 9000', 'パスMTUディスカバリ'] },
        { name: 'ネットワーク性能指標', desc: 'ネットワークの性能は、帯域幅・スループット・レイテンシ・ジッタといった指標で測る。\n帯域幅（Bandwidth）：単位時間に送れる理論上の最大量(bps)\nレイテンシ（Latency）：片道/往復(RTT)の遅延時間\nスループット（Throughput）：実際に転送できた実効速度\nTCPスループットは RTT と ウィンドウサイズ（一度に送れる未確認応答データ量）に依存する(帯域遅延積 BDP = 帯域 × RTT)\n輻輳制御（Congestion Control）：混雑時に送信量を調整して破綻を防ぐ仕組み', keyword: '帯域幅 レイテンシ RTT スループット ウィンドウサイズ 帯域遅延積 BDP 輻輳制御', tags: ['帯域 / レイテンシ', 'スループット / RTT', '輻輳制御'] },
        { name: 'QoS（サービス品質）', desc: 'QoS（サービス品質）は、**限られた帯域で重要な通信を優先する**制御。\n主な仕組み：\n- 分類・マーキング：パケットに優先度(DSCP等)を付与\n- 優先制御 / キューイング：音声・映像などリアルタイム通信を優先的に送出\n- 帯域制御：シェーピング(平滑化)/ ポリシング(超過分を破棄)で送信レートを管理\n- 用途：VoIP・ビデオ会議など遅延・ジッタに敏感なトラフィックの品質確保', keyword: 'QoS サービス品質 DSCP 優先制御 キューイング シェーピング ポリシング VoIP ジッタ', tags: ['QoS / 優先制御', 'DSCP / マーキング', 'シェーピング / ポリシング'] },
      ],
    },
    {
      title: 'IPアドレスとサブネット',
      items: [
        { name: 'IPアドレス（IPv4 / IPv6）', desc: 'IPアドレスは、**ネットワーク上の機器を識別する**住所（IPv4とIPv6）。\nIPv4（Internet Protocol version 4）：32ビット（例 192.168.1.1）。約43億個で枯渇\nIPv6（Internet Protocol version 6）：128ビットで実質無制限\nグローバルIP（インターネットで一意）vs プライベートIP（組織内で自由に使える 10.0.0.0/8・172.16.0.0/12・192.168.0.0/16）\nループバック 127.0.0.1（自ホスト）', keyword: 'IPアドレス IPv4 IPv6 グローバルIP プライベートIP ループバック', tags: ['IPv4 / IPv6', 'プライベートIP', 'ループバック'] },
        { name: 'サブネット設計', desc: '大きなネットワークは、サブネットに分割してCIDRでIPアドレス範囲を割り当てる。これをサブネット設計という。\n主な要素：\n- サブネットマスク：**IPアドレスのうちネットワーク部とホスト部を分ける**境界（例 255.255.255.0）\n- CIDR表記：/24 のようにネットワーク部のビット数で表す（255.255.255.0 = /24）\n- サブネット分割（Subnetting）：大きなネットワークを小さく区切って管理・セキュリティを向上\nネットワークアドレス（先頭）とブロードキャストアドレス（末尾）は割り当て不可', keyword: 'サブネットマスク CIDR サブネット分割 ネットワークアドレス ブロードキャスト', tags: ['サブネットマスク', 'CIDR / prefix', 'ブロードキャスト'] },
        { name: 'アドレス変換（NAT）', desc: 'アドレス変換（NAT）は、**プライベートIPとグローバルIPを相互変換する**仕組み。\nNAPT（Network Address Port Translation） / PAT：ポート番号も使って複数の内部端末を1つのグローバルIPで共有（IPマスカレード）\n用途：IPv4アドレス節約・内部ネットワークの隠蔽によるセキュリティ向上\n静的NAT（1対1）と動的NAT（プールから割当）がある', keyword: 'NAT NAPT PAT IPマスカレード アドレス変換 ポート変換', tags: ['NAT', 'NAPT / PAT', 'アドレス変換'] },
        { name: '通信の宛先方式', desc: '通信は、宛先の指定方法によってユニキャスト・ブロードキャスト・マルチキャスト・エニーキャストに分けられる。\nユニキャスト：1対1の通常通信\nブロードキャスト：同一セグメント全員へ一斉送信(ARP等)。ルーターを越えない\nマルチキャスト：特定グループにのみ配信(1対多)。動画・株価配信などで帯域を節約\nIGMP（Internet Group Management Protocol）：受信者がマルチキャストグループへの参加/離脱を通知するプロトコル\nマルチキャストアドレス：224.0.0.0〜239.255.255.255 (IPv4クラスD)', keyword: 'ユニキャスト ブロードキャスト マルチキャスト IGMP マルチキャストアドレス クラスD 1対多', tags: ['ユニ / ブロード / マルチキャスト', 'IGMP', 'クラスD 224.x'] },
      ],
    },
    {
      title: 'ルーティングとスイッチング',
      items: [
        { name: 'L2/L3の中継機器', desc: 'ネットワークでデータを中継する機器には、L2で動くスイッチや、L3で動くルーターなどがある。\n主な機器：\n- スイッチ（L2）：**同一ネットワーク内でMACアドレスを見てフレームを転送する**機器\n- ルーター（L3）：異なるネットワーク間をIPアドレスで中継する機器\n- デフォルトゲートウェイ：自分のネットワーク外へ出る際の出口となるルーター\n- MACアドレス：NICに割り当てられた物理アドレス。ARPでIP↔MACを対応付ける', keyword: 'ルーター スイッチ L2 L3 デフォルトゲートウェイ MACアドレス ARP', tags: ['スイッチ / L2', 'ルーター / L3', 'デフォルトゲートウェイ'], seeAlso: ['ルーティング'] },
        { name: 'ルーティング', desc: 'ルーティングは、**パケットを宛先まで転送する経路制御**。\nルーティングテーブル：宛先ネットワークごとの転送先を記した表。最長一致 (Longest Match) で選択\n静的ルーティング：手動で経路を設定（小規模・固定向け）\n動的ルーティング：プロトコルで経路を自動学習。RIP（距離ベクトル）・OSPF（リンクステート）・BGP（インターネット間の経路制御）', keyword: 'ルーティング ルーティングテーブル 最長一致 静的ルーティング 動的ルーティング OSPF BGP', tags: ['ルーティングテーブル', '静的 / 動的', 'OSPF / BGP'] },
        { name: 'ネットワークセグメンテーション', desc: 'ネットワークセグメンテーションは、ネットワークを論理的に分割して管理性とセキュリティを高める技術（VLAN・サブネット等）。\nVLAN（Virtual LAN）：**物理構成に関係なくスイッチを論理的に分割し、ブロードキャストドメインを分けて管理・セキュリティを向上させる**技術。\n主な技術：\n- ブロードキャストドメイン：ブロードキャストが届く範囲。ルーターで区切られる\n- セグメンテーション：用途や部門ごとにネットワークを分けて、障害・攻撃の影響範囲を限定する', keyword: 'VLAN ブロードキャストドメイン セグメンテーション ネットワーク分割', tags: ['VLAN', 'ブロードキャストドメイン', 'セグメンテーション'] },
        { name: 'BGP（境界ゲートウェイプロトコル）', desc: 'BGP（境界ゲートウェイプロトコル）は、**インターネットや組織間（AS間）の経路を交換する**動的ルーティングプロトコル。\n主な用語：\n- AS（自律システム）：単一の管理ポリシーで運用されるネットワークの塊。AS番号で識別\n- eBGP：異なるAS間 / iBGP：同一AS内\n- 経路広告（Advertisement）：自分が到達できるネットワークを隣接ルーターに通知\n- パス選択：AS_PATH長・ローカルプリファレンス・MED（複数経路がある場合の優先度を示す属性）などの属性で最適経路を決定\n経路集約でルーティングテーブルを縮小する', keyword: 'BGP 境界ゲートウェイプロトコル AS 自律システム eBGP iBGP 経路広告 AS_PATH ローカルプリファレンス MED', tags: ['BGP / AS番号', 'eBGP / iBGP', '経路広告 / パス選択'] },
      ],
    },
    {
      title: 'DNS・アプリ層プロトコル',
      items: [
        { name: 'DNS（名前解決）', desc: 'DNS（名前解決）は、**ドメイン名（例 example.com）をIPアドレスに変換する**仕組み。\nレコード種別：A（IPv4）・AAAA（IPv6）・CNAME（別名）・MX（メール）・NS（ネームサーバ）・TXT・PTR（逆引き）\n名前解決の流れ：リゾルバ → ルート → TLD → 権威DNSサーバへ再帰的に問い合わせ\nTTL（Time To Live）：レコードのキャッシュ有効期間', keyword: 'DNS 名前解決 Aレコード CNAME MXレコード 権威DNS リゾルバ TTL', tags: ['レコード種別 / A・CNAME', '権威 / リゾルバ', 'TTL'] },
        { name: 'Web通信プロトコル', desc: 'Webの通信には、アプリ層プロトコルのHTTPと、それを暗号化したHTTPSが使われる。\nHTTP（HyperText Transfer Protocol）：Webのアプリ層プロトコル。**リクエスト/レスポンス型でステートレス**\nメソッド：GET（取得）・POST（送信）・PUT・DELETE\nステータスコード：2xx成功・3xxリダイレクト・4xxクライアントエラー・5xxサーバエラー\nHTTPS（HyperText Transfer Protocol Secure）：HTTPをTLSで暗号化。盗聴・改ざん・なりすましを防ぐ', keyword: 'HTTP HTTPS メソッド GET POST ステータスコード リクエスト レスポンス', tags: ['メソッド / GET・POST', 'ステータスコード', 'HTTPS'] },
        { name: '補助的な通信プロトコル', desc: 'ネットワーク運用は、IPアドレスを配るDHCP、MACアドレスを解決するARP、到達確認のICMP、時刻同期のNTPなど、多くの補助プロトコルに支えられている。\nDHCP（Dynamic Host Configuration Protocol）：**端末にIPアドレス・サブネットマスク・デフォルトゲートウェイ・DNSを自動配布する**仕組み（DORA＝発見→提案→要求→確認の4ステップ）\nARP（Address Resolution Protocol）：同一セグメント内でIPアドレスからMACアドレスを解決\nICMP（Internet Control Message Protocol）：疎通確認 (ping) や経路調査 (traceroute) に使う制御プロトコル\nNTP（Network Time Protocol）：時刻同期プロトコル', keyword: 'DHCP ARP ICMP ping traceroute NTP 時刻同期 IP自動割当', tags: ['DHCP', 'ARP / ICMP', 'ping / traceroute'] },
      ],
    },
    {
      title: 'ネットワークセキュリティ・監視',
      items: [
        { name: 'ファイアウォールとアクセス制御', desc: 'ファイアウォールは、通信を許可・拒否してネットワークを守る仕組み。パケットフィルタリングやステートフルインスペクションで制御する。\n主な仕組み：\n- ファイアウォール：**通信を許可/拒否するルール（IP・ポート・プロトコル）で境界を防御**\n- ステートフルインスペクション：通信の状態を追跡し、戻りパケットを自動許可\n- ステートレス vs ステートフル：ステートレスは行き・戻りを個別に判定、ステートフルは接続単位で判定\n- ACL（Access Control List）：通信可否のルールリスト', keyword: 'ファイアウォール ステートフル ステートレス ACL アクセス制御 パケットフィルタ', tags: ['ファイアウォール', 'ステートフル / ステートレス', 'ACL'] },
        { name: 'VPNと暗号化通信', desc: 'VPNは、公衆網の上に暗号化した仮想的な専用線を作る技術。拠点間やリモートアクセスの通信を安全にする。\n主な種類：\n- IPsec（IP Security） VPN：L3で暗号化。拠点間接続 (Site-to-Site) に多い\n- SSL（Secure Sockets Layer）/TLS VPN：ブラウザベースでリモートアクセス向け\n- トンネリング：パケットを別のプロトコルで包んで転送する仕組み', keyword: 'VPN IPsec SSL VPN トンネリング 暗号化通信 拠点間接続', tags: ['VPN', 'IPsec / SSL-TLS', 'トンネリング'] },
        { name: '負荷分散と監視', desc: 'ロードバランサーは、複数のサーバーに通信を振り分けて負荷分散と可用性を確保する。あわせてサーバーの死活を監視する。\nロードバランサ（LB）：**複数サーバへ通信を振り分けて負荷分散**・可用性を確保\nL4 LB（IP/ポートで分散）vs L7 LB（URL/ヘッダーで分散）\nヘルスチェック：異常なサーバを振り分け対象から自動的に外す\n監視・調査ツール：パケットキャプチャ (Wireshark/tcpdump)・SNMP（機器監視）・フローログ', keyword: 'ロードバランサ 負荷分散 L4 L7 ヘルスチェック パケットキャプチャ SNMP', tags: ['ロードバランサ / L4・L7', 'ヘルスチェック', 'パケットキャプチャ'] },
      ],
    },
  ],

  SEC: [
    {
      title: '暗号技術',
      items: [
        { name: '暗号化方式（対称/非対称）', desc: '暗号化には、同じ鍵で暗号化・復号する共通鍵（対称）方式と、公開鍵と秘密鍵のペアを使う公開鍵（非対称）方式がある。\n主な方式：\n- 共通鍵暗号（対称鍵 / Symmetric）：**暗号化と復号に同じ鍵を使う**。高速だが鍵配送が課題（例 AES）\n- 公開鍵暗号（非対称鍵 / Asymmetric）：公開鍵で暗号化し秘密鍵で復号。鍵配送問題を解決するが低速（例 RSA・楕円曲線暗号）\n- ハイブリッド暗号：データ本体は共通鍵で暗号化し、その共通鍵を公開鍵で送る（TLSの方式）', keyword: '共通鍵暗号 公開鍵暗号 対称鍵 非対称鍵 AES RSA ハイブリッド暗号', tags: ['共通鍵 / AES', '公開鍵 / RSA', 'ハイブリッド暗号'] },
        { name: 'ハッシュと完全性', desc: 'ハッシュ関数は、データを固定長の値に変換する一方向の関数。この値を比べることで、データが改ざんされていないこと（完全性）を確認できる。\nハッシュ関数：**任意長のデータを固定長の値に変換する一方向関数**（元に戻せない）。\n主な性質：\n- 同じ入力は同じ出力になる\n- わずかな入力の変化で出力が大きく変わる\n- 同じ出力を持つ別入力を見つける「衝突」が困難\n主な用途：\n- パスワード保存（ソルト付きハッシュ）\n- 改ざん検知\n- 完全性検証\n代表アルゴリズム：SHA-256（推奨）/ MD5・SHA-1 は脆弱で非推奨', keyword: 'ハッシュ関数 SHA-256 MD5 ソルト 完全性 改ざん検知 一方向関数', tags: ['ハッシュ / SHA-256', 'ソルト', '完全性検証'] },
        { name: '電子署名とPKI', desc: '電子署名は、公開鍵暗号で送信者の本人性とデータの完全性を保証する仕組み。これを支える証明書と認証局の体系をPKI（公開鍵基盤）という。\n主な要素：\n- デジタル署名：**秘密鍵で署名**し公開鍵で検証。送信者のなりすまし防止と改ざん検知を両立\n- デジタル証明書：公開鍵とその持ち主を認証局 (CA) が保証する電子文書 (X.509)\n- PKI（公開鍵基盤）：CA・証明書・失効リスト(CRL/OCSP) で信頼を担保する仕組み\n- TLS（Transport Layer Security）/SSL：サーバ証明書で相手を確認し通信を暗号化', keyword: 'デジタル署名 デジタル証明書 認証局 CA PKI X.509 TLS SSL 失効', tags: ['デジタル署名', '証明書 / CA', 'PKI'] },
        { name: '鍵管理とエンベロープ暗号', desc: '暗号は鍵の管理が要で、鍵が漏れれば無意味になる。データ鍵をさらに別の鍵で暗号化して守る方式をエンベロープ暗号という。\nキーライフサイクル：生成 → 配布 → 保管 → ローテーション(定期更新) → 失効・廃棄\nエンベロープ暗号（Envelope Encryption）：データはデータ鍵(DEK)で暗号化し、そのDEKを上位のマスター鍵(KEK)で**暗号化する2層構造**。大量データを効率よく守り、保護対象をKEKに集約できる\nHSM（Hardware Security Module）：鍵を耐タンパーな専用ハードで生成・保管する装置\n鍵管理システム(KMS)の基本概念', keyword: '鍵管理 キーライフサイクル 鍵ローテーション エンベロープ暗号 Envelope Encryption DEK KEK データ鍵 マスターキー HSM', tags: ['エンベロープ暗号 / DEK・KEK', '鍵ローテーション', 'HSM'] },
        { name: 'TLS/SSLとハンドシェイク', desc: 'TLS（旧SSL）は、通信を暗号化して盗聴・改ざん・なりすましを防ぐプロトコル。通信開始時のハンドシェイクで鍵を交換する。HTTPSの土台。\nハンドシェイク概略：\n① クライアントが対応する暗号スイート（暗号アルゴリズムの組み合わせ）を提示\n② サーバが証明書(公開鍵)を提示\n③ 証明書を検証し、共通鍵(セッション鍵)を安全に共有\n④ 以降はセッション鍵(共通鍵暗号)で高速に暗号化通信\nつまり公開鍵で鍵交換し本文は共通鍵で暗号化するハイブリッド方式。前方秘匿性(PFS)で過去の通信も保護', keyword: 'TLS SSL ハンドシェイク 暗号スイート セッション鍵 証明書検証 ハイブリッド暗号 前方秘匿性 PFS HTTPS', tags: ['TLSハンドシェイク', 'セッション鍵', '前方秘匿性 / PFS'] },
      ],
    },
    {
      title: '認証と認可',
      items: [
        { name: '認証と認可の基本', desc: '認証は「あなたは誰か」を確かめる本人確認、認可は「何をしてよいか」を決める権限付与で、両者は別の概念。\n認証（Authentication）：**本人確認（「あなたは誰か」）**\n- 認証の3要素：知識（パスワード）・所持（トークン・スマホ）・生体（指紋・顔）\n- 多要素認証（MFA）：異なる要素を2つ以上組み合わせて強度を高める\n認可（Authorization）：アクセス権の制御（「何をしてよいか」）', keyword: '認証 認可 Authentication Authorization MFA 多要素認証 本人確認', tags: ['認証 / Authentication', '認可 / Authorization', 'MFA'] },
        { name: 'アクセス制御モデル', desc: '誰が何にアクセスできるかを決める方式には、DAC・MAC・RBAC（ロールベース）・ABAC（属性ベース）などのモデルがある。\n主なモデル：\n- DAC（任意アクセス制御）：リソースの所有者が自分の判断でアクセス権を設定できる方式\n- MAC（強制アクセス制御）：管理者が定めたポリシーに従い、所有者でも権限を変更できない厳格な方式\n- 最小権限の原則（Least Privilege）：**業務に必要な最小限**の権限だけ与える\n- RBAC（ロールベースアクセス制御）：役割 (ロール) に権限をまとめ、ユーザーにロールを割り当てる\n- ABAC（属性ベースアクセス制御）：属性（部署・時間・場所等）の条件で制御\n- 職務分掌（Separation of Duties）：権限を分散させ単独での不正を防ぐ', keyword: '最小権限 Least Privilege RBAC ABAC アクセス制御 職務分掌 ロール DAC MAC', tags: ['最小権限', 'RBAC / ABAC', '職務分掌'] },
        { name: 'ID連携とSSO', desc: 'ID連携は、複数サービス間で認証情報を受け渡す仕組み。これにより一度のログインで複数サービスを使えるSSO（シングルサインオン）を実現する。SAML・OIDC・OAuthが使われる。\n主な仕組み：\n- SSO（シングルサインオン）：**一度の認証で複数サービスを利用できる**仕組み\n- フェデレーション：組織をまたいで認証情報を信頼・連携する\n- SAML（Security Assertion Markup Language）：主に企業向けのXMLベース認証連携\n- OAuth（Open Authorization） 2.0：認可の委譲（第三者アプリにAPIアクセスを許可）\n- OpenID Connect（OIDC）：OAuth 2.0上に認証を追加した仕様（IDトークン）', keyword: 'SSO シングルサインオン フェデレーション SAML OAuth OpenID Connect OIDC', tags: ['SSO / フェデレーション', 'SAML', 'OAuth / OIDC'] },
      ],
    },
    {
      title: '脅威と攻撃',
      items: [
        { name: 'マルウェア', desc: 'マルウェアは、**悪意あるソフト**の総称。\n主な種類：\n- ウイルス / ワーム：自己増殖して感染を広げる\n- トロイの木馬：正規プログラムを装って侵入\n- ランサムウェア：データを暗号化して身代金を要求\n- スパイウェア / ボット：情報窃取・遠隔操作（C2から指令）\n対策：\n- アンチウイルス\n- EDR（Endpoint Detection and Response：端末の不審な挙動を検知・対応する仕組み）\n- パターン更新\n- 振る舞い検知\n- バックアップ', keyword: 'マルウェア ウイルス ワーム トロイの木馬 ランサムウェア ボット C2 EDR', tags: ['ランサムウェア', 'ワーム / トロイ', 'ボット / C2'] },
        { name: 'Web・アプリへの攻撃', desc: 'Webアプリを狙う攻撃には、SQLインジェクション・XSS・CSRFなど、入力やセッションの弱点を突く手口がある。\n主な攻撃：\n- SQLインジェクション：**入力に不正なSQLを注入してDBを不正操作**（対策：プレースホルダ）\n- XSS（クロスサイトスクリプティング）：悪意あるスクリプトを埋め込み他ユーザーで実行（対策：エスケープ）\n- CSRF（Cross-Site Request Forgery）：ログイン状態を悪用して意図しない操作をさせる（対策：トークン）\n- バッファオーバーフロー：確保領域を超える書き込みで不正コードを実行\n- ディレクトリトラバーサル：../等で公開範囲外のファイルに不正アクセス', keyword: 'SQLインジェクション XSS クロスサイトスクリプティング CSRF バッファオーバーフロー 脆弱性', tags: ['SQLi', 'XSS', 'CSRF'] },
        { name: 'その他の攻撃手法', desc: 'ネットワークや認証を狙う攻撃には、DoS/DDoS・中間者攻撃・ブルートフォースなどがある。\n主な攻撃：\n- DoS（Denial of Service） / DDoS：**大量アクセスでサービスを停止させる**攻撃（分散させたものがDDoS）\n- ブルートフォース：パスワード等の組み合わせを総当たりで試して突破する攻撃\n- 中間者攻撃（MITM）：通信に割り込んで盗聴・改ざん\n- フィッシング：偽サイト・偽メールで認証情報をだまし取る\n- ソーシャルエンジニアリング：人の心理につけ込む攻撃（なりすまし電話・肩越しの覗き見）', keyword: 'DoS DDoS 中間者攻撃 MITM フィッシング ソーシャルエンジニアリング ブルートフォース', tags: ['DoS / DDoS', '中間者攻撃 / MITM', 'フィッシング'] },
      ],
    },
    {
      title: 'セキュリティ管理・防御',
      items: [
        { name: '情報セキュリティの3要素', desc: '情報セキュリティは、機密性・完全性・可用性という3つの要素（CIA）を守ることが基本。\n機密性（Confidentiality）：認可された者だけがアクセスできる\n完全性（Integrity）：情報が正確で改ざんされていない\n可用性（Availability）：必要なときに利用できる\n拡張要素：真正性・責任追跡性 (Accountability)・否認防止 (Non-repudiation)', keyword: 'CIA 機密性 完全性 可用性 情報セキュリティ 否認防止 真正性', tags: ['機密性 / Confidentiality', '完全性 / Integrity', '可用性 / Availability'] },
        { name: '防御設計の原則', desc: '安全なシステムを設計するには、最小権限・多層防御・ゼロトラストといった基本原則に従う。\n主な原則：\n- 多層防御（Defense in Depth）：**単一の対策に頼らず**境界・ネットワーク・ホスト・アプリ・データの各層で守る\n- ゼロトラスト（Zero Trust）：「何も信頼しない」を前提に、社内外を問わず全アクセスを常に検証する\n最小権限・マイクロセグメンテーション（ネットワークをごく小さい単位に分割し、区画ごとにアクセスを制御する手法）・継続的な認証が要素', keyword: '多層防御 Defense in Depth ゼロトラスト Zero Trust マイクロセグメンテーション', tags: ['多層防御', 'ゼロトラスト', '継続的検証'] },
        { name: '脆弱性管理とデータ保護', desc: '脆弱性は継続的に発見して修正し、データは暗号化やアクセス制御で守る。この2つがセキュリティ運用の柱。\n主な観点：\n- 脆弱性管理：**既知の弱点 (CVE：Common Vulnerabilities and Exposures) をスキャンし**、リスク (CVSS：Common Vulnerability Scoring System) で優先順位を付けてパッチ適用\n- パッチ管理：OS・ソフトを最新化して既知の穴をふさぐ\n- 保存データ暗号化 (at rest)\n- 通信データ暗号化 (in transit)\n- バックアップと 3-2-1ルール（3コピー・2媒体・1オフサイト）', keyword: '脆弱性管理 CVE CVSS パッチ管理 暗号化 バックアップ 3-2-1ルール', tags: ['脆弱性 / CVE・CVSS', 'パッチ管理', 'バックアップ / 3-2-1'] },
      ],
    },
    {
      title: 'インシデント対応・監視',
      items: [
        { name: 'インシデント対応プロセス', desc: 'セキュリティ事故には、検知→封じ込め→根絶→復旧→教訓という流れで体系的に対応する。\n準備 → 検知・分析 → 封じ込め (Containment) → 根絶 (Eradication) → 復旧 (Recovery) → 事後学習 (Lessons Learned)\nCSIRT：インシデント対応を担う専門チーム\nフォレンジック：証拠保全と原因調査（改ざんを避け証拠の連鎖を維持）', keyword: 'インシデント対応 封じ込め 根絶 復旧 CSIRT フォレンジック 証拠保全', tags: ['対応プロセス', 'CSIRT', 'フォレンジック'] },
        { name: 'ログ管理・監視', desc: 'システムのログは、誰がいつ何をしたかの記録。収集・保全・監視して、監査や原因調査に使う。\nログ：**誰が・いつ・何をしたか**の記録。監査・追跡・原因調査の基礎\nSIEM（Security Information and Event Management）：各所のログを集約・相関分析して脅威を検知\nIDS（Intrusion Detection System） / IPS：侵入検知 (Detection) / 侵入防止 (Prevention)\n監査ログの保護：改ざん防止・一元管理・保持期間の設定', keyword: 'ログ管理 SIEM IDS IPS 侵入検知 侵入防止 監査ログ 相関分析', tags: ['SIEM', 'IDS / IPS', '監査ログ'] },
        { name: 'リスク管理とコンプライアンス', desc: 'リスクは「脅威×脆弱性×資産価値」で評価し、回避・低減・移転・受容から対応を選ぶ。あわせて法令や基準の遵守（コンプライアンス）を図る。\nリスクアセスメント：リスクの特定・分析・評価\nコンプライアンス基準：ISO 27001（ISMS）・PCI DSS（カード）・GDPR（個人データ保護）・NIST（米国国立標準技術研究所が定めるセキュリティ基準）\nセキュリティポリシー：組織のルールを文書化し教育・監査で維持', keyword: 'リスク管理 リスクアセスメント コンプライアンス ISO27001 PCI DSS GDPR NIST ISMS', tags: ['リスクアセスメント', 'ISO27001 / PCI DSS', 'コンプライアンス'] },
      ],
    },
  ],
};

// ── 同一サービスの記事グルーピング ───────────────────────────
// 同じサービスの記事（例: Lambda が CLF/SAA/DVA…に別粒度で存在）を束ねて、
//   ・記事同士を相互リンク（同じサービス欄）
//   ・関連(seeAlso)にサービスを挙げたらその全記事を列挙
//   ・タイトルを Lambda①/Lambda② のように番号付きにする
// を実現するためのインデックス。
// グループ化キー = 基底サービス名（括弧の観点ラベルは除去して同一視）。
// スラッシュを含む複合名（比較・複合記事）は過剰グルーピングを避けて独立扱い。
interface Article { id: string; exam: string; secIdx: number; name: string; item: Item; serviceKey: string }

// 同一サービスの記事をまとめるための基底サービス名。詳細記事（「Route 53詳細」「VPC基礎」
// 「Bedrock Agents」等の括弧なし接尾辞）も本体記事とグループ化して相互リンクさせる。
const BASE_SERVICES = [
  'AWS IAM Identity Center', 'Amazon S3 Glacier', 'Amazon Route 53', 'Amazon SageMaker',
  'Amazon CloudWatch', 'Amazon CloudFront', 'Amazon DynamoDB', 'Amazon Bedrock', 'Amazon Kinesis',
  'Amazon Aurora', 'Amazon Cognito', 'Amazon Inspector', 'Amazon VPC', 'Amazon S3',
  'AWS Direct Connect', 'AWS Network Firewall', 'AWS Organizations', 'AWS Shield', 'AWS Config',
  'AWS Glue', 'AWS IAM', 'AWS KMS', 'AWS Systems Manager', 'Amazon GuardDuty', 'AWS Security Hub',
];

function serviceKeyOf(name: string): string {
  // 複合・比較記事（「A / B」「A + B」）は束ねない
  if (name.includes('/') || name.includes('+')) return name;
  // 既知の基底サービス名に最長前方一致すれば、その本体でグループ化
  let best = '';
  for (const b of BASE_SERVICES) {
    if (name.startsWith(b) && b.length > best.length) best = b;
  }
  if (best) return best;
  // それ以外は括弧ラベルを除いた名称でグループ化
  const base = name.replace(/[（(].*$/, '').trim();
  return base || name;
}

// serviceKey -> その全記事（CHEAT_DATA の出現順）
const SERVICE_GROUPS: Map<string, Article[]> = (() => {
  const m = new Map<string, Article[]>();
  for (const [exam, secs] of Object.entries(CHEAT_DATA)) {
    secs.forEach((sec, secIdx) => {
      for (const item of sec.items) {
        const key = serviceKeyOf(item.name);
        let arr = m.get(key);
        if (!arr) { arr = []; m.set(key, arr); }
        arr.push({ id: `${exam}::${secIdx}::${item.name}`, exam, secIdx, name: item.name, item, serviceKey: key });
      }
    });
  }
  return m;
})();

// (資格, 名前) で記事を一意特定（資格内で item 名は一意）
function findArticle(exam: string, name: string): Article | undefined {
  return SERVICE_GROUPS.get(serviceKeyOf(name))?.find(a => a.exam === exam && a.name === name);
}

// 名前 → 同じサービスの全記事（seeAlso 展開用）
function groupOfName(name: string): Article[] {
  return SERVICE_GROUPS.get(serviceKeyOf(name)) ?? [];
}

// 記事の表示番号（グループが2件以上の時のみ 1..、単独なら 0）
function articleNumber(art: Article): number {
  const g = SERVICE_GROUPS.get(art.serviceKey);
  if (!g || g.length < 2) return 0;
  return g.findIndex(a => a.id === art.id) + 1;
}

function circledNumber(n: number): string {
  return n >= 1 && n <= 20 ? String.fromCharCode(0x2460 + n - 1) : `(${n})`;
}

// 表示タイトル:
//   ・feature 記事（name ≠ serviceKey）→ そのまま art.name（"Amazon SageMaker Studio" 等）
//   ・overview 記事（name = serviceKey）→ 同名が複数 exam に存在する場合のみ番号付き
function articleTitle(art: Article): string {
  const n = articleNumber(art);
  if (n === 0) return art.name;
  if (art.name !== art.serviceKey) return art.name;
  // overview が複数 exam に同名で存在する場合のみ番号で区別
  const overviews = (SERVICE_GROUPS.get(art.serviceKey) ?? []).filter(a => a.name === a.serviceKey);
  if (overviews.length <= 1) return art.name;
  const idx = overviews.findIndex(a => a.id === art.id);
  return `${art.serviceKey}${circledNumber(idx + 1)}`;
}

// ── レベル定義（ExamSelectOverlay と同じ構成） ─────────────────
const EXAM_LEVELS = [
  { key: 'Practitioner', color: EXAM_LEVEL_COLORS.Foundational, exams: ['CLF', 'AIF'] },
  { key: 'Business',     color: EXAM_LEVEL_COLORS.Business, exams: ['AIB'] },
  { key: 'Associate',    color: EXAM_LEVEL_COLORS.Associate, exams: ['SAA', 'DVA', 'SOA', 'DEA', 'MLA'] },
  { key: 'Professional', color: EXAM_LEVEL_COLORS.Professional, exams: ['SAP', 'DOP', 'AIP'] },
  { key: 'Specialty',    color: EXAM_LEVEL_COLORS.Specialty, exams: ['ANS', 'SCS'] },
  { key: 'Additional',   color: EXAM_LEVEL_COLORS.Additional, exams: ['ML', 'DB', 'NW', 'SEC'] },
] as const;

// 検索時に横断する全資格の順序
const ALL_EXAM_ORDER: string[] = EXAM_LEVELS.flatMap(l => [...l.exams]);

type LevelKey = typeof EXAM_LEVELS[number]['key'];

// タブ先頭に表示する「このカードの狙い＋関連資格への導線」。
// オリジナルカード→対象資格（前提の先）、公式資格→前提のオリジナルカードを相互にリンクする。
const EXAM_INTRO: Record<string, { note: string; links: { exam: string; label: string }[] }> = {
  // オリジナル資格（前提知識カード）→ 対象の公式資格
  ML:  { note: 'AIF/MLA/AIP で共通して問われる機械学習の基礎を、AWSサービスに依存せず学ぶ前提知識カードです。', links: [{ exam: 'AIF', label: 'AIF' }, { exam: 'MLA', label: 'MLA' }, { exam: 'AIP', label: 'AIP' }] },
  DB:  { note: 'DEA が前提とする SQL・データベースの基礎を学ぶ前提知識カードです。', links: [{ exam: 'DEA', label: 'DEA' }] },
  NW:  { note: 'ANS は公式にネットワークの実務経験が前提。TCP/IP・サブネット・ルーティング等の基礎を学ぶ前提知識カードです。', links: [{ exam: 'ANS', label: 'ANS' }] },
  SEC: { note: 'SCS が前提とするセキュリティの基礎（暗号・認証認可・脅威対応など）を学ぶ前提知識カードです。', links: [{ exam: 'SCS', label: 'SCS' }] },
  // 公式資格 → 前提となるオリジナル資格（基礎固め）
  AIF: { note: '機械学習の基礎（分類・回帰・評価指標・過学習など）は「ML」カードで先に固められます。', links: [{ exam: 'ML', label: 'ML基礎' }] },
  MLA: { note: '前提となる機械学習の基礎は「ML」カードで先に固められます。', links: [{ exam: 'ML', label: 'ML基礎' }] },
  AIP: { note: '前提となる機械学習の基礎は「ML」カードで先に固められます。', links: [{ exam: 'ML', label: 'ML基礎' }] },
  AIB: { note: 'ビジネス職向けの認定です。AI/MLの基礎用語は「ML」カードで、AI×AWSの全体像は「AIF」カードで先に把握しておくと戦略・ガバナンスの理解が進みます。', links: [{ exam: 'ML', label: 'ML基礎' }, { exam: 'AIF', label: 'AIF' }] },
  DEA: { note: '前提となる SQL・データベースの基礎は「DB」カードで先に固められます。', links: [{ exam: 'DB', label: 'DB基礎' }] },
  ANS: { note: '前提となるネットワークの基礎（TCP/IP・サブネット・ルーティング等）は「NW」カードで先に固められます。', links: [{ exam: 'NW', label: 'NW基礎' }] },
  SCS: { note: '前提となるセキュリティの基礎（暗号・認証認可・脅威対応など）は「SEC」カードで先に固められます。', links: [{ exam: 'SEC', label: 'SEC基礎' }] },
};

function levelOf(exam: string): LevelKey {
  return (EXAM_LEVELS.find(l => (l.exams as readonly string[]).includes(exam))?.key ?? 'Associate') as LevelKey;
}

// ── コンポーネント ────────────────────────────────────────────
export default function CheatSheet() {
  const { lang } = useLanguage();
  const ja = lang === 'ja';
  const { user, loading } = useAuth();
  const isMobile = useIsMobile();
  const [activeLevel, setActiveLevel] = useState<LevelKey>('Associate');
  const [selectedExam, setSelectedExam] = useState<string>('SAA');
  // 資格カードの横スクロール行と選択中カード（選択カードが右端で見切れないよう水平スクロールする）
  const examRowRef = useRef<HTMLDivElement>(null);
  const selExamBtnRef = useRef<HTMLButtonElement>(null);
  // レベルタブ行（6レベルはモバイル幅に収まらないので横スクロール＋右端フェード）
  const { ref: levelTabsRef, maskStyle: levelTabsMask } = useHorizontalScrollHint(isMobile);
  const [search, setSearch] = useState('');
  const [goalInit, setGoalInit] = useState(false);
  const [copiedTerm, setCopiedTerm] = useState<string | null>(null);
  const [pendingScrollTo, setPendingScrollTo] = useState<string | null>(null);
  const [highlightedItem, setHighlightedItem] = useState<string | null>(null);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [headerVisible, setHeaderVisible] = useState(true);
  const [headerHeight, setHeaderHeight] = useState(0);
  const headerRef = useRef<HTMLDivElement>(null);
  const lastScrollRef = useRef(0);
  const navigatingRef = useRef(false);
  const [deletionMap, setDeletionMap] = useState<Record<string, { reason: string; deleteDate: string }>>({});

  // 削除予定フラグ（`${exam}::${item.name}` キー）。期日を過ぎた項目は非表示、
  // 未到達の項目は警告バナー表示に使う。
  useEffect(() => {
    fetch(`${API_ENDPOINT}/cheatsheet-deletions`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        const items: { itemKey: string; reason: string; deleteDate: string }[] = data?.items ?? [];
        const map: Record<string, { reason: string; deleteDate: string }> = {};
        for (const it of items) {
          if (it.itemKey) map[it.itemKey] = { reason: it.reason, deleteDate: it.deleteDate };
        }
        setDeletionMap(map);
      })
      .catch(() => {});
  }, []);

  function handleTermCopy(term: string) {
    navigator.clipboard.writeText(term);
    setCopiedTerm(term);
    setTimeout(() => setCopiedTerm(null), 1500);
  }

  // 記事ID（`${exam}::${secIdx}::${name}`）で特定の記事へ遷移する。
  // 同名記事が複数資格にあるため、名前ではなくIDで一意に飛ぶ。
  function navigateToArticle(id: string) {
    const targetExam = id.split('::')[0];
    setSearch('');
    setHeaderVisible(true);
    navigatingRef.current = true;
    if (!CHEAT_DATA[targetExam]) { navigatingRef.current = false; return; }
    if (targetExam !== selectedExam) {
      setActiveLevel(levelOf(targetExam) as LevelKey);
      setSelectedExam(targetExam);
    }
    setPendingScrollTo(id);
    setTimeout(() => { navigatingRef.current = false; }, 1000);
  }

  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeaderHeight(el.offsetHeight));
    ro.observe(el);
    setHeaderHeight(el.offsetHeight);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const container = document.getElementById('main-scroll');
    if (!container) return;
    const onScroll = () => {
      const st = container.scrollTop;
      setShowScrollTop(st > 300);
      if (navigatingRef.current) { lastScrollRef.current = st; return; }
      const delta = st - lastScrollRef.current;
      if (st <= 0) {
        setHeaderVisible(true);
      } else if (Math.abs(delta) > 4) {
        setHeaderVisible(delta < 0);
      }
      lastScrollRef.current = st;
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!pendingScrollTo) return;
    const escaped = pendingScrollTo.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const el = document.querySelector<HTMLElement>(`[data-article-id="${escaped}"]`);
    if (el) {
      const container = document.getElementById('main-scroll');
      if (container) {
        const rect = el.getBoundingClientRect();
        const cRect = container.getBoundingClientRect();
        // 記事パネルの上端を（固定ヘッダーの下に）合わせる。中央寄せだと大きい記事の
        // 冒頭が見切れるため、上端基準にして記事の始まりを常に見せる。
        const topMargin = (headerHeight || 104) + 8;
        const offset = container.scrollTop + rect.top - cRect.top - topMargin;
        container.scrollTo({ top: Math.max(0, offset), behavior: 'smooth' });
      } else {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      setHighlightedItem(pendingScrollTo);
      setTimeout(() => setHighlightedItem(null), 1500);
      setPendingScrollTo(null);
    }
  }, [selectedExam, pendingScrollTo, headerHeight]);

  // 選択中の資格カードが横スクロール行内で見切れないように水平スクロール位置を合わせる
  // （例: 目標資格=MLA のとき Associate の最後尾 MLA が右端で切れるのを防ぐ）。
  // 垂直スクロールは動かさず、行内の scrollLeft だけ調整する。
  useEffect(() => {
    const row = examRowRef.current;
    const btn = selExamBtnRef.current;
    if (!row || !btn) return;
    const bLeft = btn.offsetLeft;
    const bRight = bLeft + btn.offsetWidth;
    const viewLeft = row.scrollLeft;
    const viewRight = viewLeft + row.clientWidth;
    if (bRight > viewRight) {
      row.scrollTo({ left: bRight - row.clientWidth + 8, behavior: 'smooth' });
    } else if (bLeft < viewLeft) {
      row.scrollTo({ left: Math.max(0, bLeft - 8), behavior: 'smooth' });
    }
  }, [selectedExam, activeLevel, isMobile]);

  // 選択中のレベルタブが行内で見切れないよう水平スクロール位置を合わせる。
  // （例: 目標資格が ML/DB/NW/SEC のとき末尾の「オリジナル」が画面外になるのを防ぐ）
  // 資格カード行と同じ方式。垂直スクロールは動かさない。
  useEffect(() => {
    const row = levelTabsRef.current;
    const btn = row?.querySelector<HTMLElement>(`[data-level="${activeLevel}"]`);
    if (!row || !btn) return;
    const bLeft = btn.offsetLeft;
    const bRight = bLeft + btn.offsetWidth;
    const viewLeft = row.scrollLeft;
    if (bRight > viewLeft + row.clientWidth) {
      row.scrollTo({ left: bRight - row.clientWidth + 8, behavior: 'smooth' });
    } else if (bLeft < viewLeft) {
      row.scrollTo({ left: Math.max(0, bLeft - 8), behavior: 'smooth' });
    }
  }, [activeLevel, isMobile, levelTabsRef]);

  useEffect(() => {
    if (loading || goalInit) return;
    setGoalInit(true);
    // ゲストも targetExam_guest に目標資格を持つ（オンボーディングで設定される）。
    // 以前は user がある時だけ読んでいたため、ゲストは目標資格に関係なく常に
    // 既定の Associate/SAA で開いていた。閲覧はゲストにも開放している機能なので uid で引く。
    const uid = user?.userId ?? 'guest';
    const goal = localStorage.getItem(`targetExam_${uid}`);
    if (goal && CHEAT_DATA[goal]) {
      setActiveLevel(levelOf(goal) as LevelKey);
      setSelectedExam(goal);
    }
  }, [user, loading, goalInit]);

  const examColor = EXAM_LEVEL_COLORS[EXAM_LEVEL[selectedExam]] ?? 'var(--color-primary)';
  const levelColor = EXAM_LEVELS.find(l => l.key === activeLevel)?.color ?? examColor;
  const currentLevelExams = EXAM_LEVELS.find(l => l.key === activeLevel)?.exams ?? [];
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  // 削除予定日を過ぎた項目は一覧から除外（ソース側のCHEAT_DATAは変更しない非表示化）
  const q = search.trim().toLowerCase();

  // 検索時は全資格を横断して対象にする。非検索時は選択中の資格のみ表示。
  // 各セクションに exam を持たせ、検索結果を資格ごとにグループ表示する。
  const filteredSections = useMemo(() => {
    const notDeleted = (exam: string, name: string) => {
      const d = deletionMap[`${exam}::${name}`];
      return !d || d.deleteDate > today;
    };
    if (!q) {
      return (CHEAT_DATA[selectedExam] ?? [])
        .map(sec => ({ exam: selectedExam, title: sec.title, items: sec.items.filter(it => notDeleted(selectedExam, it.name)) }))
        .filter(sec => sec.items.length > 0);
    }
    const match = (it: Item) =>
      it.name.toLowerCase().includes(q) ||
      it.desc.toLowerCase().includes(q) ||
      it.tags.some(t => t.toLowerCase().includes(q));
    const out: { exam: string; title: string; items: Item[] }[] = [];
    for (const exam of ALL_EXAM_ORDER) {
      for (const sec of (CHEAT_DATA[exam] ?? [])) {
        const items = sec.items.filter(it => match(it) && notDeleted(exam, it.name));
        if (items.length) out.push({ exam, title: sec.title, items });
      }
    }
    return out;
  }, [q, selectedExam, deletionMap, today]);

  const totalHits = filteredSections.reduce((s, sec) => s + sec.items.length, 0);

  const allNames = useMemo(() => {
    const seen = new Set<string>();
    for (const secs of Object.values(CHEAT_DATA)) {
      for (const sec of secs) {
        for (const it of sec.items) seen.add(it.name);
      }
    }
    return [...seen].sort((a, b) => b.length - a.length);
  }, []);

  function selectExam(exam: string) {
    setSelectedExam(exam);
    setSearch('');
    setPendingScrollTo(null);
    document.getElementById('main-scroll')?.scrollTo({ top: 0, behavior: 'instant' });
  }

  function selectLevel(lv: LevelKey) {
    setActiveLevel(lv);
    const lvDef = EXAM_LEVELS.find(l => l.key === lv);
    const first = lvDef?.exams.find(e => CHEAT_DATA[e]) ?? lvDef?.exams[0];
    if (first) selectExam(first);
  }

  // 別タブ（関連資格・前提知識カード）へ切り替える導線
  function switchExam(exam: string) {
    if (!CHEAT_DATA[exam]) return;
    setActiveLevel(levelOf(exam) as LevelKey);
    selectExam(exam);
  }

  const padX = isMobile ? 'var(--page-pad-x-mobile)' : 'var(--page-pad-x)';
  const padY = isMobile ? 'var(--page-pad-y-mobile)' : 'var(--page-pad-y)';

  const stickyHeader = (
    <div
      ref={headerRef}
      style={{
        position: 'fixed',
        top: 56,
        left: 'var(--content-left, 0px)',
        right: 0,
        zIndex: 80,
        background: 'var(--color-bg-main)',
        borderBottom: '1px solid var(--color-border)',
        boxShadow: 'var(--box-shadow-sm)',
        transform: headerVisible ? 'translateY(0)' : 'translateY(-100%)',
        transition: 'transform 0.25s ease',
      }}
    >
      <div style={{ maxWidth: 860, margin: '0 auto', padding: `var(--spacing-sm) ${padX} 0` }}>
        {/* 検索バー */}
        <div style={{ position: 'relative', marginBottom: 'var(--spacing-md)' }}>
          <div style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-text-light)', display: 'flex', pointerEvents: 'none' }}>
            <IconSearch />
          </div>
          <input
            type="search"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="全資格から検索（サービス名・キーワード）"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '8px 12px 8px 34px',
              borderRadius: 'var(--border-radius-md)',
              border: '1.5px solid var(--color-border)',
              background: 'var(--color-bg-white)',
              color: 'var(--color-text-main)',
              fontSize: 'var(--font-size-sm)',
              outline: 'none',
            }}
          />
        </div>
        {/* レベルタブ：目標資格設定オーバーレイ(ExamSelectOverlay)とデザインを統一（flex:1 均等・levelLabel） */}
        <div
          ref={levelTabsRef}
          style={{ display: 'flex', borderBottom: '2px solid var(--color-border)', marginBottom: 0, overflowX: isMobile ? 'auto' : 'visible', scrollbarWidth: 'none', ...levelTabsMask }}
        >
          {EXAM_LEVELS.map(({ key, color }) => (
            <button
              key={key}
              data-level={key}
              onClick={() => selectLevel(key as LevelKey)}
              style={{
                flex: isMobile ? '0 0 auto' : 1, textAlign: 'center', whiteSpace: 'nowrap',
                padding: isMobile ? '10px 8px' : '10px 14px',
                background: 'none', border: 'none', cursor: 'pointer',
                borderBottom: activeLevel === key ? `2px solid ${color}` : '2px solid transparent',
                marginBottom: -2,
                color: activeLevel === key ? color : 'var(--color-text-sub)',
                fontWeight: activeLevel === key ? 700 : 400,
                fontSize: isMobile ? 'var(--font-size-xs)' : 'var(--font-size-sm2)',
                transition: 'all 0.15s',
              }}
            >
              {levelLabel(key, ja)}
            </button>
          ))}
        </div>
        {/* 試験カード（横スクロール）：目標資格設定オーバーレイ(ExamSelectOverlay)とデザインを統一 */}
        <div ref={examRowRef} style={{ display: 'flex', gap: 10, padding: '14px 0', overflowX: 'auto', flexShrink: 0 }}>
          {currentLevelExams.filter(e => CHEAT_DATA[e]).map(exam => {
            const isSelected = selectedExam === exam;
            const EIcon = EXAM_ICON_COMPONENTS[exam];
            return (
              <button
                key={exam}
                ref={isSelected ? selExamBtnRef : undefined}
                onClick={() => selectExam(exam)}
                style={{
                  flexShrink: 0, width: 80, padding: '10px 6px 8px', cursor: 'pointer',
                  borderRadius: 10, textAlign: 'center', position: 'relative',
                  border: `2px solid ${isSelected ? levelColor : 'var(--color-border)'}`,
                  background: isSelected ? levelColor : 'var(--color-bg-card)',
                  transition: 'all 0.15s',
                }}
              >
                {EIcon && (
                  <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 4, color: isSelected ? levelOn(levelColor) : 'var(--color-text-light)' }}>
                    <EIcon size={18} />
                  </div>
                )}
                <div style={{ fontWeight: 800, fontSize: 'var(--font-size-md)', color: isSelected ? levelOn(levelColor) : 'var(--color-text-main)', lineHeight: 1 }}>{exam}</div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );

  return (
    <>
      {typeof window !== 'undefined' && createPortal(stickyHeader, document.body)}
      <PageLayout maxWidth={860}>
        {/* 固定ヘッダー分の余白スペーサー（marginTop で PageLayout の top padding を相殺） */}
        <div style={{ height: headerHeight || 104, marginTop: `calc(-1 * ${padY})` }} />

      {/* 用語コピーヒント */}
      {!q && (
        <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-points)', marginBottom: 'var(--spacing-sm)', marginTop: 0 }}>
          色付き太字の用語はタップしてコピーできます（検索向けに文脈補足が付く場合あり）
        </p>
      )}

      {/* カードの狙い＋関連資格への導線（オリジナルカード / AIF） */}
      {!q && EXAM_INTRO[selectedExam] && (
        <div style={{ background: tint(examColor, 6), border: `1px solid ${tint(examColor, 33)}`, borderRadius: 'var(--border-radius-md)', padding: '10px 12px', marginBottom: 'var(--spacing-md)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-sub)', lineHeight: 1.6 }}>{EXAM_INTRO[selectedExam].note}</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-light)', flexShrink: 0 }}>関連:</span>
            {EXAM_INTRO[selectedExam].links.map(l => (
              <button
                key={l.exam}
                onClick={() => switchExam(l.exam)}
                style={{ padding: '3px 10px', borderRadius: 'var(--border-radius-md)', border: `1.5px solid ${examColor}`, background: 'var(--color-bg-white)', color: levelText(examColor), fontSize: 'var(--font-size-2xs)', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}
              >{l.label} →</button>
            ))}
          </div>
        </div>
      )}

      {/* 検索ヒット数 */}
      {q && (
        <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-sub)', marginBottom: 'var(--spacing-sm)' }}>
          「{search}」: {totalHits} 件
        </p>
      )}
      {q && totalHits === 0 && (
        <p style={{ color: 'var(--color-text-light)', fontSize: 'var(--font-size-sm)', textAlign: 'center', padding: 'var(--spacing-xl)' }}>
          該当するサービス・概念が見つかりませんでした
        </p>
      )}

      {/* セクション一覧 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}>
        {filteredSections.map(section => {
          const secColor = EXAM_LEVEL_COLORS[EXAM_LEVEL[section.exam]] ?? examColor;
          return (
          <div key={`${section.exam}-${section.title}`}>
            <h2 style={{
              fontSize: 'var(--font-size-sm)',
              fontWeight: 700,
              color: levelText(secColor),
              margin: '0 0 var(--spacing-sm)',
              paddingBottom: 6,
              borderBottom: `2px solid ${tint(secColor, 19)}`,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}>
              <span style={{ display: 'inline-block', width: 3, height: 14, background: secColor, borderRadius: 2 }} />
              {/* 検索時はどの資格の記事かを示すバッジを表示 */}
              {q && <span style={{ fontSize: 'var(--font-size-2xs)', fontWeight: 700, color: levelOn(secColor), background: secColor, borderRadius: 'var(--border-radius-sm)', padding: '1px 8px', flexShrink: 0 }}>{section.exam}</span>}
              {section.title}
            </h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(400px, 100%), 1fr))', gap: 'var(--spacing-sm)' }}>
              {section.items.map(item => (
                <ItemCard key={`${section.exam}-${item.name}`} item={item} exam={section.exam} q={q} allNames={allNames} highlightedId={highlightedItem} onCopy={handleTermCopy} onNavigate={navigateToArticle} scheduledDeletion={deletionMap[`${section.exam}::${item.name}`]} />
              ))}
            </div>
          </div>
          );
        })}
      </div>
      {/* トップへ戻るボタン */}
      {showScrollTop && (
        <button
          onClick={() => {
            const el = document.getElementById('main-scroll');
            if (!el) return;
            const start = el.scrollTop;
            const t0 = performance.now();
            const step = (now: number) => {
              const p = Math.min((now - t0) / 200, 1);
              el.scrollTop = start * (1 - p) ** 3;
              if (p < 1) requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
          }}
          title="トップへ戻る"
          style={{
            position: 'fixed',
            bottom: 80,
            right: 16,
            width: 44,
            height: 44,
            borderRadius: '50%',
            border: '1px solid var(--color-border)',
            background: 'var(--color-bg-white)',
            boxShadow: 'var(--box-shadow-md)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
            color: 'var(--color-text-main)',
          }}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m18 15-6-6-6 6"/>
          </svg>
        </button>
      )}
      {/* コピー完了トースト */}
      {copiedTerm !== null && (
        <div style={{
          position: 'fixed',
          bottom: 80,
          left: '50%',
          transform: 'translateX(-50%)',
          background: 'var(--color-points)',
          color: 'var(--color-on-points)',
          padding: '8px 20px',
          borderRadius: 'var(--border-radius-full)',
          fontSize: 'var(--font-size-sm)',
          fontWeight: 600,
          boxShadow: 'var(--box-shadow-md)',
          zIndex: 9999,
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
        }}>
          コピーしました
        </div>
      )}
      </PageLayout>
    </>
  );
}

// 「用語: 説明」の用語らしさ判定（文中コロンの誤検出を除外）。未閉じ括弧・句点・過長は用語ではない。
// 「〜例」のようにリストの導入に過ぎないラベルは用語扱いしない（強調・◯を付けない）
function isIntroLabel(t: string): boolean {
  return /例$/.test(t);
}

function isCleanTermLabel(t: string): boolean {
  if (t.length > 30 || /[。！？\n]/.test(t)) return false;
  if (isIntroLabel(t)) return false;
  const open = (t.match(/[（(]/g) || []).length;
  const close = (t.match(/[）)]/g) || []).length;
  return open === close;
}

// 括弧の外側にある最初の全角コロンの位置を返す（括弧内グロスの「：」を区切りと誤認しないため）
function topLevelColonIndex(s: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '（' || c === '(') depth++;
    else if (c === '）' || c === ')') depth = Math.max(0, depth - 1);
    else if (c === '：' && depth === 0) return i;
  }
  return -1;
}

// 親概念（直後に「- 」子項目が続く行）か判定。親子構造はオリジナル資格に多い
function isParentLine(lines: string[], i: number): boolean {
  return !lines[i].startsWith('- ') && i + 1 < lines.length && lines[i + 1].startsWith('- ');
}

// 「◯」を付ける対象＝トップレベル（子でない）の用語行か判定。
// 親概念（子を持つ行）に加え、用語見出し行（isITTerm/isBoldTerm 相当）も同じ階層の用語として対象にする。
function isTopTermLine(lines: string[], i: number): boolean {
  const l = lines[i];
  if (l.startsWith('- ')) return false;
  // ①②…のような丸付き数字始まりの行には◯を重ねない
  if (/^[①-⑳㉑-㊿]/.test(l)) return false;
  if (isParentLine(lines, i)) return true; // 子を持つ親（コロン無しの見出しも含む）
  const ci = topLevelColonIndex(l);
  if (ci <= 0) return false;
  const t = l.slice(0, ci).replace(/\*\*/g, '');
  const isIT = !/。/.test(t) && !isIntroLabel(t) && !SIMPLE_TERMS.has(t) && (/[A-Za-z]/.test(t) || EXTRA_COPYABLE_TERMS.has(t));
  const isBold = !isIT && isCleanTermLabel(t);
  return isIT || isBold;
}

// desc を表示と同じプレーンテキストへ整形（紹介する用語行に「◯ 」・子概念に「・」を付与）してコピーに使う
function descToPlainText(desc: string): string {
  const lines = desc.split('\n');
  return lines
    .map((line, i) => {
      const body = line.replace(/\*\*/g, '');
      if (body.startsWith('- ')) return '・' + body.slice(2);
      return isTopTermLine(lines, i) ? '◯ ' + body : body;
    })
    .join('\n');
}

function ItemCard({ item, exam, q, allNames, highlightedId, onCopy, onNavigate, scheduledDeletion }: { item: Item; exam: string; q: string; allNames: string[]; highlightedId: string | null; onCopy: (term: string) => void; onNavigate: (id: string) => void; scheduledDeletion?: { reason: string; deleteDate: string } }) {
  const [allCopied, setAllCopied] = useState(false);
  // リンクが7件以上になるカテゴリを「もっと見る」で展開するための状態（カテゴリ名ごとに独立）
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  // この記事のグループ情報（表示番号・同じサービスの兄弟記事の解決に使う）
  const article = useMemo(() => findArticle(exam, item.name), [exam, item.name]);
  const title = article ? articleTitle(article) : item.name;
  const highlighted = !!article && highlightedId === article.id;
  const handleCopyAll = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(`${item.name}\n\n${descToPlainText(item.desc)}`).then(() => {
      setAllCopied(true);
      setTimeout(() => setAllCopied(false), 1500);
    });
  };

  const highlight = (text: string): React.ReactNode => {
    if (!q) return text;
    const idx = text.toLowerCase().indexOf(q);
    if (idx < 0) return text;
    return (
      <>
        {text.slice(0, idx)}
        <mark style={{ background: '#fef08a', color: 'inherit', borderRadius: 2 }}>{text.slice(idx, idx + q.length)}</mark>
        {text.slice(idx + q.length)}
      </>
    );
  };

  // desc内の **強調** を黒太字にしつつ検索ハイライトも適用する（各記事の最重要フレーズ用）
  const renderRich = (text: string): React.ReactNode => {
    const parts: React.ReactNode[] = [];
    const re = /\*\*(.+?)\*\*/g;
    let last = 0, k = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parts.push(<React.Fragment key={`t${k}`}>{highlight(text.slice(last, m.index))}</React.Fragment>);
      parts.push(<strong key={`b${k}`} style={{ fontWeight: 700, color: 'var(--color-text-main)' }}>{highlight(m[1])}</strong>);
      last = m.index + m[0].length; k++;
    }
    if (last < text.length) parts.push(<React.Fragment key={`t${k}`}>{highlight(text.slice(last))}</React.Fragment>);
    return <>{parts}</>;
  };

  const autoSeeAlso = useMemo(() => {
    const existing = new Set(item.seeAlso ?? []);
    const names = allNames.filter(n => n !== item.name && !existing.has(n));
    if (names.length === 0) return [];
    const escaped = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const regex = new RegExp(escaped.join('|'), 'g');
    const found = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = regex.exec(item.desc)) !== null) found.add(match[0]);
    return [...found].sort((a, b) => a.localeCompare(b, 'ja'));
  }, [item, allNames]);

  // 親記事 — 自分が機能記事（name ≠ serviceKey）の場合、同じサービスの概要記事（name = serviceKey）。
  // サービス名のみの概要記事は全資格を通して1つの原則（docs/05-screens.md参照）なので、
  // 資格をまたいでも常に「親記事」側で優先的に確定させる（同じサービスに奪われないよう先に計算）。
  const parentArticles = useMemo(() => {
    if (!article || article.name === article.serviceKey) return [] as Article[];
    return (SERVICE_GROUPS.get(article.serviceKey) ?? []).filter(a => a.name === a.serviceKey);
  }, [article]);

  // 子記事 — 自分が概要記事（name = serviceKey）の場合、同じサービスの機能記事（name ≠ serviceKey）。
  const childArticles = useMemo(() => {
    if (!article || article.name !== article.serviceKey) return [] as Article[];
    return (SERVICE_GROUPS.get(article.serviceKey) ?? []).filter(a => a.name !== a.serviceKey);
  }, [article]);

  // 同じサービスの他記事 — 自分と完全に同名の記事が別資格にもある場合のみ（例:「Amazon SageMaker
  // Clarify」がAIFとMLA双方にある等）。親記事(概要記事)・子記事(機能記事)とは名前が異なるため
  // 自然に排他になる。
  const siblings = useMemo(() => {
    if (!article) return [] as Article[];
    return (SERVICE_GROUPS.get(article.serviceKey) ?? []).filter(a => a.id !== article.id && a.name === article.name);
  }, [article]);

  // 関連サービス — seeAlso/自動検出で挙がった「他サービス」の全記事を展開して列挙。
  // 自分自身・同じサービス（同じサービス/親記事/子記事）は除外し、純粋な他サービスのみ残す。
  const relatedArticles = useMemo(() => {
    const seen = new Set<string>();
    if (article) seen.add(article.id);
    siblings.forEach(a => seen.add(a.id));
    parentArticles.forEach(a => seen.add(a.id));
    childArticles.forEach(a => seen.add(a.id));
    const out: Article[] = [];
    for (const nm of [...(item.seeAlso ?? []), ...autoSeeAlso]) {
      for (const a of groupOfName(nm)) {
        if (seen.has(a.id)) continue;
        if (article && a.serviceKey === article.serviceKey) continue;
        seen.add(a.id);
        out.push(a);
      }
    }
    return out;
  }, [item.seeAlso, autoSeeAlso, article, siblings, parentArticles, childArticles]);

  function copyWithContext(text: string) {
    // termKeywords 等で既に（）文脈が付いている場合はそのままコピー
    if (text.includes('（') || text.includes('(')) { onCopy(text); return; }
    // 括弧なし部分だけを文脈ラベルとして使用（"AWS CDK（Cloud Development Kit）" → "AWS CDK"）
    const context = item.name.replace(/[（(][^）)]*[）)]/g, '').trim();
    const t = text.toLowerCase();
    const ct = context.toLowerCase();
    // 用語と文脈ラベルが互いを含む場合は文脈不要
    if (t.includes(ct) || ct.includes(t)) { onCopy(text); return; }
    onCopy(`${text}（${context}）`);
  }

  return (
    <div
      data-article-id={article?.id ?? item.name}
      style={{
        background: 'var(--color-bg-white)',
        border: highlighted ? '1px solid var(--color-points)' : '1px solid var(--color-border)',
        borderRadius: 'var(--border-radius-md)',
        padding: '10px 12px',
        boxShadow: highlighted ? '0 0 0 3px rgba(0,158,158,0.2)' : 'var(--box-shadow-sm)',
        transition: 'border-color 0.3s, box-shadow 0.3s',
      }}
    >
      <div style={{ marginBottom: 4, display: 'flex', alignItems: 'flex-start', gap: 'var(--spacing-xs)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {(/[A-Za-z]/.test(item.name) || /[゠-ヿ]{5,}/.test(item.name)) ? (
            <div
              onClick={() => copyWithContext(item.keyword ?? item.name.replace(/[（(][^）)]*[）)]/g, '').trim())}
              title="タップしてコピー"
              style={{ fontWeight: 700, fontSize: 'var(--font-size-base)', color: 'var(--color-points)', cursor: 'pointer' }}
            >
              {highlight(title)}
            </div>
          ) : (
            <div style={{ fontWeight: 700, fontSize: 'var(--font-size-base)', color: 'var(--color-text-main)' }}>
              {highlight(title)}
            </div>
          )}
        </div>
        <button
          onClick={handleCopyAll}
          title={allCopied ? 'コピー済み' : '記事全体をコピー（AI質問用）'}
          style={{
            flexShrink: 0,
            background: 'none',
            border: `1.5px solid ${allCopied ? 'var(--color-success)' : 'var(--color-border)'}`,
            borderRadius: '50%',
            width: 28, height: 28,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer',
            color: allCopied ? 'var(--color-success)' : 'var(--color-text-light)',
            transition: 'all 0.2s',
          }}
        >
          {allCopied ? <IconCheck size={13} /> : <IconCopy size={13} />}
        </button>
      </div>
      {scheduledDeletion && (
        <div style={{ background: '#FFF4E5', border: '1px solid #F5A623', borderRadius: 'var(--border-radius-md)', padding: '8px 12px', marginBottom: 8, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <span style={{ flexShrink: 0, fontSize: 'var(--font-size-base)', lineHeight: 1.6 }}>⚠️</span>
          <span style={{ fontSize: 'var(--font-size-xs)', color: '#8A5A00', lineHeight: 1.6, overflowWrap: 'break-word', wordBreak: 'break-word' }}>
            この項目は{scheduledDeletion.deleteDate}に削除されます（理由: {scheduledDeletion.reason}）。
          </span>
        </div>
      )}
      <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', margin: 0, lineHeight: 1.6 }}>
        {(() => { const lines = item.desc.split('\n'); return lines.map((line, i) => {
          // 先頭「- 」は下位概念（子項目）。インデントして親子関係を明示する
          const isChild = line.startsWith('- ');
          // 紹介する用語行（親子関係の有無に関わらず）には行頭に「◯」を付与
          const hasCircle = isTopTermLine(lines, i);
          const body = isChild ? line.slice(2) : line;
          const colonIdx = topLevelColonIndex(body);
          // 用語は既にティール/黒太字で強調されるため、用語内の **強調** 記法は除去して二重強調・記号残りを防ぐ
          const term = colonIdx > 0 ? body.slice(0, colonIdx).replace(/\*\*/g, '') : '';
          // ASCII英字を含む、またはEXTRA_COPYABLE_TERMSに含まれる場合にIT用語として強調
          // 用語部に「。」を含む＝文中コロン(文＋見出し)なので用語扱いしない
          const isITTerm = colonIdx > 0 && !/。/.test(term) && !isIntroLabel(term) && !SIMPLE_TERMS.has(term) && (
            /[A-Za-z]/.test(term) ||
            EXTRA_COPYABLE_TERMS.has(term)
          );
          // 「用語: 説明」の日本語用語（コピー対象外）は黒太字で強調する。文中コロン(未閉じ括弧等)は除外
          const isBoldTerm = !isITTerm && colonIdx > 0 && isCleanTermLabel(term);
          const copyTerm = item.termKeywords?.[term] ?? term;
          const inner = isITTerm ? (
            <>
              <span
                onClick={() => copyWithContext(copyTerm)}
                title={copyTerm !== term ? `コピー: ${copyTerm}` : 'タップしてコピー'}
                style={{ fontWeight: 700, color: 'var(--color-points)', cursor: 'pointer' }}
              >{highlight(term)}</span>
              {'：'}
              {renderRich(body.slice(colonIdx + 1))}
            </>
          ) : isBoldTerm ? (
            <>
              <strong style={{ fontWeight: 700, color: 'var(--color-text-main)' }}>{highlight(term)}</strong>
              {'：'}
              {renderRich(body.slice(colonIdx + 1))}
            </>
          ) : renderRich(body);
          // 子項目(下位概念)は「・」プレフィックスで表示（インデント無し。スマホの横幅対策＆見慣れた記号に）
          // 用語行は「◯ 」プレフィックス（後ろに半角空白）。◯は黒太字（用語自体の強調とは独立）
          const content = isChild ? (
            <><span style={{ color: 'var(--color-text-light)' }}>・</span>{inner}</>
          ) : hasCircle ? (
            <><span style={{ color: 'var(--color-text-main)', fontWeight: 700 }}>{'◯ '}</span>{inner}</>
          ) : inner;
          return (
            <React.Fragment key={i}>
              {i > 0 && <br />}
              {content}
            </React.Fragment>
          );
        }); })()}
      </p>
      {(parentArticles.length > 0 || childArticles.length > 0 || siblings.length > 0 || relatedArticles.length > 0) && (
        <div style={{ marginTop: 8, paddingTop: 6, borderTop: '1px solid var(--color-border)', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {/* 親記事（自分が機能記事の場合の、同じサービスの概要記事） */}
          <LinkChipGroup groupKey="parent" label="親記事" articles={parentArticles}
            labelFn={a => a.exam} expandedGroups={expandedGroups} setExpandedGroups={setExpandedGroups} onNavigate={onNavigate} />
          {/* 子記事（自分が概要記事の場合の、同じサービスの機能記事） */}
          <LinkChipGroup groupKey="child" label="子記事" articles={childArticles}
            labelFn={a => articleTitle(a)} expandedGroups={expandedGroups} setExpandedGroups={setExpandedGroups} onNavigate={onNavigate} />
          {/* 同じサービスの他資格・他観点版へのリンク */}
          <LinkChipGroup groupKey="sibling" label="同じサービス" articles={siblings}
            labelFn={a => a.exam} expandedGroups={expandedGroups} setExpandedGroups={setExpandedGroups} onNavigate={onNavigate} />
          {/* 関連サービス（挙げたサービスの全記事を展開） */}
          <LinkChipGroup groupKey="related" label="関連" articles={relatedArticles}
            labelFn={a => articleTitle(a)} expandedGroups={expandedGroups} setExpandedGroups={setExpandedGroups} onNavigate={onNavigate} />
        </div>
      )}
    </div>
  );
}

function ArticleChip({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        fontSize: 'var(--font-size-2xs)',
        color: 'var(--color-points)',
        background: 'rgba(0,158,158,0.08)',
        border: '1px solid rgba(0,158,158,0.25)',
        borderRadius: 'var(--border-radius-md)',
        padding: '1px 8px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >→ {label}</button>
  );
}

// カテゴリごとのリンク一覧。3件までは常時表示、4件目以降は「もっと見る」で展開する
// （カテゴリ内でチップが増え続けてカードが肥大化するのを防ぐため）。
const LINK_GROUP_VISIBLE_MAX = 3;

function LinkChipGroup({ groupKey, label, articles, labelFn, expandedGroups, setExpandedGroups, onNavigate }: {
  groupKey: string;
  label: string;
  articles: Article[];
  labelFn: (a: Article) => string;
  expandedGroups: Set<string>;
  setExpandedGroups: React.Dispatch<React.SetStateAction<Set<string>>>;
  onNavigate: (id: string) => void;
}) {
  if (articles.length === 0) return null;
  const expanded = expandedGroups.has(groupKey);
  const hidden = articles.length - LINK_GROUP_VISIBLE_MAX;
  const visible = expanded || hidden <= 0 ? articles : articles.slice(0, LINK_GROUP_VISIBLE_MAX);
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
      <span style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-light)' }}>{label}:</span>
      {visible.map(a => (
        <ArticleChip key={a.id} label={labelFn(a)} onClick={() => onNavigate(a.id)} />
      ))}
      {!expanded && hidden > 0 && (
        <button
          onClick={() => setExpandedGroups(prev => new Set(prev).add(groupKey))}
          style={{
            fontSize: 'var(--font-size-2xs)',
            color: 'var(--color-text-light)',
            background: 'none',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--border-radius-md)',
            padding: '1px 8px',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >+{hidden}件 もっと見る</button>
      )}
    </div>
  );
}
