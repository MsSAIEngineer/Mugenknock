'use client';
import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation } from '@/compat/react-router-dom';
import { API_ENDPOINT, EXAM_DOMAINS, EXAM_DOMAIN_SERVICES, EXAM_TYPES, EXAM_CONFIGS, DOMAIN_RATE_WARNING, DOMAIN_RATE_CAUTION, PASS_SCORES, EXAM_LEVEL, EXAM_LEVEL_COLORS, tint, tagIdMatches, toDomainIndex, isNonAwsExam } from '../constants';
import { syncPreferencesToServer, syncTargetExamToServer, collectExamDatesFromLocal } from '../utils/preferences';
import { lockBodyScroll } from '../utils/bodyScrollLock';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import PageLayout from '../components/ui/PageLayout';
import {
  IconCalendarNotebook, IconTarget, IconAnnoyed, IconList,
  IconSparkles, IconChevronRight, IconChevronDown, IconLock, IconFlag, IconStar, IconTrendingUp, IconPenLine,
  IconSprout, IconBox, IconBot, IconCode2, IconCloud, IconDatabase, IconBrain, IconVectorSquare, IconFileCodeCorner, IconAtom, IconShieldIcon, IconWaypoints,
  EXAM_ICON_COMPONENTS, IconSave, IconSaveCheck, IconCopy, IconCheck, IconTrophy, IconCircleCheck, IconCircleX, IconExternalLink, IconFileText,
} from '../components/Icons';
import ExamSelectOverlay, { EXAM_DESC, EXAM_URLS, EXAM_GUIDE_PDF_URLS, ConfirmBurst } from '../components/ExamSelectOverlay';
import Confetti from '../components/Confetti';
import KeyHint from '../components/KeyHint';


const FOCUSED_UNLOCK_THRESHOLD = 20;

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

function jstToday(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

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

function daysUntil(dateStr: string): number {
  const examDate = new Date(dateStr + 'T00:00:00+09:00');
  const today = new Date(new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10) + 'T00:00:00+09:00');
  return Math.round((examDate.getTime() - today.getTime()) / 86400000);
}

