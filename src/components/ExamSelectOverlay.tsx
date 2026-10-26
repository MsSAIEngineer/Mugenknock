'use client';
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { lockBodyScroll } from '../utils/bodyScrollLock';
import { resetExercisePrefsOnExamChange } from '../utils/preferences';
import { API_ENDPOINT, EXAM_CONFIGS, EXAM_DOMAINS, DOMAIN_WEIGHTS, PASS_SCORES, isNonAwsExam, levelLabel, COMPANION_EXAM, companionLabel, officialExamsForCompanion, EXAM_LEVEL_COLORS, tint } from '@/constants';
import { EXAM_ICON_COMPONENTS, IconCircleCheck, IconExternalLink, IconFileText } from '@/components/Icons';
import Button from '@/components/ui/Button';
import { useHorizontalScrollHint } from '@/hooks/useHorizontalScrollHint';

import MarkdownText from '@/components/ui/MarkdownText';

// 決定ボタンのフリップ完了時に飛ばすパーティクル放散。
// パネルの overflow:hidden に切られないよう body 直下へ portal し、
// fixed 座標（ボタン中心）から放散することで輪郭を越えて飛ばす。
// 色は資格レベルカラー（levelColor）の濃淡 + 少量の白アクセント。
const BURST_COUNT = 26;

export function ConfirmBurst({ x, y, color, onDone }: { x: number; y: number; color: string; onDone: () => void }) {
  // レベル色の濃淡（levelColor は CSS 変数なので tint で半透明にする）
  const palette = useMemo(() => [color, color, color, tint(color, 80), tint(color, 60), '#ffffff'], [color]);
  const particles = useMemo(() => Array.from({ length: BURST_COUNT }, (_, i) => {
    const angle = (360 / BURST_COUNT) * i + (Math.random() * 22 - 11);
    const dist = 46 + Math.random() * 78;
    const rad = (angle * Math.PI) / 180;
    return {
      id: i,
      dx: Math.cos(rad) * dist,
      dy: Math.sin(rad) * dist,
      size: 6 + Math.random() * 7,
      color: palette[Math.floor(Math.random() * palette.length)],
      delay: Math.random() * 0.08,
      dur: 0.5 + Math.random() * 0.28,
      round: Math.random() > 0.4,
    };
  }), [palette]);

  useEffect(() => {
    const t = setTimeout(onDone, 820);
    return () => clearTimeout(t);
  }, [onDone]);

  const css = useMemo(() => particles.map(p => `
    @keyframes esoBurst-${p.id} {
      0%   { transform: translate(-50%,-50%) translate(0,0) scale(1); opacity: 1; }
      100% { transform: translate(-50%,-50%) translate(${p.dx}px,${p.dy}px) scale(0.08); opacity: 0; }
    }`).join(''), [particles]);

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 9900, pointerEvents: 'none' }}>
      <style>{css}</style>
      {particles.map(p => (
        <div key={p.id} style={{
          position: 'absolute', left: x, top: y,
          width: p.size, height: p.round ? p.size : p.size * 0.5,
          borderRadius: p.round ? '50%' : '2px',
          background: p.color,
          boxShadow: `0 0 ${p.size}px ${tint(p.color, 53)}`,
          animation: `esoBurst-${p.id} ${p.dur}s cubic-bezier(.25,.6,.4,1) ${p.delay}s both`,
        }} />
      ))}
    </div>,
    document.body,
  );
}

const EXAM_LEVELS = [
  { key: 'Practitioner', color: EXAM_LEVEL_COLORS.Foundational, exams: ['CLF', 'AIF'] },
  { key: 'Business',     color: EXAM_LEVEL_COLORS.Business, exams: ['AIB'] },
  { key: 'Associate',    color: EXAM_LEVEL_COLORS.Associate, exams: ['SAA', 'DVA', 'SOA', 'DEA', 'MLA'] },
  { key: 'Professional', color: EXAM_LEVEL_COLORS.Professional, exams: ['SAP', 'DOP', 'AIP'] },
  { key: 'Specialty',    color: EXAM_LEVEL_COLORS.Specialty, exams: ['ANS', 'SCS'] },
  { key: 'Additional',   color: EXAM_LEVEL_COLORS.Additional, exams: ['ML', 'DB', 'NW', 'SEC'] },
] as const;

