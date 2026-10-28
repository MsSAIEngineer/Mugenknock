'use client';
// 苦手分析（苦手ドメイン＋間違えやすい問題＋問題詳細モーダル）。
// 記録画面（/aws/stats）の「苦手分析」タブの本体。以前はマイページの苦手分析タブにあった（specs/007）。
import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from '@/compat/react-router-dom';
import { API_ENDPOINT, EXAM_DOMAINS, EXAM_DOMAIN_SERVICES, DOMAIN_RATE_WARNING, DOMAIN_RATE_CAUTION, tagIdMatches, toDomainIndex } from '@/constants';
import { lockBodyScroll } from '@/utils/bodyScrollLock';
import Card from '@/components/ui/Card';
import { IconChevronDown, IconLock, IconCopy, IconCheck } from '@/components/Icons';

export const FOCUSED_UNLOCK_THRESHOLD = 20;

type WeakQuestion = {
  questionId: string;
  questionText: string;
  correctCount: number;
  incorrectCount: number;
};

type DomainStat = {
  tagId: string;
  correctCount?: number;
  incorrectCount?: number;
  recentResults?: boolean[];
};

// 集計の窓。'all' は累計（correctCount / incorrectCount）。
// 以前は統計画面の「ノック成績」に累計のドメイン別正答率が別にあり、同じ正答率が画面で食い違っていた
type RecentWindow = 10 | 20 | 30 | 'all';

