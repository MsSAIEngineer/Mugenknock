import EXAM_DOMAINS_MASTER from './data/examDomains.json';

export const API_ENDPOINT = process.env.NEXT_PUBLIC_API_ENDPOINT
  ?? 'https://a0q3656qw4.execute-api.ap-northeast-1.amazonaws.com/dev';

export const ADMIN_EMAIL = 'mugenknock@gmail.com';

export const EXAM_TYPES = ['CLF', 'AIF', 'AIB', 'SAA', 'DVA', 'SOA', 'DEA', 'MLA', 'SAP', 'DOP', 'AIP', 'ANS', 'SCS', 'ML', 'DB', 'NW', 'SEC'] as const;
export type ExamType = typeof EXAM_TYPES[number];

// 「Additional」レベルの非AWS外部知識カード。AWS認定ではなく、各AWS資格が前提とする
// AWS外の土台知識（機械学習・データベース・ネットワーク・セキュリティ）を補うための独自カード。
export const NON_AWS_EXAM_TYPES = new Set<string>(['ML', 'DB', 'NW', 'SEC']);
export const isNonAwsExam = (examType: string): boolean => NON_AWS_EXAM_TYPES.has(examType);

// 公式資格 → 前提知識(オリジナル資格)の対応表。通常演習（サクッと演習/しっかり対策/
// トレーニング演習タブ）で、対応する公式資格を対象にすると既定でこのオリジナル資格の
// 問題も出題プールに混ざる（specs/003-original-exam-blend）。模擬試験には適用しない。
// lambda/src/app.js にも同じ対応表がある（FE/BEで別コードベースのため重複定義）。
export const COMPANION_EXAM: Record<string, string> = { AIF: 'ML', MLA: 'ML', AIP: 'ML', DEA: 'DB', ANS: 'NW', SCS: 'SEC' };

// COMPANION_EXAM の逆引き: 基礎知識資格(ML/DB/NW/SEC) → それを既定で含む公式資格一覧。
// 目標資格設定パネル・演習設定パネルで「お互いの資格の存在」を案内するのに使う。
export function officialExamsForCompanion(companionExamType: string): string[] {
  return Object.entries(COMPANION_EXAM)
    .filter(([, companion]) => companion === companionExamType)
    .map(([official]) => official);
}

// 合格スコア（スケールスコア 100〜1000 での公式合格ライン）
export const PASS_SCORES: Record<string, number> = {
  CLF: 700,
  SAA: 720,
  SAP: 750,
  DVA: 720,
  SOA: 720,
  DEA: 720,
  DOP: 750,
  AIF: 700,
  AIB: 700,
  MLA: 720,
  AIP: 750,
  ANS: 700,
  SCS: 750,
  ML: 700,
  DB: 700,
  NW: 700,
  SEC: 700,
};

// 演習モードでの合否判定に使う正答率の目安（スケールスコアの近似値）
export const PASS_RATE: Record<string, number> = {
  CLF: 70,
  SAA: 72,
  SAP: 75,
  DVA: 72,
  SOA: 72,
  DEA: 72,
  DOP: 75,
  AIF: 70,
  AIB: 70,
  MLA: 72,
  AIP: 75,
  ANS: 70,
  SCS: 75,
  ML: 70,
  DB: 70,
  NW: 70,
  SEC: 70,
};

// 試験の出題ドメイン（単一マスタ src/data/examDomains.json から導出）
// 配列 index = ドメインの正準キー。名前は表示専用ラベルとして扱う。
export const EXAM_DOMAINS: Record<string, string[]> = Object.fromEntries(
  Object.entries(EXAM_DOMAINS_MASTER).map(([exam, doms]) => [exam, doms.map(d => d.ja)])
);

// ドメインごとの頻出サービス・機能（苦手分析の学習ガイド用）。index = ドメインの正準キー。
export const EXAM_DOMAIN_SERVICES: Record<string, string[][]> = Object.fromEntries(
  Object.entries(EXAM_DOMAINS_MASTER).map(([exam, doms]) => [exam, doms.map(d => (d as { services?: string[] }).services ?? [])])
);