export const EXAM_DESC: Record<string, string> = {
  CLF: 'AWSクラウドの基礎知識・サービス・概念を問う入門試験。エンジニア以外でも取得可能。ITの基礎から学べるエントリーポイント。',
  SAA: 'AWSを使ったシステム設計・高可用性・コスト最適化の知識を問う、AWS最人気資格。クラウドアーキテクチャの標準スキルとして業界で広く認知。',
  SAP: 'SAAより高度な大規模システム設計・移行戦略・複雑なアーキテクチャを扱うプロフェッショナル資格。SAAの取得後を推奨。',
  DVA: 'AWSを使ったアプリ開発・デバッグ・デプロイ・セキュリティの実践知識を問う。Lambda・DynamoDB・API Gatewayが頻出。',
  SOA: 'AWSの運用・監視・自動化・スケーリング・セキュリティ管理を問う運用者向け試験。CloudWatch・Systems Managerが中心。',
  DOP: 'CI/CD・Infrastructure as Code・自動化・監視などDevOps実践を問うプロ資格。CodePipeline・CloudFormation・OpsWorksが重要。',
  DEA: 'データ収集・変換・保管・パイプライン設計などデータエンジニアリング全般を問う。Glue・Kinesis・Redshiftが頻出。',
  AIF: 'AIと機械学習の基礎・AWSのAI/MLサービスの活用知識を問う入門レベルの試験。Bedrock・SageMaker・Rekognitionが中心。',
  AIB: 'AIをビジネス成果へ変える戦略・投資判断・ガバナンス・組織変革を問うビジネス職向けの新資格。コーディング不要でROI・KPI・責任あるAI・CAFが中心。',
  MLA: 'モデル開発・デプロイ・スケーリング・MLパイプライン構築の実践スキルを問う。SageMakerの深い理解が必要。',
  AIP: '生成AIアプリの設計・実装・最適化に特化した新資格。Amazon Bedrockを中心に、プロンプトエンジニアリングやRAGが頻出。',
  // ANS は AWS 公式が廃止を告知済み（英語版 認定ページ / 認定一覧ともに 2026-12-31）。
  // 受験を検討する人が期限を見落とさないよう説明の先頭に単独行で置く。
  ANS: '【2026年12月31日で提供終了予定】\nハイブリッドクラウド・DNS・負荷分散・ネットワーク設計の高度な知識を問うSpecialty。Transit Gateway・Direct Connectが中心。',
  SCS: 'セキュリティ設計・実装・インシデント対応・コンプライアンスを問うSpecialty。IAM・KMS・GuardDutyの深い理解が必要。',
  // オリジナル（非AWS認定）カードは「〇〇対策として、」で冒頭を統一し、
  // どの資格の土台を固めるカードなのかを先頭で明示する。
  ML: 'AIF・MLA・AIP 対策として、機械学習の基礎知識（過学習・評価指標・特徴量・生成AI等）を、AWSサービスに依存しない形で横断演習する独自カード。',
  DB: 'DEA 対策として、SQL・正規化・インデックス・トランザクションなどDBの基礎に加え、分析SQL・ディメンショナルモデリング・データ形式などデータエンジニアリングの前提知識を演習する独自カード。',
  NW: 'ANS 対策として、ネットワークの実務知識（TCP/IP・サブネット・ルーティング・DNS・VPN等）を、AWSサービスに依存しない形で演習する独自カード。',
  SEC: 'SCS 対策として、セキュリティの基礎知識（暗号・認証認可・脅威と脆弱性・インシデント対応・データ保護等）を、ベンダー中立な観点で演習する独自カード。',
};

