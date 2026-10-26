'use client';
import React, { useState, useEffect } from 'react';
import { Navigate, useNavigate } from '@/compat/react-router-dom';
import { useAuth, hadPriorSession } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import { IconUser, IconBot, IconTarget, IconTrendingUp, IconNetwork } from '../components/Icons';
import Reveal from '../components/Reveal';
import { SiteArchitecture } from '../components/SiteArchitecture';
import { EXAM_TYPES } from '../constants';

const BENEFITS: { ja: string; en: string }[] = [
  {
    ja: 'キャリアアップに直結。AWS認定は世界標準のクラウド資格として採用市場で高く評価されています。',
    en: 'Globally recognized. AWS certifications are valued by employers worldwide and can lead to career advancement.',
  },
  {
    ja: 'クラウドスキルを客観的に証明できます。設計・セキュリティ・コスト最適化など実務直結の知識が身につきます。',
    en: 'Validate your skills. Gain practical knowledge in architecture, security, and cost optimization with recognized credentials.',
  },
  {
    ja: '入門レベルのCLFからプロフェッショナル・スペシャリティまで、段階的に学習できる体系が整っています。',
    en: 'Structured path. Progress from foundational CLF through professional and specialty levels at your own pace.',
  },
];

// 問題数（QUESTION_COUNT）に依存する文言は関数コンポーネント内で組み立てる
// （count は app/page.tsx がビルド時に取得して渡す prop のため）。
const FEATURES_STATIC: { ja_title: string; en_title: string; ja: string; en: string; icon: React.ReactNode }[] = [
  {
    icon: <IconTarget size={24} />,
    ja_title: '4つの学習モード',
    en_title: 'Four Study Modes',
    ja: 'サクッと演習・演習・模試・しっかり対策の4モードを搭載。スキマ時間の短期演習から本番形式の模試、苦手問題の重点練習まで目的に合わせて選べます。',
    en: 'Four modes: quick session, step-by-step practice, timed exam simulation, and focused training on weak/incorrect questions — pick what fits your goal.',
  },
  {
    icon: <IconTrendingUp size={24} />,
    ja_title: '弱点分析・学習記録',
    en_title: 'Analysis & Progress Tracking',
    ja: 'ドメイン別の正答率グラフで苦手分野を即把握。週間達成状況・予想スコア推移・解答履歴を記録し、成長の軌跡を可視化します。',
    en: 'Spot weak domains instantly with per-domain accuracy charts. Track weekly goals, estimated score trends, and answer history to see your growth over time.',
  },
];

const COMPARE_ROWS: { p: [string, string]; s: [string, string] }[] = [
  { p: ['ロードが遅い', 'Slow loading'], s: ['待たせない表示速度（ローカルに自動プリフェッチ＆キャッシュ）', 'Instant display that never makes you wait (auto local prefetch & cache)'] },
  { p: ['弱点分析が甘い', 'Weak personalization'], s: ['解くほど穴が見える弱点特化（出題ドメイン別に集計・分析）', 'Weak-point focus that sharpens as you solve (tallied & analyzed by exam domain)'] },
  { p: ['日本語が不自然', 'Awkward Japanese'], s: ['自然で読みやすい日本語（自動AI監査スクリプトを毎晩実行）', 'Natural, readable Japanese (nightly automated AI audit script)'] },
  { p: ['情報が古い', 'Outdated content'], s: ['最新試験に合わせて作り直し（自動AI監査スクリプトを毎晩実行）', 'Rebuilt to match the latest exams (nightly automated AI audit script)'] },
];

// FALLBACK は app/page.tsx からの props 未指定時（型上は起きない想定）の保険。
// 実際の値は questionCount.ts が計算し、この関数の呼び出し元(app/page.tsx)が渡す。
const QUESTION_COUNT_FALLBACK = 4500;