// ── domain フィールドのユーティリティ ────────────────────────
// domain は整数インデックス（正準キー）。旧データは文字列の場合があるため両対応。
export type QuestionLike = { examType: string; domain?: number | string | null };

export function qDomainName(q: QuestionLike): string {
  if (typeof q.domain === 'number') return EXAM_DOMAINS[q.examType]?.[q.domain] ?? '';
  if (typeof q.domain === 'string') return EXAM_DOMAINS[q.examType]?.[toDomainIndex(q.examType, q.domain)] ?? '';
  return '';
}

export function qDomainIndex(examType: string, nameOrIndex: number | string): number {
  if (typeof nameOrIndex === 'number') return nameOrIndex;
  return EXAM_DOMAINS[examType]?.indexOf(nameOrIndex) ?? -1;
}

// ── ドメイン正準キー（整数 index）変換ヘルパ ─────────────────
// 表示は名前、永続化・転送は index を正準キーとする。
export function domainName(examType: string, idx: number, lang: string = 'ja'): string {
  const ja = EXAM_DOMAINS[examType]?.[idx] ?? '';
  return lang === 'en' ? (DOMAIN_NAME_EN[ja] ?? ja) : ja;
}
// name / index / 数値文字列 → index（該当なしは -1）
export function toDomainIndex(examType: string, v: string | number): number {
  if (typeof v === 'number') return Number.isInteger(v) ? v : -1;
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  return EXAM_DOMAINS[examType]?.indexOf(v) ?? -1;
}
// 名前/index 配列 → index 配列（永続化・転送用。該当なしは除外）
export function domainsToIndices(examType: string, values: (string | number)[]): number[] {
  return values.map(v => toDomainIndex(examType, v)).filter(i => i >= 0);
}
// 保存済み（index / 旧名いずれも可）→ 現在の名前配列（表示用）。未保存(undefined)は全ドメイン。
export function storedDomainsToNames(examType: string, stored: (string | number)[] | undefined): string[] {
  const all = EXAM_DOMAINS[examType] ?? [];
  if (!stored) return [...all];
  const names = stored
    .map(v => { const i = toDomainIndex(examType, v); return i >= 0 ? all[i] : undefined; })
    .filter((n): n is string => !!n);
  return names.length > 0 ? names : [...all];
}
// UserTagStats の tagId が当該試験・index に一致するか。
// 形式: "SAA_0", "DOP_1" 等の "examType_index" 文字列。
// 旧形式 ("0", "1") はすべての試験で共有されていたため意図的に無視する（試験切替バグの原因）。
export function tagIdMatches(tagId: string, examType: string, idx: number): boolean {
  return tagId === `${examType}_${idx}`;
}
// domain-results に送る tagId を生成する（"SAA_0" 等）。
export function makeTagId(examType: string, idx: number): string {
  return `${examType}_${idx}`;
}
// 問題の domain index（旧データ: 文字列は変換、未設定は -1）
export function questionDomainIndex(q: QuestionLike): number {
  if (typeof q.domain === 'number') return q.domain;
  if (typeof q.domain === 'string') return toDomainIndex(q.examType, q.domain);
  return -1;
}

// ドメイン名の英語対応（日本語キー → 英語表示）— マスタから導出
// 共通キー（例: 'セキュリティとコンプライアンス'）は同一 en のため重複しても問題なし。
export const DOMAIN_NAME_EN: Record<string, string> = Object.fromEntries(
  Object.values(EXAM_DOMAINS_MASTER).flat().map(d => [d.ja, d.en])
);

// 試験レベル表示
export const EXAM_LEVEL: Record<string, string> = {
  CLF: 'Foundational',
  SAA: 'Associate',
  SAP: 'Professional',
  DVA: 'Associate',
  SOA: 'Associate',
  DOP: 'Professional',
  DEA: 'Associate',
  AIF: 'Foundational',
  AIB: 'Business',
  MLA: 'Associate',
  AIP: 'Professional',
  ANS: 'Specialty',
  SCS: 'Specialty',
  ML: 'Additional',
  DB: 'Additional',
  NW: 'Additional',
  SEC: 'Additional',
};