const EXAM_CATCHCOPY: Record<string, string> = {
  CLF: 'AWS資格の登竜門！誰もがここから！',
  AIF: 'AI時代の新教養！まずはAI×AWSを知ろう！',
  AIB: 'AIをビジネスの武器に！戦略で価値を生み出せ！',
  SAA: '迷ったらコレ！AWS資格の王道エース！',
  DVA: 'コードでクラウドを動かせ！開発者の定番資格！',
  SOA: '運用の現場力を証明！トラブル対応の第一人者へ！',
  DEA: 'データ活用の第一歩！分析基盤の設計者へ！',
  MLA: '機械学習エンジニアへの登竜門！AIを作る側へ！',
  SAP: 'AWS設計の最高峰！アーキテクト最難関！',
  DOP: '運用・自動化・改善の集大成！DevOpsの最高峰！',
  AIP: '生成AIをビジネスへ！AI開発の最前線！',
  SCS: '守れる者だけが任される！AWSセキュリティの番人！',
  ANS: 'ネットワークの深淵へ！AWS屈指の難関資格！',
  ML: '資格の枠を超えて！機械学習の土台を固めろ！',
  DB: 'データの基本を制す！SQL・DB設計の地力を鍛えろ！',
  NW: 'ANSの前提を制覇！ネットワークの地力を鍛えろ！',
  SEC: 'SCSの前提を固めろ！セキュリティの基礎体力を鍛えろ！',
};

export const EXAM_URLS: Record<string, string> = {
  CLF: 'https://aws.amazon.com/jp/certification/certified-cloud-practitioner/',
  SAA: 'https://aws.amazon.com/jp/certification/certified-solutions-architect-associate/',
  SAP: 'https://aws.amazon.com/jp/certification/certified-solutions-architect-professional/',
  DVA: 'https://aws.amazon.com/jp/certification/certified-developer-associate/',
  SOA: 'https://aws.amazon.com/jp/certification/certified-sysops-admin-associate/',
  DOP: 'https://aws.amazon.com/jp/certification/certified-devops-engineer-professional/',
  DEA: 'https://aws.amazon.com/jp/certification/certified-data-engineer-associate/',
  AIF: 'https://aws.amazon.com/jp/certification/certified-ai-practitioner/',
  AIB: 'https://aws.amazon.com/jp/certification/certified-ai-business-strategist/',
  MLA: 'https://aws.amazon.com/jp/certification/certified-machine-learning-engineer-associate/',
  AIP: 'https://aws.amazon.com/jp/certification/certified-generative-ai-developer-professional/',
  ANS: 'https://aws.amazon.com/jp/certification/certified-advanced-networking-specialty/',
  SCS: 'https://aws.amazon.com/jp/certification/certified-security-specialty/',
};

// AWS公式の日本語版試験ガイドPDF（docs.aws.amazon.com / d1.awsstatic.com、2026-08時点で存在確認済み）
export const EXAM_GUIDE_PDF_URLS: Record<string, string> = {
  CLF: 'https://docs.aws.amazon.com/ja_jp/aws-certification/latest/cloud-practitioner-02/cloud-practitioner-02.pdf',
  SAA: 'https://docs.aws.amazon.com/ja_jp/aws-certification/latest/solutions-architect-associate-03/solutions-architect-associate-03.pdf',
  SAP: 'https://docs.aws.amazon.com/ja_jp/aws-certification/latest/solutions-architect-professional-02/solutions-architect-professional-02.pdf',
  DVA: 'https://docs.aws.amazon.com/ja_jp/aws-certification/latest/developer-associate-02/developer-associate-02.pdf',
  SOA: 'https://d1.awsstatic.com/ja_JP/training-and-certification/docs-sysops-associate/AWS-Certified-SysOps-Administrator-Associate_Exam-Guide.pdf',
  DOP: 'https://docs.aws.amazon.com/ja_jp/aws-certification/latest/devops-engineer-professional-02/devops-engineer-professional-02.pdf',
  DEA: 'https://docs.aws.amazon.com/ja_jp/aws-certification/latest/data-engineer-associate-01/data-engineer-associate-01.pdf',
  AIF: 'https://docs.aws.amazon.com/ja_jp/aws-certification/latest/ai-practitioner-01/ai-practitioner-01.pdf',
  AIB: 'https://docs.aws.amazon.com/ja_jp/aws-certification/latest/ai-business-strategist-01/ai-business-strategist-01.pdf',
  MLA: 'https://docs.aws.amazon.com/ja_jp/aws-certification/latest/machine-learning-engineer-associate-01/machine-learning-engineer-associate-01.pdf',
  AIP: 'https://docs.aws.amazon.com/ja_jp/aws-certification/latest/ai-professional-01/ai-professional-01.pdf',
  ANS: 'https://docs.aws.amazon.com/ja_jp/aws-certification/latest/advanced-networking-specialty-01/advanced-networking-specialty-01.pdf',
  SCS: 'https://docs.aws.amazon.com/ja_jp/aws-certification/latest/security-specialty-03/security-specialty-03.pdf',
};

