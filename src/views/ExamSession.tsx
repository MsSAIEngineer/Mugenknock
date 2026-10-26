'use client';
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation } from '@/compat/react-router-dom';
import { API_ENDPOINT, EXAM_CONFIGS, PASS_RATE, EXAM_LEVEL } from '../constants';
import { lockBodyScroll } from '../utils/bodyScrollLock';
import { recordSessionDomainStats } from '../utils/domainStats';
import { qText, qChoiceAt } from '../utils/i18nQuestion';
import { deleteCached, deleteCachedByPrefix } from '../utils/cache';
import { addPoints } from '../utils/points';
import { incrementDailyProgress } from '../utils/dailyProgress';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import ReportModal from '../components/ReportModal';
import { IconFlag, IconStar, IconCircleCheck, IconCirclePause, IconCheck, IconAlertTriangle } from '../components/Icons';
import KeyHint from '../components/KeyHint';
import { isKbMode } from '../utils/keyboardMode';

const WAKARANAI = 'わからない';
const stripLabel = (s: string) => s.replace(/^[A-E]\.\s*/, '');

type Question = {
  questionId: string;
  examType: string;
  questionText: string;
  choices: string[];
  correctAnswers?: string[];
  correctAnswerIndices?: number[];
  explanation?: string;
  isMultiple: boolean;
  correctAnswerCount?: number;
  validityCheckedAt?: string;
  updatedAt?: string;
  createdAt?: string;
  scheduledDeletionReason?: string;
  scheduledDeletionDate?: string;
};

// correctAnswerIndices が稀にスカラー値で保存されており .includes/.every でクラッシュするため必ず配列化する
const toIdxArr = (v: any): number[] => Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]);