// 正解1問あたりのポイント。**回答した問題自身の examType** で決める（2026-10-27）。
// 他の公式資格の演習に混ざった基礎知識（ML/DB/NW/SEC）は、演習中の資格ではなく基礎知識のポイント（2）で数える。
// Foundational: 1 / Business・Associate・Additional(基礎知識): 2 / Professional・Specialty: 3
export function pointsPerCorrect(examType: string): number {
  switch (EXAM_LEVEL[examType]) {
    case 'Foundational': return 1;
    case 'Professional':
    case 'Specialty': return 3;
    default: return 2;
  }
}

// 資格レベル色の唯一の定義。実体は src/index.css の --level-*（ライト/ダークで値が変わる）。
// これは塗り・線用の明るい色。文字に使うときは levelText()、塗りに文字を載せるときは levelOn() を通す。
// CSS 変数なので hex にアルファを足す書き方（`${c}33`）はできない。半透明は tint() を使う。
export const EXAM_LEVEL_COLORS: Record<string, string> = {
  Foundational: 'var(--level-foundational)',
  Business:     'var(--level-business)',
  Associate:    'var(--level-associate)',
  Professional: 'var(--level-professional)',
  Specialty:    'var(--level-specialty)',
  Additional:   'var(--level-additional)',
};

// レベル色を文字に使うときの濃い色（白地で 4.5:1 以上）。レベル色以外（--color-primary 等）はそのまま返す
export const levelText = (color: string): string =>
  color.startsWith('var(--level-') ? color.replace(/\)$/, '-text)') : color;

// レベル色の塗りの上に載せる文字色。レベル色以外の塗りには白を返す
export const levelOn = (color: string): string =>
  color.startsWith('var(--level-') ? color.replace(/\)$/, '-on)') : '#ffffff';

// 色を pct% の不透明度にする。CSS 変数・hex のどちらでも使える。
export const tint = (color: string, pct: number): string =>
  `color-mix(in srgb, ${color} ${pct}%, transparent)`;

// レベルの表示ラベル。内部キー 'Additional'（非AWSカード）は「基礎知識」と表示する。
// 他のレベルは従来どおり英語表記のまま。
export const levelLabel = (level: string, ja: boolean): string =>
  level === 'Additional' ? (ja ? '基礎知識' : 'Original') : level;