interface ExamSelectOverlayProps {
  targetExam: string | null;
  uid: string;
  lang: string;
  isMobile: boolean;
  /** 選択確定時コールバック */
  onSelect: (exam: string) => void;
  /** 閉じるボタン用コールバック。未指定の場合は閉じられない（初回オンボーディング用） */
  onClose?: () => void;
  /** デスクトップ時の最大幅（px）。省略時は 760 */
  desktopMaxWidth?: number;
  /** デスクトップ時の高さ（vh 文字列）。省略時は '72vh' */
  desktopHeight?: string;
  /** true のとき確定ボタンをパルスアニメーションで強調（初回オンボーディング時） */
  onboarding?: boolean;
}

export default function ExamSelectOverlay({
  targetExam, uid, lang, isMobile, onSelect, onClose,
  // 既定値がモバイル幅(420)と同じだったため、デスクトップでもスマホと同じ縦長パネルになり、
  // さらに6レベルのタブが収まらず末尾(Specialty/オリジナル)がクリップされて選べなくなっていた。
  // デスクトップは横に使える前提の寸法にする。
  desktopMaxWidth = 760, desktopHeight = '72vh', onboarding = false,
}: ExamSelectOverlayProps) {
  const ja = lang === 'ja';
  const initLevel = targetExam
    ? (EXAM_LEVELS.find(l => l.exams.includes(targetExam as never))?.key ?? 'Practitioner')
    : 'Practitioner';

  const [activeLevel, setActiveLevel] = useState<string>(initLevel);
  const [previewExam, setPreviewExam] = useState<string | null>(targetExam ?? EXAM_LEVELS[0].exams[0]);
  const [passComments, setPassComments] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [domainOpen, setDomainOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const cardStripRef = useRef<HTMLDivElement>(null);
  const [burst, setBurst] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    fetch(`${API_ENDPOINT}/settings/pass-comments`)
      .then(r => r.json())
      .then(d => { if (d.comments) setPassComments(d.comments); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setDomainOpen(false);
  }, [previewExam]);

  useEffect(() => {
    const examToShow = currentLevelDef.exams.find(e => e === previewExam) ?? currentLevelDef.exams[0];
    const el = cardStripRef.current?.querySelector<HTMLElement>(`[data-exam="${examToShow}"]`);
    el?.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' });
  }, [activeLevel]);

  useEffect(() => {
    return lockBodyScroll();
  }, []);

  // レベルタブ行（6レベルはモバイル幅に収まらないので横スクロール＋右端フェード）
  const { ref: levelTabsRef, maskStyle: levelTabsMask } = useHorizontalScrollHint(isMobile);

  // 選択中のレベルタブが行内で見切れないよう水平スクロール位置を合わせる。
  // （例: 目標資格が ML/DB/NW/SEC のとき末尾の「オリジナル」が画面外になるのを防ぐ）
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

  const currentLevelDef = EXAM_LEVELS.find(l => l.key === activeLevel) ?? EXAM_LEVELS[0];
  const levelColor = currentLevelDef.color;
  const dismissible = !!onClose;

  return createPortal(
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9800,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
      onClick={dismissible ? onClose : undefined}
      onTouchStart={e => e.stopPropagation()}
      onTouchMove={e => e.stopPropagation()}
    >
      <div
        data-kbscope="1" role="dialog" aria-modal="true" aria-label={ja ? "目標資格を選択" : "Choose target exam"}
        style={{
          background: 'var(--color-bg-white)',
          borderRadius: 'var(--border-radius-lg)',
          width: '100%',
          maxWidth: isMobile ? 420 : desktopMaxWidth,
          boxShadow: 'var(--box-shadow-md)',
          height: isMobile ? '75vh' : desktopHeight,
          maxHeight: isMobile ? '75vh' : desktopHeight,
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* ヘッダー */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px 0', flexShrink: 0 }}>
          {isMobile ? (
            /* モバイル: タイトル+リンクを左に横並び・✕右 */
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span style={{ fontWeight: 700, fontSize: 'var(--font-size-lg)', whiteSpace: 'nowrap' }}>
                  {ja ? '目標資格を選択' : 'Select Target Exam'}
                </span>
                <a
                  href="https://d1.awsstatic.com/onedam/marketing-channels/website/aws/ja_JP/certification/approved/pdfs/AWS_certification_paths.pdf"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-size-xs)', fontWeight: 600, color: 'var(--color-primary)', textDecoration: 'none', whiteSpace: 'nowrap' }}
                >
                  {ja ? 'AWS資格パス' : 'AWS Cert Path'}<IconExternalLink size={12} />
                </a>
              </div>
              {dismissible && (
                <button
                  data-kbclose="1"
                  onClick={onClose}
                  style={{ border: 'none', background: 'none', fontSize: 'var(--font-size-xl)', cursor: 'pointer', color: 'var(--color-text-sub)', padding: '4px 8px', lineHeight: 1, flexShrink: 0 }}
                >✕</button>
              )}
            </>
          ) : (
            /* デスクトップ: タイトル+リンクを左に横並び・✕右 */
            <>
              <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span style={{ fontWeight: 700, fontSize: 'var(--font-size-lg)', whiteSpace: 'nowrap' }}>
                  {ja ? '目標資格を選択' : 'Select Target Exam'}
                </span>
                <a
                  href="https://d1.awsstatic.com/onedam/marketing-channels/website/aws/ja_JP/certification/approved/pdfs/AWS_certification_paths.pdf"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-size-xs)', fontWeight: 600, color: 'var(--color-primary)', textDecoration: 'none', whiteSpace: 'nowrap' }}
                >
                  {ja ? 'AWS資格パス' : 'AWS Cert Path'}<IconExternalLink size={12} />
                </a>
              </div>
              {dismissible && (
                <button
                  data-kbclose="1"
                  onClick={onClose}
                  style={{ border: 'none', background: 'none', fontSize: 'var(--font-size-xl)', cursor: 'pointer', color: 'var(--color-text-sub)', padding: '4px 8px', lineHeight: 1 }}
                >✕</button>
              )}
            </>
          )}
        </div>

        {/* レベルタブ */}
        <div
          ref={levelTabsRef}
          style={{ display: 'flex', borderBottom: '2px solid var(--color-border)', flexShrink: 0, padding: isMobile ? '0 var(--spacing-sm)' : '0 var(--spacing-lg)', overflowX: isMobile ? 'auto' : 'visible', scrollbarWidth: 'none', ...levelTabsMask }}
          onTouchStart={e => e.stopPropagation()}
          onTouchMove={e => e.stopPropagation()}
        >
          {EXAM_LEVELS.map(({ key, color }) => (
            <button key={key} data-level={key} data-kbnav="tab" data-kbtab-active={activeLevel === key ? '1' : undefined} onClick={() => {
              setActiveLevel(key);
              const levelDef = EXAM_LEVELS.find(l => l.key === key);
              const examInLevel = levelDef?.exams.find(e => e === targetExam) ?? levelDef?.exams[0] ?? null;
              setPreviewExam(examInLevel as string | null);
            }} style={{
              flex: isMobile ? '0 0 auto' : 1, textAlign: 'center', whiteSpace: 'nowrap',
              padding: isMobile ? '10px 8px' : '10px 14px',
              background: 'none', border: 'none', cursor: 'pointer',
              borderBottom: activeLevel === key ? `2px solid ${color}` : '2px solid transparent',
              marginBottom: -2, color: activeLevel === key ? color : 'var(--color-text-sub)',
              fontWeight: activeLevel === key ? 700 : 400,
              fontSize: isMobile ? 'var(--font-size-xs)' : 'var(--font-size-sm2)',
            }}>
              {levelLabel(key, ja)}
            </button>
          ))}
        </div>

        {/* 資格カード（横スクロール） */}
        <div
          ref={cardStripRef}
          style={{ display: 'flex', gap: 10, padding: '14px 20px', overflowX: 'auto', flexShrink: 0 }}
          onTouchStart={e => e.stopPropagation()}
          onTouchMove={e => e.stopPropagation()}
        >
          {currentLevelDef.exams.map(exam => {
            const isSelected = targetExam === exam;
            const isPreviewing = previewExam === exam;
            const ExamIcon = EXAM_ICON_COMPONENTS[exam];
            return (
              <button
                key={exam}
                data-kbnav="1"
                data-exam={exam}
                onClick={() => setPreviewExam(exam)}
                style={{
                  flexShrink: 0, width: 80, padding: '10px 6px 8px', cursor: 'pointer',
                  borderRadius: 10, textAlign: 'center', position: 'relative',
                  border: `2px solid ${isPreviewing || isSelected ? levelColor : 'var(--color-border)'}`,
                  background: isPreviewing
                    ? levelColor
                    : isSelected
                    ? tint(levelColor, 20)
                    : 'var(--color-bg-card)',
                }}
              >
                {isSelected && (
                  <div style={{ position: 'absolute', top: 4, right: 4, color: isPreviewing ? '#fff' : levelColor, lineHeight: 0 }}>
                    <IconCircleCheck size={14} />
                  </div>
                )}
                {ExamIcon && (
                  <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 4, color: isPreviewing ? 'var(--color-on-level)' : isSelected ? levelColor : 'var(--color-text-light)' }}>
                    <ExamIcon size={18} />
                  </div>
                )}
                <div style={{ fontWeight: 800, fontSize: 'var(--font-size-md)', color: isPreviewing ? 'var(--color-on-level)' : isSelected ? levelColor : 'var(--color-text-main)', lineHeight: 1 }}>{exam}</div>
              </button>
            );
          })}
        </div>

        {/* 詳細パネル（スクロール） */}
        <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', borderTop: '1px solid var(--color-border)' }}>
          {previewExam && (() => {
            const exam = previewExam;
            const cfg = EXAM_CONFIGS[exam];
            return (
              <div style={{ padding: '16px 20px' }}>
                <div style={{ marginBottom: 10 }}>
                  {EXAM_CATCHCOPY[exam] && (
                    <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)', fontStyle: 'italic', marginBottom: 4 }}>{EXAM_CATCHCOPY[exam]}</div>
                  )}
                  <div style={{ fontWeight: 700, fontSize: 17, color: 'var(--color-text-main)' }}>
                    {(cfg?.fullName ?? exam).replace('AWS Certified ', '')}
                  </div>
                </div>
                {/* whiteSpace:'pre-line' … ANS の提供終了告知のように、説明文中の
                    改行(\n)を意図どおり反映させるため（通常の <p> は改行を無視する） */}
                <p style={{ margin: '0 0 8px', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', lineHeight: 1.7, whiteSpace: 'pre-line' }}>
                  {EXAM_DESC[exam] ?? ''}
                </p>
                {/* 公式資格↔基礎知識資格の相互案内（specs/003-original-exam-blend） */}
                {COMPANION_EXAM[exam] && (
                  <p style={{ margin: '0 0 8px', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)' }}>
                    {ja
                      ? <>※<span style={{ color: EXAM_LEVEL_COLORS.Additional }}>{`基礎知識（${companionLabel(COMPANION_EXAM[exam])}）`}</span>を含みます</>
                      : <>※Includes <span style={{ color: EXAM_LEVEL_COLORS.Additional }}>{companionLabel(COMPANION_EXAM[exam])}</span> fundamentals</>}
                  </p>
                )}
                {isNonAwsExam(exam) && officialExamsForCompanion(exam).length > 0 && (
                  <p style={{ margin: '0 0 8px', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)' }}>
                    {ja
                      ? `※${officialExamsForCompanion(exam).join('、')}でも演習可能です`
                      : `※Also included when practicing ${officialExamsForCompanion(exam).join(', ')}`}
                  </p>
                )}
                {(EXAM_URLS[exam] || EXAM_GUIDE_PDF_URLS[exam]) && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'nowrap', marginBottom: 12 }}>
                    {EXAM_URLS[exam] && (
                      <a href={EXAM_URLS[exam]} target="_blank" rel="noopener noreferrer"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--color-primary)', textDecoration: 'none', fontWeight: 600, fontSize: 'var(--font-size-sm)', whiteSpace: 'nowrap' }}>
                        {ja ? '認定ページ' : 'Certification page'}<IconExternalLink size={12} />
                      </a>
                    )}
                    {EXAM_GUIDE_PDF_URLS[exam] && (
                      <a href={EXAM_GUIDE_PDF_URLS[exam]} target="_blank" rel="noopener noreferrer"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--color-primary)', textDecoration: 'none', fontWeight: 600, fontSize: 'var(--font-size-sm)', whiteSpace: 'nowrap' }}>
                        <IconFileText size={12} />{ja ? '試験ガイド(PDF)' : 'Exam Guide (PDF)'}
                      </a>
                    )}
                  </div>
                )}
                {/* 試験コード・出題割合などの本番試験情報カード。オリジナル(非AWS)カードでは表示しない */}
                {!isNonAwsExam(exam) && (
                <div style={{ marginBottom: 12, padding: '10px 12px', background: 'var(--color-bg-main)', borderRadius: 8 }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 20px' }}>
                    {[
                      { label: ja ? '試験コード' : 'Code',       value: cfg?.examCode ?? '' },
                      { label: ja ? '問題数'     : 'Questions',  value: `${cfg?.totalQuestions ?? '—'}${ja ? '問' : 'Q'}` },
                      { label: ja ? '試験時間'   : 'Duration',   value: `${cfg?.timeLimitMin ?? '—'}${ja ? '分' : 'min'}` },
                      { label: ja ? '合格ライン' : 'Pass Score', value: `${PASS_SCORES[exam] ?? '—'}/1000` },
                    ].map(({ label: lbl, value }) => (
                      <div key={lbl}>
                        <div style={{ fontSize: 'var(--font-size-3xs)', color: 'var(--color-text-light)', marginBottom: 2 }}>{lbl}</div>
                        <div style={{ fontSize: 'var(--font-size-sm2)', fontWeight: 700, color: 'var(--color-text-main)' }}>{value}</div>
                      </div>
                    ))}
                  </div>
                  {(() => {
                    const domains = EXAM_DOMAINS[exam] ?? [];
                    const weights = DOMAIN_WEIGHTS[exam] ?? [];
                    if (domains.length === 0 || weights.length === 0) return null;
                    return (
                      <>
                        <button
                          onClick={() => setDomainOpen(o => !o)}
                          style={{
                            width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                            background: 'none', border: 'none', cursor: 'pointer',
                            padding: '8px 0 0', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)', fontWeight: 600,
                          }}
                        >
                          <span>{ja ? 'ドメイン別出題割合' : 'Domain Weights'}</span>
                          <span style={{ fontSize: 'var(--font-size-3xs)', display: 'inline-block', transform: domainOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>▼</span>
                        </button>
                        {domainOpen && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 8 }}>
                            {domains.map((d, i) => {
                              const pct = weights[i] ?? 0;
                              return (
                                <div key={d}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-sub)', marginBottom: 3 }}>
                                    <span>{d}</span>
                                    <span style={{ fontWeight: 700, color: levelColor, flexShrink: 0, marginLeft: 8 }}>{pct}%</span>
                                  </div>
                                  <div style={{ height: 4, background: 'var(--color-border)', borderRadius: 2 }}>
                                    <div style={{ width: `${pct}%`, height: '100%', background: levelColor, borderRadius: 2 }} />
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>
                )}
                {passComments[exam] && (
                  <div style={{ marginTop: 12, padding: '10px 12px', background: tint(levelColor, 7), borderLeft: `3px solid ${levelColor}`, borderRadius: '0 6px 6px 0' }}>
                    <div style={{ fontSize: 'var(--font-size-2xs)', color: levelColor, fontWeight: 700, marginBottom: 4 }}>{ja ? '運営者コメント' : 'From the team'}</div>
                    <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', lineHeight: 1.7 }}><MarkdownText text={passComments[exam]} color={levelColor} /></div>
                  </div>
                )}
              </div>
            );
          })()}
        </div>

        {/* フッター：決定ボタン。初回の最重要操作なので、文字入りの主ボタンにする
            （以前は 44px のアイコンボタン＋動き続ける矢印で、何を押せばよいか分かりにくかった） */}
        {previewExam && (() => {
          const exam = previewExam;
          const isCurrentTarget = targetExam === exam;
          return (
            <div style={{ flexShrink: 0, borderTop: `2px solid ${tint(levelColor, 20)}`, background: tint(levelColor, 3), padding: 'var(--spacing-sm) var(--spacing-md)', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 'var(--spacing-md)', minHeight: 64 }}>
              {(isCurrentTarget || confirming) ? (
                <div role="status" style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-xs)', fontSize: 'var(--font-size-sm2)', fontWeight: 700, color: 'var(--color-success)' }}>
                  <IconCircleCheck size={18} />{ja ? `${exam} を学習中` : `Studying ${exam}`}
                </div>
              ) : (
                <Button
                  data-kbnav="confirm"
                  onClick={(e) => {
                    if (confirming) return;
                    setConfirming(true);
                    resetExercisePrefsOnExamChange(uid, localStorage.getItem(`targetExam_${uid}`), exam);
                    localStorage.setItem(`targetExam_${uid}`, exam);
                    window.dispatchEvent(new CustomEvent('targetExamChanged', { detail: exam }));
                    // 押した操作への応答としてだけパーティクルを出す
                    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
                    if (!reduceMotion) {
                      const r = e.currentTarget.getBoundingClientRect();
                      setBurst({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
                    }
                    // 「学習中」を一瞬見せてから反映する
                    setTimeout(() => { onSelect(exam); setConfirming(false); }, 700);
                    // 非オンボーディング（マイページからの目標資格変更等）では、反映の約1秒後にオーバレイを自動で閉じる。
                    // オンボーディングは導線が異なるため onSelect 側で制御し除外。
                    if (!onboarding && onClose) setTimeout(() => onClose(), 1700);
                  }}
                  disabled={confirming}
                >
                  {ja ? `${exam} を目標にする` : `Set ${exam} as target`}
                </Button>
              )}
            </div>
          );
        })()}
      </div>

      {burst && <ConfirmBurst x={burst.x} y={burst.y} color={levelColor} onDone={() => setBurst(null)} />}
    </div>,
    document.body,
  );
}
