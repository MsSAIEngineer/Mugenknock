'use client';
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useLocation } from '@/compat/react-router-dom';
import { API_ENDPOINT } from '../constants';
import WeakAnalysis from '../components/records/WeakAnalysis';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import PageLayout from '../components/ui/PageLayout';
import { getCached, setCached } from '../utils/cache';
import { IconStar, IconTarget, IconLightbulb } from '../components/Icons';

const TARGET_EXAM_KEY_BASE = 'targetExam';
const STATS_GOOD_RATE = 70;

type Session = {
  sessionId: string;
  examType: string;
  mode: string;
  score: number;
  isPassed: boolean;
  startedAt: string;
  endedAt?: string;
  isMini?: boolean;
  isFocused?: boolean;
  questionIds?: string[];
};

type AnswerRecord = {
  questionId: string;
  questionText: string;
  isCorrect: boolean;
  answeredAt: string;
};


// ── スコア推移折れ線グラフ ────────────────────────────────────────────
const ScoreLineChart = ({ sessions, passRate, lang }: { sessions: Session[]; passRate?: number; lang: string }) => {
  const [tooltip, setTooltip] = useState<{ x: number; y: number; session: Session } | null>(null);

  const W = 500, H = 160;
  const padL = 30, padR = 36, padT = 16, padB = 16;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const n = sessions.length;
  const xOf = (i: number) => padL + (n > 1 ? (i / (n - 1)) * chartW : chartW / 2);
  const yOf = (score: number) => padT + chartH * (1 - score / 100);
  const linePoints = sessions.map((s, i) => `${xOf(i)},${yOf(s.score)}`).join(' ');
  const gridScores = [0, 25, 50, 75, 100];

  const stagger = 0.13;
  const nodeDur = 0.22;
  const totalLineDur = n > 1 ? (n - 1) * stagger + nodeDur : 0;
  const totalLength = n > 1
    ? sessions.slice(0, -1).reduce((sum, _, i) => {
        const dx = xOf(i + 1) - xOf(i);
        const dy = yOf(sessions[i + 1].score) - yOf(sessions[i].score);
        return sum + Math.sqrt(dx * dx + dy * dy);
      }, 0)
    : 0;

  return (
    <svg key={n} viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible' }} role="img"
      aria-label={`セッション別スコア推移（${n}回）`}>
      {gridScores.map(v => (
        <g key={v}>
          <line x1={padL} y1={yOf(v)} x2={W - padR} y2={yOf(v)} stroke="var(--color-border)" strokeWidth={0.7} />
          <text x={padL - 4} y={yOf(v) + 3.5} fontSize={9} textAnchor="end" fill="var(--color-text-light)">{v}</text>
        </g>
      ))}
      {passRate !== undefined && (
        <>
          <line x1={padL} y1={yOf(passRate)} x2={W - padR} y2={yOf(passRate)}
            stroke="var(--color-primary)" strokeWidth={1.2} strokeDasharray="5 3" />
          <text x={W - padR + 3} y={yOf(passRate) + 3.5} fontSize={9} fill="var(--color-primary)" fontWeight="700">{passRate}%</text>
        </>
      )}
      {n > 1 && (
        <polyline points={linePoints} fill="none" stroke="var(--color-primary)" strokeWidth={1.5} strokeOpacity={0.3} strokeLinejoin="round"
          strokeDasharray={totalLength} strokeDashoffset={totalLength}>
          <animate attributeName="stroke-dashoffset" from={String(totalLength)} to="0" dur={`${totalLineDur}s`} fill="freeze" />
        </polyline>
      )}
      {sessions.map((s, i) => {
        const cx = xOf(i), cy = yOf(s.score);
        const color = s.mode === 'exam'
          ? (s.isPassed ? 'var(--color-success)' : 'var(--color-danger)')
          : (s.score >= STATS_GOOD_RATE ? 'var(--color-success)' : 'var(--color-danger)');
        return (
          <circle key={s.sessionId}
            cx={cx} cy={cy} r={0} fill={color}
            style={{ cursor: 'pointer' }}
            onMouseEnter={() => setTooltip({ x: cx, y: cy, session: s })}
            onMouseLeave={() => setTooltip(null)}
          >
            <animate attributeName="r" values="0;4;3" keyTimes="0;0.65;1"
              dur={`${nodeDur}s`} begin={`${i * stagger}s`} fill="freeze" />
            <animate attributeName="opacity" from="0" to="1"
              dur="0.1s" begin={`${i * stagger}s`} fill="freeze" />
          </circle>
        );
      })}
      {tooltip && (() => {
        const { x, y, session: s } = tooltip;
        const modeLabel = s.mode === 'exercise'
          ? (lang === 'ja' ? '演習' : 'Exercise')
          : (s.isMini ? (lang === 'ja' ? 'ミニ模試' : 'Mini Exam') : (lang === 'ja' ? '模試' : 'Mock Exam'));
        const d = new Date(s.endedAt || s.startedAt);
        const dateLabel = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        const lines: string[] = [modeLabel, `${lang === 'ja' ? 'スコア' : 'Score'}: ${s.score}%`, dateLabel];
        if (s.mode === 'exam') lines.push(s.isPassed ? (lang === 'ja' ? '合格' : 'Passed') : (lang === 'ja' ? '不合格' : 'Failed'));
        const lineH = 13, pad = 7, boxW = 128;
        const boxH = lines.length * lineH + pad * 2;
        const boxX = x > W * 0.6 ? x - boxW - 6 : x + 6;
        const boxY = Math.min(y < padT + 40 ? y + 6 : y - boxH - 6, H + 10);
        return (
          <g style={{ pointerEvents: 'none' }}>
            <rect x={boxX} y={boxY} width={boxW} height={boxH}
              style={{ fill: 'var(--color-bg-white)', stroke: 'var(--color-border)', strokeWidth: 1, filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.1))' }}
              rx={4} />
            {lines.map((line, li) => (
              <text key={li} x={boxX + pad} y={boxY + pad + (li + 1) * lineH - 2}
                fontSize={9} fontWeight={li === 0 ? '700' : '400'}
                style={{ fill: li === 0 ? 'var(--color-text-main)' : 'var(--color-text-sub)' }}>
                {line}
              </text>
            ))}
          </g>
        );
      })()}
    </svg>
  );
};