// 試験の説明文
export const EXAM_DESC_JA: Record<string, string> = {
  CLF: 'クラウドの基礎を問う入門レベルの認定',
  SAA: '最も人気の高いアソシエイトレベル認定',
  SAP: '高度な設計スキルを証明するプロ認定',
  DVA: 'AWSを使ったアプリケーション開発スキルを問うアソシエイト認定',
  SOA: 'AWSインフラの運用・監視・自動化・デプロイスキルを問うアソシエイト認定',
  DOP: '開発・運用の高度なスキルを証明するプロ認定',
  DEA: 'データパイプラインの実装・管理・最適化スキルを問うアソシエイト認定',
  AIF: 'AI/MLの概念とAWSサービスを幅広くカバーする入門認定',
  AIB: 'AIをビジネス成果へ結びつける戦略・ガバナンス・組織変革を問うビジネス認定',
  MLA: 'MLモデルの構築・デプロイ・運用を問うアソシエイト認定',
  AIP: 'AWSで生成AIソリューションを実装・デプロイするプロフェッショナル認定',
  // AWS 公式が廃止を告知済み（英語版 認定ページ / 認定一覧ともに 2026-12-31）
  ANS: '【2026年12月31日で提供終了】AWSとハイブリッドネットワークの高度な設計・実装スキルを問うスペシャリティ認定',
  SCS: 'AWSクラウドのセキュリティ専門知識を証明するスペシャリティ認定',
  ML: '【AWS認定ではありません】AIF・MLA・AIP 対策として、共通して問われる機械学習の基礎知識を横断演習する独自カード',
  DB: '【AWS認定ではありません】DEA 対策として、SQL・正規化・インデックス・トランザクション等のDB基礎に加え、分析SQL・データモデリング・データ形式などデータエンジニアリングの前提知識を演習する独自カード',
  NW: '【AWS認定ではありません】ANS 対策として、前提となるネットワーク（TCP/IP・サブネット・ルーティング・DNS等）の基礎知識を演習する独自カード',
  SEC: '【AWS認定ではありません】SCS 対策として、前提となるセキュリティ（暗号・認証認可・脅威・インシデント対応等）の基礎知識を演習する独自カード',
};
export const EXAM_DESC_EN: Record<string, string> = {
  CLF: 'Foundational certification covering cloud basics',
  SAA: 'Most popular associate-level AWS certification',
  SAP: 'Professional certification for advanced architects',
  DVA: 'Associate certification for AWS application developers',
  SOA: 'Associate certification for AWS cloud operations, monitoring, and automation',
  DOP: 'Professional certification for DevOps engineers',
  DEA: 'Associate certification for implementing and managing data pipelines on AWS',
  AIF: 'Foundational certification covering AI/ML concepts and AWS services',
  AIB: 'Business certification for turning AI capabilities into business outcomes through strategy, governance, and transformation',
  MLA: 'Associate certification for building and operating ML solutions',
  AIP: 'Professional certification for integrating and deploying generative AI solutions on AWS',
  ANS: '[Retiring December 31, 2026] Specialty certification for advanced AWS and hybrid network architecture design',
  SCS: 'Specialty certification for AWS cloud security expertise',
  ML: '[Not an AWS certification] Cross-cutting machine learning fundamentals shared across the AIF/MLA/AIP exams',
  DB: '[Not an AWS certification] Database fundamentals (SQL, normalization, indexing, transactions) plus data-engineering prerequisites (analytical SQL, data modeling, data formats) for DEA preparation',
  NW: '[Not an AWS certification] Networking fundamentals (TCP/IP, subnetting, routing, DNS) assumed as a prerequisite for the ANS exam',
  SEC: '[Not an AWS certification] Security fundamentals (cryptography, authN/authZ, threats, incident response) assumed as a prerequisite for the SCS exam',
};

// ドメイン正答率の色分けしきい値（0–1スケール・全資格共通）
// 60%未満=赤（苦手）／60〜79%=黄（要注意）／80%以上=緑（良好）
export const DOMAIN_RATE_WARNING = 0.60;
export const DOMAIN_RATE_CAUTION = 0.80;

// ドメイン配点（公式試験ガイドの割合 %）— マスタから導出
export const DOMAIN_WEIGHTS: Record<string, number[]> = Object.fromEntries(
  Object.entries(EXAM_DOMAINS_MASTER).map(([exam, doms]) => [exam, doms.map(d => d.weight)])
);