const formatTime = (sec: number) => {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = (sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
};

export default function ExamSession() {
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as any;
  const { user } = useAuth();
  const { lang, t } = useLanguage();

  const sessionId: string = state?.sessionId ?? '';
  const questions: Question[] = state?.questions ?? [];
  const userId: string = state?.userId ?? '';
  const examType: string = state?.examType ?? '';
  const isMini: boolean = state?.isMini ?? false;
  const config = EXAM_CONFIGS[examType] ?? Object.values(EXAM_CONFIGS)[0];
  const timeLimitMin = isMini ? Math.ceil(config.timeLimitMin / 5) : config.timeLimitMin;
  const totalSec = timeLimitMin * 60;

  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  // リロードで compat レイヤーが初期 state を復活させると進捗が巻き戻るため、
  // 同一セッションの examDraft がより多くの回答を持つ場合は初期値として復元する。
  // （useState 初期化時に反映することで、保存useEffectによる上書きより前に確定させる）
  const _resumeInit = useMemo(() => {
    let answers0: Record<string, string[]> = state?.resumeAnswers ?? {};
    let index0: number = state?.resumeIndex ?? 0;
    let timeLeft0: number = state?.resumeTimeLeft ?? totalSec;
    let flagged0: string[] = state?.resumeFlagged ?? [];
    let orders0: Record<string, number[]> = {};
    try {
      const raw = state?.userId ? localStorage.getItem(`examDraft_${state.userId}`) : null;
      if (raw) {
        const d = JSON.parse(raw);
        if (d.sessionId === state?.sessionId && Array.isArray(d.flagged)) flagged0 = d.flagged;
        // 選択肢の並び順（同一セッション内で固定）を復元する
        if (d.sessionId === state?.sessionId && d.choiceOrders && typeof d.choiceOrders === 'object') orders0 = d.choiceOrders;
        if (d.sessionId === state?.sessionId &&
            Object.keys(d.answers ?? {}).length > Object.keys(answers0).length) {
          answers0 = d.answers ?? {};
          index0 = d.currentIndex ?? 0;
          if (typeof d.timeLeft === 'number') timeLeft0 = d.timeLeft;
        }
      }
    } catch {}
    return { answers0, index0, timeLeft0, flagged0, orders0 };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [currentIndex, setCurrentIndex] = useState<number>(_resumeInit.index0);
  const [answers, setAnswers] = useState<Record<string, string[]>>(_resumeInit.answers0);
  const [timeLeft, setTimeLeft] = useState<number>(_resumeInit.timeLeft0);
  const timeLeftRef = useRef<number>(_resumeInit.timeLeft0);
  // 選択肢の並び順（questionId → シャッフル済みの元インデックス列）。初回のみシャッフルし
  // ドラフトへ永続化。同一セッション内は固定（再開しても同順）、次セッションで再シャッフル。
  const savedOrdersRef = useRef<Record<string, number[]>>(_resumeInit.orders0 ?? {});
  const [paused, setPaused] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const finishedRef = useRef(false);
  const [bookmarkedIds, setBookmarkedIds] = useState<Set<string>>(new Set());
  const [flaggedIds, setFlaggedIds] = useState<Set<string>>(new Set(_resumeInit.flagged0));
  const [hoveredNode, setHoveredNode] = useState<number | null>(null);

  // 「後で確認する」フラグの切替（セッション内のみ・localStorageの examDraft に保存）
  const toggleFlag = (qid: string) => {
    setFlaggedIds(prev => { const n = new Set(prev); if (n.has(qid)) n.delete(qid); else n.add(qid); return n; });
  };

  useEffect(() => {
    if (!userId) return;
    fetch(`${API_ENDPOINT}/users/me/bookmarks?userId=${userId}`)
      .then(r => r.json())
      .then(d => setBookmarkedIds(new Set(d.questionIds ?? [])))
      .catch(() => {});
  }, [userId]);

  useEffect(() => {
    document.querySelector('main')?.scrollTo({ top: 0 });
    setAnswerCountError(null);
  }, [currentIndex]);

  const toggleBookmark = async (questionId: string) => {
    const isBookmarked = bookmarkedIds.has(questionId);
    try {
      if (isBookmarked) {
        await fetch(`${API_ENDPOINT}/questions/${questionId}/bookmark?userId=${userId}`, { method: 'DELETE' });
        setBookmarkedIds(prev => { const next = new Set(prev); next.delete(questionId); return next; });
      } else {
        await fetch(`${API_ENDPOINT}/questions/${questionId}/bookmark`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId }),
        });
        setBookmarkedIds(prev => { const next = new Set(prev); next.add(questionId); return next; });
      }
    } catch (err) { console.error(err); }
  };

  // timeLeftRef を常に最新値に保つ
  useEffect(() => { timeLeftRef.current = timeLeft; }, [timeLeft]);

  // 回答・問題移動のたびにドラフト保存
  useEffect(() => {
    if (!sessionId) return;
    try {
      localStorage.setItem(`examDraft_${userId}`, JSON.stringify({
        sessionId, examType, questions, userId, isMini,
        currentIndex, answers, timeLeft: timeLeftRef.current, flagged: [...flaggedIds],
        choiceOrders: savedOrdersRef.current, savedAt: Date.now(),
      }));
    } catch { /* quota over 等は無視 */ }
    // サーバにも進捗保存（端末跨ぎ/キャッシュ削除でも再開可能に。questionsは送らず軽量に）
    if (userId && userId !== 'guest') {
      fetch(`${API_ENDPOINT}/sessions/${sessionId}/progress`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, sessionType: isMini ? 'mini' : 'exam', draft: { currentIndex, answers, timeLeft: timeLeftRef.current } }),
      }).catch(() => {});
    }
  }, [answers, currentIndex, flaggedIds]); // eslint-disable-line react-hooks/exhaustive-deps

  // 途中離脱時の保存: 上の効果は回答・移動時のみ発火し、SPA内遷移では何も走らないため、
  // beforeunload/pagehide とアンマウント時に最新の残り時間込みで確実に保存する。
  const examDraftRef = useRef({ answers, currentIndex, flaggedIds });
  useEffect(() => { examDraftRef.current = { answers, currentIndex, flaggedIds }; });
  const saveExamDraftNow = useCallback(() => {
    if (!sessionId || finishedRef.current) return;
    const { answers: a, currentIndex: ci, flaggedIds: f } = examDraftRef.current;
    try {
      localStorage.setItem(`examDraft_${userId}`, JSON.stringify({
        sessionId, examType, questions, userId, isMini,
        currentIndex: ci, answers: a, timeLeft: timeLeftRef.current, flagged: [...f], savedAt: Date.now(),
      }));
    } catch { /* quota over 等は無視 */ }
    if (userId && userId !== 'guest') {
      fetch(`${API_ENDPOINT}/sessions/${sessionId}/progress`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, sessionType: isMini ? 'mini' : 'exam', draft: { currentIndex: ci, answers: a, timeLeft: timeLeftRef.current } }),
      }).catch(() => {});
    }
  }, [sessionId, examType, questions, userId, isMini]);
  useEffect(() => {
    if (!sessionId) return;
    window.addEventListener('beforeunload', saveExamDraftNow);
    window.addEventListener('pagehide', saveExamDraftNow);
    return () => {
      window.removeEventListener('beforeunload', saveExamDraftNow);
      window.removeEventListener('pagehide', saveExamDraftNow);
      // SPA内遷移では beforeunload が発火しないためアンマウント時にも保存（完了後は no-op）
      saveExamDraftNow();
    };
  }, [saveExamDraftNow]);

  // タイマー
  useEffect(() => {
    if (paused || timeLeft <= 0 || finishedRef.current) return;
    const id = setInterval(() => setTimeLeft(t => t - 1), 1000);
    return () => clearInterval(id);
  }, [paused, timeLeft]);

  // 時間切れ
  useEffect(() => {
    if (timeLeft <= 0 && !finishedRef.current) handleFinish(true);
  }, [timeLeft]);

  const currentQ = questions[currentIndex];
  const selected = answers[currentQ?.questionId] ?? [];

  const CHOICE_LABELS = ['A', 'B', 'C', 'D', 'E'];

  const choiceShuffleMap = useRef(new Map<string, number[]>());
  if (currentQ?.choices && !choiceShuffleMap.current.has(currentQ.questionId)) {
    const validIdx = currentQ.choices
      .map((_: unknown, i: number) => i)
      .filter((i: number) => currentQ.choices[i] !== WAKARANAI);
    // 保存済みの順があれば復元（＝同一セッションで確定済み）。無ければ初回シャッフルして記録。
    const saved = savedOrdersRef.current[currentQ.questionId];
    let idx: number[];
    if (saved && saved.length === validIdx.length) {
      idx = saved;
    } else {
      idx = [...validIdx];
      for (let i = idx.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [idx[i], idx[j]] = [idx[j], idx[i]];
      }
      savedOrdersRef.current[currentQ.questionId] = idx;
    }
    choiceShuffleMap.current.set(currentQ.questionId, idx);
  }
  const shuffledIndices = choiceShuffleMap.current.get(currentQ?.questionId) ?? [];

  const [lastSelected, setLastSelected] = useState<string | null>(null);
  // キーボード操作用カーソル（Web版のみ）
  const [cursorIndex, setCursorIndex] = useState(0);
  const cursorElRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { setCursorIndex(0); }, [currentIndex]);
  // 右ペインがフォーカス中か（左ペイン操作中は選択肢カーソルを隠す）
  const [rightActive, setRightActive] = useState(true);
  useEffect(() => {
    setRightActive(document.body.dataset.pane !== 'left');
    const h = (e: Event) => setRightActive((e as CustomEvent).detail !== 'left');
    window.addEventListener('panefocuschange', h);
    return () => window.removeEventListener('panefocuschange', h);
  }, []);
  // キー入力モード（既定OFF=カーソル非表示、矢印で有効化）
  const [kbMode, setKbModeState] = useState(false);
  useEffect(() => {
    setKbModeState(isKbMode());
    const h = (e: Event) => setKbModeState((e as CustomEvent).detail === true);
    window.addEventListener('kbmodechange', h);
    return () => window.removeEventListener('kbmodechange', h);
  }, []);
  // カーソルの選択肢が画面内に入るようスクロール追従（Web版）
  useEffect(() => { if (!isMobile) cursorElRef.current?.scrollIntoView({ block: 'nearest' }); }, [cursorIndex, isMobile]);

  const toggle = (choice: string) => {
    const qid = currentQ.questionId;
    const cur = answers[qid] ?? [];
    setAnswerCountError(null);
    setLastSelected(choice);
    if (choice === WAKARANAI) {
      setAnswers(prev => ({ ...prev, [qid]: cur.includes(WAKARANAI) ? [] : [WAKARANAI] }));
    } else if (currentQ.isMultiple) {
      setAnswers(prev => ({
        ...prev,
        [qid]: cur.includes(choice) ? cur.filter(c => c !== choice) : [...cur.filter(c => c !== WAKARANAI), choice]
      }));
    } else {
      setAnswers(prev => ({ ...prev, [qid]: [choice] }));
    }
  };

  const handleNext = () => {
    const isWakaranai = selected.includes(WAKARANAI);
    if (!isWakaranai && currentQ.isMultiple && currentQ.correctAnswerCount && selected.length > 0 &&
        selected.length !== currentQ.correctAnswerCount) {
      setAnswerCountError(lang === 'ja'
        ? `${currentQ.correctAnswerCount}つ選択してください（現在${selected.length}つ）`
        : `Select ${currentQ.correctAnswerCount} answers (currently ${selected.length})`);
      return;
    }
    setCurrentIndex(i => Math.min(questions.length - 1, i + 1));
  };

  const handleAbortAndGrade = async () => {
    if (finishedRef.current) return;
    const answeredQs = questions.filter((q: Question) => !!answers[q.questionId]);
    if (answeredQs.length === 0) return;
    finishedRef.current = true;
    setShowAbortConfirm(false);
    setSubmitting(true);
    setPaused(false);
    localStorage.removeItem(`examDraft_${userId}`);
    try {
      const abortResults = answeredQs.map((q: Question) => {
        const userAns = answers[q.questionId] ?? [];
        const correctIdx: number[] = toIdxArr(q.correctAnswerIndices);
        const userOrigIdx = userAns.map((t: string) => q.choices.indexOf(t));
        const isCorrect = correctIdx.length > 0 && correctIdx.length === userOrigIdx.length && correctIdx.every((i: number) => userOrigIdx.includes(i));
        return { questionId: q.questionId, isCorrect, userAns };
      });
      await Promise.all(abortResults.map(r =>
        fetch(`${API_ENDPOINT}/sessions/${sessionId}/answers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, questionId: r.questionId, selectedAnswers: r.userAns, isCorrect: r.isCorrect, examType }),
        }).catch(() => {})
      ));
      const correctCount = abortResults.filter(r => r.isCorrect).length;
      const score = Math.round((correctCount / abortResults.length) * 100);
      const isPassed = score >= PASS_RATE[examType];
      await fetch(`${API_ENDPOINT}/sessions/${sessionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, status: 'completed', score, isPassed, examType, answeredCount: abortResults.length }),
      });
      const qMap = new Map(answeredQs.map((q: Question) => [q.questionId, q]));
      recordSessionDomainStats({
        examType, userId, results: abortResults,
        questionById: (qId) => qMap.get(qId) as any,
      });
      deleteCachedByPrefix(`ustats_${userId}`);
      window.dispatchEvent(new CustomEvent('qstatsRefresh'));
      localStorage.setItem(`postSessionRefresh_${userId}`, String(Date.now()));
      const ptsPerQAbort = EXAM_LEVEL[examType] === 'Foundational' ? 1 : EXAM_LEVEL[examType] === 'Associate' ? 2 : 3;
      const earnedPtsAbort = correctCount * ptsPerQAbort;
      if (userId && earnedPtsAbort > 0) addPoints(userId, earnedPtsAbort);
      const jstTodayAbort = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
      const dailyKeyAbort = `dailyQCount_${examType}_${userId}_${jstTodayAbort}`;
      const localPrevAbort = parseInt(localStorage.getItem(dailyKeyAbort) ?? '0', 10);
      const serverDailyAbort = await incrementDailyProgress(userId, examType, abortResults.length);
      const prevDailyAbort = serverDailyAbort != null ? serverDailyAbort - abortResults.length : localPrevAbort;
      const newDailyAbort = serverDailyAbort != null ? serverDailyAbort : localPrevAbort + abortResults.length;
      localStorage.setItem(dailyKeyAbort, String(newDailyAbort));
      const dailyGoalAbort = parseInt(localStorage.getItem(`dailyGoal_${userId}`) ?? '10', 10);
      const rewardKeyAbort = `dailyGoalReward_${examType}_${userId}_${jstTodayAbort}`;
      let dailyBonusPtsAbort = 0;
      if (serverDailyAbort != null && newDailyAbort >= dailyGoalAbort && prevDailyAbort < dailyGoalAbort && !localStorage.getItem(rewardKeyAbort) && userId !== 'guest') {
        localStorage.setItem(rewardKeyAbort, '1');
        dailyBonusPtsAbort = 10;
        addPoints(userId, dailyBonusPtsAbort);
      }
      localStorage.setItem(`sessionScoreAdd_${examType}_${userId}`, '1');
      navigate('/aws/result', {
        state: { results: abortResults.map(r => ({ questionId: r.questionId, isCorrect: r.isCorrect })), questions: answeredQs, score, isPassed, sessionId, userId, examType, mode: 'exam', aborted: true, earnedPts: earnedPtsAbort, dailyBonusPts: dailyBonusPtsAbort },
      });
    } catch (err) {
      console.error(err);
      alert(t('examSession.submitFailed'));
      finishedRef.current = false;
      setSubmitting(false);
    }
  };

  const handleSaveAndExit = () => {
    try {
      localStorage.setItem(`examDraft_${userId}`, JSON.stringify({
        sessionId, examType, questions, userId, isMini,
        currentIndex, answers, timeLeft: timeLeftRef.current, savedAt: Date.now(),
      }));
    } catch {}
    navigate('/aws/practice');
  };

  const handleFinish = async (timeUp = false) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    setSubmitting(true);
    setPaused(false);
    localStorage.removeItem(`examDraft_${userId}`);

    try {
      const results = questions.map((q: Question) => {
        const userAns = answers[q.questionId] ?? [];
        const correctIdx: number[] = toIdxArr(q.correctAnswerIndices);
        const userOrigIdx = userAns.map(t => q.choices.indexOf(t));
        const isCorrect = correctIdx.length > 0 && correctIdx.length === userOrigIdx.length && correctIdx.every(i => userOrigIdx.includes(i));
        return { questionId: q.questionId, isCorrect, userAns };
      });

      await Promise.all(results.map(r =>
        fetch(`${API_ENDPOINT}/sessions/${sessionId}/answers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, questionId: r.questionId, selectedAnswers: r.userAns, isCorrect: r.isCorrect, examType })
        }).catch(() => {})
      ));

      const correctCount = results.filter(r => r.isCorrect).length;
      const score = Math.round((correctCount / questions.length) * 100);
      const isPassed = score >= PASS_RATE[examType];

      await fetch(`${API_ENDPOINT}/sessions/${sessionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, status: 'completed', score, isPassed, examType, answeredCount: results.length })
      });

      // ドメイン別統計を記録（domain_history / domain_results / サーバー同期）
      const qMapFull = new Map(questions.map((q: Question) => [q.questionId, q]));
      recordSessionDomainStats({
        examType, userId, results,
        questionById: (qId) => qMapFull.get(qId) as any,
      });
      // セッション完了でキャッシュ破棄 → ホーム画面が最新データをサーバーから再取得
      deleteCachedByPrefix(`ustats_${userId}`);
      window.dispatchEvent(new CustomEvent('qstatsRefresh'));
      localStorage.setItem(`postSessionRefresh_${userId}`, String(Date.now()));
      const ptsPerQ = EXAM_LEVEL[examType] === 'Foundational' ? 1 : EXAM_LEVEL[examType] === 'Associate' ? 2 : 3;
      const earnedPts = correctCount * ptsPerQ;
      if (userId && earnedPts > 0) addPoints(userId, earnedPts);
      const jstToday = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
      const dailyKey = `dailyQCount_${examType}_${userId}_${jstToday}`;
      const localPrevDaily = parseInt(localStorage.getItem(dailyKey) ?? '0', 10);
      const serverDaily = await incrementDailyProgress(userId, examType, results.length);
      const prevDaily = serverDaily != null ? serverDaily - results.length : localPrevDaily;
      const newDaily = serverDaily != null ? serverDaily : localPrevDaily + results.length;
      localStorage.setItem(dailyKey, String(newDaily));
      const dailyGoal = parseInt(localStorage.getItem(`dailyGoal_${userId}`) ?? '10', 10);
      const rewardKey = `dailyGoalReward_${examType}_${userId}_${jstToday}`;
      let dailyBonusPts = 0;
      if (serverDaily != null && newDaily >= dailyGoal && prevDaily < dailyGoal && !localStorage.getItem(rewardKey) && userId !== 'guest') {
        localStorage.setItem(rewardKey, '1');
        dailyBonusPts = 10;
        addPoints(userId, dailyBonusPts);
      }
      localStorage.setItem(`sessionScoreAdd_${examType}_${userId}`, '1');
      navigate('/aws/result', {
        state: { results: results.map(r => ({ questionId: r.questionId, isCorrect: r.isCorrect })), questions, score, isPassed, sessionId, userId, examType, mode: 'exam', timeUp, earnedPts, dailyBonusPts }
      });
    } catch (err) {
      console.error(err);
      alert(t('examSession.submitFailed'));
      finishedRef.current = false;
      setSubmitting(false);
    }
  };

  const [reportOpen, setReportOpen] = useState(false);
  const [answerCountError, setAnswerCountError] = useState<string | null>(null);
  const [showAbortConfirm, setShowAbortConfirm] = useState(false);

  useEffect(() => {
    const anyOpen = paused || showConfirm || showAbortConfirm;
    if (!anyOpen) return;
    return lockBodyScroll();
  }, [paused, showConfirm, showAbortConfirm]);

  useEffect(() => {
    if (!state) navigate('/aws/exam/setup', { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── キーボード操作（Web版のみ）──
  // ↑↓←→: カーソル移動 / Enter: カーソルの選択肢を選択・トグル / Shift+Enter: 次へ（最終問題は採点へ）
  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandlerRef.current = (e: KeyboardEvent) => {
    if (isMobile || !currentQ) return;
    const el = e.target as HTMLElement | null;
    const tag = el?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
    if (paused || submitting || showConfirm || showAbortConfirm || reportOpen) return;
    if (document.body.dataset.pane === 'left') return; // 左ペイン操作中は抑止（←→はLayoutが処理）
    const total = shuffledIndices.length + 1; // +1 = わからない
    const scrollMain = (toBottom: boolean) => {
      const m = document.querySelector('main');
      const tgt = toBottom ? (m ? m.scrollHeight : document.body.scrollHeight) : 0;
      (m ?? window).scrollTo({ top: tgt, behavior: 'smooth' });
    };
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (cursorIndex >= total - 1) scrollMain(true);
      else setCursorIndex(c => Math.min(total - 1, c + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (cursorIndex <= 0) scrollMain(false);
      else setCursorIndex(c => Math.max(0, c - 1));
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      // 単一選択で未選択時はカーソルの選択肢を選んでから次へ（決定ステップ省略）
      if (selected.length === 0 && !currentQ.isMultiple && cursorIndex < shuffledIndices.length) {
        toggle(currentQ.choices[shuffledIndices[cursorIndex]]);
      }
      if (currentIndex < questions.length - 1) handleNext(); else setShowConfirm(true);
    } else if (e.key === 'Enter' && isKbMode()) {
      e.preventDefault();
      toggle(cursorIndex < shuffledIndices.length ? currentQ.choices[shuffledIndices[cursorIndex]] : WAKARANAI);
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyHandlerRef.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  if (!state) return null;

  const answeredCount = Object.keys(answers).length;
  const unansweredCount = questions.length - answeredCount;
  const timerRed = timeLeft < 300; // 5分以下で赤

  if (submitting) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '60vh', gap: 16 }}>
        <div className="sherpa-spinner" style={{ width: 36, height: 36, borderWidth: 3 }} />
        <div style={{ fontSize: 'var(--font-size-h3)', color: 'var(--color-text-sub)' }}>{t('examSession.scoring')}</div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: 'var(--spacing-xl) var(--spacing-lg)', paddingBottom: isMobile ? 120 : undefined }} className="session-container">

      {/* 一時停止オーバーレイ */}
      {paused && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,28,36,0.8)', zIndex: 1000,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 'var(--spacing-xl)', padding: 'var(--spacing-lg)' }}>
          <div style={{ fontSize: 'var(--font-size-xxl)', color: 'white', fontWeight: 700 }}>{t('examSession.pausedTitle')}</div>
          <div style={{ fontSize: 'var(--font-size-base)', color: 'rgba(255,255,255,0.7)', textAlign: 'center' }}>{t('examSession.pausedNote')}</div>
          <Button variant="primary" size="lg" onClick={() => setPaused(false)}>
            {t('examSession.resume')}
          </Button>
        </div>
      )}

      {/* 確認ダイアログ */}
      {showConfirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--spacing-md)' }}>
          <Card title={t('examSession.confirmTitle')} style={{ maxWidth: 420, width: '100%', boxShadow: 'var(--box-shadow-md)' }} padding="var(--spacing-xl)">
            <div style={{ fontSize: 'var(--font-size-base)', color: 'var(--color-text-sub)', marginBottom: 'var(--spacing-xl)', lineHeight: 1.6, textAlign: 'center' }}>
              {t('examSession.answered')}: <strong>{answeredCount}</strong> / {questions.length} {lang === 'ja' ? '問' : 'Q'}<br />
              {t('examSession.unanswered')}: <strong style={{ color: unansweredCount > 0 ? 'var(--color-danger)' : 'var(--color-success)' }}>{unansweredCount}</strong> {lang === 'ja' ? '問' : 'Q'}<br />
              {flaggedIds.size > 0 && (<>{lang === 'ja' ? 'あとで確認' : 'Flagged'}: <strong style={{ color: 'var(--color-accent)' }}>{flaggedIds.size}</strong> {lang === 'ja' ? '問' : 'Q'}<br /></>)}
              <br />
              {t('examSession.confirmQ')}
            </div>
            <div style={{ display: 'flex', gap: 'var(--spacing-md)', justifyContent: 'center' }}>
              <Button variant="outline" onClick={() => setShowConfirm(false)}>
                {t('examSession.cancel')}
              </Button>
              <Button variant="primary" onClick={() => { setShowConfirm(false); handleFinish(); }}>
                {t('examSession.submit')}
              </Button>
            </div>
          </Card>
        </div>
      )}

      {/* 中断して採点 確認ダイアログ */}
      {showAbortConfirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--spacing-md)' }}>
          <Card style={{ maxWidth: 420, width: '100%', boxShadow: 'var(--box-shadow-md)' }} padding="var(--spacing-xl)">
            <div style={{ fontWeight: 700, fontSize: 'var(--font-size-md)', marginBottom: 12, color: 'var(--color-text-main)' }}>
              {lang === 'ja' ? '中断して採点' : 'Interrupt & Grade'}
            </div>
            <div style={{ fontSize: 'var(--font-size-base)', color: 'var(--color-text-sub)', marginBottom: 'var(--spacing-xl)', lineHeight: 1.7 }}>
              {lang === 'ja' ? (
                <>{answeredCount}問の回答を採点します。<br />未回答の{unansweredCount}問は集計されません。</>
              ) : (
                <>{answeredCount} answered question{answeredCount !== 1 ? 's' : ''} will be graded.<br />The remaining {unansweredCount} will not be counted.</>
              )}
            </div>
            <div style={{ display: 'flex', gap: 'var(--spacing-md)', justifyContent: 'flex-end' }}>
              <Button variant="outline" onClick={() => setShowAbortConfirm(false)}>
                {lang === 'ja' ? 'キャンセル' : 'Cancel'}
              </Button>
              <Button variant="primary" onClick={handleAbortAndGrade}>
                {lang === 'ja' ? '採点する' : 'Grade Now'}
              </Button>
            </div>
          </Card>
        </div>
      )}

      {/* 進捗ノード（画面上部に固定） */}
      {(() => {
        const WINDOW = 5;
        const total = questions.length;
        const useWindow = total > WINDOW;
        const windowStart = useWindow
          ? Math.max(0, Math.min(currentIndex - Math.floor(WINDOW / 2), total - WINDOW))
          : 0;
        const visibleIndices = useWindow
          ? Array.from({ length: WINDOW }, (_, k) => windowStart + k)
          : Array.from({ length: total }, (_, k) => k);
        return (
          <div style={{ position: 'fixed', top: 56, left: 0, right: 0, zIndex: 190, background: 'var(--color-bg-white)', borderBottom: '1px solid var(--color-border)', padding: '15px 16px 8px', display: 'flex', alignItems: 'center', gap: 0 }}>
            <div style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
              {visibleIndices.map((i, visIdx) => {
                const isAnswered = !!answers[questions[i]?.questionId];
                const isCurrent = i === currentIndex;
                const isHovered = hoveredNode === i;
                const isFlagged = flaggedIds.has(questions[i]?.questionId);
                return (
                  <React.Fragment key={i}>
                    <span style={{ position: 'relative', display: 'flex', flexShrink: 0 }}>
                      {isFlagged && (
                        <span style={{ position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)', marginBottom: 2, color: 'var(--color-accent)', lineHeight: 0 }}>
                          <IconFlag size={9} filled />
                        </span>
                      )}
                    <div
                      onClick={() => setCurrentIndex(i)}
                      onMouseEnter={() => setHoveredNode(i)}
                      onMouseLeave={() => setHoveredNode(null)}
                      title={`第${i + 1}問へ`}
                      style={{
                        width: isCurrent ? 12 : isHovered ? 9 : 7,
                        height: isCurrent ? 12 : isHovered ? 9 : 7,
                        borderRadius: '50%',
                        flexShrink: 0,
                        background: isAnswered || isCurrent ? 'var(--color-primary)' : 'transparent',
                        border: `2px solid ${isAnswered || isCurrent ? 'var(--color-primary)' : 'var(--color-text-light)'}`,
                        boxShadow: isCurrent
                          ? '0 0 0 2px var(--color-primary-light, rgba(82,130,255,0.25))'
                          : isHovered ? '0 0 0 3px var(--color-primary-light, rgba(82,130,255,0.35))' : 'none',
                        cursor: 'pointer',
                        transition: 'all 0.15s',
                        opacity: isAnswered && !isCurrent && !isHovered ? 0.75 : 1,
                      }}
                    />
                    </span>
                    {visIdx < visibleIndices.length - 1 && (
                      <div style={{ flex: 1, height: 2, background: isAnswered ? 'var(--color-primary)' : 'var(--color-text-light)', transition: 'background 0.2s' }} />
                    )}
                  </React.Fragment>
                );
              })}
            </div>
            {useWindow && (
              <span style={{ flexShrink: 0, marginLeft: 12, fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-text-light)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                {currentIndex + 1} / {total}
              </span>
            )}
          </div>
        );
      })()}
      {/* 固定ノードバーの高さ分のスペーサー */}
      <div style={{ height: 44 }} />

      {/* タイマーバー */}
      <Card padding="8px 16px" style={{ marginBottom: 'var(--spacing-lg)' }}>
        {/* 上段: ⏸ · タイマー+総時間 · ✓途中採点 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <button
            onClick={handleSaveAndExit}
            style={{ width: 32, height: 32, flexShrink: 0, borderRadius: '50%', border: '1px solid var(--color-border)', background: 'transparent', cursor: 'pointer', color: 'var(--color-text-sub)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            aria-label={lang === 'ja' ? '中断してホームへ' : 'Save & Home'}
          >
            <IconCirclePause size={16} />
          </button>
          <span className="exam-timer-time" style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 'var(--font-size-lg)', color: timerRed ? 'var(--color-danger)' : 'var(--color-text-main)', transition: 'color 1s', whiteSpace: 'nowrap', flexShrink: 0 }}>
            {formatTime(timeLeft)}
            <span style={{ fontWeight: 400, color: 'var(--color-text-light)', fontSize: 'var(--font-size-sm)' }}> / {formatTime(totalSec)}</span>
          </span>
          <div style={{ flex: 1 }} />
        </div>
        {/* 下段: 残り時間 棒グラフ */}
        <div style={{ height: 5, borderRadius: 3, background: 'var(--color-border)', overflow: 'hidden' }}>
          <div style={{
            height: '100%',
            width: `${Math.max(0, (timeLeft / totalSec) * 100)}%`,
            background: timerRed ? 'var(--color-danger)' : timeLeft < totalSec * 0.3 ? 'var(--color-warning, #f59e0b)' : 'var(--color-primary)',
            borderRadius: 3,
            transition: 'width 1s linear, background 1s',
          }} />
        </div>
      </Card>

      <Card padding="var(--spacing-xl)" style={{ marginBottom: 'var(--spacing-lg)' }}>
        {/* 問題 */}
        <div style={{ marginBottom: 'var(--spacing-xl)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--spacing-sm)', marginBottom: 'var(--spacing-md)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)', minWidth: 0 }}>
              {/* あとで確認フラグ（模試特有・問題左上） */}
              <button
                onClick={() => toggleFlag(currentQ.questionId)}
                title={flaggedIds.has(currentQ.questionId)
                  ? (lang === 'ja' ? 'あとで確認のフラグを外す' : 'Remove review flag')
                  : (lang === 'ja' ? 'あとで見直す問題としてフラグを立てる（模試のみ・提出前に一覧から戻れます）' : 'Flag this question for later review (exam only)')}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0,
                  padding: '4px 12px 4px 10px', borderRadius: 'var(--border-radius-md)', cursor: 'pointer',
                  border: `1px solid ${flaggedIds.has(currentQ.questionId) ? 'var(--color-accent)' : 'var(--color-border)'}`,
                  background: flaggedIds.has(currentQ.questionId) ? 'color-mix(in srgb, var(--color-accent) 12%, transparent)' : 'transparent',
                  color: flaggedIds.has(currentQ.questionId) ? 'var(--color-accent)' : 'var(--color-text-sub)',
                  fontSize: 'var(--font-size-xs)', fontWeight: 700, transition: 'all 0.15s',
                }}
              >
                <IconFlag size={13} filled={flaggedIds.has(currentQ.questionId)} />
                <span>{lang === 'ja' ? 'あとで確認' : 'Review later'}</span>
              </button>
              {currentQ.isMultiple && (
                <Badge variant="outline">
                  {t('examSession.multiple')}{currentQ.correctAnswerCount ? ` (${currentQ.correctAnswerCount})` : ''}
                </Badge>
              )}
            </div>
            {user && (
              <button
                onClick={() => toggleBookmark(currentQ.questionId)}
                title={bookmarkedIds.has(currentQ.questionId) ? t('examSession.removeBookmark') : t('examSession.bookmark')}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px', display: 'flex', alignItems: 'center', flexShrink: 0 }}
              >
                <span style={{ color: bookmarkedIds.has(currentQ.questionId) ? 'var(--color-warning, #f59e0b)' : 'var(--color-text-light)' }}>
                  <IconStar filled={bookmarkedIds.has(currentQ.questionId)} size={20} />
                </span>
              </button>
            )}
          </div>
          {currentQ.scheduledDeletionDate && (
            <div style={{ background: '#FFF4E5', border: '1px solid #F5A623', borderRadius: 'var(--border-radius-md)', padding: '8px 12px', marginBottom: 'var(--spacing-sm)', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <span style={{ flexShrink: 0, fontSize: 'var(--font-size-base)', lineHeight: 1.6 }}>⚠️</span>
              <span style={{ fontSize: 'var(--font-size-xs)', color: '#8A5A00', lineHeight: 1.6, overflowWrap: 'break-word', wordBreak: 'break-word' }}>
                この問題は{currentQ.scheduledDeletionDate}に削除されます（理由: {currentQ.scheduledDeletionReason}）。
              </span>
            </div>
          )}
          <p style={{ fontSize: 'var(--font-size-lg)', lineHeight: 1.6, fontWeight: 400, margin: 0, color: 'var(--color-text-main)', overflowWrap: 'break-word', wordBreak: 'break-word', minWidth: 0, whiteSpace: 'pre-wrap' }}>
            {qText(currentQ as any, lang)}
          </p>
        </div>

        <div style={{ marginBottom: 'var(--spacing-xl)' }}>
          {shuffledIndices.map((ci: number, displayIdx: number) => {
            const origChoice = currentQ.choices[ci];
            const choice = qChoiceAt(currentQ as any, lang, ci);
            const isSelected = selected.includes(origChoice);
            const isCursor = !isMobile && kbMode && rightActive && displayIdx === cursorIndex;
            return (
              <button
                key={origChoice}
                ref={isCursor ? cursorElRef : undefined}
                onClick={() => toggle(origChoice)}
                className={lastSelected === origChoice && selected.includes(origChoice) ? 'choice-select-anim' : ''}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: 'var(--spacing-md) var(--spacing-lg)', marginBottom: 'var(--spacing-sm)', borderRadius: 'var(--border-radius-md)',
                  border: `1px solid ${isSelected ? 'var(--color-primary)' : 'var(--color-border)'}`,
                  background: isSelected ? 'var(--color-primary-light)' : 'var(--color-bg-elevated)',
                  boxShadow: isSelected ? '0 0 0 1px var(--color-primary)' : 'none',
                  outline: isCursor ? '2px solid var(--color-accent)' : undefined,
                  outlineOffset: isCursor ? 1 : undefined,
                  cursor: 'pointer', fontSize: 'var(--font-size-base)',
                  color: 'var(--color-text-main)',
                  transition: 'all 0.15s ease'
                }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  {currentQ.isMultiple ? (
                    <div style={{
                      width: 16, height: 16, borderRadius: 3, flexShrink: 0, marginTop: 3,
                      border: `2px solid ${isSelected ? 'var(--color-primary)' : 'var(--color-border)'}`,
                      background: isSelected ? 'var(--color-primary)' : 'transparent',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      pointerEvents: 'none',
                    }}>
                      {isSelected && <span style={{ color: 'white', fontSize: 'var(--font-size-2xs)', lineHeight: 1, fontWeight: 700 }}>✓</span>}
                    </div>
                  ) : (
                    <div style={{
                      width: 16, height: 16, borderRadius: '50%', flexShrink: 0, marginTop: 3,
                      border: `2px solid ${isSelected ? 'var(--color-primary)' : 'var(--color-border)'}`,
                      background: isSelected ? 'var(--color-primary)' : 'transparent',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      pointerEvents: 'none',
                    }}>
                      {isSelected && <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'white' }} />}
                    </div>
                  )}
                  <span style={{ flex: 1, minWidth: 0, overflowWrap: 'break-word', wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
                    <strong style={{ marginRight: 2 }}>{CHOICE_LABELS[displayIdx]}.</strong> {stripLabel(choice)}
                  </span>
                </div>
              </button>
            );
          })}
          {(() => {
            const wSelected = selected.includes(WAKARANAI);
            const wCursor = !isMobile && kbMode && rightActive && cursorIndex === shuffledIndices.length;
            return (
              <button
                ref={wCursor ? cursorElRef : undefined}
                onClick={() => toggle(WAKARANAI)}
                style={{
                  display: 'flex', alignItems: 'center', width: '100%', textAlign: 'left',
                  padding: 'var(--spacing-sm) var(--spacing-lg)', marginTop: 'var(--spacing-sm)', borderRadius: 'var(--border-radius-md)',
                  border: `1px ${wSelected ? 'solid' : 'dashed'}`,
                  borderColor: wSelected ? 'var(--color-text-sub)' : 'var(--color-border)',
                  background: wSelected ? 'var(--color-bg-main)' : 'transparent',
                  cursor: 'pointer', fontSize: 'var(--font-size-sm)',
                  color: 'var(--color-text-light)',
                  transition: 'all 0.15s ease',
                  ...((!isMobile && cursorIndex === shuffledIndices.length) ? { outline: '2px solid var(--color-accent)', outlineOffset: 1 } : {}),
                }}>
                <span style={{ marginRight: 10, fontSize: 'var(--font-size-sm)', flexShrink: 0 }}>？</span>
                <span>{WAKARANAI}</span>
              </button>
            );
          })()}
        </div>

        {/* 通報・途中採点（問題の下・演習系と統一） */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--spacing-sm)', marginBottom: 'var(--spacing-md)' }}>
          <button
            onClick={() => setReportOpen(true)}
            style={{ background: 'none', border: '1px solid var(--color-border)', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, color: 'var(--color-text-sub)', fontSize: 'var(--font-size-xs)', padding: '3px 10px', transition: 'all 0.2s' }}
            onMouseEnter={e => { e.currentTarget.style.color = 'var(--color-danger)'; e.currentTarget.style.borderColor = 'var(--color-danger)'; }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--color-text-sub)'; e.currentTarget.style.borderColor = 'var(--color-border)'; }}
            title={lang === 'ja' ? '問題の不備を通報' : 'Report an issue'}
          >
            <IconAlertTriangle size={13} />
            <span>{lang === 'ja' ? '通報' : 'Report'}</span>
          </button>
          <button
            onClick={() => answeredCount > 0 && setShowAbortConfirm(true)}
            disabled={answeredCount === 0}
            style={{ background: 'none', border: '1px solid var(--color-border)', borderRadius: 'var(--border-radius-md)', padding: '3px 10px', fontSize: 'var(--font-size-xs)', fontWeight: 600, cursor: answeredCount === 0 ? 'default' : 'pointer', color: 'var(--color-text-sub)', opacity: answeredCount === 0 ? 0.45 : 1, whiteSpace: 'nowrap', transition: 'all 0.15s', display: 'flex', alignItems: 'center', gap: 3 }}
          >
            <IconCheck size={11} />
            {lang === 'ja' ? '途中採点' : 'Grade'}
          </button>
        </div>

        {/* メタデータ */}
        <div style={{ paddingTop: 'var(--spacing-sm)', borderTop: '1px dashed var(--color-border)', display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-lg)', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)' }}>
          <span>
            {lang === 'ja' ? 'AI確認' : 'AI review'}:{' '}
            {currentQ.validityCheckedAt
              ? <strong style={{ color: 'var(--color-success)' }}>✓ {new Date(currentQ.validityCheckedAt).toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' })}</strong>
              : <strong>{lang === 'ja' ? '未確認' : 'not reviewed'}</strong>
            }
          </span>
          <span>
            {lang === 'ja' ? '最終編集' : 'Last edited'}:{' '}
            <strong style={{ color: (currentQ.updatedAt || currentQ.createdAt) ? 'var(--color-text-sub)' : 'inherit' }}>
              {(currentQ.updatedAt || currentQ.createdAt)
                ? new Date((currentQ.updatedAt || currentQ.createdAt)!).toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' })
                : '-'}
            </strong>
          </span>
        </div>
      </Card>

      {/* ナビゲーションパネル */}
      <Card padding="var(--spacing-lg)">
        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-sub)', marginBottom: 'var(--spacing-lg)', display: 'flex', gap: 'var(--spacing-lg)', fontWeight: 700 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 12, height: 12, background: 'var(--color-primary-light)', borderRadius: 6, border: '2px solid var(--color-primary)' }} />{t('examSession.current')}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 12, height: 12, background: 'var(--color-text-sub)', borderRadius: 6 }} />{t('examSession.answeredLegend')}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 12, height: 12, background: 'var(--color-bg-elevated)', borderRadius: 6, border: '1px solid var(--color-text-sub)' }} />{t('examSession.unansweredLegend')}
          </span>
        </div>
        <div style={{ maxHeight: 176, overflowY: 'auto', marginBottom: 'var(--spacing-lg)' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-sm)' }}>
          {questions.map((_: any, i: number) => {
            const isCurrent = i === currentIndex;
            const isAnswered = !!answers[questions[i]?.questionId];
            const isFlagged = flaggedIds.has(questions[i]?.questionId);
            let bg = 'var(--color-bg-elevated)';
            let color = 'var(--color-text-sub)';
            let border = '1px solid var(--color-text-sub)';

            if (isCurrent) {
              bg = 'var(--color-primary-light)';
              color = 'var(--color-primary)';
              border = '2px solid var(--color-primary)';
            } else if (isAnswered) {
              bg = 'var(--color-text-sub)';
              color = 'white';
              border = '1px solid var(--color-text-sub)';
            }

            return (
              <button key={i} onClick={() => setCurrentIndex(i)}
                style={{ position: 'relative', width: 32, height: 32, borderRadius: 'var(--border-radius-full)', border,
                  background: bg, color,
                  cursor: 'pointer', fontSize: 'var(--font-size-sm)', fontWeight: isCurrent ? 700 : 400, transition: 'all 0.2s' }}>
                {i + 1}
                {isFlagged && (
                  <span style={{ position: 'absolute', top: -4, right: -4, color: 'var(--color-accent)', background: 'var(--color-bg-white)', borderRadius: '50%', display: 'flex', padding: 1, lineHeight: 0 }}>
                    <IconFlag size={11} filled />
                  </span>
                )}
              </button>
            );
          })}
          </div>
        </div>
        {answerCountError && (
          <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 'var(--spacing-sm)' }}>
            <span style={{ color: 'var(--color-danger)', fontSize: 'var(--font-size-sm)' }}>{answerCountError}</span>
          </div>
        )}
      </Card>

      {createPortal(
        isMobile ? (
          <div style={{ position: 'fixed', bottom: 56, left: 0, right: 0, zIndex: 150, padding: 'var(--spacing-sm) var(--spacing-md)', display: 'flex', gap: 'var(--spacing-sm)', background: 'var(--color-bg-white)', borderTop: '1px solid var(--color-border)', boxShadow: 'var(--box-shadow-up)' }}>
            <button
              disabled={currentIndex === questions.length - 1}
              onClick={handleNext}
              style={{ flex: 1, height: 44, border: 'none', borderRadius: 22, background: currentIndex === questions.length - 1 ? 'var(--color-bg-main)' : 'var(--color-accent)', color: currentIndex === questions.length - 1 ? 'var(--color-text-light)' : 'var(--color-btn-primary-text)', fontWeight: 600, fontSize: 'var(--font-size-base)', cursor: currentIndex === questions.length - 1 ? 'default' : 'pointer' }}
            >
              {lang === 'ja' ? '次の問題へ' : 'Next'}
            </button>
            {unansweredCount === 0 && (
              <button
                onClick={() => setShowConfirm(true)}
                style={{ width: 44, height: 44, flexShrink: 0, border: '1.5px solid var(--color-success)', borderRadius: '50%', background: 'var(--color-bg-white)', color: 'var(--color-success)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                aria-label={t('examSession.submit')}
              >
                <IconCircleCheck size={22} />
              </button>
            )}
          </div>
        ) : (
          <div style={{ position: 'fixed', right: 24, bottom: 24, zIndex: 150 }}>
            <button
              onClick={() => setShowConfirm(true)}
              style={{ height: 44, padding: '0 24px', border: 'none', borderRadius: 22, background: 'var(--color-accent)', color: 'var(--color-btn-primary-text)', fontWeight: 600, fontSize: 'var(--font-size-base)', cursor: 'pointer', whiteSpace: 'nowrap', boxShadow: 'var(--box-shadow-pop)', display: 'inline-flex', alignItems: 'center', gap: 8 }}
            >
              {t('examSession.submit')}
              <KeyHint />
            </button>
          </div>
        ),
        document.body
      )}

      {reportOpen && (
        <ReportModal
          questionId={currentQ.questionId}
          userId={userId}
          lang={lang}
          onClose={() => setReportOpen(false)}
        />
      )}
    </div>
  );
}