// ── 日次活動棒グラフ（万歩計） ───────────────────────────────────────
const ActivityChart = ({ data, lang }: { data: { label: string; count: number; isToday: boolean }[]; lang: string }) => {
  const [tooltip, setTooltip] = useState<{ x: number; y: number; label: string; count: number; isToday: boolean } | null>(null);
  const chartKey = data.length + '-' + data.map(d => d.count).join(',');
  const W = 600, H = 160;
  const padL = 28, padR = 8, padT = 24, padB = 30;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const n = data.length;
  const maxCount = Math.max(...data.map(d => d.count), 1);
  const slotW = chartW / n;
  const barW = Math.max(4, Math.min(8, slotW * 0.65));
  const showEvery = n <= 7 ? 1 : n <= 14 ? 2 : 5;

  return (
    <svg key={chartKey} viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img"
      aria-label={lang === 'ja'
        ? `日次の解答数（${n}日間・合計${data.reduce((a, d) => a + d.count, 0)}問）`
        : `Daily answers (${n} days, ${data.reduce((a, d) => a + d.count, 0)} total)`}>
      {[0, Math.round(maxCount / 2), maxCount].filter((v, i, a) => a.indexOf(v) === i).map(v => (
        <g key={v}>
          <line x1={padL} y1={padT + chartH * (1 - v / maxCount)} x2={W - padR} y2={padT + chartH * (1 - v / maxCount)}
            stroke="var(--color-border)" strokeWidth={0.7} />
          <text x={padL - 4} y={padT + chartH * (1 - v / maxCount) + 3.5} fontSize={8} textAnchor="end" fill="var(--color-text-light)">{v}</text>
        </g>
      ))}
      {data.map((d, i) => {
        const cx = padL + slotW * i + slotW / 2;
        const barH = d.count > 0 ? Math.max(3, (d.count / maxCount) * chartH) : 0;
        const y = padT + chartH - barH;
        return (
          <g key={i}
            onMouseEnter={() => d.count > 0 && setTooltip({ x: cx, y, label: d.label, count: d.count, isToday: d.isToday })}
            onMouseLeave={() => setTooltip(null)}
            style={{ cursor: d.count > 0 ? 'default' : 'default' }}
          >
            <rect x={padL + slotW * i} y={padT} width={slotW} height={chartH} fill="transparent" />
            {d.count > 0 && (
              <rect x={cx - barW / 2} y={y} width={barW} height={barH} rx={3}
                fill="var(--color-primary)" opacity={d.isToday ? 1 : 0.45}
                style={{
                  transformBox: 'fill-box',
                  transformOrigin: 'center bottom',
                  animation: `growBar 0.45s cubic-bezier(0.34, 1.56, 0.64, 1) ${i * 22}ms both`,
                }}
              />
            )}
            {d.count > 0 && (
              <text x={cx} y={y - 5} textAnchor="middle" fontSize={9} fontWeight="700" fill={d.isToday ? 'var(--color-primary)' : 'var(--color-text-sub)'}
                style={{ animation: `sherpa-fade-in 0.3s ease ${0.25 + i * 0.022}s both` }}>
                {d.count}
              </text>
            )}
            {i % showEvery === 0 && (
              <text x={cx} y={H - padB + 12} textAnchor="middle" fontSize={9} fill={d.isToday ? 'var(--color-text-main)' : 'var(--color-text-light)'} fontWeight={d.isToday ? '700' : '400'}>
                {d.label}
              </text>
            )}
          </g>
        );
      })}
      {tooltip && (() => {
        const { x, y, label, count, isToday } = tooltip;
        const todayLabel = lang === 'ja' ? '今日' : 'Today';
        const lines = [label + (isToday ? ` (${todayLabel})` : ''), `${lang === 'ja' ? '回答数' : 'Answered'}: ${count}`];
        const lineH = 13, pad = 7, boxW = 110;
        const boxH = lines.length * lineH + pad * 2;
        const boxX = Math.min(x + 8, W - padR - boxW);
        const boxY = Math.max(padT, Math.min(y - boxH / 2, H - padB - boxH));
        return (
          <g style={{ pointerEvents: 'none' }}>
            <rect x={boxX} y={boxY} width={boxW} height={boxH} rx={4}
              style={{ fill: 'var(--color-bg-white)', stroke: 'var(--color-border)', strokeWidth: 1, filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.12))' }} />
            {lines.map((line, li) => (
              <text key={li} x={boxX + pad} y={boxY + pad + (li + 1) * lineH - 2}
                fontSize={9} fontWeight={li === 0 ? '700' : '400'}
                style={{ fill: li === 0 ? 'var(--color-text-main)' : 'var(--color-text-sub)' }}>
                {line}
              </text>
            ))}
          </g>
        );
      })()}
    </svg>
  );
};