const CopyButton = ({ getText }: { getText: () => string }) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(getText()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const color = copied ? 'var(--color-success)' : 'var(--color-primary)';
  return (
    <button
      onClick={handleCopy}
      title={copied ? 'コピー済み' : 'コピー'}
      aria-label={copied ? 'コピー済み' : 'コピー'}
      style={{
        background: 'none', border: `1.5px solid ${color}`, borderRadius: '50%',
        width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer', color, transition: 'all 0.2s', flexShrink: 0,
      }}
    >
      {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
    </button>
  );
};

export default function WeakAnalysis({ userId, targetExam, ja, isMobile }: {
  userId: string | null;
  targetExam: string | null;
  ja: boolean;
  isMobile: boolean;
}) {
  const navigate = useNavigate();

  // ── ドメイン統計 ──
  const [domainStats, setDomainStats] = useState<DomainStat[]>([]);
  const [answeredCount, setAnsweredCount] = useState(0);
  const [statsLoading, setStatsLoading] = useState(false);
  // 苦手ドメインの正答率フィルタ（直近N問。演習開始当初のデータを除外して現在の実力を測る）
  const [recentWindow, setRecentWindow] = useState<RecentWindow>(10);

  useEffect(() => {
    if (!userId || !targetExam) return;
    setStatsLoading(true);
      // 累計（correctCount/incorrectCount）はサーバが examType 指定時にだけ UserQuestionStats から集計して埋める。
      // 指定しないと「累計」タブが全ドメイン未演習になる。
    Promise.all([
      fetch(`${API_ENDPOINT}/users/me/stats?userId=${userId}&examType=${targetExam}`).then(r => r.json()),
      fetch(`${API_ENDPOINT}/users/me/question-stats?userId=${userId}&examType=${targetExam}`).then(r => r.json()),
    ]).then(([statsData, qData]) => {
      setDomainStats(statsData.stats ?? []);
      setAnsweredCount(qData.answeredCount ?? 0);
    }).catch(() => {}).finally(() => setStatsLoading(false));
  }, [userId, targetExam]);

  const focusedUnlocked = !!userId && answeredCount >= FOCUSED_UNLOCK_THRESHOLD;

  // ── 頻出ミス問題 ──
  const [weakQuestions, setWeakQuestions] = useState<WeakQuestion[]>([]);
  const [weakLoading, setWeakLoading] = useState(false);
  const [weakLoaded, setWeakLoaded] = useState(false);

  useEffect(() => {
    if (!userId || !targetExam || !focusedUnlocked || weakLoaded) return;
    setWeakLoading(true);
    fetch(`${API_ENDPOINT}/users/me/weak-questions?userId=${userId}&examType=${targetExam}&minIncorrect=2`)
      .then(r => r.json())
      .then(d => { setWeakQuestions(d.items ?? []); setWeakLoaded(true); })
      .catch(() => {})
      .finally(() => setWeakLoading(false));
  }, [userId, targetExam, focusedUnlocked, weakLoaded]);

  // ── 問題詳細モーダル ──
  const [weakQDetails, setWeakQDetails] = useState<Record<string, any>>({});
  const [weakQDetailLoading, setWeakQDetailLoading] = useState<string | null>(null);
  const [questionModal, setQuestionModal] = useState<{ qid: string; detail: any | null; loading: boolean } | null>(null);

  useEffect(() => {
    if (!questionModal) return;
    return lockBodyScroll();
  }, [questionModal]);

  const openWeakQModal = useCallback(async (qid: string) => {
    const cached = weakQDetails[qid];
    setQuestionModal({ qid, detail: cached ?? null, loading: !cached });
    if (!cached && weakQDetailLoading !== qid) {
      setWeakQDetailLoading(qid);
      try {
        const res = await fetch(`${API_ENDPOINT}/questions/${qid}`);
        const data = await res.json();
        setWeakQDetails(prev => ({ ...prev, [qid]: data }));
        setQuestionModal(prev => prev?.qid === qid ? { ...prev, detail: data, loading: false } : prev);
      } catch {
        setWeakQDetails(prev => ({ ...prev, [qid]: null }));
        setQuestionModal(prev => prev?.qid === qid ? { ...prev, loading: false } : prev);
      } finally { setWeakQDetailLoading(null); }
    }
  }, [weakQDetails, weakQDetailLoading]);

  // ── Ctrl/Cmd+Enter で「しっかり対策」を開始（Web版のみ、ホームと同挙動） ──
  useEffect(() => {
    if (isMobile) return;
    const h = (e: KeyboardEvent) => {
      if (!(e.key === 'Enter' && (e.ctrlKey || e.metaKey))) return;
      if (!focusedUnlocked || questionModal) return;
      const el = e.target as HTMLElement | null;
      const t = el?.tagName;
      if (t === 'INPUT' || t === 'TEXTAREA' || el?.isContentEditable) return;
      e.preventDefault();
      navigate('/aws/', { state: { startFocused: true } });
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [isMobile, focusedUnlocked, questionModal, navigate]);

  const domains = EXAM_DOMAINS[targetExam ?? ''] ?? [];

  // ドメインの正答率。窓が直近N問なら recentResults の末尾N件、累計なら correctCount/incorrectCount。
  // 直近の履歴が無い場合だけ累計にフォールバックする（以前のマイページと同じ）
  const domainResult = (domain: string) => {
    const dIdx = toDomainIndex(targetExam ?? '', domain);
    const stat = domainStats.find(s => tagIdMatches(s.tagId, targetExam ?? '', dIdx));
    const cumCorrect = stat?.correctCount ?? 0;
    const cumTotal = cumCorrect + (stat?.incorrectCount ?? 0);
    const recent = recentWindow === 'all' ? [] : (stat?.recentResults ?? []).slice(-recentWindow);
    const correct = recent.length > 0 ? recent.filter(Boolean).length : cumCorrect;
    const total = recent.length > 0 ? recent.length : cumTotal;
    return { dIdx, correct, total, pct: total > 0 ? Math.round((correct / total) * 100) : null };
  };

  if (!userId) {
    return (
      <Card padding="var(--spacing-xl)">
        <p style={{ margin: 0, textAlign: 'center', fontSize: 'var(--font-size-sm2)', color: 'var(--color-text-light)' }}>
          {ja ? 'ログインすると苦手分析が表示されます' : 'Log in to view your analysis'}
        </p>
      </Card>
    );
  }
  if (!targetExam) {
    return (
      <Card padding="var(--spacing-xl)">
        <p style={{ margin: 0, textAlign: 'center', fontSize: 'var(--font-size-sm2)', color: 'var(--color-text-light)' }}>
          {ja ? '目標資格を設定してください' : 'Set a target exam first'}
        </p>
      </Card>
    );
  }
  if (statsLoading) {
    return (
      <>
        <Card style={{ marginBottom: 'var(--spacing-md)' }}>
          <div className="skeleton" style={{ height: 10, width: '35%', borderRadius: 'var(--border-radius-sm)', marginBottom: 'var(--spacing-md)' }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {[68, 55, 82, 46, 73].map((w, i) => (
              <div key={i} style={{ paddingTop: i === 0 ? 0 : 'var(--spacing-md)', paddingBottom: i < 4 ? 'var(--spacing-md)' : 0, borderBottom: i < 4 ? '1px solid var(--color-border)' : 'none', display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 'var(--spacing-md)', rowGap: 'var(--spacing-xs)', alignItems: 'baseline' }}>
                <div className="skeleton" style={{ height: 18, width: 44, borderRadius: 'var(--border-radius-sm)' }} />
                <div className="skeleton" style={{ height: 14, width: `${w}%`, borderRadius: 'var(--border-radius-sm)' }} />
                <div style={{ gridColumn: 2 }}><div className="skeleton" style={{ height: 10, width: '88%', borderRadius: 'var(--border-radius-sm)' }} /></div>
              </div>
            ))}
          </div>
        </Card>
        <Card>
          <div className="skeleton" style={{ height: 14, width: '55%', borderRadius: 'var(--border-radius-sm)', marginBottom: 'var(--spacing-md)' }} />
          {[1, 2, 3].map(i => (
            <div key={i} style={{ height: 44, borderRadius: 'var(--border-radius-md)', border: '1px solid var(--color-border)', marginBottom: i < 3 ? 'var(--spacing-sm)' : 0, overflow: 'hidden' }}>
              <div className="skeleton" style={{ height: '100%', borderRadius: 0 }} />
            </div>
          ))}
        </Card>
      </>
    );
  }

  const maxEx = Math.max(0, ...domains.map(d => {
    const st = domainStats.find(s => tagIdMatches(s.tagId, targetExam, toDomainIndex(targetExam, d)));
    return (st?.recentResults ?? []).length;
  }));

  return (
    <>
      {/* 苦手ドメイン */}
      <Card style={{ marginBottom: 'var(--spacing-md)' }}>
        <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-text-sub)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 'var(--spacing-md)' }}>
          {ja ? '苦手ドメイン' : 'Weak Domains'}
        </div>
        {!focusedUnlocked ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)', padding: 'var(--spacing-sm) var(--spacing-md)', borderRadius: 'var(--border-radius-md)', background: 'var(--color-bg-main)' }}>
            <IconLock size={14} />
            <div>
              <div style={{ fontSize: 'var(--font-size-sm2)', color: 'var(--color-text-sub)' }}>
                {ja ? `あと${Math.max(0, FOCUSED_UNLOCK_THRESHOLD - answeredCount)}問演習するとアンロック` : `${Math.max(0, FOCUSED_UNLOCK_THRESHOLD - answeredCount)} more questions to unlock`}
              </div>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)' }}>
                {ja ? `現在 ${answeredCount}/${FOCUSED_UNLOCK_THRESHOLD}問` : `${answeredCount}/${FOCUSED_UNLOCK_THRESHOLD} answered`}
              </div>
            </div>
          </div>
        ) : domains.length === 0 ? (
          <p style={{ margin: 0, fontSize: 'var(--font-size-sm2)', color: 'var(--color-text-light)' }}>
            {ja ? 'ドメイン情報がありません' : 'No domain data'}
          </p>
        ) : (
          <>
          {/* 集計の窓：直近N問は演習開始当初の古いデータを除外して現在の正答率を測る。累計は全期間 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)', marginBottom: 'var(--spacing-md)', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)', fontWeight: 700 }}>{ja ? '集計対象' : 'Window'}</span>
            <div style={{ display: 'inline-flex', border: '1px solid var(--color-border)', borderRadius: 'var(--border-radius-md)', overflow: 'hidden' }}>
              {([10, 20, 30, 'all'] as const).map((w, i) => {
                const active = recentWindow === w;
                const disabled = w !== 'all' && w - 10 >= maxEx;
                return (
                  <button
                    key={w}
                    onClick={() => !disabled && setRecentWindow(w)}
                    disabled={disabled}
                    aria-pressed={active}
                    style={{ border: 'none', borderLeft: i === 0 ? 'none' : '1px solid var(--color-border)', background: active ? 'var(--color-primary)' : 'transparent', color: disabled ? 'var(--color-text-light)' : active ? 'var(--color-on-primary)' : 'var(--color-text-sub)', fontSize: 'var(--font-size-xs)', fontWeight: 700, padding: 'var(--spacing-xs) var(--spacing-md)', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.4 : 1, transition: 'background 0.15s' }}
                  >
                    {w === 'all' ? (ja ? '累計' : 'All time') : (ja ? `直近${w}問` : `Last ${w}`)}
                  </button>
                );
              })}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {[...domains].sort((a, b) => (domainResult(a).pct ?? 101) - (domainResult(b).pct ?? 101)).map((domain, di) => {
              const { dIdx, correct, total, pct } = domainResult(domain);
              const isWeak = pct !== null && pct < DOMAIN_RATE_WARNING * 100;
              const isFair = pct !== null && pct < DOMAIN_RATE_CAUTION * 100 && !isWeak;
              const color = pct === null ? 'var(--color-text-light)' : isWeak ? 'var(--color-danger)' : isFair ? 'var(--color-caution)' : 'var(--color-success)';
              const services = EXAM_DOMAIN_SERVICES[targetExam]?.[dIdx] ?? [];
              const notLast = di < domains.length - 1;
              return (
                <div key={domain} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 'var(--spacing-md)', rowGap: 'var(--spacing-xs)', alignItems: 'baseline', paddingTop: di === 0 ? 0 : 'var(--spacing-md)', paddingBottom: notLast ? 'var(--spacing-md)' : 0, borderBottom: notLast ? '1px solid var(--color-border)' : 'none' }}>
                  <span style={{ gridColumn: 1, whiteSpace: 'nowrap' }}>
                    <span style={{ fontSize: 'var(--font-size-lg)', fontWeight: 800, color }}>
                      {pct !== null ? `${pct}%` : (ja ? '未演習' : 'N/A')}
                    </span>
                    {total > 0 && (
                      <span style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-light)', marginLeft: 'var(--spacing-xs)' }}>
                        （{correct}/{total}{ja ? '問' : ''}）
                      </span>
                    )}
                  </span>
                  <span style={{ gridColumn: 2, fontSize: 'var(--font-size-sm2)', color: isWeak ? 'var(--color-danger)' : 'var(--color-text-main)', fontWeight: isWeak ? 700 : 600, lineHeight: 1.45 }}>
                    {isWeak && '⚠ '}{domain}
                  </span>
                  {services.length > 0 && (
                    <div style={{ gridColumn: 2, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-sub)', lineHeight: 1.65 }}>
                      <span style={{ fontWeight: 700 }}>{ja ? '頻出サービス・機能：' : 'Key services: '}</span>
                      {services.join(' / ')}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 'var(--spacing-md)', paddingTop: 'var(--spacing-sm)', borderTop: '1px solid var(--color-border)', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)', lineHeight: 1.6 }}>
            {ja
              ? '「しっかり対策」モードでは苦手問題・誤答問題を優先して出題します。ホーム画面から開始できます。'
              : '"Focused Practice" mode prioritizes your weak and incorrect questions. Start it from the home screen.'}
          </div>
          </>
        )}
      </Card>

      {/* 頻出ミス問題 */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)', marginBottom: 'var(--spacing-md)' }}>
          <span style={{ fontSize: 'var(--font-size-base)' }}>✗</span>
          <span style={{ fontWeight: 700, fontSize: 'var(--font-size-base)' }}>{ja ? '間違えやすい問題（2回以上）' : 'Frequent Mistakes (2+ times)'}</span>
        </div>
        {!focusedUnlocked ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)', padding: 'var(--spacing-sm) var(--spacing-md)', borderRadius: 'var(--border-radius-md)', background: 'var(--color-bg-main)' }}>
            <IconLock size={14} />
            <span style={{ fontSize: 'var(--font-size-sm2)', color: 'var(--color-text-sub)' }}>
              {ja ? `あと${Math.max(0, FOCUSED_UNLOCK_THRESHOLD - answeredCount)}問でアンロック` : `${Math.max(0, FOCUSED_UNLOCK_THRESHOLD - answeredCount)} more to unlock`}
            </span>
          </div>
        ) : weakLoading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)' }}>
            {[1, 2, 3].map(i => (
              <div key={i} style={{ height: 48, borderRadius: 'var(--border-radius-md)', border: '1px solid var(--color-border)', overflow: 'hidden' }}>
                <div className="skeleton" style={{ height: '100%', borderRadius: 0 }} />
              </div>
            ))}
          </div>
        ) : weakQuestions.length === 0 ? (
          <p style={{ margin: 0, fontSize: 'var(--font-size-sm2)', color: 'var(--color-text-light)', textAlign: 'center', padding: '8px 0' }}>
            {ja ? '2回以上間違えた問題はありません' : 'No questions wrong 2+ times'}
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)' }}>
            {weakQuestions.map(q => (
              <button
                key={q.questionId}
                type="button"
                onClick={() => openWeakQModal(q.questionId)}
                style={{ borderRadius: 'var(--border-radius-md)', border: '1px solid var(--color-border)', background: 'transparent', padding: 'var(--spacing-sm)', display: 'flex', gap: 'var(--spacing-sm)', alignItems: 'flex-start', cursor: 'pointer', textAlign: 'left', width: '100%' }}
              >
                <span style={{ flexShrink: 0, fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-danger)', background: 'var(--color-danger-light)', borderRadius: 'var(--border-radius-sm)', padding: '0 var(--spacing-xs)' }}>
                  ×{q.incorrectCount}
                </span>
                <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', lineHeight: 1.5, flex: 1 }}>
                  {q.questionText?.slice(0, 80)}{(q.questionText?.length ?? 0) > 80 ? '…' : ''}
                </span>
                <span style={{ flexShrink: 0, color: 'var(--color-text-light)', display: 'flex', alignItems: 'center', transform: 'rotate(-90deg)' }}>
                  <IconChevronDown size={14} />
                </span>
              </button>
            ))}
          </div>
        )}
      </Card>

      {/* ── 問題詳細モーダル ── */}
      {questionModal && (
        <div
          data-kbscope="1" role="dialog" aria-modal="true" aria-label={ja ? '問題詳細' : 'Question detail'}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: isMobile ? 'flex-end' : 'center', justifyContent: 'center', padding: isMobile ? 0 : 'var(--spacing-lg)' }}
          onClick={() => setQuestionModal(null)}
        >
          <div
            style={{ background: 'var(--color-bg-white)', borderRadius: isMobile ? 'var(--border-radius-lg) var(--border-radius-lg) 0 0' : 'var(--border-radius-lg)', padding: 'var(--spacing-xl)', width: '100%', maxWidth: isMobile ? '100%' : 'var(--modal-width-md)', maxHeight: isMobile ? '85vh' : '80vh', overflowY: 'auto', boxShadow: 'var(--box-shadow-lg)' }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-lg)' }}>
              <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 700, color: 'var(--color-text-sub)' }}>
                {ja ? '問題詳細' : 'Question Detail'}
              </span>
              <button onClick={() => setQuestionModal(null)} aria-label={ja ? '閉じる' : 'Close'} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-sub)', fontSize: 'var(--font-size-xl)', lineHeight: 1, padding: '0 var(--spacing-xs)' }}>✕</button>
            </div>

            {questionModal.loading ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--spacing-xl) 0' }}>
                <div className="sherpa-spinner" />
              </div>
            ) : questionModal.detail ? (
              <div style={{ userSelect: 'text' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-sm)' }}>
                  <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-text-sub)' }}>{ja ? '問題文' : 'Question'}</span>
                  <CopyButton getText={() => {
                    const choices = (questionModal.detail.choices ?? []).map((c: string, i: number) => `${String.fromCharCode(65 + i)}. ${c.replace(/^[A-E]\.\s*/, '')}`).join('\n');
                    return `${questionModal.detail.questionText}\n\n${choices}`;
                  }} />
                </div>
                <p style={{ fontSize: 'var(--font-size-base)', color: 'var(--color-text-main)', lineHeight: 1.75, margin: '0 0 var(--spacing-lg)', whiteSpace: 'pre-wrap', fontWeight: 500 }}>
                  {questionModal.detail.questionText}
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)', marginBottom: 'var(--spacing-lg)' }}>
                  {(questionModal.detail.choices ?? []).map((c: string, i: number) => {
                    const isCorrect = (questionModal.detail.correctAnswerIndices ?? []).includes(i);
                    return (
                      <div key={i} style={{ fontSize: 'var(--font-size-sm)', padding: 'var(--spacing-sm) var(--spacing-md)', borderRadius: 'var(--border-radius-md)', border: `1.5px solid ${isCorrect ? 'var(--color-success)' : 'var(--color-border)'}`, background: isCorrect ? 'var(--color-feedback-correct-bg)' : 'var(--color-bg-main)', color: isCorrect ? 'var(--color-success)' : 'var(--color-text-sub)', lineHeight: 1.6 }}>
                        <span style={{ fontWeight: 700, marginRight: 'var(--spacing-xs)' }}>{String.fromCharCode(65 + i)}.</span>
                        {isCorrect ? '✓ ' : ''}{c.replace(/^[A-E]\.\s*/, '')}
                      </div>
                    );
                  })}
                </div>
                {questionModal.detail.explanation && (
                  <div style={{ padding: 'var(--spacing-md)', borderRadius: 'var(--border-radius-md)', background: 'var(--color-bg-info)', border: '1px solid var(--color-border-info)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-sm)' }}>
                      <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-text-info)' }}>{ja ? '解説' : 'Explanation'}</span>
                      <CopyButton getText={() => {
                        const choices = (questionModal.detail.choices ?? []).map((c: string, i: number) => `${String.fromCharCode(65 + i)}. ${c.replace(/^[A-E]\.\s*/, '')}`).join('\n');
                        return `${questionModal.detail.questionText}\n\n${choices}\n\n${ja ? '解説' : 'Explanation'}\n${questionModal.detail.explanation}`;
                      }} />
                    </div>
                    <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', margin: 0, lineHeight: 1.75, whiteSpace: 'pre-wrap' }}>{questionModal.detail.explanation}</p>
                  </div>
                )}
                {/* iOS Safari の padding-bottom スクロール欠落 + safe area 対策 */}
                {isMobile && <div style={{ height: 'calc(var(--spacing-xl) + env(safe-area-inset-bottom, 0px))' }} aria-hidden="true" />}
              </div>
            ) : (
              <p style={{ margin: 0, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-light)' }}>{ja ? '詳細を取得できませんでした' : 'Failed to load details'}</p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