export default function Portal({ questionCount = QUESTION_COUNT_FALLBACK }: { questionCount?: number }) {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const { lang } = useLanguage();
  const ja = lang === 'ja';
  const qCount = questionCount.toLocaleString();

  const FEATURES: { ja_title: string; en_title: string; ja: string; en: string; icon: React.ReactNode }[] = [
    {
      icon: <IconBot size={24} />,
      ja_title: 'AI生成の練習問題',
      en_title: 'AI-Generated Questions',
      ja: `Claude AIが作成した全12資格対応の本番同等問題を${qCount}問以上収録。各選択肢ごとの解説付きで、正解だけでなく不正解の理由まで理解できます。`,
      en: `Over ${qCount} exam-grade questions across all 12 AWS certifications, created by Claude AI with per-choice explanations — learn not just what's right, but why each option is wrong.`,
    },
    ...FEATURES_STATIC,
  ];

  const HERO_STATS: { num: string; ja: string; en: string }[] = [
    { num: `${qCount}+`, ja: '練習問題', en: 'Questions' },
    { num: '12',  ja: '資格対応',   en: 'Certifications' },
    { num: '4',   ja: '学習モード', en: 'Study Modes' },
  ];
  // SSR安全: 初期値はサーバー/初回クライアントで一致する固定値にし、実値はマウント後に反映する
  // （静的HTMLにランディング本文を出すため、レンダー中は window/localStorage を参照しない）。
  const [isMobile, setIsMobile] = useState(false);
  const [cookieConsent, setCookieConsent] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [doRedirect, setDoRedirect] = useState(false);

  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    handler(); // マウント時に実際の画面幅を反映
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  useEffect(() => {
    setCookieConsent(localStorage.getItem('cookie_consent_v1') === 'accepted');
  }, []);

  useEffect(() => {
    // 最初のレンダー直後に mounted=true → ヒーローのトランジション発火
    const t = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(t);
  }, []);

  // ログイン済みユーザーはランディングを表示せずアプリ本体へリダイレクト（クライアント判定・SSR安全）。
  // ?view= または #about のときはランディングを表示したままにする。
  useEffect(() => {
    if (loading || !user) return;
    const forceView =
      new URLSearchParams(window.location.search).has('view') ||
      window.location.hash === '#about';
    if (!forceView) {
      setDoRedirect(true);
    }
  }, [loading, user]);

  if (doRedirect) {
    return <Navigate to="/aws/" replace />;
  }

  // ログイン経験者は、認証確定までランディング(未ログイン向け)を描画しない(?view=/#aboutは除く)。
  // SSR/初回ハイドレーション(!mounted)ではSEO維持のため従来どおり描画し、未ログイン/初回訪問
  // ユーザー(hadPriorSession=false)にも即座にランディングを見せる。
  if (mounted && hadPriorSession() && (loading || user)) {
    const forceView =
      new URLSearchParams(window.location.search).has('view') ||
      window.location.hash === '#about';
    if (!forceView) {
      return (
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-bg-main)' }}>
          <div className="sherpa-spinner" style={{ width: 28, height: 28, borderWidth: 3 }} />
        </div>
      );
    }
  }

  const handleStart = () => navigate('/aws/');
  const acceptCookies = () => {
    localStorage.setItem('cookie_consent_v1', 'accepted');
    setCookieConsent(true);
  };

  const trans = (delay: number) =>
    `opacity 0.65s ease ${delay}ms, transform 0.65s cubic-bezier(0.22, 1, 0.36, 1) ${delay}ms`;

  // スクロールRevealのトリガーを遅らせる: -80px で要素が80px以上ビューポート内に入ってから発火
  const rv = { rootMargin: '-10px 0px -80px 0px', threshold: 0.1 } as const;

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--color-bg-main)', color: 'var(--color-text-main)', fontFamily: 'inherit' }}>
      {/* ── ヘッダー ── */}
      <header style={{
        height: 56, minHeight: 56, background: 'var(--color-bg-white)',
        display: 'flex', alignItems: 'center',
        padding: isMobile ? '0 12px 0 8px' : '0 var(--spacing-lg)',
        gap: 'var(--spacing-md)', zIndex: 200, flexShrink: 0,
        borderBottom: '1px solid var(--color-border)',
      }}>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
          <button
            onClick={() => navigate(user ? '/account' : '/login')}
            aria-label={user ? (ja ? 'アカウント' : 'Account') : (ja ? 'ログイン' : 'Log in')}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: user ? 'var(--color-primary-light)' : 'transparent',
              border: '1px solid var(--color-border)', borderRadius: '50%',
              cursor: 'pointer', color: user ? 'var(--color-primary)' : 'var(--color-text-sub)',
              width: 36, height: 36, padding: 0, flexShrink: 0, transition: 'background 0.2s',
              fontSize: 'var(--font-size-base)', fontWeight: 700, letterSpacing: 0,
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--color-bg-main)'}
            onMouseLeave={e => e.currentTarget.style.background = user ? 'var(--color-primary-light)' : 'transparent'}
          >
            {user?.email ? user.email[0].toUpperCase() : <IconUser />}
          </button>
        </div>
      </header>

      <main style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ maxWidth: 860, margin: '0 auto', padding: isMobile ? 'var(--spacing-md) var(--spacing-md) 88px' : 'var(--spacing-lg) var(--spacing-xl) 88px' }}>

          {/* ── ヒーロー ── */}
          <section style={{ marginBottom: 'var(--spacing-md)' }}>
            <div style={{
              background: 'var(--color-bg-white)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--border-radius-lg)',
              boxShadow: 'var(--box-shadow-sm)',
              padding: isMobile ? 'var(--spacing-lg) var(--spacing-md)' : 'var(--spacing-xl) var(--spacing-xl)',
              textAlign: 'center',
              overflow: 'hidden',
              position: 'relative',
            }}>
              {/* 装飾: 右上のグラデーション円 */}
              <div style={{
                position: 'absolute', top: -50, right: -50, width: 200, height: 200,
                borderRadius: '50%',
                background: 'radial-gradient(circle, rgba(255,153,0,0.12) 0%, transparent 70%)',
                pointerEvents: 'none',
              }} />
              {/* 装飾: 左下のグラデーション円 */}
              <div style={{
                position: 'absolute', bottom: -40, left: -40, width: 160, height: 160,
                borderRadius: '50%',
                background: 'radial-gradient(circle, rgba(0,108,224,0.07) 0%, transparent 70%)',
                pointerEvents: 'none',
              }} />

              {/* ロゴ — 入場: opacity+scale、入場後: 浮遊ループ */}
              <div style={{
                display: 'inline-flex', marginBottom: 'var(--spacing-md)',
                opacity: mounted ? 1 : 0,
                transform: mounted ? 'none' : 'scale(0.82) translateY(8px)',
                transition: trans(0),
              }}>
                <div className="portal-logo-float">
                  <img src="/mugen-icon.png"   alt="無限ノック" style={{ height: isMobile ? 44 : 56, width: 'auto' }} />
                  <img src="/mugen-header.png" alt=""           style={{ height: isMobile ? 44 : 56, width: 'auto' }} />
                </div>
              </div>

              {/* キャッチコピー */}
              <h1 style={{
                fontSize: isMobile ? 'var(--font-size-h3)' : 'var(--font-size-h2)',
                fontWeight: 800, color: 'var(--color-text-main)',
                margin: '0 0 var(--spacing-md)', letterSpacing: '-0.3px', lineHeight: 1.4,
                opacity: mounted ? 1 : 0,
                transform: mounted ? 'none' : 'translateY(14px)',
                transition: trans(110),
              }}>
                {ja ? 'AWS認定試験の練習問題サービス' : 'AWS Certification Practice'}
              </h1>

              {/* 本文 */}
              <p style={{
                fontSize: isMobile ? 'var(--font-size-base)' : 'var(--font-size-md)',
                color: 'var(--color-text-sub)',
                margin: '0 auto var(--spacing-lg)', maxWidth: 620,
                lineHeight: 2, textAlign: 'left',
                opacity: mounted ? 1 : 0,
                transform: mounted ? 'none' : 'translateY(14px)',
                transition: trans(220),
              }}>
                {ja
                  ? `「無限ノック」は、AWS認定全12資格の本番同等問題（${qCount}問以上）から出題する完全解説付きのWeb問題集です。PC・スマホ・タブレットから無料で演習でき、4つの学習モード・ドメイン別の弱点分析・週間目標管理で合格をサポートします。`
                  : `Mugenknock is a fully-explained web question bank with ${qCount}+ exam-grade questions across all 12 AWS certifications. Practice free on PC, phone, or tablet — with four study modes, per-domain weak-point analysis, and weekly goal tracking to keep you on track.`}
              </p>

              {/* 統計バッジ */}
              <div style={{ display: 'flex', justifyContent: 'center', gap: isMobile ? 20 : 40, flexWrap: 'wrap' }}>
                {HERO_STATS.map((stat, i) => (
                  <div
                    key={i}
                    style={{
                      textAlign: 'center',
                      opacity: mounted ? 1 : 0,
                      transform: mounted ? 'none' : 'translateY(10px) scale(0.88)',
                      transition: `opacity 0.5s ease ${340 + i * 90}ms, transform 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) ${340 + i * 90}ms`,
                    }}
                  >
                    <div style={{
                      fontSize: isMobile ? 'var(--font-size-xl)' : 'var(--font-size-h2)',
                      fontWeight: 900, color: 'var(--color-accent-dark)', letterSpacing: '-1px', lineHeight: 1.1,
                    }}>
                      {stat.num}
                    </div>
                    <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-light)', marginTop: 3, fontWeight: 500 }}>
                      {ja ? stat.ja : stat.en}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* ── メリット ── */}
          <section style={{ marginBottom: isMobile ? 'var(--spacing-xl)' : 48 }}>
            <Reveal {...rv} variant="left" offset={20}>
              <h2 style={{
                fontSize: isMobile ? 'var(--font-size-h3)' : 'var(--font-size-h2)',
                fontWeight: 800, color: 'var(--color-text-main)',
                margin: '0 0 var(--spacing-md)', letterSpacing: '-0.3px',
              }}>
                {ja ? 'AWS認定資格を取得するメリット' : 'Why Get AWS Certified?'}
              </h2>
            </Reveal>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)' }}>
              {BENEFITS.map((b, i) => (
                <Reveal key={i} {...rv} delay={i * 80} offset={20} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 14,
                  background: 'var(--color-bg-white)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--border-radius-md)',
                  boxShadow: 'var(--box-shadow-sm)',
                  padding: '14px 16px',
                }}>
                  <Reveal variant="pop" {...rv} delay={i * 80 + 60} style={{ flexShrink: 0 }}>
                    <span style={{
                      width: 24, height: 24, borderRadius: '50%',
                      background: 'var(--color-accent)', color: '#fff',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 'var(--font-size-sm2)', fontWeight: 800,
                    }}>{i + 1}</span>
                  </Reveal>
                  <p style={{ margin: 0, fontSize: isMobile ? 'var(--font-size-sm2)' : 'var(--font-size-base)', color: 'var(--color-text-sub)', lineHeight: 1.75 }}>{ja ? b.ja : b.en}</p>
                </Reveal>
              ))}
            </div>
          </section>

          {/* ── 機能 ── */}
          <section style={{ marginBottom: isMobile ? 'var(--spacing-xl)' : 48 }}>
            <Reveal {...rv} variant="left" offset={20}>
              <h2 style={{
                fontSize: isMobile ? 'var(--font-size-h3)' : 'var(--font-size-h2)',
                fontWeight: 800, color: 'var(--color-text-main)',
                margin: '0 0 var(--spacing-md)', letterSpacing: '-0.3px',
              }}>
                {ja ? '無限ノックでできること' : 'What You Can Do'}
              </h2>
            </Reveal>
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)', gap: 14 }}>
              {FEATURES.map((f, i) => (
                <Reveal key={i} {...rv} delay={i * 80} offset={20} className="portal-card" style={{
                  background: 'var(--color-bg-white)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--border-radius-md)',
                  boxShadow: 'var(--box-shadow-sm)',
                  padding: '20px 16px',
                }}>
                  <div style={{
                    width: 40, height: 40, borderRadius: 'var(--border-radius-md)',
                    background: 'var(--color-primary-light)', color: 'var(--color-primary)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    marginBottom: 'var(--spacing-sm)',
                  }}>{f.icon}</div>
                  <div style={{ fontSize: 'var(--font-size-sm2)', fontWeight: 800, color: 'var(--color-primary)', marginBottom: 'var(--spacing-sm)' }}>{ja ? f.ja_title : f.en_title}</div>
                  <p style={{ margin: 0, fontSize: isMobile ? 'var(--font-size-sm)' : 'var(--font-size-sm2)', color: 'var(--color-text-sub)', lineHeight: 1.75 }}>{ja ? f.ja : f.en}</p>
                </Reveal>
              ))}
            </div>
          </section>

          {/* ── 開発の意図・目的 ── */}
          <section>
            <Reveal {...rv} variant="left" offset={20}>
              <h2 style={{
                fontSize: isMobile ? 'var(--font-size-h3)' : 'var(--font-size-h2)',
                fontWeight: 800, color: 'var(--color-text-main)',
                margin: '0 0 var(--spacing-md)', letterSpacing: '-0.3px',
              }}>
                {ja ? '本サイトのポリシー' : 'Our Policy'}
              </h2>
            </Reveal>
            <Reveal {...rv} style={{
              background: 'var(--color-bg-white)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--border-radius-lg)',
              boxShadow: 'var(--box-shadow-sm)',
              padding: isMobile ? 'var(--spacing-md)' : 'var(--spacing-lg) var(--spacing-xl)',
              lineHeight: 1.95,
            }}>
              <p style={{ margin: '0 0 var(--spacing-md)', fontSize: isMobile ? 'var(--font-size-base)' : 'var(--font-size-lg)', fontWeight: 700, color: 'var(--color-text-main)' }}>
                {ja
                  ? '本サイト「無限ノック」は、管理者である西園寺ニアが AWS 資格 全12種の全冠を目指して作成した資格演習サイトです。'
                  : 'Mugenknock is a certification practice site that I — Saionji Nia, the site\'s owner — built to conquer all 12 AWS certifications.'}
              </p>
              <p style={{ margin: '0 0 var(--spacing-md)', fontSize: isMobile ? 'var(--font-size-sm2)' : 'var(--font-size-base)', color: 'var(--color-text-sub)' }}>
                {ja
                  ? '個人的に、既存の問題演習サービスにはずっと不満がありました。サイトを開くたびに待たされるロード。弱点ドメインを集計・分析してくれない不親切さ。どこか不自然な日本語。そして更新が少なく新情報をキャッチアップできていない問題・解説文。'
                  : 'Personally, I was never satisfied with the existing practice services. Loading that keeps you waiting every time you open the site. The unhelpfulness of never tallying or analyzing your weak domains. Japanese that reads a little unnatural. And questions and explanations that are rarely updated and fail to keep up with new information.'}
              </p>
              <p style={{ margin: '0 0 var(--spacing-sm)', fontSize: isMobile ? 'var(--font-size-sm2)' : 'var(--font-size-base)', color: 'var(--color-text-sub)' }}>
                {ja
                  ? 'そんな不満の結果、「ないなら作ってしまおう！」と思い立ちました。なので、このウェブサイトは私が感じていたその不満のひとつひとつに答えを出すつもりで作りました。'
                  : 'Fed up with all of that, I thought, "If it doesn\'t exist, I\'ll just build it!" So I built this website intending to answer every one of those frustrations, one by one.'}
              </p>

              {/* メリットリスト */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)', margin: '0 0 var(--spacing-md)' }}>
                {COMPARE_ROWS.map((row, i) => (
                  <Reveal key={i} {...rv} delay={i * 70} offset={12} style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--spacing-sm)' }}>
                    <span style={{ color: 'var(--color-accent)', fontWeight: 800, flexShrink: 0, lineHeight: 1.6 }}>✓</span>
                    <span style={{ fontSize: isMobile ? 'var(--font-size-sm2)' : 'var(--font-size-base)', color: 'var(--color-text-main)', fontWeight: 700 }}>{ja ? row.s[0] : row.s[1]}</span>
                  </Reveal>
                ))}
              </div>

              <p style={{ margin: 0, fontSize: isMobile ? 'var(--font-size-sm2)' : 'var(--font-size-base)', color: 'var(--color-text-main)', fontWeight: 700, whiteSpace: 'pre-wrap' }}>
                {ja
                  ? '現在私が取得している資格は\n「CLF」「AIF」「SAA」「SOA」「DVA」「SAP」「DOP」\nの7つです。\nAWS資格12種を全冠するまではこのサイトを改良し続けるので、私と同じくAWS 資格の取得へ向けて努力している方はどうぞ使ってみてください！'
                  : 'The certifications I currently hold are CLF, AIF, SAA, SOA, DVA, SAP, and DOP — seven so far. At least until I earn them all, I\'ll keep improving this site. If you\'re working toward AWS certifications like me, please give it a try. I\'d be grateful for any feedback via the report or message features.'}
              </p>
              <p style={{ margin: 'var(--spacing-md) 0 0', textAlign: 'right', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-light)' }}>
                {ja ? '開発者　西園寺ニア' : '— Saionji Nia, Developer'}
              </p>
            </Reveal>
          </section>

          {/* ── Webサイトの構成図（ランディング最下部にそのまま掲載） ── */}
          <section style={{ marginTop: isMobile ? 'var(--spacing-xl)' : 48 }}>
            <Reveal {...rv} variant="left" offset={20}>
              <h2 style={{
                fontSize: isMobile ? 'var(--font-size-h3)' : 'var(--font-size-h2)',
                fontWeight: 800, color: 'var(--color-text-main)',
                margin: '0 0 var(--spacing-lg)', letterSpacing: '-0.3px',
                display: 'flex', alignItems: 'center', gap: 10,
              }}>
                <IconNetwork size={isMobile ? 22 : 26} />
                {ja ? 'Webサイトの構成図' : 'Site Architecture'}
              </h2>
            </Reveal>
            <Reveal {...rv} offset={16}>
              <SiteArchitecture ja={ja} isMobile={isMobile} />
            </Reveal>
          </section>

        </div>
      </main>

<footer style={{ padding: '14px var(--spacing-lg)', textAlign: 'center', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)', borderTop: '1px solid var(--color-border)', background: 'var(--color-bg-white)' }}>
        © {new Date().getFullYear()} MugenKnock
        <span style={{ margin: '0 10px' }}>|</span>
        <a href="/about#privacy" style={{ color: 'var(--color-text-light)', textDecoration: 'none' }}
          onMouseEnter={e => { e.currentTarget.style.textDecoration = 'underline'; }}
          onMouseLeave={e => { e.currentTarget.style.textDecoration = 'none'; }}>
          プライバシーポリシー
        </a>
        <span style={{ margin: '0 10px' }}>|</span>
        <a href="/about#terms" style={{ color: 'var(--color-text-light)', textDecoration: 'none' }}
          onMouseEnter={e => { e.currentTarget.style.textDecoration = 'underline'; }}
          onMouseLeave={e => { e.currentTarget.style.textDecoration = 'none'; }}>
          利用規約
        </a>
      </footer>

      {/* ── 演習開始ボタン（固定） ── */}
      <div style={{
        position: 'fixed', bottom: mounted && !cookieConsent ? 72 : 0, left: 0, right: 0, zIndex: 500,
        background: 'var(--color-bg-white)',
        borderTop: '1px solid var(--color-border)',
        padding: isMobile ? '10px 16px 16px' : '12px 24px 14px',
        boxShadow: 'var(--box-shadow-up)',
      }}>
        <div style={{ maxWidth: 860, margin: '0 auto' }}>
          <button
            onClick={handleStart}
            className="portal-cta-pulse"
            style={{
              width: '100%', height: 44, border: 'none', borderRadius: 22,
              background: 'var(--color-accent)', color: 'var(--color-btn-primary-text)',
              fontWeight: 600, fontSize: 'var(--font-size-base)', cursor: 'pointer',
              transition: 'background 0.15s, transform 0.1s',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = 'var(--color-accent-hover)';
              e.currentTarget.style.transform = 'translateY(-1px)';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = 'var(--color-accent)';
              e.currentTarget.style.transform = 'translateY(0)';
            }}
          >
            {ja ? '演習開始' : 'Start Practice'}
          </button>
          {!user && (
            <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-light)', margin: '4px 0 0', textAlign: 'center' }}>
              {ja ? 'アカウント登録なしで体験できます' : 'No account required to get started'}
            </p>
          )}
        </div>
      </div>

      {/* ── Cookie 同意バナー ── */}
      {mounted && !cookieConsent && (
        <div style={{
          position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 9999,
          background: 'var(--color-bg-white)',
          borderTop: '1px solid var(--color-border)',
          padding: '12px 20px',
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          boxShadow: 'var(--box-shadow-up)',
        }}>
          <span style={{ flex: 1, minWidth: 200, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', lineHeight: 1.6 }}>
            {ja
              ? '本サービスは、ログイン状態の維持・アクセス解析のためにCookieを使用しています。'
              : 'This site uses cookies to keep you signed in and for analytics.'}
            {' '}
            <a href="/about#privacy" style={{ color: 'var(--color-primary)', fontSize: 'var(--font-size-sm)' }}>
              {ja ? '詳細' : 'Learn more'}
            </a>
          </span>
          <button
            onClick={acceptCookies}
            style={{ flexShrink: 0, padding: '6px 18px', background: 'var(--color-accent)', color: 'var(--color-btn-primary-text)', border: 'none', borderRadius: 'var(--border-radius-full)', fontWeight: 700, fontSize: 'var(--font-size-sm)', cursor: 'pointer' }}
          >
            {ja ? '同意して閉じる' : 'Accept'}
          </button>
        </div>
      )}
    </div>
  );
}