// 模試モードの設定
export const EXAM_CONFIGS: Record<string, {
  examCode: string;
  fullName: string;
  totalQuestions: number;
  timeLimitMin: number;
}> = {
  CLF: { examCode: 'CLF-C02', fullName: 'AWS Certified Cloud Practitioner',                       totalQuestions: 65, timeLimitMin: 90  },
  SAA: { examCode: 'SAA-C03', fullName: 'AWS Certified Solutions Architect – Associate',           totalQuestions: 65, timeLimitMin: 130 },
  SAP: { examCode: 'SAP-C02', fullName: 'AWS Certified Solutions Architect – Professional',        totalQuestions: 75, timeLimitMin: 180 },
  DVA: { examCode: 'DVA-C02', fullName: 'AWS Certified Developer – Associate',                    totalQuestions: 65, timeLimitMin: 130 },
  SOA: { examCode: 'SOA-C03', fullName: 'AWS Certified CloudOps Engineer – Associate',             totalQuestions: 65, timeLimitMin: 130 },
  DOP: { examCode: 'DOP-C02', fullName: 'AWS Certified DevOps Engineer – Professional',            totalQuestions: 75, timeLimitMin: 180 },
  DEA: { examCode: 'DEA-C01', fullName: 'AWS Certified Data Engineer – Associate',                 totalQuestions: 65, timeLimitMin: 130 },
  AIF: { examCode: 'AIF-C01', fullName: 'AWS Certified AI Practitioner',                          totalQuestions: 65, timeLimitMin: 90  },
  AIB: { examCode: 'AIB-C01', fullName: 'AWS Certified AI Business Strategist',                   totalQuestions: 85, timeLimitMin: 170 },
  MLA: { examCode: 'MLA-C01', fullName: 'AWS Certified Machine Learning Engineer – Associate',    totalQuestions: 65, timeLimitMin: 130 },
  AIP: { examCode: 'AIP-C01', fullName: 'AWS Certified Generative AI Developer – Professional',   totalQuestions: 75, timeLimitMin: 180 },
  ANS: { examCode: 'ANS-C01', fullName: 'AWS Certified Advanced Networking – Specialty',           totalQuestions: 65, timeLimitMin: 170 },
  SCS: { examCode: 'SCS-C03', fullName: 'AWS Certified Security – Specialty',                     totalQuestions: 65, timeLimitMin: 170 },
  ML: { examCode: 'ML', fullName: '【基礎知識】機械学習',                                          totalQuestions: 65, timeLimitMin: 90  },
  DB: { examCode: 'DB', fullName: '【基礎知識】データベース',                                      totalQuestions: 65, timeLimitMin: 90  },
  NW: { examCode: 'NW', fullName: '【基礎知識】ネットワーク',                                      totalQuestions: 65, timeLimitMin: 90  },
  SEC: { examCode: 'SEC', fullName: '【基礎知識】セキュリティ',                                    totalQuestions: 65, timeLimitMin: 90  },
};

// COMPANION_EXAM の表示名（「【基礎知識】」を外した短い名称）。
// 通常演習の設定モーダルで「基礎知識（機械学習）を含める」のように使う。
export function companionLabel(companionExamType: string): string {
  return (EXAM_CONFIGS[companionExamType]?.fullName ?? companionExamType).replace('【基礎知識】', '');
}

