'use client';
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation } from '@/compat/react-router-dom';
import { API_ENDPOINT, PASS_RATE, EXAM_DOMAINS, DOMAIN_NAME_EN, EXAM_LEVEL, EXAM_LEVEL_COLORS, qDomainName, isNonAwsExam, companionLabel } from '../constants';
import { recordSessionDomainStats, recentForTag } from '../utils/domainStats';
import { qText } from '../utils/i18nQuestion';
import { getCached, setCached, deleteCached, deleteCachedByPrefix, DEFAULT_TTL } from '../utils/cache';
import { addPoints } from '../utils/points';
import { incrementDailyProgress } from '../utils/dailyProgress';
import { lockBodyScroll } from '../utils/bodyScrollLock';
import { schedulePrefetchAfterSession } from '../utils/questionPrefetch';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import ReportModal from '../components/ReportModal';
import { ConfirmBurst } from '../components/ExamSelectOverlay';
import { IconBookOpen, IconBean, IconCopy, IconCheck, IconCircleCheck, IconCircleX, IconHeart, IconThumbsUp, IconThumbsDown, IconMoreVertical, IconInfinity } from '../components/Icons';
import KeyHint from '../components/KeyHint';
import { isKbMode } from '../utils/keyboardMode';

type Tip = { tipId: string; title: string; content: string; examType: string };

const WAKARANAI = 'わからない';
// ♡(ブックマーク)ONの色。ポップな変化を出すためピンク。
const HEART_ACTIVE_COLOR = '#ec4899';
// 👍👎の色。「しっかり対策」開始ボタンと同じ青緑で揃える。
const REACTION_ACTIVE_COLOR = 'var(--color-points)';
// DBによっては correctAnswers に "B. テキスト" のようなラベル接頭辞が付いている場合がある
const stripLabel = (s: string) => s.replace(/^[A-E]\.\s*/, '');

type Question = {
  questionId: string;
  examType: string;
  questionText: string;
  choices: string[];
  correctAnswers?: string[];
  correctAnswerIndices?: number[];
  choiceExplanations?: string[];
  explanation?: string;
  domain?: number;
  isMultiple: boolean;
  correctAnswerCount?: number;
  validityCheckedAt?: string;
  updatedAt?: string;
  createdAt?: string;
  globalAttempts?: number;
  globalCorrect?: number;
  scheduledDeletionReason?: string;
  scheduledDeletionDate?: string;
};

// correctAnswerIndices が稀に単一回答問題でスカラー値（数値）として保存されていることがあり、
// .includes / .every を呼ぶとクラッシュする。必ず数値配列に正規化する。
const toIdxArr = (v: any): number[] => Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]);

// 解説下のアクション列で使う丸アイコンボタン（コピーボタンと同じ 28px の枠に合わせる）。
// 輪郭は付けず、アイコン色は状態によらず灰色で統一する。押した状態は
// アイコン自体の塗り(filled)で示す（IconHeart等のfilledプロパティ側で対応）。
const IconActionButton = ({ onClick, disabled, active, activeColor, title, children }: {
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; disabled?: boolean; active?: boolean; activeColor?: string; title: string; children: React.ReactNode;
}) => {
  // OFF→ONになった瞬間だけポップ演出（ON→OFFの解除時は再生しない）。
  const [popping, setPopping] = useState(false);
  const wasActiveRef = useRef(active);
  useEffect(() => {
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = active;
    if (active && !wasActive) {
      setPopping(true);
      const t = setTimeout(() => setPopping(false), 400);
      return () => clearTimeout(t);
    }
  }, [active]);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={active}
      style={{
        background: 'none', border: 'none',
        borderRadius: '50%', width: 28, height: 28,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: disabled ? 'default' : 'pointer',
        color: active && activeColor ? activeColor : 'var(--color-text-sub)',
        opacity: disabled ? 0.4 : 1, transition: 'opacity 0.2s, color 0.2s', flexShrink: 0, padding: 0,
        animation: popping ? 'actionIconPop 0.4s ease' : 'none',
      }}
    >
      {children}
    </button>
  );
};