export default function MyPage() {
  const { user } = useAuth();
  const { lang } = useLanguage();
  const navigate = useNavigate();
  const location = useLocation();
  const ja = lang === 'ja';
  const uid = user?.userId ?? 'guest';
  const isMobile = window.innerWidth < 768;

  // ホームの苦手分析カード等、外部から特定タブを指定して遷移してくるケースに対応
  const [tab, setTab] = useState<'target' | 'analysis' | 'history'>(() => {
    const requested = (location.state as any)?.tab;
    return requested === 'analysis' || requested === 'history' ? requested : 'target';
  });
  const [showSettingsEdit, setShowSettingsEdit] = useState(false);
  const [settingsSaveMsg, setSettingsSaveMsg] = useState<'saved' | 'already' | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsBurst, setSettingsBurst] = useState<{ x: number; y: number } | null>(null);
  const saveBtnSettingsRef = useRef<HTMLButtonElement>(null);
  const SETTINGS_BURST_COLOR = '#e74c3c';
  const [editExamDate, setEditExamDate] = useState('');
  const [editDailyGoal, setEditDailyGoal] = useState(10); // min=10
  const [showExamSelect, setShowExamSelect] = useState(false);
  const [showWeeklyDetail, setShowWeeklyDetail] = useState(false);
  const [circleAnimated, setCircleAnimated] = useState(false);
  const [barAnimated, setBarAnimated] = useState(false);
  const [popupBarAnimated, setPopupBarAnimated] = useState(false);

  // ── ターゲット試験 ──
  const [targetExam, setTargetExam] = useState<string | null>(() => localStorage.getItem(`targetExam_${uid}`));
  useEffect(() => {
    const saved = localStorage.getItem(`targetExam_${uid}`);
    setTargetExam(saved);
    try { setObtainedCerts(JSON.parse(localStorage.getItem(`obtainedCerts_${uid}`) ?? '[]')); } catch { setObtainedCerts([]); }
  }, [uid]);

  // ── 受験日 ──
  const [examDate, setExamDate] = useState<string>(() =>
    targetExam ? (localStorage.getItem(`examDate_${targetExam}_${uid}`) ?? '') : ''
  );
  useEffect(() => {
    if (targetExam) setExamDate(localStorage.getItem(`examDate_${targetExam}_${uid}`) ?? '');
    else setExamDate('');
  }, [targetExam, uid]);

  const handleExamDateChange = (v: string) => {
    setExamDate(v);
    if (!targetExam) return;
    if (v) localStorage.setItem(`examDate_${targetExam}_${uid}`, v);
    else localStorage.removeItem(`examDate_${targetExam}_${uid}`);
    window.dispatchEvent(new CustomEvent('examDateChanged', { detail: { examType: targetExam, date: v } }));
    if (user) {
      const examDates = collectExamDatesFromLocal(uid, EXAM_TYPES);
      syncPreferencesToServer(user.userId, uid, { examDates });
    }
  };

  const remainingDays = examDate ? daysUntil(examDate) : null;

  // ── 日次目標 ──
  const [dailyGoal, setDailyGoal] = useState<number>(() =>
    Math.max(10, parseInt(localStorage.getItem(`dailyGoal_${uid}`) ?? '10', 10))
  );
  const handleDailyGoalChange = (v: number) => {
    setDailyGoal(v);
    localStorage.setItem(`dailyGoal_${uid}`, String(v));
    if (user) syncPreferencesToServer(user.userId, uid, { dailyGoal: v });
  };
  // 目標設定オーバレイの変更有無（保存アニメ・自動クローズの判定に使う）
  const settingsDirty = editExamDate !== examDate || editDailyGoal !== dailyGoal;

  // ── サーバーから設定を読み込み（ログイン時のデバイス間同期） ──
  useEffect(() => {
    if (!user) return;
    fetch(`${API_ENDPOINT}/users/me/preferences?userId=${encodeURIComponent(user.userId)}`)
      .then(r => r.json())
      .then(data => {
        // 受験日
        const examDates: Record<string, string> = data.examDates ?? {};
        for (const [et, date] of Object.entries(examDates)) {
          if (!date) continue;
          const key = `examDate_${et}_${uid}`;
          if (localStorage.getItem(key) !== date) {
            localStorage.setItem(key, date);
            window.dispatchEvent(new CustomEvent('examDateChanged', { detail: { examType: et, date } }));
          }
        }
        if (targetExam && examDates[targetExam]) {
          setExamDate(examDates[targetExam]);
        }
        // 目標演習量
        if (data.dailyGoal != null) {
          const serverGoal = Number(data.dailyGoal);
          localStorage.setItem(`dailyGoal_${uid}`, String(serverGoal));
          setDailyGoal(serverGoal);
        }
        // 取得済資格（サーバー優先・ローカルとマージして和集合）
        if (Array.isArray(data.obtainedCerts) && data.obtainedCerts.length > 0) {
          setObtainedCerts(prev => {
            const merged = [...new Set([...prev, ...data.obtainedCerts])];
            localStorage.setItem(`obtainedCerts_${uid}`, JSON.stringify(merged));
            return merged;
          });
        }
      })
      .catch(() => {});
  }, [user?.userId]); // eslint-disable-line react-hooks/exhaustive-deps



  // ── 週間達成度 ──
  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.now() + 9 * 3600 * 1000 - (6 - i) * 86400000);
    return d.toISOString().slice(0, 10);
  });
  const examColor = targetExam ? (EXAM_LEVEL_COLORS[EXAM_LEVEL[targetExam]] ?? 'var(--color-primary)') : 'var(--color-primary)';

  // 週間達成状況はサーバの sessions から日別集計し、端末を変えても連携されるようにする。
  // （ログイン時のみ。未ログイン/取得失敗時は localStorage の dailyQCount にフォールバック）
  const [serverDayCounts, setServerDayCounts] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    if (!user || !targetExam) { setServerDayCounts(null); return; }
    fetch(`${API_ENDPOINT}/users/me/sessions?userId=${user.userId}&limit=200`)
      .then(r => r.json())
      .then(d => {
        const map: Record<string, number> = {};
        for (const s of (d.items ?? [])) {
          if (s.examType !== targetExam) continue;
          const ts = s.endedAt || s.startedAt;
          if (!ts) continue;
          const jst = new Date(new Date(ts).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
          const cnt = typeof s.answeredCount === 'number' ? s.answeredCount : (Array.isArray(s.questionIds) ? s.questionIds.length : 0);
          map[jst] = (map[jst] ?? 0) + cnt;
        }
        setServerDayCounts(map);
      })
      .catch(() => setServerDayCounts(null));
  }, [user, targetExam]);

  useEffect(() => {
    setCircleAnimated(false);
    setBarAnimated(false);
    const id = requestAnimationFrame(() => requestAnimationFrame(() => {
      setCircleAnimated(true);
      setBarAnimated(true);
    }));
    return () => cancelAnimationFrame(id);
  }, [serverDayCounts, targetExam]);

  useEffect(() => {
    if (!showWeeklyDetail) return;
    setPopupBarAnimated(false);
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setPopupBarAnimated(true)));
    return () => cancelAnimationFrame(id);
  }, [showWeeklyDetail]);

  // 目標資格のみの日別演習量（マイページは全て目標資格基準で表示）
  const weekCountsTarget = weekDays.map(d =>
    serverDayCounts
      ? (serverDayCounts[d] ?? 0)
      : (targetExam ? parseInt(localStorage.getItem(`dailyQCount_${targetExam}_${uid}_${d}`) ?? '0', 10) : 0)
  );
  const todayCount = weekCountsTarget[6];

  // ── ドメイン統計（苦手分析タブ） ──
  const [domainStats, setDomainStats] = useState<DomainStat[]>([]);
  const [answeredCount, setAnsweredCount] = useState(0);
  const [statsLoading, setStatsLoading] = useState(false);
  // 苦手ドメインの正答率フィルタ（直近N問。演習開始当初のデータを除外して現在の実力を測る）
  const [recentWindow, setRecentWindow] = useState<10 | 20 | 30>(10);

  useEffect(() => {
    if (tab !== 'analysis' || !user || !targetExam) return;
    setStatsLoading(true);
    Promise.all([
      fetch(`${API_ENDPOINT}/users/me/stats?userId=${user.userId}`).then(r => r.json()),
      fetch(`${API_ENDPOINT}/users/me/question-stats?userId=${user.userId}&examType=${targetExam}`).then(r => r.json()),
    ]).then(([statsData, qData]) => {
      setDomainStats(statsData.stats ?? []);
      setAnsweredCount(qData.answeredCount ?? 0);
    }).catch(() => {}).finally(() => setStatsLoading(false));
  }, [tab, user, targetExam]);

  const focusedUnlocked = !!user && answeredCount >= FOCUSED_UNLOCK_THRESHOLD;

  // ── 頻出ミス問題（苦手分析タブ） ──
  const [weakQuestions, setWeakQuestions] = useState<WeakQuestion[]>([]);
  const [weakLoading, setWeakLoading] = useState(false);
  const [weakLoaded, setWeakLoaded] = useState(false);

  useEffect(() => {
    if (tab !== 'analysis' || !user || !targetExam || !focusedUnlocked || weakLoaded) return;
    setWeakLoading(true);
    fetch(`${API_ENDPOINT}/users/me/weak-questions?userId=${user.userId}&examType=${targetExam}&minIncorrect=2`)
      .then(r => r.json())
      .then(d => { setWeakQuestions(d.items ?? []); setWeakLoaded(true); })
      .catch(() => {})
      .finally(() => setWeakLoading(false));
  }, [tab, user, targetExam, focusedUnlocked, weakLoaded]);

  // ── 弱問展開（苦手分析タブ） ──
  const [expandedWeakQ, setExpandedWeakQ] = useState<string | null>(null);
  const [weakQDetails, setWeakQDetails] = useState<Record<string, any>>({});
  const [weakQDetailLoading, setWeakQDetailLoading] = useState<string | null>(null);

  const handleToggleWeakQ = useCallback(async (qid: string) => {
    if (expandedWeakQ === qid) { setExpandedWeakQ(null); return; }
    setExpandedWeakQ(qid);
    if (weakQDetails[qid] || weakQDetailLoading === qid) return;
    setWeakQDetailLoading(qid);
    try {
      const res = await fetch(`${API_ENDPOINT}/questions/${qid}`);
      const data = await res.json();
      setWeakQDetails(prev => ({ ...prev, [qid]: data }));
    } catch { setWeakQDetails(prev => ({ ...prev, [qid]: null })); }
    finally { setWeakQDetailLoading(null); }
  }, [expandedWeakQ, weakQDetails, weakQDetailLoading]);

  // ── 演習履歴（履歴タブ） ──
  const [sessions, setSessions] = useState<Session[]>([]);
  const [histLoading, setHistLoading] = useState(false);
  const [histLoadedExam, setHistLoadedExam] = useState<string | null>(null);
  const [totalExercised, setTotalExercised] = useState<number | null>(null);
  const [totalSessionCount, setTotalSessionCount] = useState<number | null>(null);

  // ── 取得済資格（履歴タブ） ──
  const [obtainedCerts, setObtainedCerts] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(`obtainedCerts_${uid}`) ?? '[]'); } catch { return []; }
  });
  const [showCertOverlay, setShowCertOverlay] = useState(false);
  const [certOverlayLevel, setCertOverlayLevel] = useState<string>('Foundational');
  const [certBurst, setCertBurst] = useState<{ x: number; y: number; color: string } | null>(null);
  const [certConfetti, setCertConfetti] = useState(false);
  const [justObtained, setJustObtained] = useState<string | null>(null);
  const toggleObtainedCert = (exam: string, btnEl: HTMLButtonElement) => {
    setObtainedCerts(prev => {
      const isObtained = prev.includes(exam);
      const next = isObtained ? prev.filter(e => e !== exam) : [...prev, exam];
      localStorage.setItem(`obtainedCerts_${uid}`, JSON.stringify(next));
      if (user) syncPreferencesToServer(user.userId, uid, { obtainedCerts: next });
      if (!isObtained) {
        const r = btnEl.getBoundingClientRect();
        const color = EXAM_LEVEL_COLORS[EXAM_LEVEL[exam]] ?? 'var(--color-primary)';
        setCertBurst({ x: r.left + r.width / 2, y: r.top + r.height / 2, color });
        setCertConfetti(true);
        setJustObtained(exam);
        setTimeout(() => setJustObtained(null), 400);
      }
      return next;
    });
  };

  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [sessionAnswers, setSessionAnswers] = useState<Record<string, AnswerRecord[]>>({});
  const [answersLoading, setAnswersLoading] = useState<string | null>(null);
  const [expandedAnswer, setExpandedAnswer] = useState<string | null>(null);
  const [answerDetails, setAnswerDetails] = useState<Record<string, any>>({});
  const [answerDetailLoading, setAnswerDetailLoading] = useState<string | null>(null);

  const handleToggleAnswer = useCallback(async (qid: string) => {
    if (expandedAnswer === qid) { setExpandedAnswer(null); return; }
    setExpandedAnswer(qid);
    if (answerDetails[qid] || answerDetailLoading === qid) return;
    setAnswerDetailLoading(qid);
    try {
      const res = await fetch(`${API_ENDPOINT}/questions/${qid}`);
      const data = await res.json();
      setAnswerDetails(prev => ({ ...prev, [qid]: data }));
    } catch { setAnswerDetails(prev => ({ ...prev, [qid]: null })); }
    finally { setAnswerDetailLoading(null); }
  }, [expandedAnswer, answerDetails, answerDetailLoading]);

  // ── 問題詳細モーダル ──
  const [questionModal, setQuestionModal] = useState<{ qid: string; detail: any | null; loading: boolean; isCorrect?: boolean } | null>(null);

  // ── オーバーレイ表示中は body スクロール・横スワイプ無効 ──
  useEffect(() => {
    const anyOpen = showSettingsEdit || showExamSelect || showWeeklyDetail || showCertOverlay || !!questionModal;
    if (!anyOpen) return;
    return lockBodyScroll();
  }, [showSettingsEdit, showExamSelect, showWeeklyDetail, showCertOverlay, questionModal]);

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

  const openAnswerModal = useCallback(async (qid: string, isCorrect: boolean) => {
    const cached = answerDetails[qid];
    setQuestionModal({ qid, detail: cached ?? null, loading: !cached, isCorrect });
    if (!cached && answerDetailLoading !== qid) {
      setAnswerDetailLoading(qid);
      try {
        const res = await fetch(`${API_ENDPOINT}/questions/${qid}`);
        const data = await res.json();
        setAnswerDetails(prev => ({ ...prev, [qid]: data }));
        setQuestionModal(prev => prev?.qid === qid ? { ...prev, detail: data, loading: false } : prev);
      } catch {
        setAnswerDetails(prev => ({ ...prev, [qid]: null }));
        setQuestionModal(prev => prev?.qid === qid ? { ...prev, loading: false } : prev);
      } finally { setAnswerDetailLoading(null); }
    }
  }, [answerDetails, answerDetailLoading]);

  // ── ブックマーク ──
  const [bookmarkedIds, setBookmarkedIds] = useState<Set<string>>(new Set());
  const [bookmarkOpLoading, setBookmarkOpLoading] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!user) return;
    fetch(`${API_ENDPOINT}/users/me/bookmarks?userId=${user.userId}`)
      .then(r => r.json())
      .then(d => setBookmarkedIds(new Set(d.questionIds ?? [])))
      .catch(() => {});
  }, [user]);

  const toggleBookmark = useCallback(async (qid: string) => {
    if (!user || bookmarkOpLoading.has(qid)) return;
    const isBookmarked = bookmarkedIds.has(qid);
    setBookmarkOpLoading(prev => { const n = new Set(prev); n.add(qid); return n; });
    try {
      if (isBookmarked) {
        await fetch(`${API_ENDPOINT}/questions/${qid}/bookmark?userId=${user.userId}`, { method: 'DELETE' });
        setBookmarkedIds(prev => { const n = new Set(prev); n.delete(qid); return n; });
      } else {
        await fetch(`${API_ENDPOINT}/questions/${qid}/bookmark`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: user.userId }),
        });
        setBookmarkedIds(prev => { const n = new Set(prev); n.add(qid); return n; });
      }
    } catch {}
    finally { setBookmarkOpLoading(prev => { const n = new Set(prev); n.delete(qid); return n; }); }
  }, [user, bookmarkedIds, bookmarkOpLoading]);

  useEffect(() => {
    if (tab !== 'history' || !user || !targetExam || histLoadedExam === targetExam) return;
    setHistLoading(true);
    Promise.all([
      fetch(`${API_ENDPOINT}/users/me/sessions?userId=${user.userId}&examType=${targetExam}&limit=10`).then(r => r.json()),
      fetch(`${API_ENDPOINT}/users/me/daily-progress?userId=${encodeURIComponent(user.userId)}&examType=${encodeURIComponent(targetExam)}`).then(r => r.json()),
    ])
      .then(([sessData, progData]) => {
        setSessions(sessData.items ?? []);
        setTotalSessionCount(sessData.totalCount ?? null);
        setTotalExercised(progData.total ?? 0);
        setHistLoadedExam(targetExam);
      })
      .catch(() => {})
      .finally(() => setHistLoading(false));
  }, [tab, user, targetExam, histLoadedExam]);

  const recentSessions = [...sessions]
    .sort((a, b) => (a.endedAt || a.startedAt) > (b.endedAt || b.startedAt) ? -1 : 1)
    .slice(0, 10);

  const handleToggleSession = useCallback(async (s: Session) => {
    if (!user) return;
    if (expandedSession === s.sessionId) { setExpandedSession(null); return; }
    setExpandedSession(s.sessionId);
    if (sessionAnswers[s.sessionId] || answersLoading === s.sessionId) return;
    setAnswersLoading(s.sessionId);
    try {
      const res = await fetch(`${API_ENDPOINT}/sessions/${s.sessionId}/answers?userId=${encodeURIComponent(user.userId)}`);
      const data = await res.json();
      setSessionAnswers(prev => ({ ...prev, [s.sessionId]: data.answers ?? [] }));
    } catch { setSessionAnswers(prev => ({ ...prev, [s.sessionId]: [] })); }
    finally { setAnswersLoading(null); }
  }, [user, expandedSession, sessionAnswers, answersLoading]);

  // ── Ctrl/Cmd+Enter で「しっかり対策」を開始（苦手分析タブ・Web版のみ、ホームと同挙動） ──
  useEffect(() => {
    if (isMobile) return;
    const h = (e: KeyboardEvent) => {
      if (!(e.key === 'Enter' && (e.ctrlKey || e.metaKey))) return;
      if (tab !== 'analysis' || !focusedUnlocked) return;
      const el = e.target as HTMLElement | null;
      const t = el?.tagName;
      if (t === 'INPUT' || t === 'TEXTAREA' || el?.isContentEditable) return;
      if (showSettingsEdit || showExamSelect || showWeeklyDetail || questionModal) return;
      e.preventDefault();
      navigate('/aws/', { state: { startFocused: true } });
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [isMobile, tab, focusedUnlocked, showSettingsEdit, showExamSelect, showWeeklyDetail, questionModal, navigate]);

  // ── UI helpers ──
  const tabStyle = (active: boolean): React.CSSProperties => ({
    flex: 1, padding: '10px 0', border: 'none', background: 'none', cursor: 'pointer',
    fontSize: 'var(--font-size-base)', fontWeight: active ? 700 : 500,
    color: active ? 'var(--color-primary)' : 'var(--color-text-sub)',
    borderBottom: `2px solid ${active ? 'var(--color-primary)' : 'transparent'}`,
    transition: 'color 0.15s, border-color 0.15s',
  });

  const domains = EXAM_DOMAINS[targetExam ?? ''] ?? [];

  return (
    <>
      <PageLayout className="page-container">

        {/* ── タブ ── */}
        <div style={{ display: 'flex', borderBottom: '1px solid color-mix(in srgb, var(--color-text-light) 40%, transparent)', marginBottom: 'var(--spacing-lg)' }}>
          <button data-kbnav="tab" style={tabStyle(tab === 'target')} onClick={() => setTab('target')}>{ja ? '目標' : 'Goals'}</button>
          <button data-kbnav="tab" style={tabStyle(tab === 'analysis')} onClick={() => setTab('analysis')}>{ja ? '苦手分析' : 'Analysis'}</button>
          <button data-kbnav="tab" style={tabStyle(tab === 'history')} onClick={() => setTab('history')}>{ja ? '履歴' : 'History'}</button>
        </div>

        {/* ════════ 目標タブ ════════ */}
        {tab === 'target' && (
          <>
            {/* 六角形バッジ共通ヘルパー */}
            {(() => {
              const HexBadge = ({ panelColor, ExamIcon }: { panelColor: string; ExamIcon?: React.FC<{ size?: number }> }) => (
                <div style={{ width: 46, height: 53, flexShrink: 0, background: panelColor, clipPath: 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <div style={{ width: 41, height: 48, background: 'var(--color-bg-white)', clipPath: 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: panelColor }}>
                    {ExamIcon && <ExamIcon size={22} />}
                  </div>
                </div>
              );

              const ExamCardContent = () => {
                if (!targetExam) return <span style={{ fontSize: 'var(--font-size-base)', color: 'var(--color-text-light)' }}>{ja ? '目標資格を設定する' : 'Set target exam'}</span>;
                const full = (EXAM_CONFIGS[targetExam]?.fullName ?? '').replace('AWS Certified ', '');
                const dashIdx = full.indexOf(' – ');
                const main = dashIdx >= 0 ? full.slice(0, dashIdx) : full;
                const level = dashIdx >= 0 ? '– ' + full.slice(dashIdx + 3) : null;
                const panelColor = EXAM_LEVEL_COLORS[EXAM_LEVEL[targetExam]] ?? 'var(--color-primary)';
                const ExamIcon = EXAM_ICON_COMPONENTS[targetExam];
                const mainNode = main;
                return (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                    <HexBadge panelColor={panelColor} ExamIcon={ExamIcon} />
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 'var(--font-size-h3)', color: panelColor, lineHeight: 1.3 }}>{mainNode}</div>
                      {level && <div style={{ fontWeight: 700, fontSize: 'var(--font-size-h3)', color: panelColor, lineHeight: 1.3 }}>{level}</div>}
                    </div>
                  </div>
                );
              };

              const ExamCardHeader = () => (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ color: 'var(--color-text-sub)', display: 'flex', alignItems: 'center' }}><IconFlag size={13} /></span>
                    <span style={{ fontWeight: 700, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-main)' }}>{ja ? '目標資格' : 'Target Exam'}</span>
                  </div>
                  <div style={{ width: 35, height: 35, borderRadius: '50%', border: '1px solid var(--color-primary)', background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-primary)', flexShrink: 0 }}>
                    <IconPenLine size={14} />
                  </div>
                </div>
              );

              return (
                <>
                  {/* ── 目標タブ本体 ── */}
                  {!isMobile ? (
                    /* デスクトップ: 概要(左300px)｜詳細(右) の2カード。横を揃え/右は塗りなし/目標資格と学習目標は別カードで分離 */
                    <>
                      {/* カード1: 目標資格(概要) ｜ 資格情報(詳細) */}
                      <div style={{ display: 'flex', minHeight: 195, marginBottom: 12, border: '1px solid color-mix(in srgb, var(--color-text-light) 40%, transparent)', borderRadius: 'var(--border-radius-md)', overflow: 'hidden', background: 'transparent' }}>
                        <div data-kbnav="1" style={{ width: 300, flexShrink: 0, padding: 'var(--spacing-lg)', cursor: 'pointer', background: 'var(--color-bg-white)' }} onClick={() => setShowExamSelect(true)}>
                          <ExamCardHeader />
                          <ExamCardContent />
                        </div>
                        <div style={{ width: 1, background: 'color-mix(in srgb, var(--color-text-light) 40%, transparent)', flexShrink: 0 }} />
                        <div style={{ flex: 1, minWidth: 0, padding: 'var(--spacing-lg)' }}>
                          {targetExam ? (() => {
                            const cfg = EXAM_CONFIGS[targetExam];
                            const panelColor = EXAM_LEVEL_COLORS[EXAM_LEVEL[targetExam]] ?? 'var(--color-primary)';
                            return (
                              <>
                                {/* 試験コード・問題数・時間・合格スコアは本番形式の情報。オリジナル(非AWS)カードでは表示しない */}
                                {!isNonAwsExam(targetExam) && (
                                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 20px', marginBottom: 10 }}>
                                    {[
                                      { label: ja ? '試験コード' : 'Code',       value: cfg?.examCode ?? '' },
                                      { label: ja ? '問題数'     : 'Questions',   value: `${cfg?.totalQuestions ?? '—'}${ja ? '問' : 'Q'}` },
                                      { label: ja ? '試験時間'   : 'Duration',    value: `${cfg?.timeLimitMin ?? '—'}${ja ? '分' : 'min'}` },
                                      { label: ja ? '合格スコア' : 'Pass Score',  value: `${PASS_SCORES[targetExam] ?? '—'}/1000` },
                                    ].map(({ label, value }) => (
                                      <div key={label}>
                                        <div style={{ fontSize: 'var(--font-size-3xs)', color: 'var(--color-text-light)', marginBottom: 1 }}>{label}</div>
                                        <div style={{ fontSize: 'var(--font-size-sm2)', fontWeight: 700, color: panelColor }}>{value}</div>
                                      </div>
                                    ))}
                                  </div>
                                )}
                                <p style={{ margin: 0, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', lineHeight: 1.6 }}>{EXAM_DESC[targetExam] ?? ''}</p>
                                <div style={{ display: 'flex', gap: 16, marginTop: 'var(--spacing-sm)' }}>
                                  {EXAM_URLS[targetExam] && (
                                    <a href={EXAM_URLS[targetExam]} target="_blank" rel="noopener noreferrer"
                                      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--font-size-sm)', color: 'var(--color-primary)', fontWeight: 600, textDecoration: 'none' }}>
                                      {ja ? '認定ページ' : 'Certification page'}<IconExternalLink size={13} />
                                    </a>
                                  )}
                                  {EXAM_GUIDE_PDF_URLS[targetExam] && (
                                    <a href={EXAM_GUIDE_PDF_URLS[targetExam]} target="_blank" rel="noopener noreferrer"
                                      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--font-size-sm)', color: 'var(--color-primary)', fontWeight: 600, textDecoration: 'none' }}>
                                      <IconFileText size={13} />{ja ? '試験ガイド(PDF)' : 'Exam Guide (PDF)'}
                                    </a>
                                  )}
                                </div>
                              </>
                            );
                          })() : (
                            <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-light)' }}>{ja ? '資格を選択すると詳細が表示されます' : 'Select an exam to see details'}</span>
                          )}
                        </div>
                      </div>

                      {/* カード2: 学習目標(概要) ｜ 週間達成状況(詳細・直接表示・塗りなし) */}
                      <div style={{ display: 'flex', minHeight: 195, marginBottom: 12, border: '1px solid color-mix(in srgb, var(--color-text-light) 40%, transparent)', borderRadius: 'var(--border-radius-md)', overflow: 'hidden', background: 'transparent' }}>
                        <div data-kbnav="1" style={{ width: 300, flexShrink: 0, padding: 'var(--spacing-lg)', cursor: 'pointer', background: 'var(--color-bg-white)' }} onClick={() => { setEditExamDate(examDate); setEditDailyGoal(dailyGoal); setShowSettingsEdit(true); }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <span style={{ color: 'var(--color-text-sub)', display: 'flex', alignItems: 'center' }}><IconCalendarNotebook size={13} /></span>
                              <span style={{ fontWeight: 700, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-main)' }}>{ja ? '学習目標' : 'Study Goals'}</span>
                            </div>
                            <div style={{ width: 35, height: 35, borderRadius: '50%', border: '1px solid var(--color-primary)', background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-primary)', flexShrink: 0 }}>
                              <IconPenLine size={14} />
                            </div>
                          </div>
                          {!targetExam ? (
                            <p style={{ margin: 0, fontSize: 'var(--font-size-sm2)', color: 'var(--color-text-light)' }}>{ja ? '目標資格を設定してください' : 'Set a target exam first'}</p>
                          ) : (
                            <>
                              <div style={{ marginBottom: 6 }}>
                                {examDate ? (
                                  <span>
                                    <span style={{ fontWeight: 700, fontSize: 'var(--font-size-lg)', color: 'var(--color-primary)' }}>{examDate.split('-').slice(1).map(Number).join('/')}</span>
                                    <span style={{ fontSize: 'var(--font-size-sm2)', color: 'var(--color-text-main)', marginLeft: 4 }}>{ja ? '受験予定' : 'exam date'}</span>
                                  </span>
                                ) : (
                                  <span style={{ fontSize: 'var(--font-size-sm2)', color: 'var(--color-text-light)' }}>{ja ? '受験日未設定' : 'No exam date set'}</span>
                                )}
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                <span>
                                  <span style={{ fontWeight: 700, fontSize: 'var(--font-size-lg)', color: 'var(--color-primary)' }}>{dailyGoal}</span>
                                  <span style={{ fontSize: 'var(--font-size-sm2)', color: 'var(--color-text-sub)' }}>{ja ? '問 / 日' : 'Q / day'}</span>
                                </span>
                                {ja && <span style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-light)' }}>※達成で<span style={{ color: 'var(--color-points)', fontWeight: 700 }}>+10p</span>！</span>}
                                {todayCount >= dailyGoal && <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-success)' }}>✓</span>}
                              </div>
                            </>
                          )}
                        </div>
                        <div style={{ width: 1, background: 'color-mix(in srgb, var(--color-text-light) 40%, transparent)', flexShrink: 0 }} />
                        <div style={{ flex: 1, minWidth: 0, padding: 'var(--spacing-lg)' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                            <span style={{ color: 'var(--color-text-sub)', display: 'flex', alignItems: 'center' }}><IconTrendingUp size={13} /></span>
                            <span style={{ fontWeight: 700, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-main)' }}>{ja ? '週間達成状況' : 'Weekly Progress'}</span>
                          </div>
                          {targetExam ? (() => {
                            const goal = dailyGoal;
                            const maxVal = Math.max(...weekCountsTarget, goal, 1);
                            const CH = 80;
                            const weekTotal = weekCountsTarget.reduce((a, b) => a + b, 0);
                            const achievedDays = weekCountsTarget.filter(c => goal > 0 && c >= goal).length;
                            return (
                              <>
                                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-sub)', marginBottom: 8 }}>
                                  {ja ? `${weekTotal}問` : `${weekTotal}Q`}
                                  <span style={{ margin: '0 6px', color: 'var(--color-border)' }}>·</span>
                                  {ja ? `達成 ${achievedDays}/7日` : `${achievedDays}/7 days`}
                                </div>
                                <div style={{ position: 'relative', height: CH + 18, marginTop: 4 }}>
                                  {goal > 0 && (
                                    <div style={{ position: 'absolute', left: 0, right: 0, bottom: (Math.min(goal, maxVal) / maxVal) * CH, borderTop: '1px dashed var(--color-primary)', pointerEvents: 'none' }} />
                                  )}
                                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', height: CH }}>
                                    {weekDays.map((d, i) => {
                                      const count = weekCountsTarget[i];
                                      const achieved = goal > 0 && count >= goal;
                                      const h = (count / maxVal) * CH;
                                      const barH = Math.max(h, count > 0 ? 3 : 0);
                                      const staggerIdx = weekCountsTarget.slice(0, i).filter(c => c > 0).length;
                                      return (
                                        <div key={d} style={{ flex: 1, position: 'relative', height: '100%', display: 'flex', alignItems: 'flex-end' }}>
                                          <div style={{ width: '100%', maxWidth: 6, margin: '0 auto', height: barAnimated ? barH : 0, background: achieved ? examColor : tint(examColor, 33), borderRadius: '3px 3px 0 0', transition: count > 0 ? `height 0.45s cubic-bezier(0.4,0,0.2,1) ${staggerIdx * 0.07}s` : 'none' }} />
                                          <span style={{ position: 'absolute', bottom: barH + 2, left: '50%', transform: 'translateX(-50%)', fontSize: 'var(--font-size-xs)', fontWeight: 700, color: count > 0 ? (achieved ? examColor : 'var(--color-text-sub)') : 'var(--color-text-light)', opacity: barAnimated ? 1 : 0, transition: count > 0 ? `opacity 0.2s ease ${0.3 + staggerIdx * 0.07}s` : 'none' }}>{count}</span>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                                  {weekDays.map((d) => {
                                    const isToday = d === jstToday();
                                    const dayLabel = new Date(d + 'T12:00:00').toLocaleDateString(ja ? 'ja-JP' : 'en-US', { weekday: 'short' });
                                    return (<div key={d} style={{ flex: 1, textAlign: 'center', fontSize: 'var(--font-size-2xs)', color: isToday ? examColor : 'var(--color-text-light)', fontWeight: isToday ? 700 : 400 }}>{dayLabel}</div>);
                                  })}
                                </div>
                              </>
                            );
                          })() : (
                            <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-light)' }}>{ja ? '目標資格を設定すると表示されます' : 'Set a target exam to view'}</span>
                          )}
                        </div>
                      </div>
                    </>
                  ) : (
                    /* モバイル: 単一カード */
                    <Card style={{ marginBottom: 12, cursor: 'pointer' }} onClick={() => setShowExamSelect(true)}>
                      <ExamCardHeader />
                      <ExamCardContent />
                    </Card>
                  )}
                </>
              );
            })()}

            {/* ── 学習目標・週間達成（デスクトップは上のB案カードに統合） ── */}
            {isMobile && (
              <>
                <Card style={{ marginBottom: 12, cursor: 'pointer' }} onClick={() => { setEditExamDate(examDate); setEditDailyGoal(dailyGoal); setShowSettingsEdit(true); }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ color: 'var(--color-text-sub)', display: 'flex', alignItems: 'center' }}><IconCalendarNotebook size={13} /></span>
                      <span style={{ fontWeight: 700, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-main)' }}>{ja ? '学習目標' : 'Study Goals'}</span>
                    </div>
                    <div style={{ width: 35, height: 35, borderRadius: '50%', border: '1px solid var(--color-primary)', background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-primary)', flexShrink: 0 }}>
                      <IconPenLine size={14} />
                    </div>
                  </div>
                  {!targetExam ? (
                    <p style={{ margin: 0, fontSize: 'var(--font-size-sm2)', color: 'var(--color-text-light)' }}>{ja ? '目標資格を設定してください' : 'Set a target exam first'}</p>
                  ) : (
                    <>
                      <div style={{ marginBottom: 6 }}>
                        {examDate ? (
                          <span>
                            <span style={{ fontWeight: 700, fontSize: 'var(--font-size-lg)', color: 'var(--color-primary)' }}>{examDate.split('-').slice(1).map(Number).join('/')}</span>
                            <span style={{ fontSize: 'var(--font-size-sm2)', color: 'var(--color-text-main)', marginLeft: 4 }}>{ja ? '受験予定' : 'exam date'}</span>
                          </span>
                        ) : (
                          <span style={{ fontSize: 'var(--font-size-sm2)', color: 'var(--color-text-light)' }}>{ja ? '受験日未設定' : 'No exam date set'}</span>
                        )}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span>
                          <span style={{ fontWeight: 700, fontSize: 'var(--font-size-lg)', color: 'var(--color-primary)' }}>{dailyGoal}</span>
                          <span style={{ fontSize: 'var(--font-size-sm2)', color: 'var(--color-text-sub)' }}>{ja ? '問 / 日' : 'Q / day'}</span>
                        </span>
                        {ja && <span style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-light)' }}>※達成で<span style={{ color: 'var(--color-points)', fontWeight: 700 }}>+10p</span>！</span>}
                        {todayCount >= dailyGoal && <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-success)' }}>✓</span>}
                      </div>
                    </>
                  )}
                </Card>
                {/* 週間達成状況（モバイルのみ単独カード） */}
                {targetExam && (
                  <Card style={{ marginBottom: 12, cursor: 'pointer' }} onClick={() => setShowWeeklyDetail(true)}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ color: 'var(--color-text-sub)', display: 'flex', alignItems: 'center' }}><IconTrendingUp size={13} /></span>
                        <span style={{ fontWeight: 700, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-main)' }}>{ja ? '週間達成状況' : 'Weekly Progress'}</span>
                      </div>
                      <span style={{ color: 'var(--color-text-light)', display: 'flex', alignItems: 'center', flexShrink: 0 }}><IconChevronRight size={16} /></span>
                    </div>
                    <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', marginBottom: 8 }}>{ja ? '直近7日間' : 'Last 7 days'}</div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      {weekDays.map((d, i) => {
                        const count = weekCountsTarget[i];
                        const rewarded = localStorage.getItem(`dailyGoalReward_${targetExam}_${uid}_${d}`) === '1';
                        const achieved = rewarded || count >= dailyGoal;
                        const pct = dailyGoal > 0 ? Math.min(1, count / dailyGoal) : 0;
                        const isToday = d === jstToday();
                        const dayLabel = new Date(d + 'T12:00:00').toLocaleDateString(ja ? 'ja-JP' : 'en-US', { weekday: 'short' });
                        const R = 14, C = 2 * Math.PI * R; // 1周=100%達成の中空リング
                        return (
                          <div key={d} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                            <div style={{ position: 'relative', width: 36, height: 36 }}>
                              <svg width={36} height={36} viewBox="0 0 36 36">
                                <circle cx={18} cy={18} r={R} fill="none" style={{ stroke: tint(examColor, 13) }} strokeWidth={4} />
                                <circle
                                  cx={18} cy={18} r={R} fill="none"
                                  strokeWidth={4} strokeLinecap="round"
                                  strokeDasharray={C}
                                  strokeDashoffset={circleAnimated ? C * (1 - pct) : C}
                                  transform="rotate(-90 18 18)"
                                  style={{ stroke: achieved ? examColor : tint(examColor, 60), transition: count > 0 ? `stroke-dashoffset 0.55s cubic-bezier(0.4,0,0.2,1) ${i * 0.1}s` : 'none' }}
                                />
                              </svg>
                              {achieved && (
                                <div style={{
                                  position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  fontSize: 'var(--font-size-base)', fontWeight: 800, color: examColor,
                                  opacity: circleAnimated ? 1 : 0,
                                  transform: circleAnimated ? 'scale(1)' : 'scale(0.4)',
                                  transition: `opacity 0.2s ease ${0.5 + i * 0.1}s, transform 0.25s ease ${0.5 + i * 0.1}s`,
                                }}>✓</div>
                              )}
                            </div>
                            <span style={{ fontSize: 'var(--font-size-3xs)', color: isToday ? examColor : 'var(--color-text-light)', fontWeight: isToday ? 700 : 400 }}>{dayLabel}</span>
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ marginTop: 8, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)', textAlign: 'right' }}>
                      {ja
                        ? `今週の達成日数：${weekDays.filter((d, i) => localStorage.getItem(`dailyGoalReward_${targetExam}_${uid}_${d}`) === '1' || weekCountsTarget[i] >= dailyGoal).length}/7日`
                        : `Achieved: ${weekDays.filter((d, i) => localStorage.getItem(`dailyGoalReward_${targetExam}_${uid}_${d}`) === '1' || weekCountsTarget[i] >= dailyGoal).length}/7 days`}
                    </div>
                  </Card>
                )}
              </>
            )}

            {/* 週間達成状況 詳細ポップアップ（1週間分の演習量 棒グラフ） */}
            {showWeeklyDetail && targetExam && (() => {
              const goal = dailyGoal;
              const maxVal = Math.max(...weekCountsTarget, goal, 1);
              const CH = 150; // 棒グラフ描画領域の高さ(px)
              const weekTotal = weekCountsTarget.reduce((a, b) => a + b, 0);
              const achievedDays = weekCountsTarget.filter(c => goal > 0 && c >= goal).length;
              return (
                <div
                  data-kbscope="1" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
                  onClick={() => setShowWeeklyDetail(false)}
                >
                  <div style={{ background: 'var(--color-bg-white)', borderRadius: 'var(--border-radius-lg)', padding: 20, width: '100%', maxWidth: 440, boxShadow: 'var(--box-shadow-md)' }} onClick={e => e.stopPropagation()}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ color: 'var(--color-text-sub)', display: 'flex', alignItems: 'center' }}><IconTrendingUp size={15} /></span>
                        <span style={{ fontWeight: 700, fontSize: 'var(--font-size-base)', color: 'var(--color-text-main)' }}>{ja ? '週間達成状況' : 'Weekly Progress'}</span>
                      </div>
                      <button onClick={() => setShowWeeklyDetail(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-light)', fontSize: 'var(--font-size-xl)', lineHeight: 1, padding: '0 4px' }}>✕</button>
                    </div>
                    <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', marginBottom: 24 }}>
                      {ja ? `直近7日間の演習量（${targetExam}）` : `Last 7 days · ${targetExam}`}
                    </div>

                    {/* 棒グラフ本体 */}
                    <div style={{ position: 'relative', height: CH, marginTop: 18 }}>
                      {/* 目標ライン（破線） */}
                      {goal > 0 && (
                        <div style={{ position: 'absolute', left: 0, right: 0, bottom: (Math.min(goal, maxVal) / maxVal) * CH, borderTop: '1px dashed var(--color-primary)', pointerEvents: 'none' }} />
                      )}
                      {/* 棒 */}
                      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', height: '100%' }}>
                        {weekDays.map((d, i) => {
                          const count = weekCountsTarget[i];
                          const achieved = goal > 0 && count >= goal;
                          const h = (count / maxVal) * CH;
                          const barH = Math.max(h, count > 0 ? 3 : 0);
                          const staggerIdx = weekCountsTarget.slice(0, i).filter(c => c > 0).length;
                          return (
                            <div key={d} style={{ flex: 1, position: 'relative', height: '100%', display: 'flex', alignItems: 'flex-end' }}>
                              <div style={{ width: '100%', maxWidth: 6, margin: '0 auto', height: popupBarAnimated ? barH : 0, background: achieved ? examColor : tint(examColor, 33), borderRadius: '3px 3px 0 0', transition: count > 0 ? `height 0.45s cubic-bezier(0.4,0,0.2,1) ${staggerIdx * 0.07}s` : 'none' }} />
                              <span style={{ position: 'absolute', bottom: barH + 2, left: '50%', transform: 'translateX(-50%)', fontSize: 'var(--font-size-xs)', fontWeight: 700, color: count > 0 ? (achieved ? examColor : 'var(--color-text-sub)') : 'var(--color-text-light)', opacity: popupBarAnimated ? 1 : 0, transition: count > 0 ? `opacity 0.2s ease ${0.3 + staggerIdx * 0.07}s` : 'none' }}>{count}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    {/* 曜日ラベル */}
                    <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                      {weekDays.map((d) => {
                        const isToday = d === jstToday();
                        const dayLabel = new Date(d + 'T12:00:00').toLocaleDateString(ja ? 'ja-JP' : 'en-US', { weekday: 'short' });
                        return (
                          <div key={d} style={{ flex: 1, textAlign: 'center', fontSize: 'var(--font-size-2xs)', color: isToday ? examColor : 'var(--color-text-light)', fontWeight: isToday ? 700 : 400 }}>{dayLabel}</div>
                        );
                      })}
                    </div>

                    {/* サマリー */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', borderTop: '1px solid var(--color-border)', paddingTop: 12, marginTop: 18 }}>
                      <span>{ja ? '7日間合計' : '7-day total'}: <strong style={{ color: 'var(--color-text-main)' }}>{weekTotal}{ja ? '問' : ''}</strong></span>
                      <span>{ja ? '達成日数' : 'Achieved'}: <strong style={{ color: examColor }}>{achievedDays}/7{ja ? '日' : ''}</strong></span>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* 設定編集ポップアップ */}
            {showSettingsEdit && (
              <div
                data-kbscope="1" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
                onClick={() => setShowSettingsEdit(false)}
                onTouchStart={e => e.stopPropagation()}
                onTouchMove={e => e.stopPropagation()}
              >
                <div style={{ background: 'var(--color-bg-white)', borderRadius: 'var(--border-radius-lg)', padding: '24px 20px', width: '100%', maxWidth: 360, boxShadow: 'var(--box-shadow-md)' }} onClick={e => e.stopPropagation()}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
                    <span style={{ fontWeight: 700, fontSize: 'var(--font-size-lg)' }}>{ja ? '目標設定' : 'Edit Settings'}</span>
                    <button onClick={() => setShowSettingsEdit(false)} style={{ width: 32, height: 32, borderRadius: '50%', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 'var(--font-size-h3)', color: 'var(--color-text-sub)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
                  </div>
                  {/* 受験日 */}
                  <div style={{ marginBottom: 20 }}>
                    <div style={{ fontSize: 'var(--font-size-sm2)', fontWeight: 600, color: 'var(--color-text-sub)', marginBottom: 8 }}>{ja ? '受験日' : 'Exam Date'}</div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input
                        type="date"
                        value={editExamDate}
                        onChange={e => setEditExamDate(e.target.value)}
                        style={{ flex: 1, border: '1px solid var(--color-border)', borderRadius: 8, padding: '8px 10px', fontSize: 'var(--font-size-base)', background: 'var(--color-bg-white)', color: 'var(--color-text-main)', cursor: 'pointer' }}
                      />
                      {editExamDate && (
                        <button onClick={() => setEditExamDate('')} style={{ padding: '6px 10px', border: '1px solid var(--color-border)', borderRadius: 8, background: 'transparent', cursor: 'pointer', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)' }}>
                          {ja ? '削除' : 'Clear'}
                        </button>
                      )}
                    </div>
                  </div>
                  {/* 目標演習量 */}
                  <div style={{ marginBottom: 24 }}>
                    <div style={{ fontSize: 'var(--font-size-sm2)', fontWeight: 600, color: 'var(--color-text-sub)', marginBottom: 12 }}>{ja ? '1日の目標演習量' : 'Daily Goal'}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 16, justifyContent: 'center' }}>
                      <button onClick={() => setEditDailyGoal(v => Math.max(10, v - 5))} disabled={editDailyGoal <= 10} style={{ width: 36, height: 36, borderRadius: '50%', border: '1px solid var(--color-border)', background: 'transparent', cursor: editDailyGoal <= 10 ? 'default' : 'pointer', fontSize: 'var(--font-size-xl)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: editDailyGoal <= 10 ? 'var(--color-text-light)' : 'var(--color-text-main)' }}>−</button>
                      <span style={{ fontSize: 24, fontWeight: 800, minWidth: 64, textAlign: 'center', color: 'var(--color-primary)', fontVariantNumeric: 'tabular-nums' }}>
                        {editDailyGoal}<span style={{ fontSize: 'var(--font-size-sm2)', fontWeight: 400, marginLeft: 2, color: 'var(--color-text-sub)' }}>{ja ? '問' : 'Q'}</span>
                      </span>
                      <button onClick={() => setEditDailyGoal(v => Math.min(100, v + 5))} disabled={editDailyGoal >= 100} style={{ width: 36, height: 36, borderRadius: '50%', border: '1px solid var(--color-border)', background: 'transparent', cursor: editDailyGoal >= 100 ? 'default' : 'pointer', fontSize: 'var(--font-size-xl)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: editDailyGoal >= 100 ? 'var(--color-text-light)' : 'var(--color-text-main)' }}>+</button>
                    </div>
                  </div>
                  {/* 保存ボタン（変更保存時: 回転＋放散アニメ → 1秒後に自動クローズ。未変更時は閉じない） */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, marginTop: 8 }}>
                    {settingsSaveMsg && (
                      <span style={{ fontSize: 'var(--font-size-sm2)', fontWeight: 700, color: settingsSaveMsg === 'saved' ? 'var(--color-success)' : 'var(--color-text-sub)', animation: 'sherpa-save-msg 2s ease-in-out both' }}>
                        {settingsSaveMsg === 'saved' ? `✓ ${ja ? '保存しました' : 'Saved'}` : (ja ? '保存済です' : 'Already saved')}
                      </span>
                    )}
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      {settingsDirty && (
                        <span style={{ position: 'absolute', top: -2, right: -2, width: 10, height: 10, borderRadius: '50%', background: SETTINGS_BURST_COLOR, border: '1.5px solid var(--color-bg-white)', zIndex: 1, pointerEvents: 'none' }} />
                      )}
                      <button
                        ref={saveBtnSettingsRef}
                        disabled={settingsSaving}
                        onClick={() => {
                          if (!settingsDirty) {
                            setSettingsSaveMsg('already');
                            setTimeout(() => setSettingsSaveMsg(null), 2000);
                            return;
                          }
                          handleExamDateChange(editExamDate);
                          handleDailyGoalChange(editDailyGoal);
                          setSettingsSaveMsg('saved');
                          setTimeout(() => setSettingsSaveMsg(null), 2000);
                          setSettingsSaving(true);
                          setTimeout(() => setSettingsSaving(false), 600);
                          const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
                          if (!reduceMotion) {
                            const r = saveBtnSettingsRef.current?.getBoundingClientRect();
                            if (r) setSettingsBurst({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
                          }
                          // アニメーション（約0.6s）完了の1秒後に自動で閉じる（変更保存時のみ）
                          setTimeout(() => setShowSettingsEdit(false), 1600);
                        }}
                        style={{ width: 44, height: 44, flexShrink: 0, padding: 0, border: 'none', background: 'transparent', cursor: settingsSaving ? 'default' : 'pointer', perspective: 600, transition: 'none' }}
                      >
                        <div style={{ position: 'relative', width: '100%', height: '100%', transformStyle: 'preserve-3d', transition: settingsSaving ? 'transform 0.55s cubic-bezier(.45,.05,.3,1)' : 'none', transform: (!settingsDirty || settingsSaving) ? 'rotateY(180deg)' : 'rotateY(0deg)' }}>
                          {/* 表面：未保存 */}
                          <span style={{ position: 'absolute', inset: 0, backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%', border: '2px solid var(--color-accent)', background: 'var(--color-bg-white)', color: 'var(--color-accent)', boxShadow: 'var(--box-shadow-pop)' }}>
                            <IconSave size={22} />
                          </span>
                          {/* 裏面：保存済 */}
                          <span style={{ position: 'absolute', inset: 0, backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden', transform: 'rotateY(180deg)', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%', background: 'var(--color-accent)', color: 'var(--color-btn-primary-text)', boxShadow: 'var(--box-shadow-pop)' }}>
                            <IconSaveCheck size={22} />
                          </span>
                        </div>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
            {settingsBurst && <ConfirmBurst x={settingsBurst.x} y={settingsBurst.y} color={SETTINGS_BURST_COLOR} onDone={() => setSettingsBurst(null)} />}

            {/* 目標資格選択オーバーレイ */}
            {showExamSelect && (
              <ExamSelectOverlay
                targetExam={targetExam}
                uid={uid}
                lang={lang}
                isMobile={isMobile}
                onSelect={(exam) => { setTargetExam(exam); if (user) syncTargetExamToServer(user.userId, uid, exam); }}
                onClose={() => setShowExamSelect(false)}
                desktopMaxWidth={672}
                desktopHeight="86vh"
              />
            )}
          </>
        )}

        {/* ════════ 苦手分析タブ ════════ */}
        {tab === 'analysis' && (
          <>
            {!user ? (
              <Card padding="var(--spacing-xl)">
                <p style={{ margin: 0, textAlign: 'center', fontSize: 'var(--font-size-sm2)', color: 'var(--color-text-light)' }}>
                  {ja ? 'ログインすると苦手分析が表示されます' : 'Log in to view your analysis'}
                </p>
              </Card>
            ) : !targetExam ? (
              <Card padding="var(--spacing-xl)">
                <p style={{ margin: 0, textAlign: 'center', fontSize: 'var(--font-size-sm2)', color: 'var(--color-text-light)' }}>
                  {ja ? '目標資格を設定してください' : 'Set a target exam first'}
                </p>
              </Card>
            ) : statsLoading ? (
              <>
                <Card style={{ marginBottom: 12 }}>
                  <div className="skeleton" style={{ height: 10, width: '35%', borderRadius: 3, marginBottom: 'var(--spacing-md)' }} />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                    {[68, 55, 82, 46, 73].map((w, i) => (
                      <div key={i} style={{ paddingTop: i === 0 ? 0 : 14, paddingBottom: i < 4 ? 14 : 0, borderBottom: i < 4 ? '1px solid var(--color-border)' : 'none', display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 12, rowGap: 4, alignItems: 'baseline' }}>
                        <div className="skeleton" style={{ height: 18, width: 44, borderRadius: 4 }} />
                        <div className="skeleton" style={{ height: 14, width: `${w}%`, borderRadius: 3 }} />
                        <div style={{ gridColumn: 2 }}><div className="skeleton" style={{ height: 10, width: '88%', borderRadius: 3 }} /></div>
                      </div>
                    ))}
                  </div>
                </Card>
                <Card>
                  <div className="skeleton" style={{ height: 14, width: '55%', borderRadius: 4, marginBottom: 12 }} />
                  {[1, 2, 3].map(i => (
                    <div key={i} style={{ height: 44, borderRadius: 8, border: '1px solid var(--color-border)', marginBottom: i < 3 ? 6 : 0, overflow: 'hidden' }}>
                      <div className="skeleton" style={{ height: '100%', borderRadius: 0 }} />
                    </div>
                  ))}
                </Card>
              </>
            ) : (
              <>
                {/* 苦手ドメイン */}
                <Card style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-text-sub)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 'var(--spacing-md)' }}>
                    {ja ? '苦手ドメイン' : 'Weak Domains'}
                  </div>
                  {!focusedUnlocked ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 8, background: 'var(--color-bg-main)' }}>
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
                    {/* 直近N問フィルタ：演習開始当初の古いデータを除外して現在の正答率を測る */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)', fontWeight: 700 }}>{ja ? '集計対象' : 'Window'}</span>
                      <div style={{ display: 'inline-flex', border: '1px solid var(--color-border)', borderRadius: 'var(--border-radius-md)', overflow: 'hidden' }}>
                        {(() => {
                          // 現在の対象資格のドメインだけで最大演習数を算出（domainStatsは全資格横断のため絞り込む）
                          const maxEx = Math.max(0, ...domains.map(d => {
                            const st = domainStats.find(s => tagIdMatches(s.tagId, targetExam ?? '', toDomainIndex(targetExam ?? '', d)));
                            return (st?.recentResults ?? []).length;
                          }));
                          return ([10, 20, 30] as const).map((w) => {
                            const active = recentWindow === w;
                            const disabled = w - 10 >= maxEx;
                            return (
                              <button
                                key={w}
                                onClick={() => !disabled && setRecentWindow(w)}
                                disabled={disabled}
                                style={{ border: 'none', borderLeft: w === 10 ? 'none' : '1px solid var(--color-border)', background: active ? 'var(--color-primary)' : 'transparent', color: disabled ? 'var(--color-text-light)' : active ? 'var(--color-on-primary)' : 'var(--color-text-sub)', fontSize: 'var(--font-size-xs)', fontWeight: 700, padding: '5px 14px', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.4 : 1, transition: 'background 0.15s' }}
                              >
                                {ja ? `直近${w}問` : `Last ${w}`}
                              </button>
                            );
                          });
                        })()}
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                      {[...domains].sort((a, b) => {
                        const getPct = (d: string) => {
                          const st = domainStats.find(s => tagIdMatches(s.tagId, targetExam ?? '', toDomainIndex(targetExam ?? '', d)));
                          // 直近 recentWindow 問でフィルタ（演習開始当初の古いデータは除外）。
                          // 履歴が無い場合のみ累計(correctCount/incorrectCount)にフォールバック。
                          const rec = (st?.recentResults ?? []).slice(-recentWindow);
                          if (rec.length > 0) return (rec.filter(Boolean).length / rec.length) * 100;
                          const cc = st?.correctCount ?? 0; const cum = cc + (st?.incorrectCount ?? 0);
                          return cum > 0 ? (cc / cum) * 100 : 101; // 未演習は末尾へ
                        };
                        return getPct(a) - getPct(b);
                      }).map((domain, di) => {
                        const dIdx = toDomainIndex(targetExam ?? '', domain);
                        const stat = domainStats.find(s => tagIdMatches(s.tagId, targetExam ?? '', dIdx));
                        // 直近 recentWindow 問で集計。履歴が無ければ累計にフォールバック。
                        const recent = (stat?.recentResults ?? []).slice(-recentWindow);
                        const cumCorrect = stat?.correctCount ?? 0;
                        const cumTotal = cumCorrect + (stat?.incorrectCount ?? 0);
                        const correct = recent.length > 0 ? recent.filter(Boolean).length : cumCorrect;
                        const total = recent.length > 0 ? recent.length : cumTotal;
                        const pct = total > 0 ? Math.round((correct / total) * 100) : null;
                        const isWeak = pct !== null && pct < DOMAIN_RATE_WARNING * 100;
                        const isFair = pct !== null && pct < DOMAIN_RATE_CAUTION * 100 && !isWeak;
                        const color = pct === null ? 'var(--color-text-light)' : isWeak ? 'var(--color-danger)' : isFair ? 'var(--color-caution)' : 'var(--color-success)';
                        const domainLabel = domain;
                        const services = EXAM_DOMAIN_SERVICES[targetExam ?? '']?.[dIdx] ?? [];
                        const notLast = di < domains.length - 1;
                        return (
                          <div key={domain} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 12, rowGap: 4, alignItems: 'baseline', paddingTop: di === 0 ? 0 : 14, paddingBottom: notLast ? 14 : 0, borderBottom: notLast ? '1px solid var(--color-border)' : 'none' }}>
                            <span style={{ gridColumn: 1, whiteSpace: 'nowrap' }}>
                              <span style={{ fontSize: 'var(--font-size-lg)', fontWeight: 800, color }}>
                                {pct !== null ? `${pct}%` : (ja ? '未演習' : 'N/A')}
                              </span>
                              {total > 0 && (
                                <span style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-light)', marginLeft: 3 }}>
                                  （{correct}/{total}{ja ? '問' : ''}）
                                </span>
                              )}
                            </span>
                            <span style={{ gridColumn: 2, fontSize: 'var(--font-size-sm2)', color: isWeak ? 'var(--color-danger)' : 'var(--color-text-main)', fontWeight: isWeak ? 700 : 600, lineHeight: 1.45 }}>
                              {isWeak && '⚠ '}{domainLabel}
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
                    <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--color-border)', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)', lineHeight: 1.6 }}>
                      {ja
                        ? '「しっかり対策」モードでは苦手問題・誤答問題を優先して出題します。ホーム画面から開始できます。'
                        : '"Focused Practice" mode prioritizes your weak and incorrect questions. Start it from the home screen.'}
                    </div>
                    </>
                  )}
                </Card>

                {/* 頻出ミス問題 */}
                <Card>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
                    <span style={{ fontSize: 'var(--font-size-base)' }}>✗</span>
                    <span style={{ fontWeight: 700, fontSize: 'var(--font-size-base)' }}>{ja ? '間違えやすい問題（2回以上）' : 'Frequent Mistakes (2+ times)'}</span>
                  </div>
                  {!focusedUnlocked ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 8, background: 'var(--color-bg-main)' }}>
                      <IconLock size={14} />
                      <span style={{ fontSize: 'var(--font-size-sm2)', color: 'var(--color-text-sub)' }}>
                        {ja ? `あと${Math.max(0, FOCUSED_UNLOCK_THRESHOLD - answeredCount)}問でアンロック` : `${Math.max(0, FOCUSED_UNLOCK_THRESHOLD - answeredCount)} more to unlock`}
                      </span>
                    </div>
                  ) : weakLoading ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {[1, 2, 3].map(i => (
                        <div key={i} style={{ height: 48, borderRadius: 8, border: '1px solid var(--color-border)', overflow: 'hidden' }}>
                          <div className="skeleton" style={{ height: '100%', borderRadius: 0 }} />
                        </div>
                      ))}
                    </div>
                  ) : weakQuestions.length === 0 ? (
                    <p style={{ margin: 0, fontSize: 'var(--font-size-sm2)', color: 'var(--color-text-light)', textAlign: 'center', padding: '8px 0' }}>
                      {ja ? '2回以上間違えた問題はありません' : 'No questions wrong 2+ times'}
                    </p>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {weakQuestions.map(q => {
                        const isExpanded = expandedWeakQ === q.questionId;
                        const detail = weakQDetails[q.questionId];
                        return (
                          <div key={q.questionId} style={{ borderRadius: 8, border: '1px solid var(--color-border)', overflow: 'hidden' }}>
                            <div
                              onClick={() => openWeakQModal(q.questionId)}
                              style={{ padding: '8px 10px', display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}
                            >
                              <span style={{ flexShrink: 0, fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-danger)', background: 'var(--color-danger-light)', borderRadius: 4, padding: '2px 6px', marginTop: 1 }}>
                                ×{q.incorrectCount}
                              </span>
                              <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', lineHeight: 1.5, flex: 1 }}>
                                {q.questionText?.slice(0, 80)}{(q.questionText?.length ?? 0) > 80 ? '…' : ''}
                              </span>
                              <span style={{ flexShrink: 0, color: 'var(--color-text-light)', display: 'flex', alignItems: 'center', marginTop: 2, transform: 'rotate(-90deg)' }}>
                                <IconChevronDown size={14} />
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </Card>
              </>
            )}
          </>
        )}

        {/* ════════ 履歴タブ ════════ */}
        {tab === 'history' && (
          <>
            {!user ? (
              <Card padding="var(--spacing-xl)">
                <p style={{ margin: 0, textAlign: 'center', fontSize: 'var(--font-size-sm2)', color: 'var(--color-text-light)' }}>
                  {ja ? 'ログインすると履歴が表示されます' : 'Log in to view your history'}
                </p>
              </Card>
            ) : histLoading ? (
              <>
                <Card style={{ marginBottom: 'var(--spacing-md)' }}>
                  <div className="skeleton" style={{ height: 10, width: '40%', borderRadius: 3, marginBottom: 'var(--spacing-xs)' }} />
                  <div className="skeleton" style={{ height: 28, width: '45%', borderRadius: 4 }} />
                </Card>
                {[1, 2, 3, 4, 5].map(i => (
                  <Card key={i} style={{ marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div className="skeleton" style={{ height: 20, width: 52, borderRadius: 'var(--border-radius-sm)', flexShrink: 0 }} />
                      <div className="skeleton" style={{ height: 14, flex: 1, borderRadius: 3 }} />
                      <div className="skeleton" style={{ height: 16, width: 36, borderRadius: 3, flexShrink: 0 }} />
                    </div>
                  </Card>
                ))}
              </>
            ) : (
              <>
                {/* 取得済資格パネル（クリックでオーバーレイを開く） */}
                {(() => {
                  const HEX = 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)';
                  const CertHex = ({ exam, obtained, color, size = 38 }: { exam: string; obtained: boolean; color: string; size?: number }) => {
                    const ExamIcon = EXAM_ICON_COMPONENTS[exam];
                    const inner = Math.round(size * 0.88);
                    const hexH = Math.round(size * 1.15);
                    const innerH = Math.round(inner * 1.15);
                    // 未取得時の縁・アイコンのグレー濃度。塗り(color-bg-main)より濃く保ちつつ少し薄めに。
                    const grayOpacity = 0.48;
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                        <div style={{ position: 'relative', width: size, height: hexH, flexShrink: 0 }}>
                          <div style={{ position: 'absolute', inset: 0, background: obtained ? color : 'var(--color-text-light)', clipPath: HEX, opacity: obtained ? 1 : grayOpacity }} />
                          <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: inner, height: innerH, background: obtained ? 'var(--color-bg-white)' : 'var(--color-bg-main)', clipPath: HEX, display: 'flex', alignItems: 'center', justifyContent: 'center', color: obtained ? color : 'var(--color-text-light)', opacity: obtained ? 1 : grayOpacity }}>
                            {ExamIcon && <ExamIcon size={Math.round(size * 0.42)} />}
                          </div>
                        </div>
                        <div style={{ fontSize: 'var(--font-size-3xs)', fontWeight: 800, color: obtained ? color : 'var(--color-text-light)', lineHeight: 1 }}>{exam}</div>
                      </div>
                    );
                  };
                  return (
                    <Card style={{ marginBottom: 'var(--spacing-md)', cursor: 'pointer' }} onClick={() => { setCertConfetti(false); setCertBurst(null); setShowCertOverlay(true); }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--spacing-md)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ color: 'var(--color-text-sub)', display: 'flex', alignItems: 'center' }}><IconTrophy size={13} /></span>
                          <span style={{ fontWeight: 700, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-main)' }}>{ja ? '取得済資格' : 'Certifications'}</span>
                        </div>
                        <div style={{ width: 35, height: 35, borderRadius: '50%', border: '1px solid var(--color-primary)', background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-primary)', flexShrink: 0 }}>
                          <IconPenLine size={14} />
                        </div>
                      </div>
                      {[
                        { color: EXAM_LEVEL_COLORS.Foundational, exams: ['CLF', 'AIF'] },
                        { color: EXAM_LEVEL_COLORS.Business, exams: ['AIB'] },
                        { color: EXAM_LEVEL_COLORS.Associate, exams: ['SAA', 'DVA', 'SOA', 'DEA', 'MLA'] },
                        { color: EXAM_LEVEL_COLORS.Professional, exams: ['SAP', 'DOP', 'AIP'] },
                        { color: EXAM_LEVEL_COLORS.Specialty, exams: ['ANS', 'SCS'] },
                      ].map(row => (
                        <div key={row.color} style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 6 }}>
                          {[...row.exams].sort((a, b) =>
                            (obtainedCerts.includes(b) ? 1 : 0) - (obtainedCerts.includes(a) ? 1 : 0)
                          ).map(exam => (
                            <CertHex key={exam} exam={exam} obtained={obtainedCerts.includes(exam)} color={row.color} size={45} />
                          ))}
                        </div>
                      ))}
                    </Card>
                  );
                })()}

                {/* 取得済資格オーバーレイ */}
                {showCertOverlay && (() => {
                  const HEX = 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)';
                  const CERT_LEVELS = [
                    { key: 'Foundational', label: 'Foundational', color: EXAM_LEVEL_COLORS.Foundational, exams: ['CLF', 'AIF'] },
                    { key: 'Business',     label: 'Business',     color: EXAM_LEVEL_COLORS.Business, exams: ['AIB'] },
                    { key: 'Associate',    label: 'Associate',    color: EXAM_LEVEL_COLORS.Associate, exams: ['SAA', 'DVA', 'SOA', 'DEA', 'MLA'] },
                    { key: 'Professional', label: 'Professional', color: EXAM_LEVEL_COLORS.Professional, exams: ['SAP', 'DOP', 'AIP'] },
                    { key: 'Specialty',    label: 'Specialty',    color: EXAM_LEVEL_COLORS.Specialty, exams: ['ANS', 'SCS'] },
                  ] as const;
                  const currentLevel = CERT_LEVELS.find(l => l.key === certOverlayLevel) ?? CERT_LEVELS[0];
                  return createPortal(
                    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9800, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={() => setShowCertOverlay(false)}>
                      <style>{`
                        @keyframes certObtainPop { 0%{transform:scale(1)} 40%{transform:scale(1.18)} 70%{transform:scale(0.94)} 100%{transform:scale(1)} }
                        @keyframes certHexSpin { 0%{transform:rotateY(0deg)} 100%{transform:rotateY(360deg)} }
                      `}</style>
                      {certConfetti && <Confetti count={70} durationMs={2200} zIndex={9900} onDone={() => setCertConfetti(false)} />}
                      {certBurst && <ConfirmBurst x={certBurst.x} y={certBurst.y} color={certBurst.color} onDone={() => setCertBurst(null)} />}
                      <div style={{ background: 'var(--color-bg-white)', borderRadius: 'var(--border-radius-lg)', width: '100%', maxWidth: 420, boxShadow: 'var(--box-shadow-lg)', display: 'flex', flexDirection: 'column', overflow: 'hidden', maxHeight: '80vh' }} onClick={e => e.stopPropagation()}>
                        {/* ヘッダー */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px 12px', flexShrink: 0, borderBottom: '1px solid var(--color-border)' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <IconTrophy size={16} />
                            <span style={{ fontWeight: 700, fontSize: 'var(--font-size-lg)' }}>{ja ? '取得済資格を設定' : 'Set Certifications'}</span>
                          </div>
                          <button onClick={() => setShowCertOverlay(false)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--color-text-light)', fontSize: 20, lineHeight: 1, padding: 4 }}>✕</button>
                        </div>
                        {/* レベルタブ */}
                        <div style={{ display: 'flex', borderBottom: '1px solid var(--color-border)', flexShrink: 0 }}>
                          {CERT_LEVELS.map(lv => (
                            <button key={lv.key} onClick={() => setCertOverlayLevel(lv.key)} style={{ flex: 1, padding: '10px 4px', border: 'none', borderBottom: `3px solid ${certOverlayLevel === lv.key ? lv.color : 'transparent'}`, background: 'transparent', cursor: 'pointer', fontSize: 'var(--font-size-xs)', fontWeight: 700, color: certOverlayLevel === lv.key ? lv.color : 'var(--color-text-light)', transition: 'color 0.15s' }}>
                              {lv.label}
                            </button>
                          ))}
                        </div>
                        {/* 資格カード */}
                        <div style={{ display: 'flex', gap: 10, padding: '20px 20px', flexWrap: 'wrap', alignContent: 'flex-start', height: 240, overflowY: 'auto' }}>
                          {currentLevel.exams.map(exam => {
                            const obtained = obtainedCerts.includes(exam);
                            const ExamIcon = EXAM_ICON_COMPONENTS[exam];
                            const c = currentLevel.color;
                            return (
                              <button
                                key={exam}
                                onClick={e => toggleObtainedCert(exam, e.currentTarget)}
                                style={{ flexShrink: 0, width: 80, padding: '10px 6px 8px', cursor: 'pointer', borderRadius: 10, textAlign: 'center', position: 'relative', border: `2px solid ${obtained ? c : 'var(--color-border)'}`, background: obtained ? c : 'var(--color-bg-card)', animation: justObtained === exam ? 'certObtainPop 0.38s cubic-bezier(.36,.07,.19,.97)' : undefined, transition: 'border-color 0.15s, background 0.15s' }}
                              >
                                {obtained && <div style={{ position: 'absolute', top: 4, right: 4, color: 'var(--color-on-level)', lineHeight: 0 }}><IconCheck size={14} /></div>}
                                {/* 六角形バッジ */}
                                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 6, perspective: 200 }}>
                                  <div style={{ width: 40, height: 46, background: obtained ? 'rgba(255,255,255,0.25)' : c + '33', clipPath: HEX, display: 'flex', alignItems: 'center', justifyContent: 'center', animation: justObtained === exam ? 'certHexSpin 0.52s ease' : undefined }}>
                                    <div style={{ width: 34, height: 39, background: obtained ? 'rgba(255,255,255,0.85)' : 'var(--color-bg-card)', clipPath: HEX, display: 'flex', alignItems: 'center', justifyContent: 'center', color: obtained ? c : 'var(--color-text-light)' }}>
                                      {ExamIcon && <ExamIcon size={17} />}
                                    </div>
                                  </div>
                                </div>
                                <div style={{ fontWeight: 800, fontSize: 'var(--font-size-md)', color: obtained ? 'var(--color-on-level)' : 'var(--color-text-main)', lineHeight: 1 }}>{exam}</div>
                              </button>
                            );
                          })}
                        </div>
                        {/* フッター */}
                        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--color-border)', flexShrink: 0, textAlign: 'center' }}>
                          <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)' }}>
                            {ja ? `${obtainedCerts.length} / 12 資格取得済` : `${obtainedCerts.length} / 12 certified`}
                          </span>
                        </div>
                      </div>
                    </div>,
                    document.body
                  );
                })()}

                {recentSessions.length === 0 ? (
                  <Card padding="var(--spacing-xl)">
                    <p style={{ margin: 0, textAlign: 'center', fontSize: 'var(--font-size-sm2)', color: 'var(--color-text-light)' }}>
                      {ja ? 'まだセッションがありません' : 'No sessions yet'}
                    </p>
                  </Card>
                ) : (
                <>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10, gap: 8 }}>
                  <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)' }}>{ja ? '直近10セッション' : 'Last 10 sessions'}</span>
                  {(totalSessionCount !== null || totalExercised !== null) && (
                    <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)', whiteSpace: 'nowrap' }}>
                      {ja ? '累計' : 'Total'}{' '}
                      {totalSessionCount !== null && <>{totalSessionCount.toLocaleString()}{ja ? 'セッション' : ' sessions'}</>}
                      {totalSessionCount !== null && totalExercised !== null && ' / '}
                      {totalExercised !== null && <>{totalExercised.toLocaleString()}{ja ? '問' : 'Q'}</>}
                    </span>
                  )}
                </div>
                {recentSessions.map(s => {
                  const modeLabel = s.mode === 'exam'
                    ? (s.isMini ? (ja ? 'ミニ模試' : 'Mini Exam') : (ja ? '模試' : 'Mock Exam'))
                    : s.isFocused ? (ja ? 'しっかり対策' : 'Focused') : (ja ? 'サクッと演習' : 'Quick');
                  const modeBg = s.mode === 'exam' ? '#fff0f0' : s.isFocused ? '#e6f4f4' : 'var(--color-primary-light)';
                  const modeColor = s.mode === 'exam' ? 'var(--color-danger)' : s.isFocused ? 'var(--color-points)' : 'var(--color-primary)';
                  const d = new Date(s.endedAt || s.startedAt);
                  const dateLabel = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                  const isExpanded = expandedSession === s.sessionId;
                  const answers = sessionAnswers[s.sessionId];
                  const qCount = s.questionIds?.length ?? 0;
                  const scoreColor = s.mode === 'exam'
                    ? (s.isPassed ? 'var(--color-success)' : 'var(--color-danger)')
                    : (s.score >= 70 ? 'var(--color-success)' : 'var(--color-danger)');

                  return (
                    <Card key={s.sessionId} style={{ marginBottom: 8 }}>
                      <div data-kbnav="1" style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', userSelect: 'none' }} onClick={() => handleToggleSession(s)}>
                        <span style={{ fontSize: 'var(--font-size-2xs)', fontWeight: 700, padding: '2px 8px', borderRadius: 'var(--border-radius-sm)', background: modeBg, color: modeColor, flexShrink: 0 }}>
                          {modeLabel}
                        </span>
                        <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', flex: 1, minWidth: 0 }}>
                          {dateLabel}
                          {qCount > 0 && <span style={{ marginLeft: 6, color: 'var(--color-text-light)' }}>{qCount}{ja ? '問' : 'Q'}</span>}
                        </span>
                        <span style={{ fontWeight: 700, fontSize: 'var(--font-size-md)', color: scoreColor, flexShrink: 0 }}>{s.score}%</span>
                        <span style={{ color: 'var(--color-text-light)', fontSize: 'var(--font-size-base)', transition: 'transform 0.2s', transform: isExpanded ? 'rotate(90deg)' : 'none', flexShrink: 0 }}>›</span>
                      </div>
                      {isExpanded && (
                        <div style={{ marginTop: 10, borderTop: '1px solid var(--color-border)', paddingTop: 8 }}>
                          {answersLoading === s.sessionId ? (
                            <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0' }}>
                              <div className="sherpa-spinner" style={{ width: 18, height: 18, borderWidth: 2 }} />
                            </div>
                          ) : !answers || answers.length === 0 ? (
                            <p style={{ margin: 0, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-light)', textAlign: 'center' }}>
                              {ja ? '回答データがありません' : 'No answer data'}
                            </p>
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                              {answers.map((a, idx) => {
                                const isAExpanded = expandedAnswer === a.questionId;
                                const aDetail = answerDetails[a.questionId];
                                return (
                                  <div
                                    key={a.questionId + idx}
                                    onClick={() => openAnswerModal(a.questionId, !!a.isCorrect)}
                                    style={{ borderRadius: 6, border: '1px solid var(--color-border)', overflow: 'hidden', cursor: 'pointer' }}
                                  >
                                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 8px' }}>
                                      <span style={{ flexShrink: 0, width: 15, height: 15, borderRadius: '50%', background: a.isCorrect ? 'var(--color-success)' : 'var(--color-danger)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 8, fontWeight: 700 }}>
                                        {a.isCorrect ? '○' : '×'}
                                      </span>
                                      <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', lineHeight: 1.5, flex: 1 }}>
                                        {a.questionText?.slice(0, 60)}{(a.questionText?.length ?? 0) > 60 ? '…' : ''}
                                      </span>
                                      {user && (
                                        <button
                                          onClick={e => { e.stopPropagation(); toggleBookmark(a.questionId); }}
                                          disabled={bookmarkOpLoading.has(a.questionId)}
                                          style={{ flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', display: 'flex', alignItems: 'center', opacity: bookmarkOpLoading.has(a.questionId) ? 0.5 : 1 }}
                                        >
                                          <span style={{ color: bookmarkedIds.has(a.questionId) ? 'var(--color-warning, #f59e0b)' : 'var(--color-text-light)' }}>
                                            <IconStar filled={bookmarkedIds.has(a.questionId)} size={14} />
                                          </span>
                                        </button>
                                      )}
                                      <span style={{ flexShrink: 0, display: 'flex', alignItems: 'center', color: 'var(--color-text-light)', transform: 'rotate(-90deg)' }}>
                                        <IconChevronDown size={13} />
                                      </span>
                                    </div>
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
                )}
              </>
            )}
          </>
        )}
      </PageLayout>

      {/* ── 問題詳細モーダル ── */}
      {questionModal && (
        <div
          data-kbscope="1" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: isMobile ? 'flex-end' : 'center', justifyContent: 'center', padding: isMobile ? 0 : 'var(--spacing-lg)' }}
          onClick={() => setQuestionModal(null)}
        >
          <div
            style={{ background: 'var(--color-bg-white)', borderRadius: isMobile ? 'var(--border-radius-lg) var(--border-radius-lg) 0 0' : 'var(--border-radius-lg)', padding: isMobile ? 'var(--spacing-xl) var(--spacing-xl) var(--spacing-xl)' : 'var(--spacing-xl)', width: '100%', maxWidth: isMobile ? '100%' : 600, maxHeight: isMobile ? '85vh' : '80vh', overflowY: 'auto', boxShadow: 'var(--box-shadow-lg)' }}
            onClick={e => e.stopPropagation()}
          >
            {/* ヘッダー */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-lg)' }}>
              <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 700, color: 'var(--color-text-sub)' }}>
                {questionModal.isCorrect !== undefined
                  ? (questionModal.isCorrect
                    ? <span style={{ color: 'var(--color-success)', display: 'inline-flex', alignItems: 'center', gap: 4 }}><IconCircleCheck size={14} />{ja ? '正解' : 'Correct'}</span>
                    : <span style={{ color: 'var(--color-danger)', display: 'inline-flex', alignItems: 'center', gap: 4 }}><IconCircleX size={14} />{ja ? '不正解' : 'Incorrect'}</span>)
                  : (ja ? '問題詳細' : 'Question Detail')}
              </span>
              <button onClick={() => setQuestionModal(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-sub)', fontSize: 'var(--font-size-xl)', lineHeight: 1, padding: '2px 6px' }}>✕</button>
            </div>

            {questionModal.loading ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--spacing-xl) 0' }}>
                <div className="sherpa-spinner" />
              </div>
            ) : questionModal.detail ? (
              <div style={{ userSelect: 'text' }}>
                {/* 問題文 */}
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
                {/* 選択肢 */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)', marginBottom: 'var(--spacing-lg)' }}>
                  {(questionModal.detail.choices ?? []).map((c: string, i: number) => {
                    const isCorrect = (questionModal.detail.correctAnswerIndices ?? []).includes(i);
                    return (
                      <div key={i} style={{ fontSize: 'var(--font-size-sm)', padding: '10px 14px', borderRadius: 'var(--border-radius-md)', border: `1.5px solid ${isCorrect ? 'var(--color-success)' : 'var(--color-border)'}`, background: isCorrect ? 'var(--color-feedback-correct-bg)' : 'var(--color-bg-main)', color: isCorrect ? 'var(--color-success)' : 'var(--color-text-sub)', lineHeight: 1.6 }}>
                        <span style={{ fontWeight: 700, marginRight: 6 }}>{String.fromCharCode(65 + i)}.</span>
                        {isCorrect ? '✓ ' : ''}{c.replace(/^[A-E]\.\s*/, '')}
                      </div>
                    );
                  })}
                </div>
                {/* 解説 */}
                {questionModal.detail.explanation && (
                  <div style={{ padding: 'var(--spacing-md)', borderRadius: 'var(--border-radius-md)', background: 'var(--color-bg-info)', border: '1px solid var(--color-border-info)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
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