// 管理者画面「AIプロンプト生成」用の資格別補足ルール（任意）。
// 夜間バッチの生成ルール(prompts/night-prompts/scripts/instructions/*.txt)で
// 実データ調査により手薄と判明したテーマを、手動生成プロンプトにも反映する。
export const EXAM_SUPPLEMENTARY_RULES: Partial<Record<string, string>> = {
  AIF: `・実際のAIF試験の約40%はAWSサービス非依存の一般的なAI・ML概念（BLEU/BERT/決定木/転移学習等）を問う。AWSサービス問題と適切に混在させること
・特にIDP（インテリジェントドキュメント処理）・ネガティブプロンプト・コンバージョン率（ビジネスKPI）は出題頻度が低くなりがちなので優先的に含めること`,
  AIB: `・これはビジネス職（PM・営業・コンサル・事業責任者等）向けの認定であり、技術実装（コーディング・チューニング・パイプライン構築・インフラ設定）は出題範囲外。戦略的意思決定・ビジネス価値・ガバナンス・組織変革を主眼にすること
・AWSサービスは「ビジネスレベルで何ができるか」の粒度で扱う（設定手順や技術仕様を問わない）。Bedrock・Amazon Q・SageMaker AI・CAF・Well-Architected(責任あるAIレンズ)・Pricing Calculator/Cost Explorer/Savings Plans・Marketplace など
・ROI/KPI/ベースライン指標での価値測定、build-buy-partner判断、料金モデル(消費/インスタンス/シート)、責任あるAIのトレードオフ、規制コンプライアンス、AI成熟度評価、チェンジマネジメント、パイロットから全社展開へのスケールは出題頻度が低くなりがちなので優先的に含めること`,
  AIP: `・特にRLHF・LoRA（フルファインチューニングとの比較）・Lake Formation（データガバナンス）は出題頻度が低くなりがちなので優先的に含めること`,
  DVA: `・DVA本試験は DynamoDB・API Gateway・Cognito の出題比率が特に高い。これらを中心に厚く出題すること
・DynamoDB: GSIとLSIの使い分け（作成タイミング・キー・整合性・スループットの違い）、パーティションキー/ソートキー/セカンダリインデックスの役割、DynamoDB Streams、クエリvsスキャンを優先的に含めること
・API Gateway: ステージと「デプロイ」の概念、ステージ変数による環境差分（dev/test/prod）の作り分け、モック統合の用途を優先的に含めること
・Cognito: ユーザープールとアイデンティティプールの使い分け（認証/JWT vs 一時AWS認証情報の付与）を明確に問うこと
・その他手薄になりがち: SAMとCloudFormationの併用・sam localでのローカルテスト/デプロイ、プロビジョンド/予約済みコンカレンシーの用途差、Lambdaのメモリ増加による高速化、Secrets Managerのリージョン間レプリケーション、既存S3データの一括暗号化（S3バッチオペレーション）、AppConfigの使い分け、ECSタスク定義`,
  DEA: `・実出題で頻出だが手薄になりがちな詳細トピックを優先的に含めること:
・Kinesis: 拡張ファンアウト(Enhanced Fan-Out)、KPL/KCLの違い(KPLのバッチ化・集約でスループット向上)
・Amazon MSK: MSK Replicatorによるクロスリージョン/クラスタ間レプリケーション
・Redshift運用: VACUUM(recluster)・VACUUM REINDEX・ANALYZE(統計更新)の役割の違い
・ゼロETL統合(Zero-ETL): Aurora/RDS→Redshift、DynamoDB→Redshift/OpenSearch を自前ETLなしで選ぶ要件
・Athena: フェデレーテッドクエリ(Lambda Connectorで他データソース横断)
・Step Functions: ステートの種類(Task/Choice/Map/Parallel)、変換パイプラインでのGlue Workflowとの使い分け
・S3 Storage Lens(分析ダッシュボード)とS3 Inventory(オブジェクト明細レポート)の使い分け
・JDBC(Java系)/ODBC(ネイティブ・Windows系)の使い分け、AppFlowのSaaS連携用途、基礎SQL(UNION/ウィンドウ関数等)`,
  SOA: `・実出題で頻出だが手薄になりがちな運用トピックを優先的に含めること:
・CloudWatch: 基本監視(5分)と詳細監視(1分)の違い、標準メトリクスにメモリ/ディスク空きは含まれずCloudWatchエージェントが必要、ステータスチェックと自動復旧
・AMI管理: copy-image(AMIコピー)の用途、クロスリージョンコピーの注意点(AMI IDはリージョン固有・EBSスナップショット複製・暗号化AMIはコピー先KMSキーで再暗号化・起動権限/タグ非継承)
・EC2 Image Builder: AMI/コンテナの自動ビルド、レシピ(ベースイメージ+コンポーネント)の概念
・SSM Distributor: ソフトウェアパッケージの作成・バージョン管理・一括配布
・Route 53 Resolver: インバウンド(オンプレ→AWS)/アウトバウンド(AWS→オンプレ)エンドポイントの向きと用途
・S3レプリケーション: ライブ(新規継続) vs バッチ(既存を遡って複製)、RTC(15分SLA)の使い分け
・CloudFormation: スタック削除でもリソースを残す DeletionPolicy:Retain/Snapshot、終了保護との違い
・トラブルシューティング問題を一定割合で出すこと（症状・エラー・接続不可を提示し根本原因/修正を問う）。例: S3イベントでLambdaが起動しない(リソースベースポリシー欠如)、プライベートEC2からS3に届かない(VPCエンドポイント/NAT不在)、AccessDenied(IAM/SCP/KMS)、CloudWatchにメモリが出ない(エージェント未導入)、ALBターゲットがunhealthy(ヘルスチェック/SG)`,
  ML: `・これはAWS認定ではなく、AIF/MLA/AIP が前提とする「機械学習の基礎知識」を問う独自カードである。
・**AWSサービス（SageMaker・Bedrock 等）が登場してもよいが、AWSサービスそのもの（仕様・選定・使い分け）を主題にしないこと。** 主眼はあくまで機械学習の概念・理論・指標であり、AWSサービスは例・文脈として補助的に登場する程度にとどめる。
・過学習/正則化、バイアス-バリアンス、適合率/再現率/F1・ROC-AUC・混同行列、特徴量エンジニアリング、交差検証、LLM/RAG/埋め込み/プロンプト、公平性・説明可能性など、汎用的なML/AI理論を扱うこと
・数式や指標の計算（例: 混同行列から適合率を求める）を含めてよい
・難易度は中級の基礎（暗記でなく理解・適用を問う。入門的な確認も可だが、易しすぎる自明問題は避ける）`,
  DB: `・これはAWS認定ではなく、DEA が前提とする「データベース／SQLの基礎知識」を問う独自カードである。
・**AWSサービス（RDS・Aurora・DynamoDB・Redshift 等）が登場してもよいが、AWSサービスそのもの（仕様・選定・使い分け）を主題にしないこと。** 主眼はあくまで汎用的なRDBMS/SQL・データモデリングの概念であり、AWSサービスは例・文脈として補助的に登場する程度にとどめる。
・正規化(1NF-3NF)、主キー/外部キー、JOIN/アンチJOIN・サブクエリ・ウィンドウ関数、インデックスと実行計画・断片化、トランザクション/ACID/分離レベル/MVCC、OLTP/OLAP・スタースキーマ、ETL/ELT・冪等性・CDC などを扱うこと
・具体的なSQL文を提示して結果や誤りを問う形式を含めてよい（PostgreSQL/標準SQL基準）
・難易度は中級の基礎（暗記でなく理解・適用を問う。入門的な確認も可だが、易しすぎる自明問題は避ける）`,
  NW: `・これはAWS認定ではなく、ANS が前提とする「ネットワークの実務基礎知識」を問う独自カードである（ANSは5年以上のネットワーク実務経験を推奨）。
・**AWSサービス（VPC・Route 53・Direct Connect 等）が登場してもよいが、AWSサービスそのもの（仕様・選定・使い分け）を主題にしないこと。** 主眼はあくまでベンダー中立なネットワーク理論・プロトコルであり、AWSサービスは例・文脈として補助的に登場する程度にとどめる。
・OSI/TCP-IPモデル、TCP/UDP、IPv4/IPv6・CIDR・サブネット計算・NAT、ルーティング(BGP/静的動的・ロンゲストマッチ)、DNS(レコード種別・再帰/反復・TTL)、TLS/HTTPS・TCPハンドシェイク、ファイアウォール/ACL・VPN/IPsec などを扱うこと
・サブネット計算やアドレス範囲の判定など、手を動かす計算問題を含めてよい
・難易度は中級の基礎を下限とする（暗記でなく理解・適用を問う。易しすぎる自明問題は避ける）`,
  SEC: `・これはAWS認定ではなく、SCS が前提とする「セキュリティの基礎知識」を問う独自カードである。
・**AWSサービス（IAM・KMS・GuardDuty 等）が登場してもよいが、AWSサービスそのもの（仕様・選定・使い分け）を主題にしないこと。** 主眼はあくまでベンダー中立なセキュリティの概念・原則であり、AWSサービスは例・文脈として補助的に登場する程度にとどめる。
・暗号技術(対称/非対称・ハッシュ・PKI・TLS)、認証認可(MFA・OAuth/OIDC/SAML・最小権限・RBAC/ABAC)、ネットワークセキュリティ(FW・IDS/IPS・ゼロトラスト)、脅威と脆弱性(OWASP Top10・権限昇格・CVSS)、インシデント対応・ログ、データ保護・ガバナンス などを扱うこと
・難易度は中級の基礎を下限とする（暗記でなく理解・適用を問う。易しすぎる自明問題は避ける）`,
};