// ── メインコンポーネント ─────────────────────────────────────────────
export default function Stats() {
  const { user } = useAuth();
  const { lang, t } = useLanguage();
  const navigate = useNavigate();
  const uid = user?.userId ?? 'guest';

  const location = useLocation();
  const isMobile = window.innerWidth < 768;
  // 記録画面（specs/007）。苦手分析・解答履歴・正答率の推移・演習量の4タブ。
  // ホーム苦手分析カード・模試設定・旧マイページのリンクは location.state.tab で初期タブを指定してくる
  type RecordsTab = 'analysis' | 'history' | 'trend' | 'volume';
  const [tab, setTab] = useState<RecordsTab>(() => {
    const requested = (location.state as any)?.tab;
    if (requested === 'performance') return 'trend'; // 旧「ノック成績」タブ
    return requested === 'history' || requested === 'trend' || requested === 'volume' ? requested : 'analysis';
  });
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [sessionAnswers, setSessionAnswers] = useState<Record<string, AnswerRecord[]>>({});
  const [answersLoading, setAnswersLoading] = useState<string | null>(null);
  const [expandedQuestion, setExpandedQuestion] = useState<string | null>(null);
  const [questionDetails, setQuestionDetails] = useState<Record<string, any>>({});
  const [questionDetailLoading, setQuestionDetailLoading] = useState<string | null>(null);
  const [bookmarkedIds, setBookmarkedIds] = useState<Set<string>>(new Set());
  const [bookmarkLoadingId, setBookmarkLoadingId] = useState<string | null>(null);
  const [targetExam, setTargetExam] = useState<string | null>(() => localStorage.getItem(`${TARGET_EXAM_KEY_BASE}_${uid}`));
  // 直接 URL で開いたとき、目標資格は Layout がサーバから読み込んでイベントで知らせてくる（トレーニング画面と同じ）
  useEffect(() => {
    setTargetExam(localStorage.getItem(`${TARGET_EXAM_KEY_BASE}_${uid}`));
    const handler = (e: Event) => setTargetExam((e as CustomEvent<string>).detail ?? null);
    window.addEventListener('targetExamChanged', handler);
    return () => window.removeEventListener('targetExamChanged', handler);
  }, [uid]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [answeredCount, setAnsweredCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [activityRange, setActivityRange] = useState<7 | 14 | 30 | 'all'>(7);
  const [showHint, setShowHint] = useState(() => !localStorage.getItem(`sherpaStatsHint_${uid}`));

  // ── 初期ロード（演習量・解答履歴・推移に必要なデータ） ──
  useEffect(() => {
    if (!user || !targetExam) { setLoading(false); return; }
    const cachedTotal = getCached<number>(`qcount_${targetExam}`);
    if (cachedTotal !== null) setTotalCount(cachedTotal);
    setLoading(true);
    const fetches: Promise<any>[] = [
      fetch(`${API_ENDPOINT}/users/me/sessions?userId=${user.userId}&limit=200`).then(r => r.json()),
      cachedTotal !== null
        ? Promise.resolve(null)
        : fetch(`${API_ENDPOINT}/questions?examType=${targetExam}&limit=0`).then(r => r.json()),
      fetch(`${API_ENDPOINT}/users/me/question-stats?userId=${user.userId}&examType=${targetExam}`).then(r => r.json()),
    ];
    Promise.all(fetches).then(([sessRes, qRes, statsRes]) => {
      setSessions((sessRes.items ?? []).filter((s: Session) => s.examType === targetExam));
      if (qRes !== null) {
        const count = qRes.total ?? qRes.count ?? 0;
        setTotalCount(count);
        setCached(`qcount_${targetExam}`, count);
      }
      setAnsweredCount(statsRes.answeredCount ?? 0);
    }).catch(console.error).finally(() => setLoading(false));
  }, [user, targetExam]);

  // ── 解答履歴タブを開いたときにブックマーク一覧をロード ──
  useEffect(() => {
    if (tab !== 'history' || !user) return;
    fetch(`${API_ENDPOINT}/users/me/bookmarks?userId=${user.userId}`)
      .then(r => r.json())
      .then(d => setBookmarkedIds(new Set(d.questionIds ?? [])))
      .catch(() => {});
  }, [tab, user]);


  // ── 派生データ ──
  const allSortedSessions = useMemo(() =>
    [...sessions].sort((a, b) =>
      (a.endedAt || a.startedAt) > (b.endedAt || b.startedAt) ? 1 : -1), [sessions]);

  const pct = totalCount > 0 ? Math.round((answeredCount / totalCount) * 100) : 0;

  const dailyData = useMemo(() => {
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    let range: number;
    if (activityRange === 'all') {
      if (sessions.length === 0) {
        range = 7;
      } else {
        const earliest = sessions.reduce((min, s) => {
          const d = (s.startedAt || '').slice(0, 10);
          return d && d < min ? d : min;
        }, todayStr);
        range = Math.max(Math.floor((today.getTime() - new Date(earliest + 'T00:00:00Z').getTime()) / 86400000) + 1, 7);
      }
    } else {
      range = activityRange;
    }
    return Array.from({ length: range }, (_, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() - (range - 1 - i));
      const dateStr = d.toISOString().slice(0, 10);
      const count = sessions.reduce((sum, s) => {
        const sDate = (s.endedAt || s.startedAt).slice(0, 10);
        return sDate === dateStr ? sum + (s.questionIds?.length ?? 0) : sum;
      }, 0);
      return { label: `${d.getMonth() + 1}/${d.getDate()}`, count, isToday: dateStr === todayStr };
    });
  }, [sessions, activityRange]);


  const totalActivity = dailyData.reduce((s, d) => s + d.count, 0);
  const effectiveRange = activityRange === 'all' ? dailyData.length : activityRange;
  const avgActivity = effectiveRange > 0 ? (totalActivity / effectiveRange).toFixed(1) : '0';

  // ── 目標資格未設定 ──
  if (!targetExam) {
    return (
      <PageLayout className="page-container">
        <Card padding="var(--spacing-xl)">
          <div style={{ textAlign: 'center', padding: 'var(--spacing-xl) 0' }}>
            <div style={{ fontSize: 32, marginBottom: 'var(--spacing-md)', color: 'var(--color-accent)', display: 'flex', justifyContent: 'center' }}><IconTarget size={40} /></div>
            <p style={{ fontSize: 'var(--font-size-base)', color: 'var(--color-text-sub)', margin: '0 0 var(--spacing-lg)' }}>
              {lang === 'ja' ? '目標資格を設定すると記録が表示されます' : 'Set a target certification to view your records'}
            </p>
            <Button variant="primary" onClick={() => navigate('/aws/')}>
              {lang === 'ja' ? 'ホームで資格を設定する' : 'Set a certification on Home'}
            </Button>
          </div>
        </Card>
      </PageLayout>
    );
  }

  const tabStyle = (active: boolean): React.CSSProperties => ({
    flex: 1, padding: '10px 0', border: 'none', background: 'none', cursor: 'pointer',
    fontSize: 'var(--font-size-base)', fontWeight: active ? 700 : 500,
    color: active ? 'var(--color-primary)' : 'var(--color-text-sub)',
    borderBottom: `2px solid ${active ? 'var(--color-primary)' : 'transparent'}`,
    transition: 'color 0.15s, border-color 0.15s',
  });

  return (
    <PageLayout className="page-container">
      {showHint && (
        <div className="fade-slide-in" style={{
          display: 'flex', alignItems: 'center', gap: 'var(--spacing-md)',
          background: 'var(--color-hint-bg)', border: '1px solid var(--color-hint-border)',
          borderRadius: 'var(--border-radius-md)', padding: '10px var(--spacing-md)',
          marginBottom: 'var(--spacing-lg)', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)',
        }}>
          <span style={{ flexShrink: 0, display: 'flex', alignItems: 'center', color: 'var(--color-text-sub)' }}><IconLightbulb size={16} /></span>
          <span style={{ flex: 1, lineHeight: 1.5 }}>{t('stats.hint')}</span>
          <button onClick={() => { localStorage.setItem(`sherpaStatsHint_${uid}`, '1'); setShowHint(false); }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-light)', fontSize: 'var(--font-size-h3)', lineHeight: 1, padding: '0 4px', flexShrink: 0 }}>✕</button>
        </div>
      )}

      {/* ── タブ ── */}
      <div style={{ display: 'flex', borderBottom: '1px solid color-mix(in srgb, var(--color-text-light) 40%, transparent)', marginBottom: 'var(--spacing-lg)' }}>
        {([
          ['analysis', lang === 'ja' ? '苦手分析' : 'Weak points'],
          ['history', lang === 'ja' ? '解答履歴' : 'History'],
          ['trend', lang === 'ja' ? '正答率の推移' : 'Accuracy'],
          ['volume', lang === 'ja' ? '演習量' : 'Volume'],
        ] as const).map(([key, label]) => (
          <button key={key} data-kbnav="tab" role="tab" aria-selected={tab === key} style={tabStyle(tab === key)} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {/* ════════ 苦手分析タブ（旧マイページ苦手分析） ════════ */}
      {tab === 'analysis' && (
        <WeakAnalysis userId={user?.userId ?? null} targetExam={targetExam} ja={lang === 'ja'} isMobile={isMobile} />
      )}

      {/* ════════ 演習量タブ ════════ */}
      {tab === 'volume' && (
        <>
          {/* 消化進捗 */}
          <Card padding="var(--spacing-lg)" style={{ marginBottom: 'var(--spacing-lg)' }}>
            <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-text-sub)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 'var(--spacing-md)' }}>
              {lang === 'ja' ? '解いた問題数' : 'Total Practice'}
            </div>
            {loading ? (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 'var(--spacing-sm)' }}>
                  <div className="skeleton" style={{ height: 14, width: '55%', borderRadius: 4 }} />
                  <div className="skeleton" style={{ height: 20, width: '25%', borderRadius: 4 }} />
                </div>
                <div className="skeleton" style={{ height: 8, borderRadius: 10, marginBottom: 6 }} />
                <div className="skeleton" style={{ height: 12, width: '20%', borderRadius: 4, marginLeft: 'auto' }} />
              </>
            ) : !user ? (
              <p style={{ margin: 0, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-light)' }}>
                {lang === 'ja' ? 'ログインすると表示されます' : 'Log in to view'}
              </p>
            ) : (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 'var(--spacing-sm)' }}>
                  <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)' }}>
                    {lang === 'ja' ? '1回以上解いた問題' : 'Questions attempted'}
                  </span>
                  <span style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: 'var(--color-primary)' }}>
                    {answeredCount}
                    <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 400, color: 'var(--color-text-sub)' }}> / {totalCount} {t('stats.qUnit')}</span>
                  </span>
                </div>
                {/* HP バー */}
                <div style={{ background: 'var(--color-bg-main)', borderRadius: 10, height: 8, overflow: 'hidden', marginBottom: 6 }}>
                  <div style={{
                    width: `${pct}%`, height: '100%', borderRadius: 10,
                    background: pct >= 60 ? 'var(--bar-gradient-success)' : pct >= 30 ? 'var(--bar-gradient-caution)' : 'var(--bar-gradient-primary)',
                    transformOrigin: 'left center',
                    animation: 'growWidth 0.8s cubic-bezier(0.4, 0, 0.2, 1) both',
                  }} />
                </div>
                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)', textAlign: 'right' }}>
                  {pct}% {lang === 'ja' ? '解答済' : 'covered'}
                </div>
              </>
            )}
          </Card>

          {/* 万歩計グラフ */}
          <Card padding="var(--spacing-lg)">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--spacing-md)', flexWrap: 'wrap', gap: 'var(--spacing-sm)' }}>
              <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-text-sub)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                {lang === 'ja' ? '日ごとの演習量' : 'Daily Activity'}
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                {([7, 14, 30, 'all'] as const).map(r => (
                  <button key={r} onClick={() => setActivityRange(r)} style={{
                    padding: '3px 10px', fontSize: 'var(--font-size-xs)', fontWeight: 600, cursor: 'pointer',
                    borderRadius: 'var(--border-radius-md)',
                    border: activityRange === r ? '1.5px solid var(--color-primary)' : '1px solid var(--color-border)',
                    background: activityRange === r ? 'var(--color-primary-light)' : 'transparent',
                    color: activityRange === r ? 'var(--color-primary)' : 'var(--color-text-sub)',
                    transition: 'all 0.15s',
                  }}>{r === 'all' ? (lang === 'ja' ? '全' : 'All') : `${r}${lang === 'ja' ? '日' : 'd'}`}</button>
                ))}
              </div>
            </div>

            {loading ? (
              <div style={{ position: 'relative', paddingBottom: '26.7%' }}>
                <div className="skeleton" style={{ position: 'absolute', inset: 0, borderRadius: 'var(--border-radius-md)' }} />
              </div>
            ) : !user ? (
              <p style={{ margin: 0, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-light)' }}>
                {lang === 'ja' ? 'ログインすると表示されます' : 'Log in to view'}
              </p>
            ) : (
              <>
                <ActivityChart data={dailyData} lang={lang} />
                <div style={{ display: 'flex', gap: 'var(--spacing-xl)', marginTop: 'var(--spacing-sm)', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-sub)' }}>
                  <span>{lang === 'ja' ? '期間合計' : 'Total'}: <strong style={{ color: 'var(--color-text-main)' }}>{totalActivity}{lang === 'ja' ? '問' : ' Q'}</strong></span>
                  <span>{lang === 'ja' ? '平均' : 'Avg'}: <strong style={{ color: 'var(--color-text-main)' }}>{avgActivity}{lang === 'ja' ? '問/日' : ' Q/day'}</strong></span>
                </div>
              </>
            )}
          </Card>
        </>
      )}

      {/* ════════ 正答率の推移タブ ════════
          ドメイン別正答率（累計）は苦手分析タブの「累計」に統合した（同じ正答率を2か所で出さない） */}
      {tab === 'trend' && (
        <>
          {user && !loading && allSortedSessions.length === 0 && (
            <Card padding="var(--spacing-xl)">
              <p style={{ margin: 0, textAlign: 'center', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)' }}>
                {lang === 'ja' ? '演習するとセッションごとの正答率がここに並びます' : 'Your accuracy per session will appear here'}
              </p>
            </Card>
          )}
          {user && allSortedSessions.length > 0 && (
            <Card style={{ marginBottom: 'var(--spacing-lg)' }}>
              <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-text-sub)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 'var(--spacing-md)' }}>
                {lang === 'ja' ? 'セッションごとの正答率' : 'Accuracy per Session'}
              </div>
              <ScoreLineChart sessions={allSortedSessions} passRate={STATS_GOOD_RATE} lang={lang} />
              <div style={{ marginTop: 6, display: 'flex', gap: 'var(--spacing-lg)', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-success)', display: 'inline-block' }} />
                  {lang === 'ja' ? '70%以上 / 合格' : '70%+ / Passed'}
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-danger)', display: 'inline-block' }} />
                  {lang === 'ja' ? '70%未満 / 不合格' : 'Below 70% / Failed'}
                </span>
              </div>
            </Card>
          )}

          {!user && (
            <Card padding="var(--spacing-xl)">
              <p style={{ margin: 0, textAlign: 'center', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-light)' }}>
                {lang === 'ja' ? 'ログインすると成績が表示されます' : 'Log in to view your performance'}
              </p>
            </Card>
          )}
        </>
      )}

      {/* ════════ 解答履歴タブ ════════ */}
      {tab === 'history' && (
        <>
          {!user ? (
            <Card padding="var(--spacing-xl)">
              <p style={{ margin: 0, textAlign: 'center', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-light)' }}>
                {lang === 'ja' ? 'ログインすると履歴が表示されます' : 'Log in to view your history'}
              </p>
            </Card>
          ) : loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--spacing-xl) 0' }}>
              <div className="sherpa-spinner" style={{ width: 28, height: 28, borderWidth: 3 }} />
            </div>
          ) : (() => {
            const recentSessions = [...sessions]
              .sort((a, b) => (a.endedAt || a.startedAt) > (b.endedAt || b.startedAt) ? -1 : 1)
              .slice(0, 5);
            if (recentSessions.length === 0) {
              return (
                <Card padding="var(--spacing-xl)">
                  <p style={{ margin: 0, textAlign: 'center', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-light)' }}>
                    {lang === 'ja' ? 'まだセッションがありません' : 'No sessions yet'}
                  </p>
                </Card>
              );
            }
            return (
              <>
                {recentSessions.map(s => {
                  const modeLabel = s.mode === 'exam'
                    ? (s.isMini ? (lang === 'ja' ? 'ミニ模試' : 'Mini Exam') : (lang === 'ja' ? '模試' : 'Mock Exam'))
                    : s.isFocused
                      ? (lang === 'ja' ? 'しっかり対策' : 'Focused')
                      : (lang === 'ja' ? 'サクッと演習' : 'Quick');
                  const modeBg = s.mode === 'exam' ? 'var(--color-danger-light, #fff0f0)' : s.isFocused ? '#e6f4f4' : 'var(--color-primary-light)';
                  const modeColor = s.mode === 'exam' ? 'var(--color-danger)' : s.isFocused ? 'var(--color-points)' : 'var(--color-primary)';
                  const d = new Date(s.endedAt || s.startedAt);
                  const dateLabel = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                  const isExpanded = expandedSession === s.sessionId;
                  const answers = sessionAnswers[s.sessionId];
                  const qCount = s.questionIds?.length ?? 0;
                  const scoreColor = s.mode === 'exam'
                    ? (s.isPassed ? 'var(--color-success)' : 'var(--color-danger)')
                    : (s.score >= 70 ? 'var(--color-success)' : 'var(--color-danger)');

                  const handleToggle = async () => {
                    if (isExpanded) { setExpandedSession(null); return; }
                    setExpandedSession(s.sessionId);
                    if (answers || answersLoading === s.sessionId) return;
                    setAnswersLoading(s.sessionId);
                    try {
                      const res = await fetch(`${API_ENDPOINT}/sessions/${s.sessionId}/answers?userId=${encodeURIComponent(user.userId)}`);
                      const data = await res.json();
                      setSessionAnswers(prev => ({ ...prev, [s.sessionId]: data.answers ?? [] }));
                    } catch { setSessionAnswers(prev => ({ ...prev, [s.sessionId]: [] })); }
                    finally { setAnswersLoading(null); }
                  };

                  return (
                    <Card key={s.sessionId} style={{ marginBottom: 'var(--spacing-md)' }}>
                      <div
                        style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', userSelect: 'none' }}
                        onClick={handleToggle}
                      >
                        <span style={{ fontSize: 'var(--font-size-2xs)', fontWeight: 700, padding: '2px 8px', borderRadius: 'var(--border-radius-sm)', background: modeBg, color: modeColor, flexShrink: 0 }}>
                          {modeLabel}
                        </span>
                        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-sub)', flex: 1, minWidth: 0 }}>
                          {dateLabel}
                          {qCount > 0 && <span style={{ marginLeft: 6, color: 'var(--color-text-light)' }}>{qCount}{lang === 'ja' ? '問' : 'Q'}</span>}
                        </span>
                        <span style={{ fontWeight: 700, fontSize: 'var(--font-size-base)', color: scoreColor, flexShrink: 0 }}>
                          {s.score}%
                        </span>
                        <span style={{ color: 'var(--color-text-light)', fontSize: 'var(--font-size-base)', transition: 'transform 0.2s', transform: isExpanded ? 'rotate(90deg)' : 'none', flexShrink: 0 }}>›</span>
                      </div>

                      {isExpanded && (
                        <div style={{ marginTop: 12, borderTop: '1px solid var(--color-border)', paddingTop: 10 }}>
                          {answersLoading === s.sessionId ? (
                            <div style={{ display: 'flex', justifyContent: 'center', padding: '12px 0' }}>
                              <div className="sherpa-spinner" style={{ width: 20, height: 20, borderWidth: 2 }} />
                            </div>
                          ) : !answers || answers.length === 0 ? (
                            <p style={{ margin: 0, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)', textAlign: 'center' }}>
                              {lang === 'ja' ? '回答データがありません' : 'No answer data available'}
                            </p>
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                              {answers.map((a, idx) => {
                                const qExpanded = expandedQuestion === a.questionId + s.sessionId + idx;
                                const detail = questionDetails[a.questionId];
                                const isBookmarked = bookmarkedIds.has(a.questionId);

                                const handleQuestionToggle = async () => {
                                  const key = a.questionId + s.sessionId + idx;
                                  if (qExpanded) { setExpandedQuestion(null); return; }
                                  setExpandedQuestion(key);
                                  if (detail || questionDetailLoading === a.questionId) return;
                                  setQuestionDetailLoading(a.questionId);
                                  try {
                                    const res = await fetch(`${API_ENDPOINT}/questions/${a.questionId}`);
                                    const d = await res.json();
                                    setQuestionDetails(prev => ({ ...prev, [a.questionId]: d }));
                                  } catch {}
                                  finally { setQuestionDetailLoading(null); }
                                };

                                const handleBookmark = async (e: React.MouseEvent) => {
                                  e.stopPropagation();
                                  if (!user || bookmarkLoadingId === a.questionId) return;
                                  setBookmarkLoadingId(a.questionId);
                                  try {
                                    if (isBookmarked) {
                                      await fetch(`${API_ENDPOINT}/questions/${a.questionId}/bookmark?userId=${user.userId}`, { method: 'DELETE' });
                                      setBookmarkedIds(prev => { const n = new Set(prev); n.delete(a.questionId); return n; });
                                    } else {
                                      await fetch(`${API_ENDPOINT}/questions/${a.questionId}/bookmark`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: user.userId }) });
                                      setBookmarkedIds(prev => { const n = new Set(prev); n.add(a.questionId); return n; });
                                    }
                                  } catch {}
                                  finally { setBookmarkLoadingId(null); }
                                };

                                return (
                                  <div key={a.questionId + s.sessionId + idx} style={{ borderRadius: 8, border: '1px solid var(--color-border)', overflow: 'hidden' }}>
                                    {/* 問題行 */}
                                    <div
                                      onClick={handleQuestionToggle}
                                      style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '8px 10px', cursor: 'pointer', background: qExpanded ? 'var(--color-bg-main)' : 'transparent' }}
                                    >
                                      <span style={{ flexShrink: 0, width: 16, height: 16, borderRadius: '50%', background: a.isCorrect ? 'var(--color-success)' : 'var(--color-danger)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 'var(--font-size-3xs)', fontWeight: 700, marginTop: 1 }}>
                                        {a.isCorrect ? '○' : '×'}
                                      </span>
                                      <span style={{ color: 'var(--color-text-sub)', lineHeight: 1.5, flex: 1, fontSize: 'var(--font-size-xs)' }}>
                                        {a.questionText || a.questionId}
                                      </span>
                                      <span style={{ color: 'var(--color-text-light)', fontSize: 'var(--font-size-xs)', flexShrink: 0, marginTop: 2, transition: 'transform 0.2s', transform: qExpanded ? 'rotate(90deg)' : 'none' }}>›</span>
                                    </div>

                                    {/* 展開：選択肢 + 解説 + ブックマーク */}
                                    {qExpanded && (
                                      <div style={{ padding: '8px 10px 10px', borderTop: '1px solid var(--color-border)', background: 'var(--color-bg-main)' }}>
                                        {questionDetailLoading === a.questionId ? (
                                          <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0' }}>
                                            <div className="sherpa-spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />
                                          </div>
                                        ) : detail ? (
                                          <>
                                            {/* 選択肢 */}
                                            {(detail.choices ?? []).length > 0 && (
                                              <div style={{ marginBottom: 8 }}>
                                                {(detail.choices as string[]).map((c, ci) => {
                                                  const label = String.fromCharCode(65 + ci);
                                                  const isCorrect = (detail.correctAnswerIndices ?? []).includes(ci);
                                                  return (
                                                    <div key={ci} style={{ display: 'flex', gap: 6, marginBottom: 4, alignItems: 'flex-start' }}>
                                                      <span style={{ flexShrink: 0, fontWeight: 700, fontSize: 'var(--font-size-2xs)', color: isCorrect ? 'var(--color-success)' : 'var(--color-text-light)', minWidth: 14, marginTop: 1 }}>{label}.</span>
                                                      <span style={{ fontSize: 'var(--font-size-xs)', color: isCorrect ? 'var(--color-text-main)' : 'var(--color-text-sub)', fontWeight: isCorrect ? 600 : 400, lineHeight: 1.5 }}>{c.replace(/^[A-Z]\.\s*/, '')}</span>
                                                    </div>
                                                  );
                                                })}
                                              </div>
                                            )}
                                            {/* 解説 */}
                                            {detail.explanation && (
                                              <p style={{ margin: '0 0 8px', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-sub)', lineHeight: 1.6, borderTop: '1px solid var(--color-border)', paddingTop: 8, overflowWrap: 'break-word', wordBreak: 'break-word' }}>
                                                {detail.explanation}
                                              </p>
                                            )}
                                          </>
                                        ) : (
                                          <p style={{ margin: 0, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)' }}>
                                            {lang === 'ja' ? '詳細を取得できませんでした' : 'Could not load details'}
                                          </p>
                                        )}
                                        {/* ブックマーク */}
                                        {user && (
                                          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                                            <button
                                              onClick={handleBookmark}
                                              disabled={bookmarkLoadingId === a.questionId}
                                              style={{ display: 'flex', alignItems: 'center', gap: 4, border: 'none', background: 'none', cursor: bookmarkLoadingId === a.questionId ? 'default' : 'pointer', color: isBookmarked ? 'var(--color-primary)' : 'var(--color-text-light)', fontSize: 'var(--font-size-xs)', padding: '2px 4px', opacity: bookmarkLoadingId === a.questionId ? 0.5 : 1 }}
                                            >
                                              <IconStar filled={isBookmarked} size={14} />
                                              {isBookmarked ? (lang === 'ja' ? 'ブックマーク済' : 'Bookmarked') : (lang === 'ja' ? 'ブックマーク' : 'Bookmark')}
                                            </button>
                                          </div>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}
                    </Card>
                  );
                })}
              </>
            );
          })()}
        </>
      )}
    </PageLayout>
  );
}