const CopyButton = ({ getText }: { getText: () => string }) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(getText()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  // 他のアクション列ボタン([♡][👍][👎][⋮])と同じく枠線なし・灰色統一。
  // コピー済みの一瞬だけは成功が分かるよう色を変える。
  const color = copied ? 'var(--color-success)' : 'var(--color-text-sub)';
  return (
    <button
      onClick={handleCopy}
      title={copied ? 'コピー済み' : 'コピー'}
      style={{
        background: 'none', border: 'none', borderRadius: '50%',
        width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer', color, transition: 'color 0.2s', flexShrink: 0, padding: 0,
      }}
    >
      {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
    </button>
  );
};

// いま進行中の演習ドラフトを指すポインタ（種別込み）。
// リロードで navigate の state が失われても、どの種別の演習を開いていたかを復元できる。
const ACTIVE_DRAFT_POINTER = 'activeExerciseDraft';

export default function ExerciseSession() {
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as any;
  const { user } = useAuth();
  const { lang, t } = useLanguage();

  // リロードで compat レイヤーが初期 state を復活させると進捗が巻き戻るため、
  // state がある場合でも同一セッションのドラフトがより多くの進捗を持てば初期値に反映する。
  // （useState 初期化時に確定させ、保存useEffectによる上書きより前に効かせる）
  const _resumeInit = useMemo(() => {
    let idx: number = state?.resumeIndex ?? 0;
    let res: { questionId: string; isCorrect: boolean }[] = state?.resumeResults ?? [];
    let ans: boolean = state?.resumeAnswered ?? false;
    let sel: string[] = state?.resumeSelectedAnswers ?? [];
    let hist: Record<number, string[]> = state?.resumeSelectionHistory ?? {};
    let qk: boolean = state?.isQuick ?? false;
    let fc: boolean = state?.isFocused ?? false;
    let mn: boolean = state?.isMini ?? false;
    let qs: Question[] | null = null;
    let qids: string[] | null = null;
    let spares: string[] | null = null;
    let orders: Record<string, number[]> = {};
    if (state?.sessionId) {
      try {
        let best: any = null;
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (!key) continue;
          if (key.startsWith('practiceExerciseDraft_') || key.startsWith('quickExerciseDraft_') || key.startsWith('focusedExerciseDraft_')) {
            try {
              const p = JSON.parse(localStorage.getItem(key) ?? '');
              if (p.questions?.length > 0 && p.sessionId === state.sessionId && (!best || (p.savedAt ?? 0) > (best.savedAt ?? 0))) best = p;
            } catch {}
          }
        }
        // 進捗が同数のときも反映する（>= にしている）。
        // navigate の state は回答済みフラグや選択中の選択肢まで運ばないことがあり、
        // 「results は同じだが answered/selectedAnswers だけ落ちる」＝回答済みの問題が
        // 未回答に見える状態になるため、同数ならドラフト側を採用する。
        if (best && (best.results?.length ?? 0) >= (res?.length ?? 0)) {
          idx = best.currentIndex ?? 0;
          res = best.results ?? [];
          ans = best.answered ?? false;
          sel = best.selectedAnswers ?? [];
          if (best.selectionHistory && typeof best.selectionHistory === 'object') hist = best.selectionHistory;
          if (best.questions?.length) qs = best.questions;
        }
        // 出題予定ID・予備IDは進捗の多寡に関わらずドラフトから補完する。
        // 再開navigateのstateにquestionIdsが含まれない場合でも、これが無いと
        // totalCountがロード済み問題数まで縮み、設定した問題数を満たせなくなる。
        if (best) {
          // 演習種別もドラフトから補完する。呼び出し側が isFocused を渡し忘れると
          // しっかり対策の再開なのにサクッと演習として扱われるため、
          // 進捗と同じくドラフトを正とする。
          if (typeof best.isQuick === 'boolean') qk = best.isQuick;
          if (typeof best.isFocused === 'boolean') fc = best.isFocused;
          if (typeof best.isMini === 'boolean') mn = best.isMini;
          if (best.questionIds?.length) qids = best.questionIds;
          if (best.spareIds?.length) spares = best.spareIds;
          // 選択肢の並び順（同一セッション内で固定）を復元する
          if (best.choiceOrders && typeof best.choiceOrders === 'object') orders = best.choiceOrders;
        }
      } catch {}
    }
    return { idx, res, ans, sel, hist, qk, fc, mn, qs, qids, spares, orders };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [sessionId, setSessionId] = useState<string>(state?.sessionId ?? '');
  // セッション作成を開始ボタンのクリティカルパスから外す（item1: 楽観的遷移）。
  // sessionId が未確定でも 1 問目を即表示し、作成完了を待つ Promise を ref に保持する。
  const sessionPromiseRef = useRef<Promise<string> | null>(null);
  const sessionCreateStartedRef = useRef(false);
  useEffect(() => {
    if (sessionId) return;
    const cs = state?.createSession;
    if (!cs || sessionCreateStartedRef.current) return;
    sessionCreateStartedRef.current = true;
    sessionPromiseRef.current = fetch(`${API_ENDPOINT}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: cs.userId, mode: cs.mode ?? 'exercise', examType: cs.examType,
        questionIds: cs.questionIds,
        ...(cs.isFocused ? { isFocused: true } : {}),
        ...(cs.isMini ? { isMini: true } : {}),
      }),
    }).then(r => r.json())
      .then(d => { setSessionId(d.sessionId ?? ''); return d.sessionId ?? ''; })
      .catch(err => { console.error('[session] create failed', err); return ''; });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // sessionId が確定するまで待つ（回答送信・完了処理で使用）
  const ensureSessionId = useCallback(async (): Promise<string> => {
    if (sessionId) return sessionId;
    if (sessionPromiseRef.current) return (await sessionPromiseRef.current) || '';
    return '';
  }, [sessionId]);
  const [questions, setQuestions] = useState<Question[]>(_resumeInit.qs ?? state?.questions ?? []);
  // プログレッシブロード用: 出題予定IDリスト（presentIds）。読み込めないIDが出たら
  // 予備ID(spare)で補填し、設定問題数を必ず満たす。useState でhook登録しTDZを回避。
  const [presentIds, setPresentIds] = useState<string[]>(state?.questionIds ?? _resumeInit.qids ?? []);
  const allQuestionIds = presentIds; // 後方互換の別名（totalや先読みの基準）
  const spareIdsRef = React.useRef<string[]>([...(state?.spareQuestionIds ?? _resumeInit.spares ?? [])]);
  // 選択肢の並び順（questionId → origIndices）。初回シャッフル時に記録し、ドラフトへ永続化する。
  // 同一セッション内は固定（再開しても同順）、次セッションでは空から再シャッフル。
  const savedOrdersRef = useRef<Record<string, number[]>>(_resumeInit.orders ?? {});
  const attemptedIdsRef = React.useRef<Set<string>>(new Set()); // 取得を試みたID（欠落の再取得・重複を防ぐ）
  const loadingNextRef = React.useRef(false);
  const [userId, setUserId] = useState<string>(state?.userId ?? '');
  const [examType, setExamType] = useState<string>(state?.examType ?? '');
  const [isQuick, setIsQuick] = useState<boolean>(_resumeInit.qk);
  const [isFocused, setIsFocused] = useState<boolean>(_resumeInit.fc);
  const [isMini, setIsMini] = useState<boolean>(_resumeInit.mn);
  // 消去法機能の有効/無効（デフォルト OFF。明示的に true のときのみ有効）
  const strikeEnabled = (() => {
    if (typeof state?.strikeEnabled === 'boolean') return state.strikeEnabled;
    const uid = state?.userId;
    if (!uid) return false;
    const key = (state?.isFocused) ? `focusedExercisePrefs_${uid}` : (state?.isQuick) ? `quickExercisePrefs_${uid}` : null;
    if (!key) return false;
    try { return JSON.parse(localStorage.getItem(key) ?? '{}').strikeEnabled === true; } catch { return false; }
  })();
  // コラム非表示フラグ（state に明示値があれば優先、なければ prefs から読む）
  const hideColumn = (() => {
    if (state?.hideColumn === true) return true;
    const uid = state?.userId;
    if (!uid) return false;
    const key = (state?.isFocused) ? `focusedExercisePrefs_${uid}` : (state?.isQuick) ? `quickExercisePrefs_${uid}` : null;
    if (!key) return false;
    try { return JSON.parse(localStorage.getItem(key) ?? '{}').hideColumn === true; } catch { return false; }
  })();
  const [initialized, setInitialized] = useState<boolean>(!!state);

  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  // currentIndex は下の useEffect の依存配列で使うため先に宣言（TDZ 回避）
  const [currentIndex, setCurrentIndex] = useState<number>(_resumeInit.idx);

  // プログレッシブロード（自己修復型）: 現在問 + 2問先までを先読みし、
  // 取得できないID（削除済み等）は presentIds から外して予備IDで補填する。
  // これにより設定問題数を必ず満たす。1問目は呼び出し元で取得済みなのでロード時間は不変。
  useEffect(() => {
    if (presentIds.length === 0) return;
    const want = Math.min(currentIndex + 3, presentIds.length); // ここまでロードしておきたい件数
    if (questions.length >= want) return;
    if (loadingNextRef.current) return;
    const loaded = new Set(questions.map(q => q.questionId));
    // まだ読み込んでおらず・取得試行もしていない presentIds を順に対象化
    const queue = presentIds.filter(id => !loaded.has(id) && !attemptedIdsRef.current.has(id));
    if (queue.length === 0) return;
    const need = Math.max(1, want - questions.length);
    const batch = queue.slice(0, need);
    batch.forEach(id => attemptedIdsRef.current.add(id));
    loadingNextRef.current = true;
    fetch(`${API_ENDPOINT}/questions?ids=${batch.join(',')}&withAnswers=true`)
      .then(r => r.json())
      .then(d => {
        const items: Question[] = d.items ?? [];
        if (items.length) {
          setQuestions(prev => {
            const have = new Set(prev.map(q => q.questionId));
            return [...prev, ...items.filter(i => !have.has(i.questionId))];
          });
        }
        // 取得できなかったID = 削除済み等。presentIds から除外し、予備IDで同数を補填。
        const got = new Set(items.map(i => i.questionId));
        const missing = batch.filter(id => !got.has(id));
        if (missing.length) {
          setPresentIds(prev => {
            const next = prev.filter(id => !missing.includes(id));
            const repl = spareIdsRef.current.splice(0, missing.length);
            return [...next, ...repl];
          });
        }
      })
      .catch(() => {
        // ネットワーク失敗時は取得試行済みマークを取り消し、後続の再試行で再取得できるようにする
        // （取り消さないと該当IDが永久に読み込まれず、設定問題数に到達できなくなる）
        batch.forEach(id => attemptedIdsRef.current.delete(id));
        // 状態変化が無いとロード効果が再発火しないため、少し待ってから再試行をトリガーする
        setTimeout(() => setPresentIds(prev => [...prev]), 1500);
      })
      .finally(() => { loadingNextRef.current = false; });
  }, [currentIndex, questions.length, presentIds]); // eslint-disable-line react-hooks/exhaustive-deps
  // 到達済みの最前線は「今いる位置」と「回答済み数」の大きい方。
  // 前の問題を見返している最中に中断・再開すると currentIndex が戻っているため、
  // それだけで復元すると回答済みの先の問題へ移動できなくなる。
  const [viewedFrontier, setViewedFrontier] = useState<number>(Math.max(_resumeInit.idx, _resumeInit.res.length));
  const [selectedAnswers, setSelectedAnswers] = useState<string[]>(_resumeInit.sel);
  const [answered, setAnswered] = useState<boolean>(_resumeInit.ans);
  const [detail, setDetail] = useState<Question | null>(null);
  const [detailFetchFailed, setDetailFetchFailed] = useState(false);
  const [tips, setTips] = useState<Tip[]>([]);
  const [bookmarkedIds, setBookmarkedIds] = useState<Set<string>>(new Set());
  // questionId -> 'up' | 'down'（自分が押したものだけ。合計数はユーザーに見せない）
  const [reactions, setReactions] = useState<Record<string, 'up' | 'down'>>({});
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const actionMenuRef = useRef<HTMLDivElement>(null);
  const [heartBurst, setHeartBurst] = useState<{ x: number; y: number } | null>(null);
  // ⋮ メニューは外側クリック・問題の切り替えで閉じる
  useEffect(() => {
    if (!actionMenuOpen) return;
    const h = (e: MouseEvent) => {
      if (actionMenuRef.current && !actionMenuRef.current.contains(e.target as Node)) setActionMenuOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [actionMenuOpen]);
  useEffect(() => { setActionMenuOpen(false); }, [currentIndex]);

  useEffect(() => {
    fetch(`${API_ENDPOINT}/tips?examType=${examType}`)
      .then(r => r.json())
      .then(d => setTips(d.items ?? []))
      .catch(() => {});
  }, [examType]);

  const [currentTip, setCurrentTip] = useState<Tip | null>(null);

  useEffect(() => {
    if (tips.length === 0) return;
    setCurrentTip(tips[Math.floor(Math.random() * tips.length)]);
  }, [currentIndex, tips]);

  useEffect(() => {
    document.querySelector('main')?.scrollTo({ top: 0 });
    setViewedFrontier(prev => Math.max(prev, currentIndex));
    setStruckChoices(new Set());
  }, [currentIndex]);

  // correctAnswers が事前ロードされていない場合のフォールバックフェッチ + 正解判定の補正
  useEffect(() => {
    const q = questions[currentIndex];
    if (!answered || !q || q.correctAnswers) return;
    fetch(`${API_ENDPOINT}/questions/${q.questionId}`)
      .then(r => r.json())
      .then(d => {
        setDetail(d);
        const correctIdx: number[] = toIdxArr(d.correctAnswerIndices);
        const selOrigIdx = selectedAnswers.map(t => { const si = shuffledChoices.indexOf(t); return si >= 0 ? origIndices[si] : -1; });
        const isCorrect = correctIdx.length > 0 && correctIdx.length === selOrigIdx.length && correctIdx.every(i => selOrigIdx.includes(i));
        setResults(prev => {
          const next = [...prev];
          if (next.length > 0) next[next.length - 1] = { questionId: q.questionId, isCorrect };
          return next;
        });
      })
      .catch(() => { setDetailFetchFailed(true); });
  }, [answered, currentIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!userId) return;
    fetch(`${API_ENDPOINT}/users/me/bookmarks?userId=${userId}`)
      .then(r => r.json())
      .then(d => setBookmarkedIds(new Set(d.questionIds ?? [])))
      .catch(() => {});
  }, [userId]);

  // 自分が押した👍👎を復元する（合計数は取得しない＝ユーザーには見せない方針）。
  useEffect(() => {
    if (!userId) return;
    fetch(`${API_ENDPOINT}/users/me/question-status?userId=${userId}&examType=${examType}`)
      .then(r => r.json())
      .then(d => setReactions(d.reactions ?? {}))
      .catch(() => {});
  }, [userId, examType]);

  // ♡/👍👎は連打のたびに送信せず、UIだけ即時反映して実際の送信は
  // ①この問題の回答確定(スコアのコミット)時 ②次の問題へ移動する時
  // ③画面を離れる時 のいずれか最初のタイミングでまとめて行う。
  // 同じ問題を表示中に何度も押し直しても、最後に確定した値だけが1回送られる。
  const pendingBookmarkRef = useRef<Record<string, boolean>>({});
  const pendingReactionRef = useRef<Record<string, 'up' | 'down' | null>>({});
  const userIdRef = useRef(userId);
  useEffect(() => { userIdRef.current = userId; }, [userId]);

  const flushBookmark = useCallback((qid: string) => {
    const val = pendingBookmarkRef.current[qid];
    if (val === undefined) return;
    delete pendingBookmarkRef.current[qid];
    const uid = userIdRef.current;
    if (!uid) return;
    if (val) {
      fetch(`${API_ENDPOINT}/questions/${qid}/bookmark`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: uid }),
      }).catch(() => {});
    } else {
      fetch(`${API_ENDPOINT}/questions/${qid}/bookmark?userId=${uid}`, { method: 'DELETE' }).catch(() => {});
    }
  }, []);

  const flushReaction = useCallback((qid: string) => {
    const val = pendingReactionRef.current[qid];
    if (val === undefined) return;
    delete pendingReactionRef.current[qid];
    const uid = userIdRef.current;
    if (!uid) return;
    fetch(`${API_ENDPOINT}/questions/${qid}/reaction`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: uid, reaction: val }),
    }).catch(() => {});
  }, []);

  // 画面離脱（③）時に残っている保留分を送る
  useEffect(() => {
    return () => {
      Object.keys(pendingBookmarkRef.current).forEach(flushBookmark);
      Object.keys(pendingReactionRef.current).forEach(flushReaction);
    };
  }, [flushBookmark, flushReaction]);

  // 👍/👎。同じものを再度押すと取り消し（null）になる。1ユーザー1問1票。
  const toggleReaction = (next: 'up' | 'down') => {
    if (!userId) return;
    const qid = currentQuestion.questionId;
    const current = reactions[qid] ?? null;
    const value: 'up' | 'down' | null = current === next ? null : next;
    setReactions(prev => {
      const n = { ...prev };
      if (value === null) delete n[qid]; else n[qid] = value;
      return n;
    });
    pendingReactionRef.current[qid] = value;
  };

  const toggleBookmark = () => {
    if (!userId) return;
    const qid = currentQuestion.questionId;
    const next = !bookmarkedIds.has(qid);
    setBookmarkedIds(prev => { const n = new Set(prev); if (next) n.add(qid); else n.delete(qid); return n; });
    pendingBookmarkRef.current[qid] = next;
  };

  // 解説下（回答前は選択肢下）のアクション列 [コピー][♡][👍][👎][⋮]。
  // 回答前後で並び・位置を変えないよう、同じ関数で両方を描画する。
  // withActions=false のときはコピーのみ（回答後の「選択肢の下」用）。
  // ボタンの並び: [👍][👎][コピー][♡][⋮]
  const renderActionRow = (getCopyText: () => string, withActions: boolean) => (
    <div style={{ display: 'flex', justifyContent: 'flex-start', alignItems: 'center', gap: 'var(--spacing-sm)', marginTop: 'var(--spacing-md)' }}>
      {withActions && (
        <>
          {/* 👍👎 … ログイン専用。合計数は出さず、自分の選択状態のみ示す。
              色は「しっかり対策」開始ボタンと同じ青緑(var(--color-points))に揃える。 */}
          <IconActionButton
            onClick={() => toggleReaction('up')}
            disabled={!userId}
            active={reactions[currentQuestion.questionId] === 'up'}
            activeColor={REACTION_ACTIVE_COLOR}
            title={lang === 'ja' ? '参考になった' : 'Helpful'}
          >
            <IconThumbsUp filled={reactions[currentQuestion.questionId] === 'up'} size={15} />
          </IconActionButton>
          <IconActionButton
            onClick={() => toggleReaction('down')}
            disabled={!userId}
            active={reactions[currentQuestion.questionId] === 'down'}
            activeColor={REACTION_ACTIVE_COLOR}
            title={lang === 'ja' ? '分かりにくい' : 'Not helpful'}
          >
            <IconThumbsDown filled={reactions[currentQuestion.questionId] === 'down'} size={15} />
          </IconActionButton>
        </>
      )}
      <CopyButton getText={getCopyText} />
      {withActions && (
        <>
          {/* ♡ = ブックマーク（旧・見出し右の☆）。ログイン専用。
              ONにする瞬間だけピンクのパーティクルバースト(ConfirmBurstを流用)を出す。 */}
          <IconActionButton
            onClick={e => {
              const becomingActive = !bookmarkedIds.has(currentQuestion.questionId);
              if (becomingActive) {
                const r = e.currentTarget.getBoundingClientRect();
                setHeartBurst({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
              }
              toggleBookmark();
            }}
            disabled={!userId}
            active={bookmarkedIds.has(currentQuestion.questionId)}
            activeColor={HEART_ACTIVE_COLOR}
            title={bookmarkedIds.has(currentQuestion.questionId) ? t('exerciseSession.removeBookmark') : t('exerciseSession.bookmark')}
          >
            <IconHeart filled={bookmarkedIds.has(currentQuestion.questionId)} size={15} />
          </IconActionButton>
          {/* ⋮ … 通報・途中採点を格納（従来は独立ボタンで並んでいた） */}
          <div ref={actionMenuRef} style={{ position: 'relative' }}>
            <IconActionButton
              onClick={() => setActionMenuOpen(o => !o)}
              active={actionMenuOpen}
              title={lang === 'ja' ? 'その他' : 'More'}
            >
              <IconMoreVertical size={15} />
            </IconActionButton>
            {actionMenuOpen && (
              <div style={{
                position: 'absolute', bottom: '100%', left: 0, marginBottom: 4,
                background: 'var(--color-bg-white)', border: '1px solid var(--color-border)',
                borderRadius: 'var(--border-radius-md)', boxShadow: 'var(--box-shadow-pop)',
                minWidth: 180, zIndex: 100, overflow: 'hidden',
              }}>
                <button
                  onClick={() => { setActionMenuOpen(false); setReportOpen(true); }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '10px 14px', background: 'none', border: 'none', borderBottom: '1px solid var(--color-border)', cursor: 'pointer', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-main)' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-bg-main)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
                >
                  {lang === 'ja' ? 'この問題を通報' : 'Report this question'}
                </button>
                <button
                  onClick={() => { setActionMenuOpen(false); if (results.length > 0) setShowAbortConfirm(true); }}
                  disabled={results.length === 0}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '10px 14px', background: 'none', border: 'none', cursor: results.length === 0 ? 'default' : 'pointer', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-main)', opacity: results.length === 0 ? 0.45 : 1 }}
                  onMouseEnter={e => { if (results.length > 0) e.currentTarget.style.background = 'var(--color-bg-main)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
                >
                  {lang === 'ja' ? 'ここまでで採点' : 'Grade up to here'}
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );

  const [results, setResults] = useState<{ questionId: string; isCorrect: boolean }[]>(_resumeInit.res);
  // 回答済み問題を見返したときに選んだ選択肢を復元するための履歴。
  // ドラフトに含めないと、再開後に前の問題へ戻ったとき「回答済みなのに何も選ばれていない」
  // ＝未回答に見える状態になるため、他の進捗と一緒に永続化する。
  const [selectionHistory, setSelectionHistory] = useState<Record<number, string[]>>(_resumeInit.hist);
  const [hoveredNode, setHoveredNode] = useState<number | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [answerCountError, setAnswerCountError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [judgmentAnim, setJudgmentAnim] = useState<'correct' | 'incorrect' | null>(null);
  const [showAbortConfirm, setShowAbortConfirm] = useState(false);

  useEffect(() => {
    if (!showAbortConfirm) return;
    return lockBodyScroll();
  }, [showAbortConfirm]);

  // ドラフト保存 — 常に最新値を ref に保持し、状態変化時と beforeunload 両方で保存する
  const draftStateRef = useRef({ currentIndex, results, answered, selectedAnswers, selectionHistory });
  useEffect(() => {
    draftStateRef.current = { currentIndex, results, answered, selectedAnswers, selectionHistory };
  });
  // 完了/中断後はドラフトを保存し直さない（削除後に再作成される競合＝残存セッション/二重取得を防ぐ）
  const finishedRef = useRef(false);

  // このセッションのドラフト保存先。保存と後片付けで同じキーを使う。
  const currentDraftKey = isFocused ? `focusedExerciseDraft_${userId}`
    : isQuick ? `quickExerciseDraft_${userId}`
    : `practiceExerciseDraft_${userId}`;

  const saveDraftNow = useCallback(() => {
    if (!sessionId || finishedRef.current) return;
    const { currentIndex: ci, results: r, answered: a, selectedAnswers: sa, selectionHistory: sh } = draftStateRef.current;
    try {
      const draftKey = currentDraftKey;
      localStorage.setItem(draftKey, JSON.stringify({
        sessionId, examType, questions, questionIds: allQuestionIds, spareIds: spareIdsRef.current, userId,
        currentIndex: ci, results: r, answered: a, selectedAnswers: sa, selectionHistory: sh,
        choiceOrders: savedOrdersRef.current,
        isQuick, isFocused, isMini, savedAt: Date.now(),
      }));
      // いま画面で開いているセッションを指すポインタ。
      // リロード時は navigate の state が消えるためドラフトの種別を特定できず、
      // 「savedAt が最新のドラフト」を拾っていた。別種別（サクッと演習・演習）の
      // ドラフトが残っていてそちらが新しいと、しっかり対策の途中なのに
      // その演習に化けてしまうため、種別をここで確定させておく。
      localStorage.setItem(ACTIVE_DRAFT_POINTER, JSON.stringify({ key: draftKey, sessionId }));
    } catch { /* quota over 等は無視 */ }
    // サーバにも進捗を保存（端末跨ぎ/キャッシュ削除でも再開可能に。questionsは送らず軽量に）
    if (userId && userId !== 'guest') {
      const sessionType = isFocused ? 'focused' : isQuick ? 'quick' : 'practice';
      fetch(`${API_ENDPOINT}/sessions/${sessionId}/progress`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, sessionType, draft: { currentIndex: ci, results: r, answered: a, selectedAnswers: sa, selectionHistory: sh } }),
      }).catch(() => {});
    }
  }, [sessionId, examType, questions, allQuestionIds, userId, isQuick, isFocused, isMini]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    saveDraftNow();
    // sessionId を依存に含める: セッション作成は非同期のため、作成完了直後に一度保存する
    // （含めないと、作成前の保存がすべて no-op になり最初の回答まで進捗が消える）
  }, [currentIndex, results, answered, selectedAnswers, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!sessionId) return;
    // beforeunload: PC/Android、pagehide: iOS Safari でより確実
    window.addEventListener('beforeunload', saveDraftNow);
    window.addEventListener('pagehide', saveDraftNow);
    return () => {
      window.removeEventListener('beforeunload', saveDraftNow);
      window.removeEventListener('pagehide', saveDraftNow);
      // SPA内遷移（ホームへ戻る等）では beforeunload/pagehide が発火しないため、
      // アンマウント時にも必ず保存する（finishedRef 完了後は saveDraftNow 側で no-op）
      saveDraftNow();
    };
  }, [saveDraftNow]);

  // ブラウザの「戻る」で演習を抜けるときの挙動を明示する。
  // 何もしないと履歴の直前の画面（演習開始前のモーダル等）に戻ってしまい、
  // 進捗が残っているのかどうかが利用者から分からない。
  // ダミーの履歴を1つ積んで戻るを捕捉し、進捗を保存してからホームへ送る
  // （セッションは中断扱いにせず、ホームの「続きから」で再開できる状態のまま）。
  useEffect(() => {
    if (!sessionId) return;
    window.history.pushState({ exerciseGuard: true }, '');
    const onPop = () => {
      saveDraftNow();   // localStorage への保存は同期。遷移前に確実に書き込まれる
      navigate('/aws/', { replace: true });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [sessionId, saveDraftNow]); // eslint-disable-line react-hooks/exhaustive-deps

  const currentQuestion = questions[currentIndex];

  // 問題が切り替わったら、直前の問題の保留中の♡/👍👎をまとめて送信する
  // （②「次の問題へ移動する時」を goToQuestion 等の呼び出し箇所によらず一元的に処理）。
  const flushedQuestionIdRef = useRef<string | null>(null);
  useEffect(() => {
    const qid = currentQuestion?.questionId;
    const prevQid = flushedQuestionIdRef.current;
    if (prevQid && prevQid !== qid) {
      flushBookmark(prevQid);
      flushReaction(prevQid);
    }
    flushedQuestionIdRef.current = qid ?? null;
  }, [currentQuestion?.questionId, flushBookmark, flushReaction]);

  const CHOICE_LABELS = ['A', 'B', 'C', 'D', 'E'];

  type ShuffledQuestion = { shuffledChoices: string[]; origIndices: number[]; labelRemap: Record<string, string> };
  const choiceShuffleMap = useRef(new Map<string, ShuffledQuestion>());
  if (currentQuestion?.choices && !choiceShuffleMap.current.has(currentQuestion.questionId)) {
    const filtered = (currentQuestion.choices as string[]).filter((c: string) => c !== WAKARANAI);
    // 保存済みの順があれば復元（＝同一セッションで既に確定した順）。無ければ初回シャッフルして記録。
    const saved = savedOrdersRef.current[currentQuestion.questionId];
    let order: number[];
    if (saved && saved.length === filtered.length) {
      order = saved;
    } else {
      order = filtered.map((_c, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      savedOrdersRef.current[currentQuestion.questionId] = order;
    }
    const remap: Record<string, string> = {};
    order.forEach((origIdx, newIdx) => { remap[CHOICE_LABELS[origIdx]] = CHOICE_LABELS[newIdx]; });
    choiceShuffleMap.current.set(currentQuestion.questionId, {
      shuffledChoices: order.map(i => filtered[i]),
      origIndices: order,
      labelRemap: remap,
    });
  }
  const { shuffledChoices, origIndices, labelRemap } = choiceShuffleMap.current.get(currentQuestion?.questionId)
    ?? { shuffledChoices: [], origIndices: [] as number[], labelRemap: {} as Record<string, string> };

  const remapLabels = (text: string) =>
    text.replace(/(?<![A-Za-z])([A-E])(?![A-Za-z])/g, (_, l) => labelRemap[l] ?? l);

  const [lastSelected, setLastSelected] = useState<string | null>(null);
  const [struckChoices, setStruckChoices] = useState<Set<string>>(new Set());
  const [copyToast, setCopyToast] = useState(false); // Ctrl+Cコピーのトースト
  // キーボード操作用カーソル（Web版のみ）。choices + わからない を対象に上下移動
  const [cursorIndex, setCursorIndex] = useState(0);
  // 進捗ノード上にカーソルがあるか（最上部でさらに↑→ノードへ移動し、←→でクリック可能ノードを移動、Enterで移動）
  const [cursorOnNodes, setCursorOnNodes] = useState(false);
  const [nodeCursorIdx, setNodeCursorIdx] = useState(0);
  const cursorElRef = useRef<HTMLButtonElement | null>(null);
  const explAnchorRef = useRef<HTMLDivElement | null>(null); // 解説パネル先頭アンカー
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
    const h = (e: Event) => { const on = (e as CustomEvent).detail === true; setKbModeState(on); if (!on) setCursorOnNodes(false); };
    window.addEventListener('kbmodechange', h);
    return () => window.removeEventListener('kbmodechange', h);
  }, []);

  useEffect(() => {
    // ドラフト探索（sessionId 一致を優先。指定なしは最新の savedAt）
    const findDraft = (matchSid?: string) => {
      const cands: any[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key) continue;
        if (key.startsWith('practiceExerciseDraft_') || key.startsWith('quickExerciseDraft_') || key.startsWith('focusedExerciseDraft_')) {
          try {
            const p = JSON.parse(localStorage.getItem(key) ?? '');
            if (!(p.questions?.length > 0)) continue;
            if (matchSid && p.sessionId !== matchSid) continue;
            cands.push(p);
          } catch {}
        }
      }
      return cands.sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0))[0];
    };

    // 直前まで開いていた演習のドラフトを、種別を保ったまま取り出す。
    // savedAt 最新のドラフトを拾うと、別種別（サクッと演習・演習）のドラフトが
    // 残っていてそちらが新しい場合に演習の種類がすり替わるため、
    // ポインタで指された種別を優先する。
    const findActiveDraft = () => {
      try {
        const ptr = JSON.parse(localStorage.getItem(ACTIVE_DRAFT_POINTER) ?? 'null');
        if (ptr?.key) {
          const p = JSON.parse(localStorage.getItem(ptr.key) ?? 'null');
          if (p?.questions?.length > 0 && (!ptr.sessionId || p.sessionId === ptr.sessionId)) return p;
        }
      } catch {}
      return findDraft();
    };

    // state がある場合: 進捗は useState 初期化時（_resumeInit）でドラフト反映済み。
    if (state) { setInitialized(true); return; }
    // state なし（リロード等）: 直前に開いていた演習のドラフトから復元する
    const draft = findActiveDraft();
    if (!draft) { navigate('/aws/', { replace: true }); return; }
    setSessionId(draft.sessionId ?? '');
    setQuestions(draft.questions);
    setUserId(draft.userId ?? '');
    setExamType(draft.examType ?? '');
    setIsQuick(draft.isQuick ?? false);
    setIsFocused(draft.isFocused ?? false);
    setIsMini(draft.isMini ?? false);
    setCurrentIndex(draft.currentIndex ?? 0);
    // 到達済みの最前線は「今いる位置」と「回答済み数」の大きい方。
    // currentIndex だけで復元すると、前の問題を見返している最中にリロードした場合に
    // 最前線がそこまで縮み、回答済みの先の問題へ戻れなくなる。
    setViewedFrontier(Math.max(draft.currentIndex ?? 0, (draft.results ?? []).length));
    setResults(draft.results ?? []);
    setAnswered(draft.answered ?? false);
    setSelectedAnswers(draft.selectedAnswers ?? []);
    // 回答済み問題を見返したときに選択肢が空にならないよう履歴も復元する
    if (draft.selectionHistory && typeof draft.selectionHistory === 'object') setSelectionHistory(draft.selectionHistory);
    // 出題予定ID・予備IDも復元する（欠けると totalCount がロード済み分まで縮み、
    // リロード後に設定した問題数より少ない問題数で終了してしまう）
    if (draft.questionIds?.length) setPresentIds(draft.questionIds);
    if (draft.spareIds?.length) spareIdsRef.current = [...draft.spareIds];
    // 選択肢の並び順も復元する。これが無いとリロードのたびに再シャッフルされ、
    // 同じ問題なのに選択肢の位置が変わる（同一セッション内では固定する方針）。
    if (draft.choiceOrders && typeof draft.choiceOrders === 'object') savedOrdersRef.current = draft.choiceOrders;
    setInitialized(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── キーボード操作まわりの Hook ──────────────────────────────────
  // 下の早期リターンより後ろに置くと、レンダーごとに呼ばれる Hook の数が変わり
  // React が "Rendered more/fewer hooks than during the previous render" で落ちる。
  // （演習中に2回リロードすると再現した: 1回目は compat 層が sessionStorage から
  //   location.state を復元するが、その際に消すため2回目は state が無くなり
  //   initialized=false → 早期リターン → ドラフト復元で true → Hook が増える）
  // 依存する値（isMobile / currentIndex / cursorIndex / shuffledChoices 等）は
  // すべてこの位置より前で宣言済みなので、ここに置ける。

  // 問題が変わったらカーソルを先頭に戻す
  useEffect(() => { setCursorIndex(0); }, [currentIndex]);
  // カーソルの選択肢が画面内に入るようスクロール追従（Web版）
  useEffect(() => { if (!isMobile) cursorElRef.current?.scrollIntoView({ block: 'nearest' }); }, [cursorIndex, isMobile]);

  // 実体の代入は toggleAnswer 等の定義後（下の方）で行う。ここは宣言のみ。
  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {});

  useEffect(() => {
    const h = (e: KeyboardEvent) => keyHandlerRef.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // Ctrl/Cmd+C: テキスト未選択時は問題文＋選択肢をコピー（上部コピーボタンと同じ・Web版のみ）
  useEffect(() => {
    if (isMobile) return;
    const onCopy = (e: KeyboardEvent) => {
      if (!((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C'))) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
      if ((window.getSelection()?.toString() ?? '') !== '') return; // 選択中は通常コピー優先
      const q = questions[currentIndex];
      if (!q) return;
      e.preventDefault();
      const choicesText = shuffledChoices.map((c, idx) => `${CHOICE_LABELS[idx]}. ${stripLabel(c)}`).join('\n');
      navigator.clipboard.writeText(`${q.questionText}\n\n${choicesText}`).then(() => {
        setCopyToast(true);
        setTimeout(() => setCopyToast(false), 1500);
      }).catch(() => {});
    };
    window.addEventListener('keydown', onCopy);
    return () => window.removeEventListener('keydown', onCopy);
  }, [isMobile, currentIndex, shuffledChoices, questions]);

  // 全 Hook 呼び出し完了後に computed values を定義
  const totalCount = allQuestionIds.length > 0 ? allQuestionIds.length : questions.length;

  // ここから下に Hook を追加しないこと（上記の理由でクラッシュする）
  if (!initialized) return null;

  // プログレッシブロード: 現在問がまだロードされていない場合はスピナーを表示
  if (!questions[currentIndex]) {
    return (
      <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-bg-main)' }}>
        <div className="sherpa-spinner" />
      </div>
    );
  }

  const toggleAnswer = (choice: string) => {
    if (answered) return;
    setAnswerCountError(null);
    setLastSelected(choice);
    if (choice === WAKARANAI) {
      setSelectedAnswers(prev => prev.includes(WAKARANAI) ? [] : [WAKARANAI]);
    } else if (currentQuestion.isMultiple) {
      setSelectedAnswers(prev =>
        prev.includes(choice)
          ? prev.filter(a => a !== choice)
          : [...prev.filter(a => a !== WAKARANAI), choice]
      );
    } else {
      setSelectedAnswers([choice]);
    }
  };

  const toggleStrikethrough = (choice: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (answered) return;
    setStruckChoices(prev => {
      const next = new Set(prev);
      if (next.has(choice)) next.delete(choice); else next.add(choice);
      return next;
    });
  };

  const submitAnswer = (overrideSel?: string[]) => {
    // onClick から誤ってイベントが渡るケースに備え、配列でなければ無視する
    const useOverride = Array.isArray(overrideSel);
    const sel = useOverride ? overrideSel! : selectedAnswers;
    if (sel.length === 0) return;
    if (useOverride) setSelectedAnswers(overrideSel!); // 即回答時はUIにも反映
    const isWakaranai = sel.includes(WAKARANAI);
    if (!isWakaranai && currentQuestion.isMultiple && currentQuestion.correctAnswerCount &&
        sel.length !== currentQuestion.correctAnswerCount) {
      setAnswerCountError(lang === 'ja'
        ? `${currentQuestion.correctAnswerCount}つ選択してください（現在${sel.length}つ）`
        : `Select ${currentQuestion.correctAnswerCount} answers (currently ${sel.length})`);
      return;
    }
    setAnswerCountError(null);

    const correctAnswerIndices: number[] = toIdxArr(currentQuestion.correctAnswerIndices);
    const selOrigIdx = sel.map(t => { const si = shuffledChoices.indexOf(t); return si >= 0 ? origIndices[si] : -1; });
    const isCorrect = correctAnswerIndices.length > 0 && correctAnswerIndices.length === selOrigIdx.length && correctAnswerIndices.every(i => selOrigIdx.includes(i));

    setResults(prev => [...prev, { questionId: currentQuestion.questionId, isCorrect }]);
    setSelectionHistory(prev => ({ ...prev, [currentIndex]: sel }));
    setAnswered(true);
    setJudgmentAnim(isCorrect ? 'correct' : 'incorrect');
    setTimeout(() => setJudgmentAnim(null), 600);

    // ①この問題のスコアがコミットされるタイミングで、保留中の♡/👍👎もまとめて送信する
    flushBookmark(currentQuestion.questionId);
    flushReaction(currentQuestion.questionId);

    const answerPayload = {
      userId,
      questionId: currentQuestion.questionId,
      selectedAnswers: sel,
      isCorrect,
      examType,
    };
    // sessionId が未確定なら作成完了を待ってから送信（楽観的遷移時のレース対策）
    (async () => {
      const sid = await ensureSessionId();
      if (!sid) return;
      fetch(`${API_ENDPOINT}/sessions/${sid}/answers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(answerPayload),
      }).catch(err => console.error(err));
    })();
  };

  const goToQuestion = (i: number) => {
    if (i > viewedFrontier || i === currentIndex) return;
    setCurrentIndex(i);
    if (i < results.length) {
      setSelectedAnswers(selectionHistory[i] ?? []);
      setAnswered(true);
    } else {
      setSelectedAnswers([]);
      setAnswered(false);
    }
    setDetail(null); setDetailFetchFailed(false);
    setAnswerCountError(null);
  };

  const nextQuestion = async () => {
    const nextIdx = currentIndex + 1;
    // 過去問を復習中（frontierより前）→ 次の問題へ進む
    if (nextIdx < results.length) {
      setCurrentIndex(nextIdx);
      setSelectedAnswers(selectionHistory[nextIdx] ?? []);
      setAnswered(true);
      setDetail(null); setDetailFetchFailed(false);
      setAnswerCountError(null);
      return;
    }
    // 次問がまだロードされていない場合: インデックスは進めてスピナーを表示し、
    // ロード効果（currentIndex 依存）を再発火させる。過去に取得失敗したIDは
    // 試行済みマークを外して再取得させる（ボタンが無反応のまま止まるのを防ぐ）。
    if (nextIdx < totalCount && nextIdx >= questions.length) {
      const loaded = new Set(questions.map(q => q.questionId));
      presentIds.forEach(id => { if (!loaded.has(id)) attemptedIdsRef.current.delete(id); });
      setCurrentIndex(nextIdx);
      setSelectedAnswers([]);
      setAnswered(false);
      setDetail(null); setDetailFetchFailed(false);
      setAnswerCountError(null);
      return;
    }
    // frontierに戻ってきた場合（かつ未回答の問題が残っている）→ 未回答モードへ
    if (nextIdx === results.length && nextIdx < questions.length) {
      setCurrentIndex(nextIdx);
      setSelectedAnswers([]);
      setAnswered(false);
      setDetail(null); setDetailFetchFailed(false);
      setAnswerCountError(null);
      return;
    }
    if (nextIdx >= totalCount) {
      finishedRef.current = true;
      setFinishing(true);
      const score = Math.round((results.filter(r => r.isCorrect).length / totalCount) * 100);
      const basePassRate = PASS_RATE[examType] ?? PASS_RATE['SAA'];
      const passRate = isMini ? Math.ceil(basePassRate / 5) : basePassRate;
      const isPassed = score >= passRate;
      const sid = await ensureSessionId();
      try {
        if (sid) await fetch(`${API_ENDPOINT}/sessions/${sid}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, status: 'completed', score, isPassed, examType, answeredCount: results.length })
        });
      } catch (err) { console.error(err); }
      // 終わったセッションの種別のドラフトだけを消す。
      // 3種すべて消すと、別種別の進行中セッションはローカルの再開情報だけ失われ、
      // サーバ側は active のまま孤児になる。その孤児を hydrateDraftsFromServer が
      // 復活させるため「完了したのにボタンが再開のまま」に見えていた。
      localStorage.removeItem(currentDraftKey);
      localStorage.removeItem(ACTIVE_DRAFT_POINTER);
      // ドメイン別統計を記録（domain_history / domain_results / サーバー同期）
      const dr = recordSessionDomainStats({
        examType, userId, results,
        questionById: (qId) => questions.find((q: Question) => q.questionId === qId) as any,
      });
      // 統計キャッシュは破棄して次回参照時にサーバから取り直す。
      // ドメイン別の累計(correctCount/incorrectCount)はサーバが UserQuestionStats から
      // 集計して返すため、ここで recentResults だけを継ぎ足すと累計が古いまま残り、
      // 既習数・正答率が未演習フィルタとズレる。
      deleteCachedByPrefix(`ustats_${userId}`);
      window.dispatchEvent(new CustomEvent('qstatsRefresh'));
      localStorage.setItem(`postSessionRefresh_${userId}`, String(Date.now()));
      const ptsPerQ = EXAM_LEVEL[examType] === 'Foundational' ? 1 : EXAM_LEVEL[examType] === 'Associate' ? 2 : 3;
      const earnedPts = results.filter(r => r.isCorrect).length * ptsPerQ;
      if (userId && earnedPts > 0) addPoints(userId, earnedPts);
      localStorage.setItem(`sessionScoreAdd_${examType}_${userId}`, '1');
      // 日次演習カウント更新（ログイン時はサーバへアトミック加算＝デバイス間で正しく合算）
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
      // 達成判定はサーバ確定の当日合計(serverDaily)がある時のみ。null時はstaleなローカル値で
      // prevDaily<goalが誤成立し同日に報酬が重複付与されるため、判定を見送る。
      if (serverDaily != null && newDaily >= dailyGoal && prevDaily < dailyGoal && !localStorage.getItem(rewardKey) && userId !== 'guest') {
        localStorage.setItem(rewardKey, '1');
        dailyBonusPts = 10;
        addPoints(userId, dailyBonusPts);
      }
      schedulePrefetchAfterSession({ examType, userId, isQuick, isFocused });
      navigate('/aws/result', { state: { results, questions, score, isPassed, sessionId: sid, userId, examType, isQuick, isFocused, isMini, earnedPts, dailyBonusPts } });
    } else {
      setCurrentIndex(prev => prev + 1);
      setSelectedAnswers([]);
      setAnswered(false);
      setDetail(null); setDetailFetchFailed(false);
      setAnswerCountError(null);
    }
  };

  const handleAbortAndGrade = async () => {
    if (results.length === 0) return;
    finishedRef.current = true;
    setShowAbortConfirm(false);
    setFinishing(true);
    const correctCount = results.filter(r => r.isCorrect).length;
    const score = Math.round((correctCount / results.length) * 100);
    const basePassRate = PASS_RATE[examType] ?? PASS_RATE['SAA'];
    const passRate = isMini ? Math.ceil(basePassRate / 5) : basePassRate;
    const isPassed = score >= passRate;
    const sid = await ensureSessionId();
    try {
      if (sid) await fetch(`${API_ENDPOINT}/sessions/${sid}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, status: 'completed', score, isPassed, examType, answeredCount: results.length }),
      });
    } catch (err) { console.error(err); }
    // 中断時も、終わらせたセッションの種別だけを消す（理由は完了時と同じ）
    localStorage.removeItem(currentDraftKey);
    localStorage.removeItem(ACTIVE_DRAFT_POINTER);
    const dr = recordSessionDomainStats({
      examType, userId, results,
      questionById: (qId) => questions.find((q: Question) => q.questionId === qId) as any,
    });
    // 上と同じ理由でキャッシュは破棄する（累計はサーバ集計が正）
    deleteCachedByPrefix(`ustats_${userId}`);
    window.dispatchEvent(new CustomEvent('qstatsRefresh'));
    localStorage.setItem(`postSessionRefresh_${userId}`, String(Date.now()));
    const ptsPerQ = EXAM_LEVEL[examType] === 'Foundational' ? 1 : EXAM_LEVEL[examType] === 'Associate' ? 2 : 3;
    const earnedPts = results.filter(r => r.isCorrect).length * ptsPerQ;
    if (userId && earnedPts > 0) addPoints(userId, earnedPts);
    localStorage.setItem(`sessionScoreAdd_${examType}_${userId}`, '1');
    const jstToday2 = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    const dailyKey2 = `dailyQCount_${examType}_${userId}_${jstToday2}`;
    const localPrevDaily2 = parseInt(localStorage.getItem(dailyKey2) ?? '0', 10);
    const serverDaily2 = await incrementDailyProgress(userId, examType, results.length);
    const prevDaily2 = serverDaily2 != null ? serverDaily2 - results.length : localPrevDaily2;
    const newDaily2 = serverDaily2 != null ? serverDaily2 : localPrevDaily2 + results.length;
    localStorage.setItem(dailyKey2, String(newDaily2));
    const dailyGoal2 = parseInt(localStorage.getItem(`dailyGoal_${userId}`) ?? '10', 10);
    const rewardKey2 = `dailyGoalReward_${examType}_${userId}_${jstToday2}`;
    let dailyBonusPts2 = 0;
    if (newDaily2 >= dailyGoal2 && prevDaily2 < dailyGoal2 && !localStorage.getItem(rewardKey2) && userId !== 'guest') {
      localStorage.setItem(rewardKey2, '1');
      dailyBonusPts2 = 10;
      addPoints(userId, dailyBonusPts2);
    }
    const answeredQuestions = questions.slice(0, results.length);
    schedulePrefetchAfterSession({ examType, userId, isQuick, isFocused });
    navigate('/aws/result', { state: { results, questions: answeredQuestions, score, isPassed, sessionId: sid, userId, examType, isQuick, isFocused, isMini, aborted: true, earnedPts, dailyBonusPts: dailyBonusPts2 } });
  };

  // ── キーボード操作（Web版のみ）──
  // ↑↓←→: カーソル移動 / Enter: カーソルの選択肢を選択・トグル / Shift+Enter: 回答→次へ
  // ※ useRef の宣言と keydown リスナーの登録は早期リターンより前へ移動済み。
  //    ここは代入のみ（Hook ではない）。toggleAnswer 等を参照するのでこの位置に残す。
  keyHandlerRef.current = (e: KeyboardEvent) => {
    if (isMobile) return;
    const el = e.target as HTMLElement | null;
    const tag = el?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
    if (document.body.dataset.pane === 'left') return; // 左ペイン操作中は抑止（←→はLayoutが処理）
    if (showAbortConfirm || finishing) return;
    const total = shuffledChoices.length + 1; // +1 = わからない
    const scrollMain = (toBottom: boolean) => {
      const m = document.querySelector('main');
      const tgt = toBottom ? (m ? m.scrollHeight : document.body.scrollHeight) : 0;
      (m ?? window).scrollTo({ top: tgt, behavior: 'smooth' });
    };
    // 進捗ノード上にカーソルがある場合：←→で前後の問題へ移動、↓で選択肢へ戻る。
    // ←→はLayoutの左ペイン移動と競合するため stopImmediatePropagation で抑止する。
    if (cursorOnNodes) {
      const maxNav = Math.min(viewedFrontier, questions.length - 1); // 移動可能（クリック可能）な最大ノード
      // オレンジカーソルは「過去の問題（＝現在の問題以外のクリック可能ノード）」だけを対象にする。
      // 現在の問題ノードは移動対象から除外（飛ばす）。
      const navNodes: number[] = [];
      for (let k = 0; k <= maxNav; k++) if (k !== currentIndex) navNodes.push(k);
      if (e.key === 'ArrowLeft') {
        e.preventDefault(); e.stopImmediatePropagation();
        setNodeCursorIdx(i => { const pos = navNodes.indexOf(i); return pos > 0 ? navNodes[pos - 1] : (navNodes[0] ?? i); });
      } else if (e.key === 'ArrowRight') {
        e.preventDefault(); e.stopImmediatePropagation();
        setNodeCursorIdx(i => { const pos = navNodes.indexOf(i); return (pos >= 0 && pos < navNodes.length - 1) ? navNodes[pos + 1] : (navNodes[navNodes.length - 1] ?? i); });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (nodeCursorIdx !== currentIndex) goToQuestion(nodeCursorIdx); // クリック相当
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCursorOnNodes(false); setCursorIndex(0);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (cursorIndex >= total - 1) {
        // 最下選択肢でさらに下：回答後は解説パネル先頭を画面上部に、未回答時は下部へ
        if (answered && explAnchorRef.current) explAnchorRef.current.scrollIntoView({ block: 'start', behavior: 'smooth' });
        else scrollMain(true);
      } else setCursorIndex(c => Math.min(total - 1, c + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (cursorIndex <= 0) {
        // 最上選択肢でさらに上：まだ最上部でなければページ最上部へ、既に最上部なら進捗ノードへ移動
        const m = document.querySelector('main');
        const atTop = (m ? m.scrollTop : 0) <= 1 && window.scrollY <= 1;
        if (atTop) {
          // 過去の問題ノードにカーソルを合わせる（現在の問題ノードには乗せない）。
          // 直前の問題を優先。無ければ現在より後ろの最小ノード。過去問題が無ければノードへ移動しない。
          const maxNav = Math.min(viewedFrontier, questions.length - 1);
          const target = currentIndex - 1 >= 0 ? currentIndex - 1 : (currentIndex + 1 <= maxNav ? currentIndex + 1 : -1);
          if (target >= 0) { setCursorOnNodes(true); setNodeCursorIdx(target); }
        }
        else scrollMain(false);
      } else setCursorIndex(c => Math.max(0, c - 1));
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (!answered) {
        // 単一選択で未選択時はカーソルの選択肢を選んで即回答（Enter決定を省略）
        if (selectedAnswers.length === 0 && !currentQuestion.isMultiple && cursorIndex < shuffledChoices.length) {
          submitAnswer([shuffledChoices[cursorIndex]]);
        } else {
          submitAnswer();
        }
      } else nextQuestion();
    } else if (e.key === 'Enter' && isKbMode()) {
      e.preventDefault();
      if (!answered) toggleAnswer(cursorIndex < shuffledChoices.length ? shuffledChoices[cursorIndex] : WAKARANAI);
    }
  };

  const getChoiceStyle = (choice: string): React.CSSProperties => {
    const base: React.CSSProperties = {
      padding: 'var(--spacing-md) var(--spacing-lg)',
      marginBottom: 'var(--spacing-sm)',
      borderRadius: 'var(--border-radius-md)',
      cursor: answered ? 'default' : 'pointer',
      border: '1px solid',
      display: 'block',
      width: '100%',
      textAlign: 'left',
      fontSize: 'var(--font-size-base)',
      color: 'var(--color-text-main)',
      transition: 'all 0.15s ease',
      background: 'var(--color-bg-elevated)',
      borderColor: 'var(--color-border)',
    };
    if (!answered) {
      const selected = selectedAnswers.includes(choice);
      return {
        ...base,
        borderColor: selected ? 'var(--color-primary)' : 'var(--color-border)',
        background: selected ? 'var(--color-primary-light)' : 'var(--color-bg-elevated)',
        boxShadow: selected ? '0 0 0 1px var(--color-primary)' : 'none',
      };
    }
    const displayQ = (currentQuestion.correctAnswers ? currentQuestion : detail) ?? currentQuestion;
    if (!displayQ.correctAnswers) {
      const selected = selectedAnswers.includes(choice);
      return {
        ...base,
        borderColor: selected ? 'var(--color-primary)' : 'var(--color-border)',
        background: selected ? 'var(--color-primary-light)' : 'var(--color-bg-elevated)',
        boxShadow: selected ? '0 0 0 1px var(--color-primary)' : 'none',
        cursor: 'default',
      };
    }
    const correctAnswerIndices: number[] = toIdxArr(displayQ.correctAnswerIndices);
    const shuffledIdx = shuffledChoices.indexOf(choice);
    const origIdx = shuffledIdx >= 0 ? origIndices[shuffledIdx] : -1;
    const isCorrect = correctAnswerIndices.includes(origIdx);
    const isSelected = selectedAnswers.includes(choice);

    if (isCorrect) {
      return { ...base, borderColor: 'var(--color-success)', background: 'var(--color-feedback-correct-bg)', color: 'var(--color-success)' };
    }
    if (isSelected && !isCorrect) {
      return { ...base, borderColor: 'var(--color-danger)', background: 'var(--color-feedback-incorrect-bg)', color: 'var(--color-danger)' };
    }
    return { ...base, borderColor: 'var(--color-border)', background: 'var(--color-bg-main)', color: 'var(--color-text-sub)' };
  };

  // 回答後に各選択肢へ付ける正誤ラベル。色だけに頼らず、アイコンと文字でも示す（WCAG 1.4.1）
  const getChoiceVerdict = (choice: string): 'correct' | 'wrong' | null => {
    if (!answered || !currentQuestion) return null;
    const displayQ = (currentQuestion.correctAnswers ? currentQuestion : detail) ?? currentQuestion;
    if (!displayQ.correctAnswers) return null;
    const shuffledIdx = shuffledChoices.indexOf(choice);
    const origIdx = shuffledIdx >= 0 ? origIndices[shuffledIdx] : -1;
    if (toIdxArr(displayQ.correctAnswerIndices).includes(origIdx)) return 'correct';
    return selectedAnswers.includes(choice) ? 'wrong' : null;
  };

  if (showAbortConfirm) {
    return createPortal(
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
        <div style={{ background: 'var(--color-bg-white)', borderRadius: 'var(--border-radius-lg)', padding: '28px 24px', width: '100%', maxWidth: 400, boxShadow: 'var(--box-shadow-lg)' }}>
          <div style={{ fontWeight: 700, fontSize: 'var(--font-size-md)', marginBottom: 12, color: 'var(--color-text-main)' }}>
            {lang === 'ja' ? '中断して採点' : 'Interrupt & Grade'}
          </div>
          <div style={{ fontSize: 'var(--font-size-base)', color: 'var(--color-text-sub)', marginBottom: 24, lineHeight: 1.7 }}>
            {lang === 'ja'
              ? <>{results.length}問の回答を採点します。<br />未回答の{questions.length - results.length}問は集計されません。</>
              : <>{results.length} answered question{results.length !== 1 ? 's' : ''} will be graded.<br />The remaining {questions.length - results.length} will not be counted.</>}
          </div>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
            <Button variant="outline" onClick={() => setShowAbortConfirm(false)}>
              {lang === 'ja' ? 'キャンセル' : 'Cancel'}
            </Button>
            <Button variant="primary" onClick={handleAbortAndGrade}>
              {lang === 'ja' ? '採点する' : 'Grade Now'}
            </Button>
          </div>
        </div>
      </div>,
      document.body
    );
  }

  if (finishing) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '60vh', gap: 16 }}>
        <div className="sherpa-spinner" style={{ width: 36, height: 36, borderWidth: 3 }} />
        <div style={{ fontSize: 'var(--font-size-h3)', color: 'var(--color-text-sub)' }}>{lang === 'ja' ? '結果を集計中...' : 'Calculating results...'}</div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: isMobile ? '0 0 var(--spacing-sm)' : '0 var(--spacing-lg) var(--spacing-xl)' }} className="session-container">
      {copyToast && createPortal(
        <div style={{ position: 'fixed', top: 72, left: '50%', transform: 'translateX(-50%)', zIndex: 9500, background: 'var(--color-text-main)', color: 'var(--color-bg-white)', padding: '8px 16px', borderRadius: 'var(--border-radius-full)', fontSize: 'var(--font-size-sm)', fontWeight: 600, boxShadow: 'var(--box-shadow-md)', animation: 'sherpa-fade-in 0.15s ease' }}>
          {lang === 'ja' ? '問題文をコピーしました' : 'Copied question'}
        </div>, document.body)}
      {/* 正誤アニメーション */}
      {judgmentAnim && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 800,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none',
        }}>
          <div style={{
            width: 110, height: 110,
            borderRadius: '50%',
            background: judgmentAnim === 'correct' ? 'rgba(47,164,79,0.92)' : 'rgba(220,53,69,0.92)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            animation: judgmentAnim === 'correct' ? 'judgment-ok 0.55s ease forwards' : 'judgment-ng 0.55s ease forwards',
            boxShadow: judgmentAnim === 'correct'
              ? '0 0 0 0 rgba(47,164,79,0.4), 0 4px 24px rgba(47,164,79,0.5)'
              : '0 0 0 0 rgba(220,53,69,0.4), 0 4px 24px rgba(220,53,69,0.5)',
          }}>
            <svg width="52" height="52" viewBox="0 0 52 52" fill="none">
              {judgmentAnim === 'correct'
                ? <polyline points="10,27 21,38 42,16" stroke="white" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" />
                : <><line x1="14" y1="14" x2="38" y2="38" stroke="white" strokeWidth="5.5" strokeLinecap="round" /><line x1="38" y1="14" x2="14" y2="38" stroke="white" strokeWidth="5.5" strokeLinecap="round" /></>
              }
            </svg>
          </div>
        </div>
      )}

      {/* 進捗ノード（画面上部に固定） */}
      {(() => {
        const WINDOW = 5;
        const useWindow = totalCount > WINDOW;
        // ノードカーソル中はカーソル位置を中心にウィンドウを寄せ、カーソルが常に見えるようにする
        const focusIdx = cursorOnNodes ? nodeCursorIdx : currentIndex;
        const windowStart = useWindow
          ? Math.max(0, Math.min(focusIdx - Math.floor(WINDOW / 2), totalCount - WINDOW))
          : 0;
        const visibleIndices = useWindow
          ? Array.from({ length: WINDOW }, (_, k) => windowStart + k)
          : Array.from({ length: totalCount }, (_, k) => k);
        const nodeCursorActive = !isMobile && kbMode && rightActive && cursorOnNodes;

        return (
          <div style={{ position: 'sticky', top: 0, zIndex: 190, background: 'var(--color-bg-white)', borderBottom: '1px solid var(--color-border)', padding: isMobile ? '8px 16px' : '8px 24px', display: 'flex', alignItems: 'center', gap: 0, width: isMobile ? 'calc(100% + 2 * var(--spacing-md))' : '100%', marginLeft: isMobile ? 'calc(-1 * var(--spacing-md))' : undefined, boxSizing: 'border-box', marginBottom: 'var(--spacing-md)' }}>
            <div style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
              {visibleIndices.map((i, visIdx) => {
                const isAnswered = i < results.length;
                const isCurrent = i === currentIndex;
                const isLoaded = i < questions.length;
                // 未ロード問題はタップ不可
                const isClickable = i <= viewedFrontier && !isCurrent && isLoaded;
                const isHovered = hoveredNode === i;
                const isNodeCursor = nodeCursorActive && i === nodeCursorIdx;
                const dotSize = isCurrent ? 12 : isNodeCursor ? 10 : isHovered ? 9 : 7;
                return (
                  <React.Fragment key={i}>
                    <div
                      onClick={isClickable ? () => goToQuestion(i) : undefined}
                      onMouseEnter={isClickable ? () => setHoveredNode(i) : undefined}
                      onMouseLeave={isClickable ? () => setHoveredNode(null) : undefined}
                      title={isClickable ? `第${i + 1}問へ` : undefined}
                      style={{
                        width: dotSize,
                        height: dotSize,
                        borderRadius: '50%',
                        flexShrink: 0,
                        background: isAnswered || isCurrent ? 'var(--color-primary)' : 'transparent',
                        border: `2px solid ${isAnswered || isCurrent ? 'var(--color-primary)' : 'var(--color-text-light)'}`,
                        // 濃度は全ノードで揃える（間をつなぐ線と同じ不透明度）。
                        // 以前は未ロード(プログレッシブロード待ち)を 0.3、回答済みを 0.75 に
                        // 落としていたが、ロード状況という利用者に無関係な内部事情で
                        // 見た目の濃さが変わり、同じ意味のノードが薄く見えていた。
                        // 状態の区別は色（primary＝回答済/現在地、text-light＝未回答）と
                        // サイズ・boxShadow で足りるため、opacity での差は付けない。
                        opacity: 1,
                        boxShadow: isNodeCursor
                          ? '0 0 0 3px var(--color-accent)'
                          : isCurrent
                          ? '0 0 0 2px var(--color-primary-light, rgba(82,130,255,0.25))'
                          : isHovered
                          ? '0 0 0 3px var(--color-primary-light, rgba(82,130,255,0.35))'
                          : 'none',
                        cursor: isClickable ? 'pointer' : 'default',
                        transition: 'all 0.15s',
                      }}
                    />
                    {visIdx < visibleIndices.length - 1 && (
                      <div style={{
                        flex: 1,
                        height: 2,
                        background: i < results.length ? 'var(--color-primary)' : 'var(--color-text-light)',
                        transition: 'background 0.2s',
                      }} />
                    )}
                  </React.Fragment>
                );
              })}
            </div>
            {useWindow && (
              <span style={{ flexShrink: 0, marginLeft: 12, fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-text-light)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                {currentIndex + 1} / {totalCount}
              </span>
            )}
          </div>
        );
      })()}
      <Card padding={isMobile ? 'var(--spacing-md)' : 'var(--spacing-xl)'}>
        {/* ブックマーク(旧☆)は解説下のアクション列(♡)へ移動した */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--spacing-lg)' }}>
          <h1 style={{ fontSize: 'var(--font-size-h2)', fontWeight: 700, margin: 0, color: 'var(--color-text-main)', display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)' }}>
            {t('exerciseSession.qLabel')} {currentIndex + 1}
            {/* 公式資格の演習に混ざった基礎知識資格(ML/DB/NW/SEC)の問題だけ ∞ を出す。
                基礎知識資格そのものの演習は全問が該当して意味がないので出さない。 */}
            {examType && isNonAwsExam(currentQuestion.examType) && currentQuestion.examType !== examType && (
              <span
                role="img"
                title={`${t('exerciseSession.companionBadge')}（${companionLabel(currentQuestion.examType)}）`}
                aria-label={`${t('exerciseSession.companionBadge')}（${companionLabel(currentQuestion.examType)}）`}
                style={{ display: 'inline-flex', color: EXAM_LEVEL_COLORS[EXAM_LEVEL[currentQuestion.examType]] ?? 'var(--color-primary)' }}
              >
                <IconInfinity size={22} />
              </span>
            )}
          </h1>
        </div>

        {currentQuestion.scheduledDeletionDate && (
          <div style={{ background: '#FFF4E5', border: '1px solid #F5A623', borderRadius: 'var(--border-radius-md)', padding: '8px 12px', marginBottom: 'var(--spacing-md)', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <span style={{ flexShrink: 0, fontSize: 'var(--font-size-base)', lineHeight: 1.6 }}>⚠️</span>
            <span style={{ fontSize: 'var(--font-size-xs)', color: '#8A5A00', lineHeight: 1.6, overflowWrap: 'break-word', wordBreak: 'break-word' }}>
              この問題は{currentQuestion.scheduledDeletionDate}に削除されます（理由: {currentQuestion.scheduledDeletionReason}）。
            </span>
          </div>
        )}

        <div style={{ marginBottom: 'var(--spacing-xl)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--spacing-sm)', gap: 'var(--spacing-md)' }}>
            <div>
              {currentQuestion.isMultiple && (
                <span style={{
                  display: 'inline-flex', alignItems: 'center',
                  border: '1.5px solid var(--color-border)', borderRadius: 4,
                  padding: '2px 8px', fontSize: 'var(--font-size-xs)', fontWeight: 700,
                  color: 'var(--color-text-sub)', background: 'transparent', whiteSpace: 'nowrap',
                }}>
                  {t('exerciseSession.multiple')}{currentQuestion.correctAnswerCount ? ` (${currentQuestion.correctAnswerCount})` : ''}
                </span>
              )}
            </div>
            {/* 問題文＋選択肢のコピーは「選択肢の下」へ移動した */}
          </div>
          <p style={{ fontSize: 'var(--font-size-lg)', lineHeight: 1.6, fontWeight: 400, margin: 0, color: 'var(--color-text-main)', overflowWrap: 'break-word', wordBreak: 'break-word', minWidth: 0, whiteSpace: 'pre-wrap' }}>
            {qText(currentQuestion as any, lang)}
          </p>
        </div>

        <div style={{ marginBottom: 'var(--spacing-xl)' }}>
          <div style={{ marginBottom: 'var(--spacing-sm)' }}>
            <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', fontWeight: 700 }}>{t('exerciseSession.choices')}</span>
          </div>
          {shuffledChoices.map((choice: string, idx: number) => {
            const isSelected = selectedAnswers.includes(choice);
            const isCursor = !isMobile && kbMode && rightActive && !cursorOnNodes && idx === cursorIndex;
            return (
              <button
                key={choice}
                ref={isCursor ? cursorElRef : undefined}
                onClick={() => toggleAnswer(choice)}
                style={{ ...getChoiceStyle(choice), ...(isCursor ? { outline: '2px solid var(--color-accent)', outlineOffset: 1 } : {}) }}
                className={lastSelected === choice && isSelected && !answered ? 'choice-select-anim' : ''}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  {currentQuestion.isMultiple ? (
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
                  <span
                    onClick={!answered && strikeEnabled ? (e) => toggleStrikethrough(choice, e) : undefined}
                    style={{
                      flex: 1, minWidth: 0, overflowWrap: 'break-word', wordBreak: 'break-word', lineHeight: 1.55, whiteSpace: 'pre-wrap',
                      textDecoration: strikeEnabled && struckChoices.has(choice) && !answered ? 'line-through' : 'none',
                      textDecorationColor: 'var(--color-danger)',
                      textDecorationThickness: '2px',
                      cursor: !answered && strikeEnabled ? 'pointer' : 'default',
                      userSelect: 'none',
                    }}
                  >
                    <strong style={{ marginRight: 2 }}>{CHOICE_LABELS[idx]}.</strong> {stripLabel(choice)}
                  </span>
                  {(() => {
                    const verdict = getChoiceVerdict(choice);
                    if (!verdict) return null;
                    const ok = verdict === 'correct';
                    const label = ok
                      ? (isSelected ? t('exerciseSession.verdictCorrectChosen') : t('exerciseSession.verdictCorrect'))
                      : t('exerciseSession.verdictWrongChosen');
                    return (
                      <span style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-xs)', marginTop: 2, fontSize: 'var(--font-size-xs)', fontWeight: 700, color: ok ? 'var(--color-success)' : 'var(--color-danger)', whiteSpace: 'nowrap' }}>
                        {ok ? <IconCircleCheck size={16} /> : <IconCircleX size={16} />}
                        {label}
                      </span>
                    );
                  })()}
                </div>
              </button>
            );
          })}
          {(() => {
            const wSelected = selectedAnswers.includes(WAKARANAI);
            const wAnsweredIncorrect = answered && wSelected;
            const wCursor = !isMobile && kbMode && rightActive && !cursorOnNodes && cursorIndex === shuffledChoices.length;
            return (
              <button
                ref={wCursor ? cursorElRef : undefined}
                onClick={() => toggleAnswer(WAKARANAI)}
                disabled={answered}
                style={{
                  padding: 'var(--spacing-sm) var(--spacing-lg)',
                  marginTop: 'var(--spacing-sm)',
                  borderRadius: 'var(--border-radius-md)',
                  cursor: answered ? 'default' : 'pointer',
                  border: `1px ${wSelected ? 'solid' : 'dashed'}`,
                  display: 'flex', alignItems: 'center', width: '100%', textAlign: 'left',
                  fontSize: 'var(--font-size-sm)',
                  transition: 'all 0.15s ease',
                  background: wAnsweredIncorrect ? 'var(--color-feedback-incorrect-bg)' : wSelected ? 'var(--color-bg-main)' : 'transparent',
                  borderColor: wAnsweredIncorrect ? 'var(--color-danger)' : wSelected ? 'var(--color-text-sub)' : 'var(--color-border)',
                  color: wAnsweredIncorrect ? 'var(--color-danger)' : 'var(--color-text-light)',
                  ...((!isMobile && !cursorOnNodes && cursorIndex === shuffledChoices.length) ? { outline: '2px solid var(--color-accent)', outlineOffset: 1 } : {}),
                }}
              >
                <span style={{ marginRight: 10, fontSize: 'var(--font-size-sm)', flexShrink: 0 }}>？</span>
                <span>{WAKARANAI}</span>
              </button>
            );
          })()}
          {/* 問題文＋選択肢のコピー（選択肢の下・左揃え）。
              回答前はここがカード最下部なのでアクション列も一緒に出し、
              回答後は解説の下に同じ列が出るのでここはコピーのみにする
              （♡等の位置が回答の前後で変わらないようにするため）。 */}
          {renderActionRow(() => {
            const choicesText = shuffledChoices.map((c: string, idx: number) => `${CHOICE_LABELS[idx]}. ${stripLabel(c)}`).join('\n');
            return `${currentQuestion.questionText}\n\n${choicesText}`;
          }, !answered)}
        </div>

        <div ref={explAnchorRef} style={{ scrollMarginTop: 56 }} />
        {answered && (() => {
          const displayQ = (currentQuestion.correctAnswers ? currentQuestion : detail) ?? currentQuestion;
          const lastResult = results[results.length - 1];
          if (!displayQ.correctAnswers) {
            return detailFetchFailed ? (
              <div style={{ padding: '12px 16px', marginBottom: 'var(--spacing-xl)', display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ color: 'var(--color-danger)', fontSize: 'var(--font-size-sm)' }}>
                  {lang === 'ja' ? '解説の読み込みに失敗しました。' : 'Failed to load explanation.'}
                </span>
                <button
                  onClick={() => { setDetailFetchFailed(false); setDetail(null); }}
                  style={{ background: 'none', border: '1px solid var(--color-danger)', borderRadius: 'var(--border-radius-md)', padding: '2px 10px', fontSize: 'var(--font-size-xs)', color: 'var(--color-danger)', cursor: 'pointer' }}>
                  {lang === 'ja' ? '再試行' : 'Retry'}
                </button>
              </div>
            ) : (
              <div style={{ padding: '12px 16px', marginBottom: 'var(--spacing-xl)', display: 'flex', alignItems: 'center', gap: 10 }}>
                <div className="sherpa-spinner" style={{ width: 18, height: 18, borderWidth: 2, flexShrink: 0 }} />
                <span style={{ color: 'var(--color-text-light)', fontSize: 'var(--font-size-sm)' }}>
                  {lang === 'ja' ? '解説を読み込み中...' : 'Loading explanation...'}
                </span>
              </div>
            );
          }
          return (
            <div className="fade-slide-in" style={{
              background: lastResult?.isCorrect ? 'var(--color-feedback-correct-bg)' : 'var(--color-feedback-incorrect-bg)',
              border: `1px solid ${lastResult?.isCorrect ? 'var(--color-success)' : 'var(--color-danger)'}`,
              padding: '16px 20px', marginBottom: 'var(--spacing-xl)',
              borderRadius: 'var(--border-radius-md)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--spacing-sm)', gap: 'var(--spacing-md)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)', minWidth: 0 }}>
                  <h3 style={{
                    margin: 0, fontSize: 'var(--font-size-md)',
                    color: lastResult?.isCorrect ? 'var(--color-success)' : 'var(--color-danger)',
                    display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)'
                  }}>
                    {lastResult?.isCorrect
                      ? <><IconCircleCheck size={16} />{t('exerciseSession.correct')}</>
                      : <><IconCircleX size={16} />{t('exerciseSession.incorrect')}</>}
                  </h3>
                  {(() => {
                    // 全ユーザーの実測正答率（回答5件以上で表示・回答後のみ見える位置）
                    const ga = Number(displayQ.globalAttempts ?? currentQuestion.globalAttempts ?? 0);
                    const gc = Number(displayQ.globalCorrect ?? currentQuestion.globalCorrect ?? 0);
                    if (!(ga >= 5)) return null;
                    return (
                      <span
                        title={lang === 'ja' ? `全ユーザーの回答 ${ga}件中 ${gc}件正解` : `${gc} of ${ga} answers correct`}
                        style={{ flexShrink: 0, fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-text-sub)', background: 'var(--color-bg-white)', border: '1px solid var(--color-border)', borderRadius: 'var(--border-radius-sm)', padding: '2px 10px', whiteSpace: 'nowrap' }}
                      >
                        {lang === 'ja' ? `受験者正答率 ${Math.round(gc / ga * 100)}%` : `Global accuracy ${Math.round(gc / ga * 100)}%`}
                      </span>
                    );
                  })()}
                </div>
                {/* 解答解説込みのコピーは解説下のアクション列へ移動した */}
              </div>
              <div style={{ fontSize: 'var(--font-size-base)', lineHeight: 1.6 }}>
                <strong>{t('exerciseSession.explanation')}</strong>
                {(() => {
                  const items = shuffledChoices.map((_: string, di: number) => ({
                    di,
                    origIdx: origIndices[di],
                    label: CHOICE_LABELS[di],
                    isCorrect: toIdxArr(displayQ.correctAnswerIndices).includes(origIndices[di]),
                    expl: (displayQ.choiceExplanations ?? [])[origIndices[di]] ?? '',
                  }));
                  const sorted = [...items.filter(x => x.isCorrect), ...items.filter(x => !x.isCorrect)];
                  return (
                    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 'var(--font-size-base)' }}>
                      {sorted.map(item => (
                        <div key={item.di} style={{ overflowWrap: 'break-word', wordBreak: 'break-word' }}>
                          <span style={{ fontWeight: 700, color: item.isCorrect ? 'var(--color-success)' : 'var(--color-text-sub)', marginRight: 4 }}>
                            {item.label}.{item.isCorrect ? ` (${lang === 'ja' ? '正解' : 'Correct'})` : ''}
                          </span>
                          <span style={{ whiteSpace: 'pre-wrap' }}>{item.expl}</span>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
            </div>
          );
        })()}

        {answerCountError && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 'var(--spacing-sm)', borderTop: '1px solid var(--color-border)' }}>
            <span style={{ color: 'var(--color-danger)', fontSize: 'var(--font-size-sm)' }}>{answerCountError}</span>
          </div>
        )}

        {/* 解説の下のアクション列 [コピー(解説込み)][♡][👍][👎][⋮]（左揃え） */}
        {answered && (() => {
          const displayQ = (currentQuestion.correctAnswers ? currentQuestion : detail) ?? currentQuestion;
          return renderActionRow(() => {
            const choicesText = shuffledChoices.map((c: string, ci: number) => `${CHOICE_LABELS[ci]}. ${stripLabel(c)}`).join('\n');
            const correctLabels = (displayQ.correctAnswers ?? []).map((ca: string) => {
              const si = shuffledChoices.findIndex((c: string) => stripLabel(c) === stripLabel(ca));
              return si >= 0 ? `${CHOICE_LABELS[si]}. ${stripLabel(ca)}` : stripLabel(ca);
            }).join(', ');
            const expl = displayQ.choiceExplanations && displayQ.choiceExplanations.length > 0
              ? displayQ.choiceExplanations.map((e: string, i: number) => `${CHOICE_LABELS[i]}. ${e}`).join('\n')
              : (displayQ.explanation ?? '');
            return `${currentQuestion.questionText}\n\n${choicesText}\n\n${t('exerciseSession.correctAnswer')}${correctLabels}\n\n${t('exerciseSession.explanation')}\n${expl}`;
          }, true);
        })()}

        {/* フッター。通報・途中採点は解説下の ⋮ メニューへ移動した */}
        <div style={{ marginTop: 'var(--spacing-md)', paddingTop: 'var(--spacing-sm)', borderTop: '1px dashed var(--color-border)' }}>
          {/* AI確認情報・問題メタデータ（左寄せ） */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-md)', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-sub)' }}>
            <span>
              {lang === 'ja' ? 'AI確認' : 'AI review'}:{' '}
              {currentQuestion.validityCheckedAt
                ? <strong style={{ color: 'var(--color-success)' }}>✓ {new Date(currentQuestion.validityCheckedAt).toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' })}</strong>
                : <strong>{lang === 'ja' ? '未確認' : 'not reviewed'}</strong>
              }
            </span>
            <span>ID: <strong style={{ color: 'var(--color-text-sub)' }}>{currentQuestion.questionId}</strong></span>
            {qDomainName(currentQuestion) && (
              <span>{lang === 'ja' ? 'ドメイン' : 'Domain'}: <strong style={{ color: 'var(--color-text-sub)' }}>{qDomainName(currentQuestion)}</strong></span>
            )}
          </div>
        </div>
      </Card>

      {heartBurst && (
        <ConfirmBurst x={heartBurst.x} y={heartBurst.y} color={HEART_ACTIVE_COLOR} onDone={() => setHeartBurst(null)} />
      )}

      {reportOpen && (
        <ReportModal
          questionId={currentQuestion.questionId}
          userId={userId}
          lang={lang}
          onClose={() => setReportOpen(false)}
        />
      )}

      {(() => {
        const _waka = selectedAnswers.includes(WAKARANAI);
        const canSubmit = _waka
          ? true
          : currentQuestion.isMultiple && currentQuestion.correctAnswerCount
            ? selectedAnswers.length === currentQuestion.correctAnswerCount
            : selectedAnswers.length > 0;
        return createPortal(
        isMobile ? (
          <div style={{ position: 'fixed', bottom: 56, left: 0, right: 0, zIndex: 150, padding: 'var(--spacing-sm) var(--spacing-md)', display: 'flex', gap: 'var(--spacing-sm)', background: 'var(--color-bg-white)', borderTop: '1px solid var(--color-border)', boxShadow: 'var(--box-shadow-up)' }}>
            {!answered ? (
              <button
                onClick={() => submitAnswer()}
                disabled={!canSubmit}
                style={{ flex: 1, height: 44, border: 'none', borderRadius: 22, background: !canSubmit ? 'var(--color-bg-main)' : 'var(--color-accent)', color: !canSubmit ? 'var(--color-text-light)' : 'var(--color-btn-primary-text)', boxShadow: !canSubmit ? 'inset 0 0 0 1px var(--color-border)' : 'none', fontWeight: 600, fontSize: 'var(--font-size-base)', cursor: !canSubmit ? 'default' : 'pointer' }}
              >
                {t('exerciseSession.answer')}
              </button>
            ) : (
              <button
                onClick={nextQuestion}
                style={{ flex: 1, height: 44, border: 'none', borderRadius: 22, background: 'var(--color-accent)', color: 'var(--color-btn-primary-text)', fontWeight: 600, fontSize: 'var(--font-size-base)', cursor: 'pointer' }}
              >
                {currentIndex + 1 >= totalCount ? t('exerciseSession.showResult') : t('exerciseSession.next')}
              </button>
            )}
          </div>
        ) : (
          <div style={{ position: 'fixed', right: 24, bottom: 24, zIndex: 150, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {!answered ? (
              <button
                onClick={() => submitAnswer()}
                disabled={!canSubmit}
                style={{ height: 44, padding: '0 24px', border: 'none', borderRadius: 22, background: !canSubmit ? 'var(--color-bg-main)' : 'var(--color-accent)', color: !canSubmit ? 'var(--color-text-light)' : 'var(--color-btn-primary-text)', fontWeight: 600, fontSize: 'var(--font-size-base)', cursor: !canSubmit ? 'default' : 'pointer', whiteSpace: 'nowrap', boxShadow: !canSubmit ? 'inset 0 0 0 1px var(--color-border), var(--box-shadow-pop)' : 'var(--box-shadow-pop)', display: 'inline-flex', alignItems: 'center', gap: 8 }}
              >
                {t('exerciseSession.answer')}
                <KeyHint />
              </button>
            ) : (
              <button
                onClick={nextQuestion}
                style={{ height: 44, padding: '0 24px', border: 'none', borderRadius: 22, background: 'var(--color-accent)', color: 'var(--color-btn-primary-text)', fontWeight: 600, fontSize: 'var(--font-size-base)', cursor: 'pointer', whiteSpace: 'nowrap', boxShadow: 'var(--box-shadow-pop)', display: 'inline-flex', alignItems: 'center', gap: 8 }}
              >
                {currentIndex + 1 >= totalCount ? t('exerciseSession.showResult') : t('exerciseSession.next')}
                <KeyHint />
              </button>
            )}
          </div>
        ),
        document.body
        );
      })()}

      {/* コラム（豆知識） */}
      {currentTip && !hideColumn && (
        <div style={{ marginTop: 'var(--spacing-xl)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-md)', marginBottom: 'var(--spacing-sm)' }}>
            <span style={{
              background: 'var(--color-accent)', color: 'var(--color-btn-primary-text)',
              fontSize: 'var(--font-size-2xs)', fontWeight: 700, letterSpacing: '1.5px',
              padding: '3px 10px', borderRadius: 'var(--border-radius-sm)',
            }}>COLUMN</span>
            <span style={{ flex: 1, height: 1, background: 'color-mix(in srgb, var(--color-text-light) 40%, transparent)' }} />
          </div>
          <Card
            padding="var(--spacing-md) var(--spacing-lg)"
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)', marginBottom: 'var(--spacing-sm)' }}>
              <span style={{ color: 'var(--color-accent)', display: 'flex', alignItems: 'center', flexShrink: 0 }}><IconBean size={22} /></span>
              <p style={{ fontWeight: 700, color: 'var(--color-text-main)', margin: 0, fontSize: 'var(--font-size-base)' }}>{currentTip.title}</p>
            </div>
            <p style={{ color: 'var(--color-text-sub)', margin: 0, fontSize: 'var(--font-size-sm)', lineHeight: 1.8 }}>
              {currentTip.content
                .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
                .replace(/\[[^\]]*\]\[\d+\]/g, '')
                .replace(/\(\s*\)/g, '')
                .replace(/\s{2,}/g, ' ')
                .trim()}
            </p>
          </Card>
        </div>
      )}
      {/* 画面下に固定した回答/次へボタンが、最後の内容（解説・コラム）に重ならないための余白 */}
      <div aria-hidden="true" style={{ height: isMobile ? 72 : 80 }} />
    </div>
  );
}