export const EXAM_OFFICIAL_URLS: Record<string, { page: string; guide: string }> = {
  CLF: { page: 'https://aws.amazon.com/certification/certified-cloud-practitioner/',                    guide: 'https://d1.awsstatic.com/training-and-certification/docs-cloud-practitioner/AWS-Certified-Cloud-Practitioner_Exam-Guide.pdf' },
  AIF: { page: 'https://aws.amazon.com/certification/certified-ai-practitioner/',                       guide: 'https://d1.awsstatic.com/training-and-certification/docs-ai-practitioner/AWS-Certified-AI-Practitioner_Exam-Guide.pdf' },
  AIB: { page: 'https://aws.amazon.com/certification/certified-ai-business-strategist/',                guide: 'https://docs.aws.amazon.com/pdfs/aws-certification/latest/ai-business-strategist-01/ai-business-strategist-01.pdf' },
  SAA: { page: 'https://aws.amazon.com/certification/certified-solutions-architect-associate/',         guide: 'https://d1.awsstatic.com/training-and-certification/docs-sa-assoc/AWS-Certified-Solutions-Architect-Associate_Exam-Guide.pdf' },
  DVA: { page: 'https://aws.amazon.com/certification/certified-developer-associate/',                   guide: 'https://d1.awsstatic.com/training-and-certification/docs-dev-associate/AWS-Certified-Developer-Associate_Exam-Guide.pdf' },
  SOA: { page: 'https://aws.amazon.com/certification/certified-sysops-admin-associate/',                guide: 'https://d1.awsstatic.com/training-and-certification/docs-sysops-associate/AWS-Certified-SysOps-Administrator-Associate_Exam-Guide.pdf' },
  DEA: { page: 'https://aws.amazon.com/certification/certified-data-engineer-associate/',               guide: 'https://d1.awsstatic.com/training-and-certification/docs-data-engineer-associate/AWS-Certified-Data-Engineer-Associate_Exam-Guide.pdf' },
  MLA: { page: 'https://aws.amazon.com/certification/certified-machine-learning-engineer-associate/',   guide: 'https://d1.awsstatic.com/training-and-certification/docs-ml-engineer-associate/AWS-Certified-Machine-Learning-Engineer-Associate_Exam-Guide.pdf' },
  SAP: { page: 'https://aws.amazon.com/certification/certified-solutions-architect-professional/',      guide: 'https://d1.awsstatic.com/training-and-certification/docs-sa-pro/AWS-Certified-Solutions-Architect-Professional_Exam-Guide.pdf' },
  DOP: { page: 'https://aws.amazon.com/certification/certified-devops-engineer-professional/',          guide: 'https://d1.awsstatic.com/training-and-certification/docs-devops-pro/AWS-Certified-DevOps-Engineer-Professional_Exam-Guide.pdf' },
  AIP: { page: 'https://aws.amazon.com/certification/certified-generative-ai-developer-professional/',  guide: 'https://d1.awsstatic.com/training-and-certification/docs-generative-ai-developer-professional/AWS-Certified-Generative-AI-Developer-Professional_Exam-Guide.pdf' },
  ANS: { page: 'https://aws.amazon.com/certification/certified-advanced-networking-specialty/',         guide: 'https://d1.awsstatic.com/training-and-certification/docs-advnetworking-spec/AWS-Certified-Advanced-Networking-Specialty_Exam-Guide.pdf' },
  SCS: { page: 'https://aws.amazon.com/certification/certified-security-specialty/',                    guide: 'https://d1.awsstatic.com/training-and-certification/docs-security-spec/AWS-Certified-Security-Specialty_Exam-Guide.pdf' },
};
