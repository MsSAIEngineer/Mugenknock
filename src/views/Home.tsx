'use client';
import React, { useEffect, useLayoutEffect, useState, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation } from '@/compat/react-router-dom';
import DailyServiceRevealModal from '../components/DailyServiceRevealModal';
import FeatureUnlockModal from '../components/FeatureUnlockModal';
import ExamSelectOverlay, { ConfirmBurst } from '../components/ExamSelectOverlay';
import StartTutorialSpotlight from '../components/StartTutorialSpotlight';

// 初回オンボーディング完了フラグ（サイト全体で1回だけチュートリアルを出す）
const ONBOARDING_TUTORIAL_KEY = 'mk_onboarding_tutorial_done_v1';
import { useAuth, hadPriorSession } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import {
  API_ENDPOINT, EXAM_TYPES, EXAM_CONFIGS, EXAM_DOMAINS,
  DOMAIN_WEIGHTS, PASS_SCORES, qDomainName, DOMAIN_RATE_WARNING,
  EXAM_LEVEL, EXAM_LEVEL_COLORS, tint,
  tagIdMatches, domainsToIndices, storedDomainsToNames, isNonAwsExam, COMPANION_EXAM, companionLabel, officialExamsForCompanion,
} from '../constants';
import { readDomainResults, readDomainHistory } from '../utils/domainStats';
import { lockBodyScroll } from '../utils/bodyScrollLock';
import { getCached, setCached, deleteCached, deleteCachedByPrefix, DEFAULT_TTL, getCachedPersist, setCachedPersist, deleteCachedPersist } from '../utils/cache';
import { animateLoadPct, randomPlateau } from '../utils/loadProgress';
import { getPoints, deductPoints } from '../utils/points';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import PageLayout from '../components/ui/PageLayout';
import { IconLightbulb, IconBean, IconSettings, IconChevronUp, IconLock, IconFileText, IconTrendingUp, IconBookOpen, IconCheck, IconCircleCheck, IconSparkles, IconPointer, IconMousePointerClick, IconCalendarNotebook, IconRefreshCw, IconTarget, IconChart, ServiceIconImg, isServiceIconKey, IconUser, IconSave, IconSaveCheck, IconExternalLink } from '../components/Icons';
import KeyHint from '../components/KeyHint';
import { CATALOG } from '../data/awsServiceCatalog';
import { autoScoreAndClearDrafts } from '../utils/sessionUtils';
import { hydrateDraftsFromServer } from '../utils/sessionResume';
import { syncTargetExamToServer, loadTargetExamFromServer, resetExercisePrefsOnExamChange } from '../utils/preferences';
import { fetchDailyProgress } from '../utils/dailyProgress';
import { useOhineriGate } from '../utils/useOhineriGate';

// ダッシュボードはワイドモニタで横を使い切れるよう、他ページ(900px)より広く取る。
// デスクトップ固定の開始バーも同じ幅で中央寄せするため定数で共有する。
const HOME_MAX_WIDTH = 1280;

type DomainStat = { tagId: string; correctCount?: number; incorrectCount?: number; recentResults?: boolean[] };
type SessionEntry = { correct: number; total: number };
type DomainHistory = Record<string, SessionEntry[]>;
// w = 記録時の「直近N問」設定。予想スコアは N によって計算が変わる（N問中の正答数で
// 各ドメインの満点が決まる）ため、N の違う点を同じ線に並べると尺度が混ざる。
// 記録時の N を残し、グラフは現在の N と一致するものだけを描く。
// w の無い古い記録は、判別できないので現在の N のものとして扱う。
type ScoreEntry = { date: string; score: number; w?: 5 | 10 };
type WeakQuestion = { questionId: string; questionText: string; correctCount: number; incorrectCount: number };

// ── ユーティリティ ───────────────────────────────────────────────
function getGrade(pct: number | null): string {
  if (pct === null) return '—';
  if (pct >= 100) return 'S'; // 5/5
  if (pct >= 80)  return 'A'; // 4/5
  if (pct >= 60)  return 'B'; // 3/5
  if (pct >= 40)  return 'C'; // 2/5
  return 'D';                  // 0–1/5
}

// ロード進捗を limit に向けて漸近的にアニメーション。返り値はキャンセル関数。

// readDomainResults / readDomainHistory は ../utils/domainStats から import（index 文字列キーに正規化）

function readScoreHistory(examType: string, uid: string): ScoreEntry[] {
  try { return JSON.parse(localStorage.getItem(`score_history_${examType}_${uid}`) ?? '[]'); } catch { return []; }
}

function readSessionScoreHistory(examType: string, uid: string): number[] {
  try { return JSON.parse(localStorage.getItem(`score_session_history_${examType}_${uid}`) ?? '[]'); } catch { return []; }
}

function readSessionScoreLog(examType: string, uid: string): ScoreEntry[] {
  try { return JSON.parse(localStorage.getItem(`score_session_log_${examType}_${uid}`) ?? '[]'); } catch { return []; }
}

// ── スコア折れ線グラフ ───────────────────────────────────────────
function ScoreLineChart({ data, passScore, lang = 'ja', animate = true, isMobile = false }: { data: ScoreEntry[]; passScore: number | null; lang?: string; animate?: boolean; isMobile?: boolean }) {
  if (data.length < 2) {
    return (
      <p style={{ color: 'var(--color-text-light)', fontSize: 'var(--font-size-sm)', fontStyle: 'italic', margin: 0 }}>
        {lang === 'ja' ? '2日分以上のデータが貯まると表示されます' : 'Appears after 2+ days of data'}
      </p>
    );
  }
  // Web版は横幅いっぱいに拡大されて縦・文字が大きくなるため、viewBoxを横長・低めにして拡大率を抑える
  const W = isMobile ? 300 : 470, H = isMobile ? 110 : 100, PL = 36, PR = 28, PT = 20, PB = 22;
  const iW = W - PL - PR, iH = H - PT - PB;
  const scores = data.map(d => d.score);
  const minS = Math.max(0, Math.min(...scores) - 50);
  const maxS = Math.min(1000, Math.max(...scores) + 50);
  const range = maxS - minS || 200;
  // 横軸は日付に比例させる。演習しなかった日は履歴に行が無いので、等間隔で描くと
  // 「10-15 → 10-17」の2日空きが1日分と同じ幅になり、実際の間隔と合わない。
  const dayNo = (s: string) => Math.floor(Date.parse(`${s}T00:00:00Z`) / 86400000);
  const days = data.map(d => dayNo(d.date));
  // 日付が壊れている・並びが逆・全部同日 のときは等間隔に落とす（NaN で描画を壊さない）
  const daysOk = days.every(n => Number.isFinite(n)) && days[days.length - 1] > days[0];
  const daySpan = daysOk ? days[days.length - 1] - days[0] : 1;
  const cx = (i: number) => PL + (daysOk ? (days[i] - days[0]) / daySpan : i / (data.length - 1)) * iW;
  const cy = (s: number) => PT + iH - ((s - minS) / range) * iH;
  const pathD = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${cx(i).toFixed(1)},${cy(d.score).toFixed(1)}`).join(' ');
  const stagger = 0.13, nodeDur = 0.22;
  const totalLength = data.slice(0, -1).reduce((sum, _, i) => {
    const dx = cx(i + 1) - cx(i), dy = cy(data[i + 1].score) - cy(data[i].score);
    return sum + Math.sqrt(dx * dx + dy * dy);
  }, 0);
  const totalLineDur = (data.length - 1) * stagger + nodeDur;
  return (
    <svg key={data.length} width="100%" viewBox={`0 0 ${W} ${H}`} style={{ overflow: 'visible', display: 'block' }}>
      {[minS, maxS].map((s, i) => (
        <text key={i} x={PL - 4} y={i === 0 ? PT + iH + 4 : PT + 4} fontSize={9} fill="var(--color-text-light)" textAnchor="end">{s}</text>
      ))}
      {passScore !== null && passScore >= minS && passScore <= maxS && (
        <>
          <line x1={PL} x2={PL + iW + 8} y1={cy(passScore)} y2={cy(passScore)} stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="4,3" />
          <text x={PL + iW + 10} y={cy(passScore) + 3} fontSize={8} fill="#f59e0b" fontWeight="bold">{lang === 'ja' ? '合格' : 'Pass'}</text>
        </>
      )}
      <path d={pathD} fill="none" stroke="var(--color-primary)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
        strokeDasharray={animate ? totalLength : undefined} strokeDashoffset={animate ? totalLength : 0}>
        {animate && <animate attributeName="stroke-dashoffset" from={String(totalLength)} to="0" dur={`${totalLineDur}s`} fill="freeze" />}
      </path>
      {data.map((d, i) => (
        <g key={i} opacity={animate ? 0 : 1}>
          {animate && <animate attributeName="opacity" from="0" to="1" dur="0.01s" begin={`${i * stagger}s`} fill="freeze" />}
          <text x={cx(i)} y={cy(d.score) - 6} fontSize={8} fill="var(--color-primary)" textAnchor="middle" fontWeight="bold">{d.score}</text>
          <circle cx={cx(i)} cy={cy(d.score)} r={animate ? 0 : 3} fill="var(--color-primary)">
            {animate && <animate attributeName="r" values="0;4;3" keyTimes="0;0.65;1" dur={`${nodeDur}s`} begin={`${i * stagger}s`} fill="freeze" />}
          </circle>
        </g>
      ))}
      <text x={cx(0)} y={H - 2} fontSize={9} fill="var(--color-text-light)" textAnchor="middle">{data[0].date.slice(5)}</text>
      <text x={cx(data.length - 1)} y={H - 2} fontSize={9} fill="var(--color-text-light)" textAnchor="middle">{data[data.length - 1].date.slice(5)}</text>
    </svg>
  );
}

function SessionScoreChart({ data, passScore, lang = 'ja', animate = true, isMobile = false }: { data: number[]; passScore: number | null; lang?: string; animate?: boolean; isMobile?: boolean }) {
  if (data.length < 2) {
    return (
      <p style={{ color: 'var(--color-text-light)', fontSize: 'var(--font-size-sm)', fontStyle: 'italic', margin: 0 }}>
        {lang === 'ja' ? '2回分以上のデータが貯まると表示されます' : 'Appears after 2+ sessions of data'}
      </p>
    );
  }
  // Web版は横幅いっぱいに拡大されて縦・文字が大きくなるため、viewBoxを横長・低めにして拡大率を抑える
  const W = isMobile ? 300 : 470, H = isMobile ? 90 : 84, PL = 36, PR = 28, PT = 20, PB = 18;
  const iW = W - PL - PR, iH = H - PT - PB;
  const minS = Math.max(0, Math.min(...data) - 50);
  const maxS = Math.min(1000, Math.max(...data) + 50);
  const range = maxS - minS || 200;
  const cx = (i: number) => PL + (i / (data.length - 1)) * iW;
  const cy = (s: number) => PT + iH - ((s - minS) / range) * iH;
  const pathD = data.map((s, i) => `${i === 0 ? 'M' : 'L'}${cx(i).toFixed(1)},${cy(s).toFixed(1)}`).join(' ');
  const stagger2 = 0.13, nodeDur2 = 0.22;
  const totalLength2 = data.slice(0, -1).reduce((sum, _, i) => {
    const dx = cx(i + 1) - cx(i), dy = cy(data[i + 1]) - cy(data[i]);
    return sum + Math.sqrt(dx * dx + dy * dy);
  }, 0);
  const totalLineDur2 = (data.length - 1) * stagger2 + nodeDur2;
  return (
    <svg key={data.length} width="100%" viewBox={`0 0 ${W} ${H}`} style={{ overflow: 'visible', display: 'block' }}>
      {[minS, maxS].map((s, i) => (
        <text key={i} x={PL - 4} y={i === 0 ? PT + iH + 4 : PT + 4} fontSize={9} fill="var(--color-text-light)" textAnchor="end">{s}</text>
      ))}
      {passScore !== null && passScore >= minS && passScore <= maxS && (
        <>
          <line x1={PL} x2={PL + iW + 8} y1={cy(passScore)} y2={cy(passScore)} stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="4,3" />
          <text x={PL + iW + 10} y={cy(passScore) + 3} fontSize={8} fill="#f59e0b" fontWeight="bold">{lang === 'ja' ? '合格' : 'Pass'}</text>
        </>
      )}
      <path d={pathD} fill="none" stroke="var(--color-accent)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
        strokeDasharray={animate ? totalLength2 : undefined} strokeDashoffset={animate ? totalLength2 : 0}>
        {animate && <animate attributeName="stroke-dashoffset" from={String(totalLength2)} to="0" dur={`${totalLineDur2}s`} fill="freeze" />}
      </path>
      {data.map((s, i) => (
        <g key={i} opacity={animate ? 0 : 1}>
          {animate && <animate attributeName="opacity" from="0" to="1" dur="0.01s" begin={`${i * stagger2}s`} fill="freeze" />}
          <text x={cx(i)} y={cy(s) - 6} fontSize={8} fill="var(--color-accent)" textAnchor="middle" fontWeight="bold">{s}</text>
          <circle cx={cx(i)} cy={cy(s)} r={animate ? 0 : 3} fill="var(--color-accent)">
            {animate && <animate attributeName="r" values="0;4;3" keyTimes="0;0.65;1" dur={`${nodeDur2}s`} begin={`${i * stagger2}s`} fill="freeze" />}
          </circle>
          {i === data.length - 1 && (
            <text x={cx(i)} y={H - 2} fontSize={9} fill="var(--color-text-sub)" textAnchor="middle" fontWeight="bold">{lang === 'ja' ? '最新' : 'Latest'}</text>
          )}
          {i === 0 && (
            <text x={cx(i)} y={H - 2} fontSize={9} fill="var(--color-text-light)" textAnchor="middle">{`-${data.length - 1}`}</text>
          )}
        </g>
      ))}
    </svg>
  );
}

// ── 成績詳細モーダル（ドメイン別 + 予想スコア 統合） ───────────
function CombinedDetailModal({ targetExam, domainAccList, estimatedScore, passScore, lang, isMobile, uid, domainStats, scoreHistory: serverScoreHistory, sessionScoreLog: serverSessionScoreLog, nodeWindow, onNodeWindowChange, inline = false, onClose }: {
  targetExam: string;
  domainAccList: { correct: number; total: number; pct: number | null }[];
  estimatedScore: number | null;
  passScore: number | null;
  lang: string;
  isMobile: boolean;
  uid: string;
  domainStats: DomainStat[];
  scoreHistory?: ScoreEntry[];
  sessionScoreLog?: ScoreEntry[];
  nodeWindow: 5 | 10;
  onNodeWindowChange: (w: 5 | 10) => void;
  // モーダル(背景オーバーレイ・✕ボタン・スクロールロック・タブ)を出さず、
  // 指定セクションだけをページ内に直接描画する（デスクトップの常時展開表示用）。
  //   'score' … 予想スコア＋ドメイン別スコア内訳（=「実力の現在地」パネル）
  //   'trend' … スコア推移＋ハイスコア記録を縦に並べる（=「推移と記録」パネル）
  // タブでの出し分けをやめ、役割ごとに別パネルへ分けるための prop。
  inline?: false | 'score' | 'trend';
  onClose?: () => void;
}) {
  const ja = lang === 'ja';
  const domains = EXAM_DOMAINS[targetExam] ?? [];
  const history = serverScoreHistory ?? readScoreHistory(targetExam, uid);
  const sessionLog = serverSessionScoreLog ?? readSessionScoreLog(targetExam, uid);
  // 記録時の「直近N問」設定が今と違う点は尺度が違うので描かない（w 無しの古い記録は現在のNとみなす）
  const sameWindow = (e: ScoreEntry) => (e.w ?? nodeWindow) === nodeWindow;
  // セッション別＝直近10回 / 日次最高点＝直近1週間（7日）
  // セッション別は w を持てる sessionScoreLog から取る（sessionScoreHistory は素の数値配列で
  // 記録時のNを判別できない。中身は log の末尾10件と一致する）。
  const sessionLast10 = sessionLog.filter(sameWindow).slice(-10).map(e => e.score);
  const dailyMaxLast7 = (() => {
    const wk = new Date(Date.now() + 9 * 3600 * 1000 - 6 * 86400000).toISOString().slice(0, 10);
    return history.filter(h => (h.date || '') >= wk && sameWindow(h));
  })();
  const [showCalc, setShowCalc] = useState(false);
  const [tab, setTab] = useState<'score' | 'history' | 'hiscore'>('score');
  const scoreTabRef = useRef<HTMLDivElement>(null);
  const [contentMinH, setContentMinH] = useState(0);
  // ノード出現アニメーション制御: 各ノードを「右端からの距離 dk=(nodeWindow-1-ni)」で識別し、
  // アニメ文字列を初出時に一度だけ確定して固定する（再レンダーで再計算＝中断/再発火しない）。
  // 5→10拡張時は新規(左側)のみ右→左で表示、既存(右5個)は前回の文字列を再利用＝再生されない。
  const prevWindowRef = useRef(nodeWindow);
  const animStyleRef = useRef<Map<number, string>>(new Map());
  // アニメ完了済みノード(dk)。タブ切替で戻っても再生しない（開き直し=モーダル再マウントでのみリセット）。
  const playedRef = useRef<Set<number>>(new Set());
  const visitedTabs = useRef(new Set<string>(['score']));

  // スコアタブ（calc非表示時）の高さを記録してタブ切替でサイズが変わらないようにする
  useLayoutEffect(() => {
    if (inline) return; // インラインはタブ切替が無いので高さ固定不要
    if (tab === 'score' && !showCalc && scoreTabRef.current) {
      setContentMinH(scoreTabRef.current.offsetHeight);
    }
  }, [tab, showCalc, inline]);

  useEffect(() => {
    if (inline) return; // インライン表示（常時展開）はモーダルではないのでスクロールロック不要
    return lockBodyScroll();
  }, [inline]);

  // レンダー後に prevWindow と animated を更新。非表示になったノード(dk>=nodeWindow)は
  // 再表示時にまたアニメさせるため animated から外す。表示中の dk は animated に登録。
  useEffect(() => {
    prevWindowRef.current = nodeWindow;
    // 非表示になったノード(dk>=nodeWindow)は再表示時にまたアニメさせるため記録を破棄。
    const m = animStyleRef.current;
    for (const k of [...m.keys()]) if (k >= nodeWindow) m.delete(k);
    for (const k of [...playedRef.current]) if (k >= nodeWindow) playedRef.current.delete(k);
  }, [nodeWindow]);

  useEffect(() => {
    visitedTabs.current.add(tab);
  }, [tab]);

  const weights = DOMAIN_WEIGHTS[targetExam] ?? domains.map(() => 100 / domains.length);
  const totalAllWeights = weights.reduce((s, w) => s + w, 0) || 100;
  const localDomainResults = readDomainResults(targetExam, uid);

  const tabs = [
    { key: 'score' as const, label: ja ? 'スコア内訳' : 'Breakdown' },
    { key: 'history' as const, label: ja ? 'スコア推移' : 'History' },
    { key: 'hiscore' as const, label: ja ? 'ハイスコア記録' : 'High Scores' },
  ];

  // インライン表示ではタブを使わず、指定セクションを直接出す。
  const showScore = inline ? inline === 'score' : tab === 'score';
  const showHistory = inline ? inline === 'trend' : tab === 'history';
  const showHiscore = inline ? inline === 'trend' : tab === 'hiscore';

  const body = (
    <>
        {/* ヘッダー行（インラインはパネル側が見出しを持つので出さない。
            ただしスコア内訳の「?」計算方法だけはインラインでも必要なので残す） */}
        {!inline ? (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 'var(--font-size-base)', color: 'var(--color-text-main)' }}>
                {ja ? '成績詳細' : 'Performance Detail'}
              </span>
              {tab === 'score' && (
                <button
                  data-kbnav="1"
                  onClick={() => setShowCalc(v => !v)}
                  style={{ width: 20, height: 20, borderRadius: '50%', border: `1.5px solid ${showCalc ? 'var(--color-primary)' : 'var(--color-border)'}`, background: showCalc ? 'var(--color-primary)' : 'transparent', color: showCalc ? '#fff' : 'var(--color-text-light)', fontSize: 'var(--font-size-xs)', fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, lineHeight: 1 }}
                  aria-label={ja ? '計算方法' : 'How calculated'}
                >?</button>
              )}
            </div>
            <button data-kbclose="1" onClick={onClose} style={{ border: 'none', background: 'none', fontSize: 'var(--font-size-h3)', cursor: 'pointer', color: 'var(--color-text-sub)', padding: '0 4px', lineHeight: 1 }}>✕</button>
          </div>
        ) : null}

        {/* タブ（インラインでは役割ごとに別パネルへ分けるため出さない） */}
        {!inline && (
        <div style={{ display: 'flex', gap: isMobile ? 4 : 0, marginBottom: 16, borderBottom: '1px solid var(--color-border)', paddingBottom: 0 }}>
          {tabs.map(t => (
            <button
              key={t.key}
              data-kbnav="tab"
              data-kbtab-active={tab === t.key ? '1' : undefined}
              onClick={() => { setTab(t.key); setShowCalc(false); }}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                flex: isMobile ? undefined : 1,
                textAlign: isMobile ? undefined : 'center',
                padding: '6px 14px', fontSize: 'var(--font-size-sm2)', fontWeight: tab === t.key ? 700 : 400,
                color: tab === t.key ? 'var(--color-primary)' : 'var(--color-text-sub)',
                borderBottom: `2px solid ${tab === t.key ? 'var(--color-primary)' : 'transparent'}`,
                marginBottom: -1, transition: 'color 0.15s',
              }}
            >{t.label}</button>
          ))}
        </div>
        )}

        {/* 計算方法 */}
        {showScore && showCalc && (
          <div style={{ background: 'var(--color-bg-main)', borderRadius: 8, padding: '10px 12px', marginBottom: 16, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-sub)', lineHeight: 1.7 }}>
            <p style={{ margin: 0 }}>
              {ja
                ? `直近セッションの回答を集計。各ドメインの上限${nodeWindow}問分で算出（${nodeWindow}問未満は正答率×(N/${nodeWindow})で計算）。未演習ドメインは0点扱い。スコア = Σ(正答率 × N/${nodeWindow} × 出題比率%) × 1000`
                : `Based on recent sessions. Score = Σ(accuracy × min(N,${nodeWindow})/${nodeWindow} × domain_weight%) × 1000. Fewer than ${nodeWindow} answers reduces the max contribution. Unpracticed domains count as 0.`}
            </p>
          </div>
        )}

        {/* タブコンテンツ（インラインは showScore / showHistory+showHiscore で出し分け） */}
        <div style={{ minHeight: inline ? undefined : (contentMinH || undefined) }}>
        {showScore && (
          <div ref={scoreTabRef}>
            <style>{`@keyframes scoreNodePop { from { opacity: 0; transform: scale(0.3); } to { opacity: 1; transform: scale(1); } }`}</style>
            <div style={{ marginBottom: 16 }}>
              {/* 未演習のときは大きな「—」が青い線に見えて壊れた表示に見えたので、文で示す */}
              {estimatedScore == null ? (
                <span style={{ fontSize: 'var(--font-size-base)', color: 'var(--color-text-sub)' }}>
                  {ja ? '演習すると予想スコアが表示されます' : 'Practice to see your estimated score'}
                </span>
              ) : (<>
              <span style={{ fontSize: 36, fontWeight: 800, color: 'var(--color-primary)', letterSpacing: '-1px' }}>{estimatedScore}</span>
              <span style={{ fontSize: 'var(--font-size-sm2)', color: 'var(--color-text-light)', marginLeft: 6 }}>/1000</span>
              </>)}
              {passScore !== null && (
                <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)', marginLeft: 10 }}>
                  {ja ? `合格ライン: ${passScore}` : `Pass: ${passScore}`}
                </span>
              )}
            </div>
            <div style={{ background: 'var(--color-bg-main)', borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-text-sub)', letterSpacing: '0.5px' }}>
                  {ja ? 'ドメイン別スコア内訳' : 'Score by Domain'}
                  {/* インラインではヘッダー行を出さないので、計算方法の「?」をここに置く */}
                  {inline && (
                    <button
                      data-kbnav="1"
                      onClick={() => setShowCalc(v => !v)}
                      style={{ width: 18, height: 18, borderRadius: '50%', border: `1.5px solid ${showCalc ? 'var(--color-primary)' : 'var(--color-border)'}`, background: showCalc ? 'var(--color-primary)' : 'transparent', color: showCalc ? '#fff' : 'var(--color-text-light)', fontSize: 'var(--font-size-2xs)', fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, lineHeight: 1, padding: 0 }}
                      aria-label={ja ? '計算方法' : 'How calculated'}
                    >?</button>
                  )}
                </span>
                <div style={{ display: 'inline-flex', border: '1px solid var(--color-border)', borderRadius: 'var(--border-radius-md)', overflow: 'hidden' }}>
                  {([5, 10] as const).map(w => {
                    const active = nodeWindow === w;
                    return (
                      <button key={w} onClick={() => onNodeWindowChange(w)}
                        style={{ border: 'none', borderLeft: w === 5 ? 'none' : '1px solid var(--color-border)', background: active ? 'var(--color-primary)' : 'transparent', color: active ? 'var(--color-on-primary)' : 'var(--color-text-sub)', fontSize: 'var(--font-size-xs)', fontWeight: 700, padding: '3px 10px', cursor: 'pointer', transition: 'background 0.15s' }}>
                        {ja ? `直近${w}回` : `Last ${w}`}
                      </button>
                    );
                  })}
                </div>
              </div>
              {domains.map((d, i) => {
                const fullMaxPts = Math.round(weights[i] / totalAllWeights * 1000);
                const label = d;
                const serverResults = domainStats.find(s => tagIdMatches(s.tagId, targetExam, i))?.recentResults;
                const nodeResults = (serverResults ?? localDomainResults[String(i)] ?? []).slice(-nodeWindow);
                const paddedNodes: (boolean | null)[] = [...Array(nodeWindow - nodeResults.length).fill(null), ...nodeResults];
                const correctInNodes = nodeResults.filter(v => !!v).length;
                const curPts = Math.round(correctInNodes / nodeWindow * fullMaxPts);
                const hasPracticed = nodeResults.length > 0;
                const formulaStr = hasPracticed ? `${fullMaxPts}×${correctInNodes}/${nodeWindow}` : null;
                return (
                  <div key={d} style={{ marginBottom: 12 }}>
                    {/* ドメイン名 */}
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, minWidth: 0, marginBottom: 5 }}>
                      <span style={{ fontSize: 'var(--font-size-2xs)', fontWeight: 700, color: 'var(--color-text-light)', flexShrink: 0 }}>D{i + 1}</span>
                      <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-main)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{label}</span>
                    </div>
                    {/* ノード行 */}
                    <div style={{ display: 'flex', alignItems: 'center' }}>
                      {paddedNodes.map((correct, ni) => {
                        const dk = nodeWindow - 1 - ni;                      // 右端からの距離
                        // 完了済みノードは再生しない（タブ切替で戻っても静止）。
                        // 未完了ノードのアニメ文字列は初出時に一度だけ確定して固定（再レンダーで中断/再発火させない）。
                        let nodeAnim: string;
                        if (playedRef.current.has(dk)) {
                          nodeAnim = 'none';
                        } else {
                          const cached = animStyleRef.current.get(dk);
                          if (cached !== undefined) {
                            nodeAnim = cached;
                          } else {
                            const isExpand = nodeWindow > prevWindowRef.current;  // 直近5→10へ拡張中か
                            const expandNewCount = isExpand ? nodeWindow - prevWindowRef.current : 0;
                            // 拡張時の新規は右→左、通常(初回)は左→右。
                            const delay = isExpand ? Math.max(0, expandNewCount - 1 - ni) * 70 : ni * 70;
                            nodeAnim = `scoreNodePop 0.22s ease ${delay}ms both`;
                            animStyleRef.current.set(dk, nodeAnim);
                          }
                        }
                        return (
                        <React.Fragment key={dk}>
                          {ni === 0
                            ? <div style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
                                <div style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
                                  {[1, 1.5, 2, 2.5, 3].map((dash, idx) => (
                                    <div key={idx} style={{ flex: 1, height: 1.5, background: `repeating-linear-gradient(to right, #AEBCBD 0px, #AEBCBD ${dash}px, transparent ${dash}px, transparent ${dash + 3}px)` }} />
                                  ))}
                                </div>
                                <div style={{ flex: 1, height: 1.5, background: '#AEBCBD' }} />
                              </div>
                            : <div style={{ flex: 1, height: 1.5, background: '#AEBCBD' }} />
                          }
                          <div
                            onAnimationEnd={() => { playedRef.current.add(dk); }}
                            style={{
                            width: 14, height: 14, borderRadius: '50%', flexShrink: 0,
                            border: `1.5px solid ${correct === null ? '#AEBCBD' : correct ? 'var(--color-success)' : 'var(--color-danger)'}`,
                            background: correct === null ? 'transparent' : correct ? 'var(--color-feedback-correct-bg)' : 'var(--color-feedback-incorrect-bg)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: 8, fontWeight: 700, lineHeight: 1,
                            color: correct === null ? '#AEBCBD' : correct ? 'var(--color-success)' : 'var(--color-danger)',
                            animation: nodeAnim,
                          }}>
                            {correct === null ? <span style={{ fontSize: 8, lineHeight: 1 }}>−</span>
                              : correct
                              ? <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                              : <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                            }
                          </div>
                        </React.Fragment>
                        );
                      })}
                    </div>
                    {/* 計算式=点数/合計（右揃え・横並び） */}
                    <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'baseline', marginTop: 3 }}>
                      {formulaStr
                        ? <span style={{ fontSize: 'var(--font-size-3xs)', color: 'var(--color-text-light)' }}>
                            {formulaStr} = <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-primary)' }}>{curPts}</span> /{fullMaxPts}
                          </span>
                        : <span style={{ fontSize: 'var(--font-size-3xs)', color: 'var(--color-text-light)' }}>—</span>
                      }
                    </div>
                  </div>
                );
              })}
              <div style={{ borderTop: '1px solid var(--color-border)', marginTop: 6, paddingTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-text-sub)' }}>{ja ? '合計' : 'Total'}</span>
                <div>
                  <span style={{ fontSize: 'var(--font-size-md)', fontWeight: 800, color: 'var(--color-primary)' }}>{estimatedScore ?? 0}</span>
                  <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)' }}> / 1000</span>
                </div>
              </div>
            </div>
          </div>
        )}
        {showHistory && (
          <div>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-text-sub)', marginBottom: 8 }}>
                {ja ? 'セッション別推移（直近10回）' : 'Per-Session Trend (last 10)'}
              </div>
              <SessionScoreChart data={sessionLast10} passScore={passScore} lang={lang} animate={!visitedTabs.current.has('history')} isMobile={isMobile} />
            </div>
            <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 12 }}>
              <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-text-sub)', marginBottom: 8 }}>
                {ja ? '日次最高点推移（直近1週間）' : 'Daily Best (last 7 days)'}
              </div>
              <ScoreLineChart data={dailyMaxLast7} passScore={passScore} lang={lang} animate={!visitedTabs.current.has('history')} isMobile={isMobile} />
            </div>
          </div>
        )}
        {/* インラインでは推移の下にハイスコアを続けて出す（タブ廃止のため） */}
        {showHiscore && (
          <div style={inline ? { borderTop: '1px solid var(--color-border)', marginTop: 14, paddingTop: 14 } : undefined}>
            {inline && (
              <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-text-sub)', marginBottom: 8 }}>
                {ja ? 'ハイスコア記録' : 'High Scores'}
              </div>
            )}
          {(() => {
            const hiscoreSource = sessionLog.length > 0 ? sessionLog : history;
            const top5 = [...hiscoreSource].sort((a, b) => b.score - a.score).slice(0, 5);
            if (top5.length === 0) {
              return (
                <p style={{ margin: 0, textAlign: 'center', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-light)', padding: '24px 0' }}>
                  {ja ? 'まだデータがありません' : 'No data yet'}
                </p>
              );
            }
            const medalEmoji = ['🥇', '🥈', '🥉'];
            return (
              <>
                <style>{`
                  @keyframes hiscore-slide-up {
                    from { opacity: 0; transform: translateY(18px); }
                    to   { opacity: 1; transform: translateY(0); }
                  }
                `}</style>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {top5.map((entry, rank) => {
                  const medalColor = rank === 0 ? '#F59E0B' : rank === 1 ? '#9CA3AF' : rank === 2 ? '#B45309' : 'var(--color-text-light)';
                  const isPass = passScore !== null && entry.score >= passScore;
                  const delay = (top5.length - 1 - rank) * 0.08;
                  return (
                    <div key={entry.date} style={{
                      display: 'flex', alignItems: 'center', gap: 12,
                      padding: '10px 12px',
                      background: rank === 0 ? 'rgba(245,158,11,0.06)' : 'var(--color-bg-main)',
                      borderRadius: 8,
                      border: rank === 0 ? '1px solid rgba(245,158,11,0.2)' : '1px solid transparent',
                      ...(visitedTabs.current.has('hiscore')
                        ? {}
                        : { animation: `hiscore-slide-up 0.35s ease both`, animationDelay: `${delay}s` }),
                    }}>
                      <span style={{ fontSize: 'var(--font-size-lg)', fontWeight: 900, color: medalColor, minWidth: 24, textAlign: 'center' }}>
                        {rank < 3 ? medalEmoji[rank] : `${rank + 1}`}
                      </span>
                      <span style={{ fontSize: 'var(--font-size-h2)', fontWeight: 800, color: isPass ? 'var(--color-success)' : 'var(--color-primary)', fontVariantNumeric: 'tabular-nums', minWidth: 52 }}>
                        {entry.score}
                      </span>
                      <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)', flex: 1 }}>
                        {entry.date}
                      </span>
                      {passScore !== null && (
                        <span style={{ fontSize: 'var(--font-size-2xs)', fontWeight: 700, padding: '2px 8px', borderRadius: 'var(--border-radius-sm)', flexShrink: 0,
                          background: isPass ? 'rgba(22,163,74,0.1)' : 'rgba(220,38,38,0.1)',
                          color: isPass ? 'var(--color-success)' : 'var(--color-danger)',
                        }}>
                          {isPass ? (ja ? '合格圏' : 'Pass') : (ja ? '未達' : 'Fail')}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
              </>
            );
          })()}
          </div>
        )}
        </div>
        {isMobile && !inline && <div style={{ height: 16 }} aria-hidden="true" />}
    </>
  );

  if (inline) {
    return body;
  }

  return (
    <div
      data-kbscope="1" role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose?.(); }}
      onTouchStart={e => e.stopPropagation()}
      onTouchMove={e => e.stopPropagation()}
    >
      <div style={{ background: 'var(--color-bg-white)', borderRadius: 'var(--border-radius-lg)', padding: isMobile ? '16px 16px 0' : '20px 28px', width: '100%', maxWidth: 540, maxHeight: isMobile ? '75vh' : '60vh', overflowY: 'auto', boxShadow: 'var(--box-shadow-lg)' }}>
        {body}
      </div>
    </div>
  );
}

// ── 日めくりAWSサービス ─────────────────────────────────────────
// ── オンボーディング ────────────────────────────────────────────
const OB_LEVEL: Record<string, string> = {
  CLF: 'Foundational', AIF: 'Foundational',
  AIB: 'Business',
  SAA: 'Associate', DVA: 'Associate', SOA: 'Associate', DEA: 'Associate', MLA: 'Associate',
  SAP: 'Professional', DOP: 'Professional', AIP: 'Professional',
  ANS: 'Specialty', SCS: 'Specialty',
  ML: 'Additional', DB: 'Additional', NW: 'Additional', SEC: 'Additional',
};
const OB_LEVEL_COLOR = EXAM_LEVEL_COLORS;
const OB_SHORT: Record<string, string> = {
  CLF: 'Cloud Practitioner', AIF: 'AI Practitioner',
  AIB: 'AI Business Strategist',
  SAA: 'Solutions Architect', DVA: 'Developer',
  SOA: 'CloudOps Engineer', DEA: 'Data Engineer', MLA: 'ML Engineer',
  SAP: 'Solutions Architect Pro', DOP: 'DevOps Engineer', AIP: 'Generative AI Dev',
  ANS: 'Advanced Networking', SCS: 'Security',
  ML: 'Machine Learning', DB: 'Database', NW: 'Networking', SEC: 'Security',
};

function OnboardingModal({ lang, uid, onComplete }: {
  lang: string; uid: string;
  onComplete: (exam: string) => void;
}) {
  const ja = lang === 'ja';
  const { user } = useAuth();
  const navigate = useNavigate();

  const handleSelect = (exam: string) => {
    resetExercisePrefsOnExamChange(uid, localStorage.getItem(`targetExam_${uid}`), exam);
    localStorage.setItem(`targetExam_${uid}`, exam);
    window.dispatchEvent(new CustomEvent('targetExamChanged', { detail: exam }));
    onComplete(exam);
  };

  const levels = ['Foundational', 'Business', 'Associate', 'Professional', 'Specialty', 'Additional'] as const;
  const grouped = levels.map(lv => ({
    lv,
    exams: EXAM_TYPES.filter(e => OB_LEVEL[e] === lv),
  }));

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 9800, background: 'var(--color-bg-main)', display: 'flex', flexDirection: 'column' }}>

      {/* ── ヘッダー（アカウントボタンのみ） ── */}
      <header style={{ height: 56, minHeight: 56, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', padding: '0 var(--spacing-lg)', borderBottom: '1px solid var(--color-border)', background: 'var(--color-bg-white)', flexShrink: 0 }}>
        <button
          onClick={() => navigate(user ? '/account' : '/login')}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: user ? 'var(--color-primary-light)' : 'transparent', border: '1px solid var(--color-border)', borderRadius: '50%', cursor: 'pointer', color: user ? 'var(--color-primary)' : 'var(--color-text-sub)', width: 36, height: 36, padding: 0, fontSize: 'var(--font-size-base)', fontWeight: 700 }}
        >
          {user?.email ? user.email[0].toUpperCase() : <IconUser />}
        </button>
      </header>

      {/* ── 資格選択 ── */}
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '32px 24px 0', maxWidth: 560, margin: '0 auto', width: '100%', paddingBottom: 32 }}>
          <h2 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 800, color: 'var(--color-text-main)', margin: '0 0 6px' }}>
            {ja ? '目指すAWS資格を選んでください' : 'Select your target exam'}
          </h2>
          <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', margin: '0 0 20px' }}>
            {ja ? '後からホーム画面でいつでも変更できます' : 'You can change this anytime on the home screen'}
          </p>

          {grouped.map(({ lv, exams }) => (
            <div key={lv} style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: OB_LEVEL_COLOR[lv], marginBottom: 8 }}>
                {lv === 'Additional' ? (ja ? '🧩 基礎知識（AWS認定外）' : '🧩 Original (not AWS certifications)') : lv}
              </div>
              {lv === 'Additional' && (
                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)', marginTop: -4, marginBottom: 8, lineHeight: 1.5 }}>
                  {ja ? 'AWS認定ではなく、各資格の前提となる基礎知識を補う自作カードです' : 'Not AWS certifications — original cards to build the foundational knowledge each exam assumes'}
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {exams.map(exam => {
                  const cfg = EXAM_CONFIGS[exam];
                  const nonAws = isNonAwsExam(exam);
                  return (
                    <button
                      key={exam}
                      onClick={() => handleSelect(exam)}
                      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderRadius: 10, cursor: 'pointer', textAlign: 'left', background: nonAws ? tint(OB_LEVEL_COLOR.Additional, 6) : 'var(--color-bg-card)', border: `2px ${nonAws ? 'dashed' : 'solid'} ${nonAws ? OB_LEVEL_COLOR.Additional : 'var(--color-border)'}`, transition: 'border-color .15s, background .15s' }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontWeight: 700, fontSize: 'var(--font-size-sm2)', color: 'var(--color-text-main)' }}>{cfg.examCode}</span>
                          {nonAws && (
                            <span style={{ fontSize: 9, fontWeight: 800, color: OB_LEVEL_COLOR.Additional, border: `1px dashed ${OB_LEVEL_COLOR.Additional}`, borderRadius: 'var(--border-radius-sm)', padding: '0 5px' }}>非公式</span>
                          )}
                        </div>
                        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-sub)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{OB_SHORT[exam]}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

    </div>,
    document.body
  );
}


type DailyService = {
  serviceId: string; name: string; shortName?: string; category?: string;
  icon: string; description: string; trivia?: string; docUrl?: string;
  contentCheckedAt?: string;
};

function resolveServiceIcon(service: DailyService): string {
  const icon = service.icon ?? '';
  if (icon.startsWith('/') || icon.startsWith('http') || isServiceIconKey(icon)) return icon;
  const norm = (n: string) => n.toLowerCase().replace(/^(amazon|aws)\s+/i, '').trim();
  const lower = service.name.toLowerCase();
  const normLower = norm(lower);
  for (const cat of CATALOG) {
    const entry = cat.services.find(s => {
      const sl = s.name.toLowerCase();
      return sl === lower || norm(sl) === normLower;
    });
    if (entry?.icon) return entry.icon;
  }
  return icon;
}

function saveToEncyclopedia(svc: DailyService, uid: string) {
  try {
    const jstDate = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

    const stored = JSON.parse(localStorage.getItem('encyclopediaServices') ?? '{}');
    stored[svc.serviceId] = svc;
    localStorage.setItem('encyclopediaServices', JSON.stringify(stored));

    const unlocked = JSON.parse(localStorage.getItem(`encyclopediaUnlocked_${uid}`) ?? '{}');
    unlocked[svc.serviceId] = jstDate;
    // カタログのserviceIdsとも照合してIDを統一（UUID vs svc-xxx-N 不一致を解消）
    const normName = (n: string) => n.toLowerCase().replace(/^amazon\s+/, '').replace(/^aws\s+/, '').trim();
    const normSvc = normName(svc.name);
    for (const cat of CATALOG) {
      for (const entry of cat.services) {
        if (
          entry.serviceIds?.includes(svc.serviceId) ||
          normName(entry.name) === normSvc
        ) {
          for (const catId of (entry.serviceIds ?? [])) {
            unlocked[catId] = jstDate;
          }
          break;
        }
      }
    }
    localStorage.setItem(`encyclopediaUnlocked_${uid}`, JSON.stringify(unlocked));

    if (localStorage.getItem(`encyclopediaUnlockDate_${uid}`) !== jstDate) {
      localStorage.setItem(`encyclopediaUnlockDate_${uid}`, jstDate);
    }

    localStorage.setItem(`encyclopediaTodayServiceId_${uid}`, svc.serviceId);

    window.dispatchEvent(new CustomEvent('encyclopediaUpdated'));
  } catch {}
}

// forceUpload=true: ユーザーの明示的な解放操作（handleReveal）からの呼び出し。
// 管理者リセット後でも新しい解放はサーバーに保存する。
// forceUpload=false（デフォルト）: マウント時の自動同期。サーバーが空なら
// 管理者リセット後とみなしてローカルも消去し再アップロードしない。
function syncEncyclopediaToServer(userId: string, forceUpload = false): void {
  const uid = userId;
  try {
    const local: Record<string, string> = JSON.parse(localStorage.getItem(`encyclopediaUnlocked_${uid}`) ?? '{}');
    const unlockDate = localStorage.getItem(`encyclopediaUnlockDate_${uid}`);
    const todayServiceId = localStorage.getItem(`encyclopediaTodayServiceId_${uid}`);
    // 解放状態をサーバーへ保存（GET失敗時もローカルの解放を必ず保存する）
    const postUnlocks = (unlocksToSave: Record<string, string>, retriesLeft: number) => {
      const body = JSON.stringify({ userId, unlocks: unlocksToSave, unlockDate, todayServiceId });
      fetch(`${API_ENDPOINT}/users/me/encyclopedia-unlocks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      }).then(r => { if (!r.ok && retriesLeft > 0) setTimeout(() => postUnlocks(unlocksToSave, retriesLeft - 1), 3000); })
        .catch(() => { if (retriesLeft > 0) setTimeout(() => postUnlocks(unlocksToSave, retriesLeft - 1), 3000); });
    };
    fetch(`${API_ENDPOINT}/users/me/encyclopedia-unlocks?userId=${encodeURIComponent(userId)}`)
      .then(r => r.ok ? r.json() : { unlocks: {} })
      .then(data => {
        const server: Record<string, string> = data.unlocks ?? {};
        const localUnlockDate = localStorage.getItem(`encyclopediaUnlockDate_${uid}`);
        const jstDateNow = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
        if (!forceUpload && Object.keys(server).length === 0 && Object.keys(local).length > 0 && localUnlockDate !== jstDateNow) {
          localStorage.setItem(`encyclopediaUnlocked_${uid}`, '{}');
          localStorage.removeItem(`encyclopediaUnlockDate_${uid}`);
          localStorage.removeItem(`encyclopediaTodayServiceId_${uid}`);
          window.dispatchEvent(new CustomEvent('encyclopediaUpdated'));
          return;
        }
        // サーバー優先マージ（ローカルに新規解放分があれば残す）
        const merged: Record<string, string> = { ...local, ...server };
        localStorage.setItem(`encyclopediaUnlocked_${uid}`, JSON.stringify(merged));
        window.dispatchEvent(new CustomEvent('encyclopediaUpdated'));
        postUnlocks(merged, 1);
      })
      .catch(() => {
        // GET失敗時もローカルの解放状態は保存する（再ログインで未解放に戻る問題の対策）
        postUnlocks(local, 2);
      });
  } catch {}
}

function TodayServiceSection({ lang, userId, authReady, onNavigateEncyclopedia, onReveal, isMobile }: {
  lang: string; userId?: string; authReady: boolean;
  onNavigateEncyclopedia: () => void;
  onReveal: (svc: DailyService) => void;
  isMobile: boolean;
}) {
  const [service, setService] = useState<DailyService | null>(null);
  const [loading, setLoading] = useState(true);
  const [revealed, setRevealed] = useState(false);
  const [rerolledService, setRerolledService] = useState<DailyService | null>(null);
  const [rerolling, setRerolling] = useState(false);
  const [rerollError, setRerollError] = useState(false);

  const jstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

  useEffect(() => {
    // 認証確定前(authReady=false)は抽選しない。userId未確定のまま走ると未ログイン(guest)用
    // サービスが抽選・キャッシュされてしまうため、確定後にのみ userId 有無で抽選する。
    if (!authReady) return;
    const uid = userId ?? 'guest';
    const jstDate = jstToday();

    const localRevealed = localStorage.getItem(`encyclopediaUnlockDate_${uid}`) === jstDate;
    if (localRevealed) setRevealed(true);

    // 再抽選キャッシュの読み込み（localStorage に保存してリロード後も維持）
    const rerollCacheKey = `daily_service_reroll_${uid}_${jstDate}`;
    const cachedReroll = getCachedPersist<DailyService>(rerollCacheKey);
    if (cachedReroll) {
      setRerolledService({ ...cachedReroll, icon: resolveServiceIcon(cachedReroll) });
    }

    const fetchService = (alreadyRevealed: boolean) => {
      const cacheKey = `daily_service_${uid}_${jstDate}`;
      const cached = getCached<DailyService>(cacheKey);
      if (cached !== null) {
        const resolved = { ...cached, icon: resolveServiceIcon(cached) };
        setService(resolved);
        setLoading(false);
        if (alreadyRevealed) {
          saveToEncyclopedia(resolved, uid);
          if (userId) syncEncyclopediaToServer(userId);
        }
        return;
      }
      const apiUrl = userId
        ? `${API_ENDPOINT}/daily-service?userId=${encodeURIComponent(userId)}`
        : `${API_ENDPOINT}/daily-service`;
      fetch(apiUrl)
        .then(r => r.json())
        .then(d => {
          const raw = d.service ?? null;
          const s = raw ? { ...raw, icon: resolveServiceIcon(raw) } : null;
          // サーバーが alreadyUnlocked=true を返した場合（別デバイスで解放済み）
          const serverUnlocked = !alreadyRevealed && !!d.alreadyUnlocked;
          const isRevealed = alreadyRevealed || serverUnlocked;
          if (serverUnlocked) {
            localStorage.setItem(`encyclopediaUnlockDate_${uid}`, jstDate);
            setRevealed(true);
          }
          if (s) {
            setCached(cacheKey, s, 60 * 60 * 1000);
            if (isRevealed) {
              saveToEncyclopedia(s, uid);
              if (userId) syncEncyclopediaToServer(userId);
            }
          }
          setService(s);
        })
        .catch(() => setService(null))
        .finally(() => setLoading(false));
    };

    if (!localRevealed && userId) {
      // ローカルで未解放の場合、サービス取得と同時にサーバーの解放状態を確認
      // （fetchService 内で alreadyUnlocked を処理するため単純に fetchService を呼ぶ）
      fetchService(false);
    } else {
      fetchService(localRevealed);
    }
  }, [userId, authReady]);

  const handleReroll = async () => {
    if (!userId || !service || rerolling) return;
    setRerollError(false);
    const uid = userId;
    const jstDate = jstToday();
    const currentPts = getPoints(uid);
    if (currentPts < 30) { setRerollError(true); return; }
    setRerolling(true);
    try {
      const seed = Math.random().toString(36).slice(2);
      const url = `${API_ENDPOINT}/daily-service?userId=${encodeURIComponent(userId)}&rerollSeed=${encodeURIComponent(seed)}`;
      const res = await fetch(url);
      const data = await res.json();
      const raw = data.service ?? null;
      if (!raw) { setRerolling(false); return; }
      const s: DailyService = { ...raw, icon: resolveServiceIcon(raw) };
      deductPoints(uid, 30);
      saveToEncyclopedia(s, uid);
      syncEncyclopediaToServer(userId, true);
      const rerollCacheKey = `daily_service_reroll_${uid}_${jstDate}`;
      setCachedPersist(rerollCacheKey, s, 24 * 60 * 60 * 1000);
      setRerolledService(s);
      onReveal(s);
    } catch (err) {
      console.error(err);
    } finally {
      setRerolling(false);
    }
  };

  const handleReveal = () => {
    const svc = rerolledService ?? service;
    if (!svc || revealed) return;
    const uid = userId ?? 'guest';
    saveToEncyclopedia(svc, uid);
    if (userId) syncEncyclopediaToServer(userId, true);
    setRevealed(true);
    onReveal(svc);
  };

  const calIcon = <IconCalendarNotebook size={13} />;

  if (loading) return (
    <Card padding="var(--spacing-md)" style={{ marginBottom: 'var(--spacing-md)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div className="skeleton" style={{ width: 13, height: 13, borderRadius: 2 }} />
        <div className="skeleton" style={{ width: 120, height: 14, borderRadius: 4 }} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
        <div className="skeleton" style={{ width: 44, height: 44, borderRadius: 10, flexShrink: 0 }} />
        <div className="skeleton" style={{ width: '45%', height: 18, borderRadius: 4 }} />
      </div>
      <div className="skeleton" style={{ width: '100%', height: 13, borderRadius: 4, marginBottom: 5 }} />
      <div className="skeleton" style={{ width: '85%', height: 13, borderRadius: 4 }} />
    </Card>
  );

  // ── シークレット状態（未タップ） ──
  if (!revealed && service) return (
    <>
      <style>{`
        @keyframes ds-pulse {
          0%,100% { box-shadow: 0 0 14px 2px rgba(82,130,255,.3), 0 0 40px 6px rgba(82,130,255,.1); }
          50%      { box-shadow: 0 0 26px 6px rgba(82,130,255,.6), 0 0 60px 14px rgba(82,130,255,.22); }
        }
      `}</style>
      {/* 注意を引く動きはカード外周の光（ds-pulse）1つだけにする。「?」の浮遊と案内文の点滅は廃止 */}
      <div
        onClick={handleReveal}
        role="button"
        tabIndex={0}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleReveal(); } }}
        style={{
          marginBottom: 'var(--spacing-md)',
          borderRadius: 'var(--border-radius-md)',
          background: 'linear-gradient(140deg,#1a1a2e 0%,#16213e 55%,#0f3460 100%)',
          border: '2px solid rgba(82,130,255,.55)',
          padding: 'var(--spacing-md)',
          cursor: 'pointer',
          animation: 'ds-pulse 2.2s ease-in-out infinite',
          userSelect: 'none',
          WebkitUserSelect: 'none',
        }}
      >
        {/* ヘッダー */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
          <span style={{ color: 'rgba(255,255,255,.7)', flexShrink: 0, display: 'flex', alignItems: 'center' }}>
            <IconCalendarNotebook size={13} />
          </span>
          <span style={{ fontWeight: 700, fontSize: 'var(--font-size-sm)', color: 'rgba(255,255,255,.85)' }}>
            {lang === 'ja' ? '日めくりAWSサービス' : 'Daily AWS Service'}
          </span>
        </div>
        {/* ? アイコン */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '8px 0 4px' }}>
          <div style={{
            fontSize: 52, fontWeight: 900, lineHeight: 1, color: 'white',
            textShadow: '0 4px 24px rgba(255,255,255,.25)',
            filter: 'drop-shadow(0 0 12px rgba(255,255,255,.2))',
          }}>?</div>
          <div style={{
            marginTop: 10, fontSize: 'var(--font-size-sm2)', fontWeight: 600,
            color: 'rgba(255,255,255,.85)',
            textShadow: '0 2px 8px rgba(0,0,0,.5)',
          }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {isMobile ? <IconPointer size={16} /> : <IconMousePointerClick size={16} />}
              {lang === 'ja'
                ? (isMobile ? 'タップして本日のサービスを解放' : 'クリックして本日のサービスを解放')
                : (isMobile ? "Tap to reveal today's service" : "Click to reveal today's service")}
            </span>
          </div>
        </div>
      </div>
    </>
  );

  if (!service) return null;

  const displayService = rerolledService ?? service;
  const iconEl = <ServiceIconImg icon={displayService.icon} name={displayService.name} size={44} />;

  return (
    <Card data-kbnav="1" padding="var(--spacing-md)" style={{ marginBottom: 'var(--spacing-md)', cursor: 'pointer' }} onClick={onNavigateEncyclopedia}>
      {/* ヘッダー行 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        {calIcon}
        <span style={{ fontWeight: 700, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-main)' }}>
          {lang === 'ja' ? '日めくりAWSサービス' : 'Daily AWS Service'}
        </span>
        {displayService.category && (
          <span style={{ marginLeft: 2, fontSize: 'var(--font-size-2xs)', fontWeight: 700, padding: '1px 7px', borderRadius: 'var(--border-radius-sm)', background: 'var(--color-primary-light)', color: 'var(--color-primary)' }}>
            {displayService.category}
          </span>
        )}
        {revealed && userId && (
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
            {rerollError && (
              <span style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-danger)', whiteSpace: 'nowrap' }}>
                {lang === 'ja' ? 'P不足' : 'Not enough P'}
              </span>
            )}
            <button
              onClick={e => { e.stopPropagation(); handleReroll(); }}
              disabled={rerolling}
              title={lang === 'ja' ? '再抽選 (-30p)' : 'Reroll (-30p)'}
              style={{
                width: 35, height: 35, borderRadius: '50%',
                border: '1px solid var(--color-border)',
                background: 'transparent',
                color: rerolling ? 'var(--color-text-light)' : 'var(--color-points)',
                cursor: rerolling ? 'default' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                opacity: rerolling ? 0.5 : 1, flexShrink: 0,
              }}
            >
              {rerolling
                ? <div className="sherpa-spinner" style={{ width: 11, height: 11, borderWidth: 2, flexShrink: 0 }} />
                : <IconSparkles size={12} />
              }
            </button>
          </div>
        )}
      </div>

      {/* アイコン＋名前 横並び */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <div style={{ width: 44, height: 44, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {iconEl}
        </div>
        <div>
          <span style={{ fontWeight: 800, fontSize: 'var(--font-size-md)', color: 'var(--color-text-main)' }}>{displayService.name}</span>
        </div>
      </div>

      {/* 説明文: アイコン行の下から全幅 */}
      <p style={{ margin: '0 0 8px', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', lineHeight: 1.7, overflowWrap: 'break-word', wordBreak: 'break-word' }}>
        {displayService.description}
      </p>

      {displayService.trivia && (
        <div style={{ background: 'var(--color-bg-main)', borderRadius: 'var(--border-radius-md)', padding: '8px 12px', display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 10 }}>
          <span style={{ color: 'var(--color-text-sub)', display: 'flex', alignItems: 'center', flexShrink: 0 }}><IconBean size={14} /></span>
          <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', lineHeight: 1.6, overflowWrap: 'break-word', wordBreak: 'break-word' }}>{displayService.trivia.replace(/^🌱\s*/, '')}</span>
        </div>
      )}

      {displayService.docUrl && (
        <a href={displayService.docUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--font-size-sm)', color: 'var(--color-primary)', textDecoration: 'none', fontWeight: 600 }}>
          {lang === 'ja' ? '公式ページを見る' : 'Official page'}<IconExternalLink size={13} />
        </a>
      )}

    </Card>
  );
}

// ── メインコンポーネント ────────────────────────────────────────
const FOCUSED_UNLOCK_THRESHOLD = 20;
function loadQuickPrefs(uid: string) {
  try { return JSON.parse(localStorage.getItem(`quickExercisePrefs_${uid}`) ?? '{}'); } catch { return {}; }
}
// サクッと演習のブックマーク優先（独立トグル・併用可）: 既定オン（明示的に false のときだけオフ）。
function quickBookmark(p: Record<string, any>): boolean {
  return p?.bookmarkOnly !== false;
}
// 前提知識(オリジナル資格)の混在: 既定オン（明示的に false のときだけオフ）。
// サクッと演習・しっかり対策・トレーニング演習タブで共通の意味（specs/003-original-exam-blend）。
function includeCompanionPref(p: Record<string, any>): boolean {
  return p?.includeCompanion !== false;
}
// 回答状況フィルタの選択肢キー → statusCounts上の「基礎知識(companion)分の内訳」フィールド名（specs/004）。
const COMPANION_COUNT_KEY: Record<string, string> = {
  none: 'companionNone', unanswered: 'companionUnanswered', incorrect: 'companionIncorrect', notcorrect: 'companionNotcorrect',
};
// 同・「目標資格単独」フィールド名。「基礎知識を含める」OFF時はこちらを表示する
// （事前に両方取得済みのため、チェックボックス切り替えは再フェッチ無しで即座に反映する）。
const TARGET_ONLY_COUNT_KEY: Record<string, string> = {
  none: 'targetOnlyNone', unanswered: 'targetOnlyUnanswered', incorrect: 'targetOnlyIncorrect', notcorrect: 'targetOnlyNotcorrect',
};
// サクッと演習の回答状況フィルタ（しっかり対策と同一の選択肢・既定は未正解を優先）。
// FocusPriority は Home 本体で型定義（'none'|'unanswered'|'incorrect'|'notcorrect'）。
function resolveQuickPriority(p: Record<string, any>): 'none' | 'unanswered' | 'incorrect' | 'notcorrect' {
  const v = p?.quickPriority;
  if (v === 'none' || v === 'unanswered' || v === 'incorrect' || v === 'notcorrect') return v;
  return 'notcorrect'; // 既定＝未正解を優先（未回答＋不正解）
}
function loadFocusedPrefs(uid: string) {
  try { return JSON.parse(localStorage.getItem(`focusedExercisePrefs_${uid}`) ?? '{}'); } catch { return {}; }
}
// 回答状況フィルタ（排他）: 指定なし / 未回答 / 不正解 / 未正解(=未回答+不正解)
type FocusPriority = 'none' | 'unanswered' | 'incorrect' | 'notcorrect';
function resolveFocusPriority(p: Record<string, any>): FocusPriority {
  if (p?.focusPriority === 'none' || p?.focusPriority === 'unanswered' || p?.focusPriority === 'incorrect' || p?.focusPriority === 'notcorrect') return p.focusPriority;
  return 'notcorrect'; // 既定＝未正解を優先（未回答＋不正解）。旧 'weak' は正答率フィルタへ移行
}
// 正答率フィルタ（排他・問題ごとの累計正答率）: 指定なし / 50% / 66% / 75% 未満
type FocusAccuracy = 'none' | 'below50' | 'below66' | 'below75';
function resolveFocusAccuracy(p: Record<string, any>): FocusAccuracy {
  if (p?.focusAccuracy === 'below50' || p?.focusAccuracy === 'below66' || p?.focusAccuracy === 'below75' || p?.focusAccuracy === 'none') return p.focusAccuracy;
  // 後方互換：旧「苦手を優先」(75%以下トグル) / 旧 focusPriority='weak' は 75%未満へ移行
  if (p?.focusWeak === true || p?.focusPriority === 'weak') return 'below75';
  return 'below75'; // 既定＝正答率75%未満を優先
}
function focusAccuracyThreshold(a: FocusAccuracy): number {
  return a === 'below50' ? 0.5 : a === 'below66' ? 0.66 : a === 'below75' ? 0.75 : 0;
}
// ブックマークフィルタ（しっかり対策・独立トグル・上乗せ）: 既定オン（明示的に false のときだけオフ）
function focusBookmarkOn(p: Record<string, any>): boolean {
  return p?.focusBookmark !== false;
}
function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// 重み付き非復元抽出：weightFn が大きい要素ほど高確率で前方に来るよう k 件選ぶ。
// 全要素に base 重みがあるため、優先対象が k 未満でも必ず k 件まで埋まる（多様性も維持）。
function weightedSampleWithoutReplacement<T>(items: T[], weightFn: (item: T) => number, k: number): T[] {
  const pool = items.map(item => ({ item, w: Math.max(0, weightFn(item)) }));
  const picked: T[] = [];
  const n = Math.min(k, pool.length);
  for (let p = 0; p < n; p++) {
    let total = 0;
    for (const e of pool) total += e.w;
    let idx = 0;
    if (total <= 0) {
      idx = Math.floor(Math.random() * pool.length); // 全重み0なら一様ランダム
    } else {
      let r = Math.random() * total;
      for (let i = 0; i < pool.length; i++) { r -= pool[i].w; if (r <= 0) { idx = i; break; } }
    }
    picked.push(pool[idx].item);
    pool.splice(idx, 1);
  }
  return picked;
}

const CHEVRON_BTN: React.CSSProperties = {
  border: 'none', background: 'none', cursor: 'pointer',
  color: 'var(--color-text-light)', fontSize: 'var(--font-size-xl)', lineHeight: 1,
  padding: '0 2px', display: 'flex', alignItems: 'center',
  transition: 'color 0.15s',
};

// 管理者リセット後にデータ系のローカルキーを全消去する（設定・環境設定は保持）
function clearUserData(uid: string) {
  const KEEP = new Set([
    `lang_${uid}`, `theme_${uid}`, `sidebarOpen_${uid}`,
    `targetExam_${uid}`, `lastQuickMode_${uid}`,
    `quickExercisePrefs_${uid}`, `focusedExercisePrefs_${uid}`,
    `sherpaExerciseHint_${uid}`, `sherpaExamHint_${uid}`, `sherpaStatsHint_${uid}`,
    `lastReset_${uid}`,
  ]);
  const suffix = `_${uid}`;
  const toRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)!;
    if (
      (!KEEP.has(key) && key.endsWith(suffix)) ||
      key.startsWith(`qstats_${uid}_`) ||
      key.startsWith(`daily_service_${uid}_`) ||
      (key.startsWith('dailyQCount_') && key.includes(`_${uid}_`)) ||
      (key.startsWith('dailyGoalReward_') && key.includes(`_${uid}_`))
    ) toRemove.push(key);
  }
  toRemove.forEach(k => localStorage.removeItem(k));
  sessionStorage.removeItem(`_ts_ustats_${uid}`);
}

export default function Home() {
  const { user, loading: authLoading } = useAuth();
  const { lang } = useLanguage();
  const navigate = useNavigate();
  const location = useLocation();
  const ja = lang === 'ja';
  const uid = user?.userId ?? 'guest';
  const { gate: ohineriGate, ui: ohineriUi } = useOhineriGate(user, ja, true);

  const [nodeWindow, setNodeWindow] = useState<5 | 10>(() =>
    localStorage.getItem(`scoreWindow_${uid}`) === '10' ? 10 : 5
  );

  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const [revealService, setRevealService] = useState<DailyService | null>(null);
  const [targetExam, setTargetExam] = useState<string | null>(() => localStorage.getItem(`targetExam_${uid}`));
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showStartTutorial, setShowStartTutorial] = useState(false);
  const [domainStats, setDomainStats] = useState<DomainStat[]>([]);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsRefreshing, setStatsRefreshing] = useState(false);
  const [statsSynced, setStatsSynced] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [quickLoading, setQuickLoading] = useState(false);
  const [quickLoadPct, setQuickLoadPct] = useState(0);

  const readQuickDraft = () => {
    try { return JSON.parse(localStorage.getItem(`quickExerciseDraft_${uid}`) ?? 'null'); } catch { return null; }
  };
  const readFocusedDraft = () => {
    try { return JSON.parse(localStorage.getItem(`focusedExerciseDraft_${uid}`) ?? 'null'); } catch { return null; }
  };
  const [quickDraft, setQuickDraft] = useState<any>(() => readQuickDraft());
  const [focusedDraft, setFocusedDraft] = useState<any>(() => readFocusedDraft());
  // 別端末/キャッシュ削除でもサーバ保存分から再開できるよう、起動時にドラフトを補完して再読込
  useEffect(() => {
    if (!user) return;
    // 認証は非同期のため、初期 useState は uid='guest' で読んでいる可能性がある。
    // user 確定時にまずローカルを正しい uid で再読込する（サーバ補完の成否に関わらず必要）。
    setQuickDraft(readQuickDraft());
    setFocusedDraft(readFocusedDraft());
    // scoreWindow も正しい uid で再読込（kvSync プル完了前でもローカル値を反映）
    setNodeWindow(localStorage.getItem(`scoreWindow_${user.userId}`) === '10' ? 10 : 5);
    hydrateDraftsFromServer(user.userId).then(h => {
      if (!h) return;
      setQuickDraft(readQuickDraft());
      setFocusedDraft(readFocusedDraft());
    });
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps
  const [showQuickModal, setShowQuickModal] = useState(false);
  const [showNewPanel, setShowNewPanel] = useState(false);
  const [showWebQuickMenu, setShowWebQuickMenu] = useState(false);
  const [showFocusedMenu, setShowFocusedMenu] = useState(false);
  const [focusedLoading, setFocusedLoading] = useState(false);
  const [focusedLoadPct, setFocusedLoadPct] = useState(0);
  const [lastMode, setLastMode] = useState<'quick' | 'focused'>(() => (localStorage.getItem(`lastQuickMode_${uid}`) as 'quick' | 'focused') ?? 'quick');
  const [answeredCount, setAnsweredCount] = useState(0);
  const [answeredCountReady, setAnsweredCountReady] = useState(false);
  const [qRefreshTick, setQRefreshTick] = useState(0); // セッション完了で +1 → useEffect 再実行
  const [quickSaveMsg, setQuickSaveMsg] = useState<'saved' | 'already' | null>(null);
  const [focusedSaveMsg, setFocusedSaveMsg] = useState<'saved' | 'already' | null>(null);
  const savedQuick = quickSaveMsg === 'saved';
  const savedFocused = focusedSaveMsg === 'saved';
  const [draftPrefs, setDraftPrefs] = useState<Record<string, any>>({});
  const savedQuickPrefsRef = useRef<Record<string, any>>({});
  const [showFocusedModal, setShowFocusedModal] = useState(false);
  const [draftFocusedPrefs, setDraftFocusedPrefs] = useState<Record<string, any>>({});
  const savedFocusedPrefsRef = useRef<Record<string, any>>({});
  // しっかり対策 設定モーダルの各優先条件の該当件数（未回答/不正解/未正解/苦手）
  // 基礎知識込み(with)・目標資格単独(targetOnly)の両方を常に取得しておき、
  // 「基礎知識を含める」チェックボックスの切り替えはクライアント側の参照切り替えのみで
  // 即座に反映する（再フェッチのラグを無くすため。specs/004）。
  const [statusCounts, setStatusCounts] = useState<{
    none?: number; bookmarked?: number; unanswered?: number; incorrect?: number; notcorrect?: number;
    below50?: number; below66?: number; below75?: number; companionTotal?: number;
    targetOnlyNone?: number; targetOnlyBookmarked?: number; targetOnlyUnanswered?: number; targetOnlyIncorrect?: number; targetOnlyNotcorrect?: number;
    companionNone?: number; companionBookmarked?: number; companionUnanswered?: number; companionIncorrect?: number; companionNotcorrect?: number;
  } | null>(null);
  // サクッと演習ドメインフィルタ用: 各ドメインに用意された問題数（ドメイン名→問数）
  const [quickDomainCounts, setQuickDomainCounts] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    if ((!showFocusedModal && !showQuickModal) || !user || !targetExam) { setStatusCounts(null); return; }
    let cancelled = false;
    const uid2 = user.userId;
    (async () => {
      try {
        const hasCompanion = !!COMPANION_EXAM[targetExam];
        const companionParam = hasCompanion ? '&includeCompanion=true' : '';
        const [idsRes, statusRes, companionRes, targetOnlyIdsRes, targetOnlyStatusRes] = await Promise.all([
          fetch(`${API_ENDPOINT}/questions?examType=${targetExam}&idsOnly=true${companionParam}`).then(r => r.json()).catch(() => null),
          fetch(`${API_ENDPOINT}/users/me/question-status?userId=${uid2}&examType=${targetExam}${companionParam}`).then(r => r.json()).catch(() => null),
          // 基礎知識チェックボックスの問題数表示用: companion資格自体の母数（未回答等とは独立）
          hasCompanion
            ? fetch(`${API_ENDPOINT}/questions?examType=${COMPANION_EXAM[targetExam]}&metaOnly=true`).then(r => r.json()).catch(() => null)
            : Promise.resolve(null),
          // 目標資格単独（基礎知識抜き）の同じ集計を並行取得。チェックボックスON/OFF
          // どちらの表示もこの1回の取得で即座に出せるようにする（specs/004）。
          hasCompanion
            ? fetch(`${API_ENDPOINT}/questions?examType=${targetExam}&idsOnly=true`).then(r => r.json()).catch(() => null)
            : Promise.resolve(null),
          hasCompanion
            ? fetch(`${API_ENDPOINT}/users/me/question-status?userId=${uid2}&examType=${targetExam}`).then(r => r.json()).catch(() => null)
            : Promise.resolve(null),
        ]);
        if (cancelled) return;
        const total = (idsRes?.questionIds ?? []).length;
        const answered = (statusRes?.answered ?? []).length;
        const incorrect = Object.keys(statusRes?.incorrect ?? {}).length;
        const unanswered = Math.max(0, total - answered);
        // 正答率フィルタ（問題ごと・未満）の該当数。acc が無い(旧Lambda)場合は weak(75%以下)のみ暫定表示。
        const accMap: Record<string, number> = statusRes?.acc ?? {};
        const accVals = Object.values(accMap);
        const below50 = accVals.filter(v => v < 0.5).length;
        const below66 = accVals.filter(v => v < 0.66).length;
        const below75 = accVals.length > 0 ? accVals.filter(v => v < 0.75).length : (statusRes?.weak ?? []).length;
        const bookmarked = (statusRes?.bookmarked ?? []).length;
        const companionTotal = companionRes?.count ?? undefined;

        // 目標資格単独の値、および内訳（基礎知識分 = 合算値 − 目標資格単独値）
        let targetOnlyNone: number | undefined, targetOnlyUnanswered: number | undefined,
          targetOnlyIncorrect: number | undefined, targetOnlyBookmarked: number | undefined, targetOnlyNotcorrect: number | undefined;
        let companionNone: number | undefined, companionUnanswered: number | undefined,
          companionIncorrect: number | undefined, companionBookmarked: number | undefined,
          companionNotcorrect: number | undefined;
        if (hasCompanion && targetOnlyIdsRes) {
          const targetOnlyTotal = (targetOnlyIdsRes?.questionIds ?? []).length;
          const targetOnlyAnswered = (targetOnlyStatusRes?.answered ?? []).length;
          targetOnlyIncorrect = Object.keys(targetOnlyStatusRes?.incorrect ?? {}).length;
          targetOnlyUnanswered = Math.max(0, targetOnlyTotal - targetOnlyAnswered);
          targetOnlyBookmarked = (targetOnlyStatusRes?.bookmarked ?? []).length;
          targetOnlyNone = targetOnlyTotal;
          targetOnlyNotcorrect = targetOnlyUnanswered + targetOnlyIncorrect;
          companionNone = Math.max(0, total - targetOnlyTotal);
          companionUnanswered = Math.max(0, unanswered - targetOnlyUnanswered);
          companionIncorrect = Math.max(0, incorrect - targetOnlyIncorrect);
          companionBookmarked = Math.max(0, bookmarked - (targetOnlyBookmarked ?? 0));
          companionNotcorrect = companionUnanswered + companionIncorrect;
        }
        setStatusCounts({
          none: total, bookmarked, unanswered, incorrect, notcorrect: unanswered + incorrect, below50, below66, below75, companionTotal,
          targetOnlyNone, targetOnlyUnanswered, targetOnlyIncorrect, targetOnlyBookmarked, targetOnlyNotcorrect,
          companionNone, companionUnanswered, companionIncorrect, companionBookmarked, companionNotcorrect,
        });
      } catch { if (!cancelled) setStatusCounts(null); }
    })();
    return () => { cancelled = true; };
  }, [showFocusedModal, showQuickModal, user, targetExam]);

  // サクッと演習ドメインフィルタの各ドメイン問数を集計（ログイン不問・問題メタから算出）
  useEffect(() => {
    if (!showQuickModal || !targetExam) { setQuickDomainCounts(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const cached = getCachedPersist<{ items: any[]; total: number }>(`qlist_${targetExam}`);
        let items: any[];
        if (cached?.items?.length) {
          items = cached.items;
        } else {
          const data = await fetch(`${API_ENDPOINT}/questions?examType=${targetExam}&metaOnly=true`).then(r => r.json());
          items = data?.items ?? [];
        }
        if (cancelled) return;
        const counts: Record<string, number> = {};
        for (const q of items) {
          const name = qDomainName(q);
          if (!name) continue;
          counts[name] = (counts[name] ?? 0) + 1;
        }
        setQuickDomainCounts(counts);
      } catch { if (!cancelled) setQuickDomainCounts(null); }
    })();
    return () => { cancelled = true; };
  }, [showQuickModal, targetExam]);

  const [quickBurst, setQuickBurst] = useState<{ x: number; y: number } | null>(null);
  const [focusedBurst, setFocusedBurst] = useState<{ x: number; y: number } | null>(null);
  const [quickSaving, setQuickSaving] = useState(false);
  const [focusedSaving, setFocusedSaving] = useState(false);
  const saveBtnQuickRef = useRef<HTMLButtonElement>(null);
  const saveBtnFocusedRef = useRef<HTMLButtonElement>(null);
  const SAVE_BURST_COLOR = '#e74c3c';
  const [showCombinedDetail, setShowCombinedDetail] = useState(false);
  const [serverScoreHistory, setServerScoreHistory] = useState<ScoreEntry[] | null>(null);
  const [serverSessionHistory, setServerSessionHistory] = useState<number[] | null>(null);
  const [serverSessionScoreLog, setServerSessionScoreLog] = useState<ScoreEntry[] | null>(null);
  // スコア履歴のサーバー読込が完了しローカルと同期済みか。
  // 追記effect（日次/セッション）はこれがtrueになるまで待つ。空/疎なローカルを基に
  // サーバーの蓄積を上書きPUTしたり、読み込んだサーバー値をstate上で疎データに戻すのを防ぐ。
  const [scoreHistLoaded, setScoreHistLoaded] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);


  useEffect(() => {
    if (authLoading) return;
    const saved = localStorage.getItem(`targetExam_${uid}`);
    if (saved !== null) {
      setTargetExam(saved);
      setShowOnboarding(false);
    } else {
      setShowOnboarding(true);
    }
  }, [uid, authLoading]);

  useEffect(() => {
    if (authLoading) return;
    const saved = localStorage.getItem(`lastQuickMode_${uid}`) as 'quick' | 'focused' | null;
    if (saved === 'quick' || saved === 'focused') setLastMode(saved);
  }, [uid, authLoading]);

  useEffect(() => {
    const handler = (e: Event) => setTargetExam((e as CustomEvent).detail);
    window.addEventListener('targetExamChanged', handler);
    return () => window.removeEventListener('targetExamChanged', handler);
  }, []);

  // ── 成績フェッチ（stale-while-revalidate） ─────────────────────────
  const TS_KEY = (uid: string) => `_ts_ustats_${uid}`;

  const doFetchStats = useCallback(async (userId: string, background: boolean, delayMs = 0) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    if (background) setStatsRefreshing(true); else setStatsLoading(true);
    try {
      if (delayMs > 0) {
        await new Promise<void>((res, rej) => {
          const t = setTimeout(res, delayMs);
          ctrl.signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); });
        });
      }
      const r = await fetch(`${API_ENDPOINT}/users/me/stats?userId=${userId}`, { signal: ctrl.signal });
      const d = await r.json();

      // 管理者リセット検知: resetAt が更新されていたらローカルデータを消去してリロード
      if (d.resetAt) {
        const lastReset = localStorage.getItem(`lastReset_${userId}`);
        if (!lastReset || d.resetAt > lastReset) {
          localStorage.setItem(`lastReset_${userId}`, d.resetAt);
          clearUserData(userId);
          window.location.reload();
          return;
        }
      }

      const stats: DomainStat[] = d.stats ?? [];
      setCached(`ustats_${userId}`, stats, DEFAULT_TTL);
      sessionStorage.setItem(TS_KEY(userId), String(Date.now()));
      setDomainStats(stats);
      setLastUpdated(new Date());
    } catch { /* abort or network error */ }
    finally {
      if (!ctrl.signal.aborted) { setStatsLoading(false); setStatsRefreshing(false); setStatsSynced(true); }
    }
  }, []);

  const refreshStats = useCallback(() => {
    if (!user || statsLoading || statsRefreshing) return;
    deleteCachedByPrefix(`ustats_${user.userId}`);
    sessionStorage.removeItem(TS_KEY(user.userId));
    doFetchStats(user.userId, false);
  }, [user, statsLoading, statsRefreshing, doFetchStats]);

  useEffect(() => {
    if (!user) { if (!authLoading) { setDomainStats([]); setLastUpdated(null); setStatsSynced(true); } return; }
    setStatsSynced(false);
    const cached = getCached<DomainStat[]>(`ustats_${user.userId}`);
    const tsRaw = sessionStorage.getItem(TS_KEY(user.userId));
    if (tsRaw) setLastUpdated(new Date(parseInt(tsRaw)));

    // セッション完了直後フラグ: どちらのケースでも確認
    const flagRaw = localStorage.getItem(`postSessionRefresh_${user.userId}`);
    const isPostSession = !!flagRaw && Date.now() - parseInt(flagRaw) < 60000;
    if (flagRaw) localStorage.removeItem(`postSessionRefresh_${user.userId}`);

    if (cached !== null) {
      setDomainStats(cached);
      // セッション直後なら遅延バックグラウンド更新（楽観的キャッシュが古いデータを上書きしないよう少し待つ）
      doFetchStats(user.userId, true, isPostSession ? 2000 : 0);
    } else {
      doFetchStats(user.userId, false, isPostSession ? 2000 : 0);
    }
    return () => { abortRef.current?.abort(); };
  }, [user?.userId, authLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!user || !targetExam) { setServerScoreHistory(null); setServerSessionHistory(null); setServerSessionScoreLog(null); return; }
    // 読込中は未同期。追記effectはこの間 return して待つ（レースによる疎データ上書きを防ぐ）。
    setScoreHistLoaded(false);
    // セッション完了直後かどうかを事前にチェック（非同期GETと追記useEffectの競合を防ぐ）
    const addKey = `sessionScoreAdd_${targetExam}_${user.userId}`;
    const hasPendingSession = !!localStorage.getItem(addKey);
    fetch(`${API_ENDPOINT}/users/me/score-history?userId=${user.userId}&examType=${targetExam}`)
      .then(r => r.json())
      .then(d => {
        const serverSH: ScoreEntry[] = d.scoreHistory ?? [];
        const serverSSH: number[] = d.sessionScoreHistory ?? [];
        const serverSSL: ScoreEntry[] = d.sessionScoreLog ?? [];
        // マイグレーション: サーバーが空でローカルにデータがあれば、サーバーへアップロード
        const localSH = readScoreHistory(targetExam, user.userId);
        const localSSH = readSessionScoreHistory(targetExam, user.userId);
        const localSSL = readSessionScoreLog(targetExam, user.userId);
        const uploadSH = serverSH.length === 0 && localSH.length > 0 ? localSH : serverSH;
        const uploadSSH = serverSSH.length === 0 && localSSH.length > 0 ? localSSH : serverSSH;
        const uploadSSL = serverSSL.length === 0 && localSSL.length > 0 ? localSSL : serverSSL;
        if (uploadSH !== serverSH || uploadSSH !== serverSSH || uploadSSL !== serverSSL) {
          fetch(`${API_ENDPOINT}/users/me/score-history`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: user.userId, examType: targetExam, scoreHistory: uploadSH, sessionScoreHistory: uploadSSH, sessionScoreLog: uploadSSL }),
          }).catch(() => {});
        }
        // サーバーデータが localStorage より多い場合は localStorage に書き込む。
        // 別デバイスや localStorage クリア後にセッション完了 effect が空ログをベースに
        // PUT してサーバーの全履歴を上書きしてしまうバグを防ぐ。
        if (uploadSH.length > localSH.length) {
          try { localStorage.setItem(`score_history_${targetExam}_${user.userId}`, JSON.stringify(uploadSH)); } catch {}
        }
        if (uploadSSL.length > localSSL.length) {
          try { localStorage.setItem(`score_session_log_${targetExam}_${user.userId}`, JSON.stringify(uploadSSL)); } catch {}
        }
        if (uploadSSH.length > localSSH.length) {
          try { localStorage.setItem(`score_session_history_${targetExam}_${user.userId}`, JSON.stringify(uploadSSH)); } catch {}
        }
        setServerScoreHistory(uploadSH);
        // セッション完了フラグがある場合、sessionScoreHistory は後続のuseEffectで追記されるため上書きしない
        if (!hasPendingSession) {
          setServerSessionHistory(uploadSSH);
          setServerSessionScoreLog(uploadSSL);
        }
        // ローカルをサーバー値へ同期済み。以降の追記effectを解禁する。
        setScoreHistLoaded(true);
      })
      // 取得失敗時は同期未完了のまま（追記effectを走らせずサーバー蓄積の上書きを避ける）。
      .catch(() => { setServerScoreHistory(null); setServerSessionHistory(null); setServerSessionScoreLog(null); });
  }, [user, targetExam]);

  // セッション完了イベントで qRefreshTick を更新 → 下の useEffect を再実行
  useEffect(() => {
    const h = () => setQRefreshTick(t => t + 1);
    window.addEventListener('qstatsRefresh', h);
    return () => window.removeEventListener('qstatsRefresh', h);
  }, []);

  useEffect(() => {
    if (!user || !targetExam) { setAnsweredCount(0); setAnsweredCountReady(true); return; }
    fetch(`${API_ENDPOINT}/users/me/question-stats?userId=${user.userId}&examType=${targetExam}`)
      .then(r => r.json())
      .then(d => setAnsweredCount(d.answeredCount ?? 0))
      .catch(() => {})
      .finally(() => setAnsweredCountReady(true));
  }, [user, targetExam, qRefreshTick]);

  // ── 予想スコア計算（サーバー統計優先、オフライン/ゲスト時はローカル履歴）──
  const domainNodeResultsMap = useMemo(() => {
    if (!targetExam) return {} as Record<string, boolean[]>;
    const localDR = readDomainResults(targetExam, uid);
    const result: Record<string, boolean[]> = {};
    (EXAM_DOMAINS[targetExam] ?? []).forEach((d, idx) => {
      const serverResults = domainStats.find(s => tagIdMatches(s.tagId, targetExam, idx))?.recentResults;
      result[d] = (serverResults ?? localDR[String(idx)] ?? []).slice(-nodeWindow);
    });
    return result;
  }, [targetExam, domainStats, uid, nodeWindow]);

  const estimatedScore = useMemo(() => {
    if (!targetExam) return null;
    const domainList = EXAM_DOMAINS[targetExam] ?? [];
    const weights = DOMAIN_WEIGHTS[targetExam] ?? domainList.map(() => 100 / domainList.length);
    const totalAllWeights = weights.reduce((s, w) => s + w, 0);
    if (totalAllWeights === 0) return null;

    let weightedSum = 0, hasAnyData = false;
    for (let i = 0; i < domainList.length; i++) {
      const nodeResults = domainNodeResultsMap[domainList[i]] ?? [];
      if (nodeResults.length === 0) continue;
      const correctInNodes = nodeResults.filter((v: boolean) => !!v).length;
      weightedSum += (correctInNodes / nodeWindow) * weights[i];
      hasAnyData = true;
    }
    if (!hasAnyData) return null;
    return Math.round((weightedSum / totalAllWeights) * 1000);
  }, [targetExam, domainNodeResultsMap, nodeWindow]);

  const focusedUnlocked = !!user && answeredCount >= FOCUSED_UNLOCK_THRESHOLD;
  const focusedUnlockedCached = localStorage.getItem(`focusedUnlockedCache_${uid}`) === '1';
  const effectiveFocusedUnlocked = !user ? false : answeredCountReady ? focusedUnlocked : focusedUnlockedCached;
  const primaryMode: 'quick' | 'focused' = lastMode === 'focused' && effectiveFocusedUnlocked ? 'focused' : 'quick';

  // 解放到達を検知して一度だけ祝福ポップアップを出す。
  // ※このeffectは下の focusedUnlockedCache 書き込みより前に宣言し、上書き前の
  //   「前回までの解放状態」を読む（今まさに閾値(FOCUSED_UNLOCK_THRESHOLD)を超えた瞬間だけ祝う）。
  const [showUnlockModal, setShowUnlockModal] = useState(false);
  useEffect(() => {
    if (!user || !answeredCountReady || !focusedUnlocked) return;
    const celebratedKey = `focusedUnlockCelebrated_${uid}`;
    if (localStorage.getItem(celebratedKey) === '1') return;
    const wasUnlockedBefore = localStorage.getItem(`focusedUnlockedCache_${uid}`) === '1';
    localStorage.setItem(celebratedKey, '1');
    // すでに解放済みだった既存ユーザーには出さず、今回到達した人だけに表示する
    if (!wasUnlockedBefore) setShowUnlockModal(true);
  }, [answeredCountReady, focusedUnlocked, user, uid]);

  useEffect(() => {
    if (answeredCountReady) {
      localStorage.setItem(`focusedUnlockedCache_${uid}`, focusedUnlocked ? '1' : '0');
    }
  }, [answeredCountReady, focusedUnlocked, uid]);

  // ── ホーム「苦手分析」カード（デスクトップ限定・ログイン専用）用 ──
  // マイページ苦手分析タブと同じデータ源。頻出ミス問題は解放(FOCUSED_UNLOCK_THRESHOLD)まで取得しない。
  const [weakQuestions, setWeakQuestions] = useState<WeakQuestion[]>([]);
  const [weakLoaded, setWeakLoaded] = useState(false);
  useEffect(() => {
    if (!user || !targetExam || !effectiveFocusedUnlocked || weakLoaded) return;
    fetch(`${API_ENDPOINT}/users/me/weak-questions?userId=${user.userId}&examType=${targetExam}&minIncorrect=2`)
      .then(r => r.json())
      .then(d => { setWeakQuestions(d.items ?? []); setWeakLoaded(true); })
      .catch(() => {});
  }, [user, targetExam, effectiveFocusedUnlocked, weakLoaded]);
  // targetExam を切り替えたら再取得する
  useEffect(() => { setWeakLoaded(false); setWeakQuestions([]); }, [targetExam]);

  // 苦手ドメイン上位2件（直近10問正答率が閾値未満・未演習は除外）
  const weakDomains = useMemo(() => {
    const examDomains = EXAM_DOMAINS[targetExam ?? ''] ?? [];
    return examDomains
      .map((domain, idx) => {
        const stat = domainStats.find(s => tagIdMatches(s.tagId, targetExam ?? '', idx));
        const recent = (stat?.recentResults ?? []).slice(-10);
        if (recent.length === 0) return null;
        const pct = recent.filter(Boolean).length / recent.length;
        return pct < DOMAIN_RATE_WARNING ? { domain, pct } : null;
      })
      .filter((v): v is { domain: string; pct: number } => v !== null)
      .sort((a, b) => a.pct - b.pct)
      .slice(0, 2);
  }, [targetExam, domainStats]);

  // 別デバイスで scoreWindow が変更された場合に kvSynced で反映する
  useEffect(() => {
    const h = (e: Event) => {
      const keys: string[] = (e as CustomEvent).detail?.keys ?? [];
      if (keys.some(k => k.startsWith('scoreWindow_'))) {
        setNodeWindow(localStorage.getItem(`scoreWindow_${uid}`) === '10' ? 10 : 5);
      }
    };
    window.addEventListener('kvSynced', h);
    return () => window.removeEventListener('kvSynced', h);
  }, [uid]);

  const passScore = targetExam ? PASS_SCORES[targetExam] : null;

  // 前日比
  const jstDate = useMemo(() => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10), []);

  // 目標演習量パネル用
  const dailyGoal = useMemo(() =>
    Math.max(1, parseInt(localStorage.getItem(`dailyGoal_${uid}`) ?? '10', 10))
  , [uid]);
  // 目標資格のみの当日演習量（マイページと同じく目標資格基準で表示）
  const [dailyCount, setDailyCount] = useState(() =>
    targetExam ? parseInt(localStorage.getItem(`dailyQCount_${targetExam}_${uid}_${jstDate}`) ?? '0', 10) : 0
  );
  useEffect(() => {
    setDailyCount(targetExam ? parseInt(localStorage.getItem(`dailyQCount_${targetExam}_${uid}_${jstDate}`) ?? '0', 10) : 0);
  }, [targetExam, uid, jstDate, domainStats]);
  // ログイン時はサーバの当日合算値を取得して反映（別デバイスで解いた分も進捗に含める）
  useEffect(() => {
    if (!user || !targetExam) return;
    fetchDailyProgress(user.userId, targetExam).then(n => {
      if (n != null) setDailyCount(prev => Math.max(prev, n));
    });
  }, [user?.userId, targetExam, jstDate]); // eslint-disable-line react-hooks/exhaustive-deps

  const [prevScore, setPrevScore] = useState<number | null>(null);

  useEffect(() => {
    if (!targetExam || estimatedScore === null) { setPrevScore(null); return; }
    const prevKey = `score_prev_${targetExam}_${uid}`;
    const raw = localStorage.getItem(prevKey);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        setPrevScore(parsed && typeof parsed === 'object' && parsed.w === nodeWindow ? parsed.s : null);
      } catch {
        setPrevScore(null);
      }
    } else {
      setPrevScore(null);
    }

    // サーバー読込が完了しローカルと同期されるまで追記しない（疎ローカルでの上書き防止）。
    // 成績の再取得も待つ。待たずに書くと、ページを開いた時点の古いキャッシュ
    // （＝前日などの成績）から計算した点が「その日の最高点」として残り、
    // 実際にはその日に取っていない点数がグラフに出る。
    if (!scoreHistLoaded || !statsSynced) return;

    // スコア履歴に追記（折れ線グラフ用）
    const histKey = `score_history_${targetExam}_${uid}`;
    let scoreHist: ScoreEntry[] = [];
    try { scoreHist = JSON.parse(localStorage.getItem(histKey) ?? '[]'); } catch {}
    // 日次は「その日の最高点」を保持（日次最高点推移）。同日は max で更新。
    // 「直近N問」設定ごとに別の行として持つ。N が違えば尺度が違い、max で混ぜられないため
    // （末尾だけ見ると、同日に N を切り替えたとき同じ行を上書きしてしまう）。
    const sameDay = scoreHist.find(e => e.date === jstDate && (e.w ?? nodeWindow) === nodeWindow);
    if (sameDay) {
      sameDay.score = Math.max(sameDay.score ?? 0, estimatedScore);
      sameDay.w = nodeWindow;
    } else {
      scoreHist.push({ date: jstDate, score: estimatedScore, w: nodeWindow });
    }
    const newHist = scoreHist.slice(-30);
    localStorage.setItem(histKey, JSON.stringify(newHist));
    setServerScoreHistory(newHist);
    if (user) {
      fetch(`${API_ENDPOINT}/users/me/score-history`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.userId, examType: targetExam, scoreHistory: newHist }),
      }).catch(() => {});
    }
  }, [targetExam, estimatedScore, jstDate, uid, scoreHistLoaded, statsSynced, nodeWindow]); // eslint-disable-line react-hooks/exhaustive-deps

  // セッション完了後にセッション別スコア履歴を追記
  useEffect(() => {
    if (!targetExam || estimatedScore === null) return;
    // サーバー読込・ローカル同期が済むまで待つ（疎ローカルを基にサーバー蓄積を上書きしない）。
    // 成績の再取得も待つ。セッション直後は古いキャッシュの予想スコアで記録してしまい、
    // ホームの表示（再取得後）とグラフ最新点がずれるため。
    if (!scoreHistLoaded || !statsSynced) return;
    const addKey = `sessionScoreAdd_${targetExam}_${uid}`;
    if (!localStorage.getItem(addKey)) return;
    localStorage.removeItem(addKey);
    const jstNow = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    // 直近5件のセッションスコア（既存）
    const sessionHistKey = `score_session_history_${targetExam}_${uid}`;
    let hist: number[] = [];
    try { hist = JSON.parse(localStorage.getItem(sessionHistKey) ?? '[]'); } catch {}
    hist = [...hist, estimatedScore].slice(-10);
    localStorage.setItem(sessionHistKey, JSON.stringify(hist));
    setServerSessionHistory(hist);
    // 全セッションのスコアログ（ハイスコア用）
    const sessionLogKey = `score_session_log_${targetExam}_${uid}`;
    let log: ScoreEntry[] = [];
    try { log = JSON.parse(localStorage.getItem(sessionLogKey) ?? '[]'); } catch {}
    log = [...log, { date: jstNow, score: estimatedScore, w: nodeWindow }].slice(-100);
    localStorage.setItem(sessionLogKey, JSON.stringify(log));
    setServerSessionScoreLog(log);
    if (user) {
      fetch(`${API_ENDPOINT}/users/me/score-history`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.userId, examType: targetExam, sessionScoreHistory: hist, sessionScoreLog: log }),
      }).catch(() => {});
    }
  }, [domainStats, targetExam, uid, estimatedScore, scoreHistLoaded, statsSynced, nodeWindow]); // eslint-disable-line react-hooks/exhaustive-deps

  const scoreDelta = prevScore !== null && estimatedScore !== null ? estimatedScore - prevScore : null;

  // サクッと演習ドラフトから再開
  const hasQuickDraft = !!(quickDraft && quickDraft.examType === targetExam);
  const hasFocusedDraft = !!(focusedDraft && focusedDraft.examType === targetExam);

  const resumeQuickExercise = () => {
    if (!quickDraft) return;
    navigate('/aws/exercise/session', {
      state: {
        sessionId: quickDraft.sessionId,
        questions: quickDraft.questions,
        // 出題予定ID・予備IDを渡す（無いと totalCount がロード済み問題数まで縮み、
        // 設定した問題数より少ないまま演習が終わってしまう）
        questionIds: quickDraft.questionIds ?? [],
        spareQuestionIds: quickDraft.spareIds ?? [],
        userId: quickDraft.userId,
        examType: quickDraft.examType,
        mode: 'exercise',
        isQuick: true,
        resumeIndex: quickDraft.currentIndex,
        resumeResults: quickDraft.results,
        resumeAnswered: quickDraft.answered,
        resumeSelectedAnswers: quickDraft.selectedAnswers,
        resumeSelectionHistory: quickDraft.selectionHistory,
      }
    });
  };

  const resumeFocusedExercise = () => {
    if (!focusedDraft) return;
    navigate('/aws/exercise/session', {
      state: {
        sessionId: focusedDraft.sessionId,
        questions: focusedDraft.questions,
        questionIds: focusedDraft.questionIds ?? [],
        spareQuestionIds: focusedDraft.spareIds ?? [],
        userId: focusedDraft.userId,
        examType: focusedDraft.examType,
        mode: 'exercise',
        isQuick: true,
        isFocused: true,
        resumeIndex: focusedDraft.currentIndex,
        resumeResults: focusedDraft.results,
        resumeAnswered: focusedDraft.answered,
        resumeSelectedAnswers: focusedDraft.selectedAnswers,
        resumeSelectionHistory: focusedDraft.selectionHistory,
      }
    });
  };

  const discardQuickDraft = () => {
    localStorage.removeItem(`quickExerciseDraft_${uid}`);
    setQuickDraft(null);
  };
  const discardFocusedDraft = () => {
    localStorage.removeItem(`focusedExerciseDraft_${uid}`);
    setFocusedDraft(null);
  };

  const switchMode = (mode: 'quick' | 'focused') => {
    setLastMode(mode);
    localStorage.setItem(`lastQuickMode_${uid}`, mode);
  };

  // サクッと演習
  const startQuickExercise = async () => {
    if (!targetExam) { alert(ja ? '試験を選択してください' : 'Please select an exam'); return; }
    // 1日の演習上限（おひねり）。残りに切り詰めるか、閉じたら開始しない
    const gatedCount = await ohineriGate(loadQuickPrefs(uid).questionCount ?? 5);
    if (gatedCount == null) return;
    setShowStartTutorial(false);
    if (estimatedScore !== null) localStorage.setItem(`score_prev_${targetExam}_${uid}`, JSON.stringify({ s: estimatedScore, w: nodeWindow }));
    const userId = user?.userId ?? 'guest';
    // ホームのプライマリ枠（サクッと/しっかり対策）のみ確定。演習(practice)・模試(exam)は残す。
    await autoScoreAndClearDrafts(userId, [`quickExerciseDraft_${userId}`, `focusedExerciseDraft_${userId}`]);
    discardQuickDraft();
    discardFocusedDraft();
    setLastMode('quick');
    localStorage.setItem(`lastQuickMode_${uid}`, 'quick');
    setQuickLoading(true);
    setQuickLoadPct(10);
    const qPrefs = loadQuickPrefs(uid);
    // 回答状況フィルタ（指定なし/未回答/不正解/未正解）＋ブックマーク優先（併用可）。
    // 未正解=未回答 or 不正解 は両フラグを渡すとサーバ scoreFn が加算し和集合として効く。
    const qPriority = resolveQuickPriority(qPrefs);
    const qFlags = {
      unansweredOnly: qPriority === 'unanswered' || qPriority === 'notcorrect',
      incorrectOnly:  qPriority === 'incorrect'  || qPriority === 'notcorrect',
      bookmarkOnly: quickBookmark(qPrefs),
    };

    try {
      const userId = user?.userId ?? 'guest';
      const hasStatusFilter = !!(user && (qFlags.unansweredOnly || qFlags.incorrectOnly || qFlags.bookmarkOnly));
      const selIdx = domainsToIndices(targetExam, qPrefs.domains ?? []);
      const allDomains = EXAM_DOMAINS[targetExam] ?? [];
      const allSelected = selIdx.length === 0 || selIdx.length >= allDomains.length;
      const count = gatedCount;
      const plateau = randomPlateau();
      const stopAnim = animateLoadPct(setQuickLoadPct, 10, plateau);
      // 前提知識(オリジナル資格)の混在: 対応資格があり、ドメイン絞り込みをしていない時のみ
      // （絞り込んだ公式ドメインに対応するオリジナル資格のドメインは無いため）
      const useCompanion = allSelected && !!COMPANION_EXAM[targetExam] && includeCompanionPref(qPrefs);

      // IDのみ取得（Lambda 側でフィルタ・ドメイン均等化）。フィルタ無しでも userId を渡すと
      // 回答数の少ないドメインを優先する deficit round-robin が効き、出題が特定ドメインに偏らない。
      const idsParams = new URLSearchParams({ examType: targetExam, shuffle: 'true', idsOnly: 'true' });
      if (!allSelected) idsParams.set('domain', selIdx.join(','));
      if (useCompanion) idsParams.set('includeCompanion', 'true');
      if (user && qFlags.bookmarkOnly)   idsParams.set('bookmarkOnly',   'true');
      if (user && qFlags.unansweredOnly) idsParams.set('unansweredOnly', 'true');
      if (user && qFlags.incorrectOnly)  idsParams.set('incorrectOnly',  'true');
      if (user) idsParams.set('userId', userId); // フィルタ無しでもドメイン均等化のため常に渡す
      const idsData = await fetch(`${API_ENDPOINT}/questions?${idsParams}`).then(r => r.json());
      if (stopAnim) { stopAnim(); setQuickLoadPct(plateau); }
      const allIds: string[] = idsData.questionIds ?? [];
      let selectedIds = allIds.slice(0, count);
      // 優先フィルタで設定数に満たない場合、同一ドメイン内のフィルタ外の問題で補充する
      if (selectedIds.length < count && hasStatusFilter) {
        const fillParams = new URLSearchParams({ examType: targetExam, shuffle: 'true', idsOnly: 'true' });
        if (!allSelected) fillParams.set('domain', selIdx.join(','));
        if (useCompanion) fillParams.set('includeCompanion', 'true');
        if (user) fillParams.set('userId', userId);
        try {
          const fillData = await fetch(`${API_ENDPOINT}/questions?${fillParams}`).then(r => r.json());
          const have = new Set(selectedIds);
          for (const id of (fillData.questionIds ?? []) as string[]) {
            if (selectedIds.length >= count) break;
            if (!have.has(id)) { selectedIds.push(id); have.add(id); }
          }
        } catch (e) { console.debug('[quick] fill topup failed:', e); }
      }
      if (selectedIds.length === 0) { alert(ja ? '条件に合う問題がありません' : 'No questions match the criteria'); return; }
      setQuickLoadPct(90);
      const questionIds = selectedIds;
      // 予備ID: 出題中に削除済み等で読み込めないIDが出ても設定問題数を満たせるよう控えを渡す。
      const _usedSel = new Set(questionIds);
      const spareQuestionIds = allIds.filter(id => !_usedSel.has(id)).slice(0, 10);
      // セッション作成は遷移先で非同期実行。1 問目だけ取得して残りはプログレッシブロード。
      // ids指定時は examType 一致フィルタを付けない（前提知識混在時、1問目が companion
      // 側のexamTypeを持つ可能性があり、targetExamで絞ると誤って0件になるため）。
      const q1Data = await fetch(`${API_ENDPOINT}/questions?ids=${questionIds[0]}&withAnswers=true`).then(r => r.json());
      navigate('/aws/exercise/session', { state: { createSession: { userId, mode: 'exercise', examType: targetExam, questionIds }, questions: q1Data.items ?? [], questionIds, spareQuestionIds, userId, mode: 'exercise', examType: targetExam, isQuick: true } });
    } catch (err) { console.error(err); alert(ja ? '演習の開始に失敗しました' : 'Failed to start exercise'); }
    finally { setQuickLoading(false); setQuickLoadPct(0); }
  };

  // しっかり対策
  const startFocusedExercise = async () => {
    if (!targetExam) { alert(ja ? '試験を選択してください' : 'Please select an exam'); return; }
    if (!user) { alert(ja ? 'ログインが必要です' : 'Login required'); return; }
    const gatedCount = await ohineriGate(loadFocusedPrefs(uid).questionCount ?? 5);
    if (gatedCount == null) return;
    setShowStartTutorial(false);
    if (estimatedScore !== null) localStorage.setItem(`score_prev_${targetExam}_${uid}`, JSON.stringify({ s: estimatedScore, w: nodeWindow }));
    // ホームのプライマリ枠（サクッと/しっかり対策）のみ確定。演習(practice)・模試(exam)は残す。
    await autoScoreAndClearDrafts(user.userId, [`quickExerciseDraft_${user.userId}`, `focusedExerciseDraft_${user.userId}`]);
    discardQuickDraft();
    discardFocusedDraft();
    setLastMode('focused');
    localStorage.setItem(`lastQuickMode_${uid}`, 'focused');
    setFocusedLoading(true);
    setFocusedLoadPct(10);
    const fPrefs = loadFocusedPrefs(uid);

    // 前提知識(オリジナル資格)の混在: 対応資格がある場合のみ。しっかり対策にドメイン絞り込みは無い。
    const useCompanion = !!COMPANION_EXAM[targetExam] && includeCompanionPref(fPrefs);

    try {
      const userId = user.userId;
      // 混在有無でプールの中身が変わるため、トグル切替時に誤って古いキャッシュを
      // 使わないようキャッシュキーを分ける。
      const qCacheKey = `qlist_${targetExam}${useCompanion ? '_companion' : ''}`;
      const cachedQs = getCachedPersist<{ items: any[]; total: number }>(qCacheKey);
      const plateau = randomPlateau();
      const stopAnim = cachedQs ? null : animateLoadPct(setFocusedLoadPct, 10, plateau);
      // プール（フルキャッシュがあればそれを、無ければ metaOnly 軽量取得）と苦手問題データを並行フェッチ。
      // 弱点ドメイン判定は q.domain のみ・苦手判定は questionId のみ使うため metaOnly で足りる。
      // 回答状況フィルタ（排他）: 指定なし / 未回答 / 不正解 / 未正解(=未回答 or 不正解)
      const focusPriority = resolveFocusPriority(fPrefs);
      // 正答率フィルタ（排他・問題ごとの累計正答率・未満）: 指定なし / 50 / 66 / 75%
      const focusAccuracy = resolveFocusAccuracy(fPrefs);
      const accThreshold = focusAccuracyThreshold(focusAccuracy);
      const companionParam = useCompanion ? '&includeCompanion=true' : '';
      // プール(metaOnly)＋ユーザー問題ステータス(answered/incorrect/weak)を1本ずつで取得。
      const [data, statusRes] = await Promise.all([
        cachedQs ? Promise.resolve(cachedQs) : fetch(`${API_ENDPOINT}/questions?examType=${targetExam}&metaOnly=true${companionParam}`).then(r => r.json()),
        fetch(`${API_ENDPOINT}/users/me/question-status?userId=${userId}&examType=${targetExam}${companionParam}`).then(r => r.json()).catch(() => null),
      ]);
      if (stopAnim) { stopAnim(); setFocusedLoadPct(plateau); }
      // フルキャッシュ時のみ明示的に validity フィルタ（metaOnly はサーバ側で済み）
      const allItems: any[] = cachedQs ? (data.items ?? []).filter((q: any) => !!q.validityCheckedAt) : (data.items ?? []);
      // プールをキャッシュして次回セッションの全件再取得を省く（短TTL）
      if (!cachedQs && (data?.items?.length ?? 0) > 0) {
        setCachedPersist(qCacheKey, { items: data.items, total: data.total ?? data.items.length }, 10 * 60 * 1000);
      }
      const incorrectCounts: Record<string, number> = statusRes?.incorrect ?? {};
      const answeredSet = new Set<string>(statusRes?.answered ?? []);
      const bookmarkedSet = new Set<string>(statusRes?.bookmarked ?? []);
      const focusBookmark = focusBookmarkOn(fPrefs); // ブックマークを優先（独立・上乗せ）
      const accMap: Record<string, number> = statusRes?.acc ?? {};
      const weakSet = new Set<string>(statusRes?.weak ?? []); // acc 無し(旧Lambda)時の 75%未満フォールバック
      // 正答率フィルタ該当判定（問題ごと・未満）。acc が無い旧Lambdaでは 75%未満のみ weak で近似。
      const accHit = (qid: string): boolean => {
        if (focusAccuracy === 'none') return false;
        const v = accMap[qid];
        if (v == null) return focusAccuracy === 'below75' && weakSet.has(qid);
        return v < accThreshold;
      };
      const focusDomain: string = fPrefs.focusDomain ?? 'below80'; // 既定＝正答率80%以下のドメインを優先

      // ② 弱点ドメイン判定は「直近10回」(recentResults) の正答率を優先採用。
      //    無ければ累計 correct/incorrect → ドメイン履歴の順にフォールバック。
      const threshold = focusDomain === 'none' ? 0
        : focusDomain === 'below40' ? 0.40 : focusDomain === 'below50' ? 0.50 : focusDomain === 'below70' ? 0.70 : focusDomain === 'below80' ? 0.80 : 0.60;
      const examDomains = EXAM_DOMAINS[targetExam] ?? [];
      const hist = readDomainHistory(targetExam, uid);
      const domainAcc = new Map<string, number | null>(); // ドメイン名 → 直近正答率（null=データ無し）
      examDomains.forEach((domain, idx) => {
        const stat = domainStats.find(s => tagIdMatches(s.tagId, targetExam, idx));
        // マイページ苦手分析と同じ「直近10回」にスライス
        const recent = (stat?.recentResults ?? []).slice(-10);
        let acc: number | null = null;
        if (recent.length > 0) {
          acc = recent.filter(Boolean).length / recent.length;
        } else if (stat && ((stat.correctCount ?? 0) + (stat.incorrectCount ?? 0)) > 0) {
          acc = (stat.correctCount ?? 0) / ((stat.correctCount ?? 0) + (stat.incorrectCount ?? 0));
        } else {
          const sessions = hist[String(idx)];
          if (sessions && sessions.length > 0) {
            const c = sessions.reduce((s, r) => s + r.correct, 0);
            const t = sessions.reduce((s, r) => s + r.total, 0);
            acc = t === 0 ? null : c / t;
          }
        }
        domainAcc.set(domain, acc);
      });
      // ドメイン弱点度（0〜1）：未演習(null)は最優先の 1、閾値以上は 0、閾値内は弱いほど大。
      const domainDeficit = (name: string): number => {
        if (focusDomain === 'none') return 0;
        const acc = domainAcc.get(name);
        if (acc == null) return 1;
        if (acc >= threshold) return 0;
        return (threshold - acc) / threshold;
      };

      // ① 蓄積成績で重み付けして抽出：base + 優先集合ヒット×W + ミス回数×W + ドメイン弱点度×W。
      //    選んだ優先条件（未回答/不正解/未正解）に合う問題を強く優先しつつ、base 重みで
      //    条件外の問題も混ぜて充足（count 件）を担保する（少ない場合の補充）。
      const W_PRIORITY = 8, W_WEAK = 8, W_INCORRECT = 4, W_DOMAIN = 6, W_BOOKMARK = 8, BASE = 1;
      const count = gatedCount;
      const pool = Array.from(new Map(allItems.map((q: any) => [q.questionId, q])).values());
      const focusWeightFn = (q: any) => {
        const qid = q.questionId;
        const isUnanswered = !answeredSet.has(qid);
        const isIncorrect = (incorrectCounts[qid] ?? 0) > 0;
        const inTarget = focusPriority === 'none' ? false
          : focusPriority === 'unanswered' ? isUnanswered
          : focusPriority === 'incorrect' ? isIncorrect
          : (isUnanswered || isIncorrect); // notcorrect = 未回答 or 不正解
        let w = BASE;
        if (inTarget) w += W_PRIORITY;
        // ブックマークフィルタ（独立・上乗せ）: ブックマーク済みを重視
        if (focusBookmark && bookmarkedSet.has(qid)) w += W_BOOKMARK;
        // 正答率フィルタ（問題ごと・未満）: 該当問題を上乗せ
        if (accHit(qid)) w += W_WEAK;
        // 不正解を含む優先度では、ミス回数が多い問題ほどさらに優先
        if (focusPriority === 'incorrect' || focusPriority === 'notcorrect') w += (incorrectCounts[qid] ?? 0) * W_INCORRECT;
        // ドメイン弱点度は targetExam 自身のドメイン体系に基づく重み付けなので、
        // 前提知識(companion)の問題（別examType・別ドメイン体系）には適用しない
        // （domainAcc に無いドメイン名で誤って「未演習=最優先」扱いになるのを防ぐ）。
        if (q.examType === targetExam) w += domainDeficit(qDomainName(q)) * W_DOMAIN;
        return w;
      };
      // 公式と前提知識(companion)は同じプールで重み付き抽出する（specs/005）。
      // フィルタ有効時に公式を先に使い切る処理（specs/004）は廃止した。
      const items: any[] = weightedSampleWithoutReplacement(pool, focusWeightFn, count);
      if (items.length === 0) { alert(ja ? '条件に合う問題がありません' : 'No questions match the criteria'); return; }
      setFocusedLoadPct(90);
      const questionIds = items.map((q: any) => q.questionId);
      // 予備ID: 出題中に読み込めないIDが出ても設定問題数を満たせるよう控えを渡す（1問目取得は不変）。
      const _usedSel = new Set(questionIds);
      const spareQuestionIds = shuffleArray(pool.filter((q: any) => !_usedSel.has(q.questionId)))
        .slice(0, 10).map((q: any) => q.questionId);
      // セッション作成は遷移先で非同期実行。フルキャッシュ時は全問をそのまま渡し、
      // metaOnly 時は 1 問目だけ取得して残りはプログレッシブロード。
      if (cachedQs) {
        navigate('/aws/exercise/session', { state: { createSession: { userId, mode: 'exercise', examType: targetExam, questionIds, isFocused: true }, questions: items, spareQuestionIds, userId, mode: 'exercise', examType: targetExam, isQuick: true, isFocused: true } });
      } else {
        // 前提知識混在時、1問目が companion 側の examType を持ちうるため examType 絞り込みは付けない。
        const q1Data = await fetch(`${API_ENDPOINT}/questions?ids=${questionIds[0]}&withAnswers=true`).then(r => r.json());
        navigate('/aws/exercise/session', { state: { createSession: { userId, mode: 'exercise', examType: targetExam, questionIds, isFocused: true }, questions: q1Data.items ?? [], questionIds, spareQuestionIds, userId, mode: 'exercise', examType: targetExam, isQuick: true, isFocused: true } });
      }
    } catch (err) { console.error(err); alert(ja ? '演習の開始に失敗しました' : 'Failed to start exercise'); }
    finally { setFocusedLoading(false); setFocusedLoadPct(0); }
  };

  // マイページの「しっかり対策を開始する」ボタンから遷移してきた場合に自動起動
  useEffect(() => {
    if ((location.state as any)?.startFocused && user && targetExam && focusedUnlockedCached) {
      window.history.replaceState({}, '', location.pathname);
      startFocusedExercise();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // オーバーレイ表示中は body スクロール・横スワイプ無効
  useEffect(() => {
    const anyOpen = showQuickModal || showFocusedModal || showCombinedDetail ||
      (isMobile && (showNewPanel || showFocusedMenu));
    if (!anyOpen) return;
    return lockBodyScroll();
  }, [showQuickModal, showFocusedModal, showCombinedDetail, showNewPanel, showFocusedMenu, isMobile]);

  // ドメイン別成績（サーバー統計優先、ゲスト/オフライン時はローカル履歴）
  const domains = useMemo(() => targetExam ? (EXAM_DOMAINS[targetExam] ?? []) : [], [targetExam]);
  const domainAccList = useMemo(() => {
    if (!targetExam) return [] as { correct: number; total: number; pct: number | null }[];
    const hist = readDomainHistory(targetExam, uid);
    return domains.map((d, idx) => {
      const stat = domainStats.find(s => tagIdMatches(s.tagId, targetExam, idx));
      if (stat) {
        const correct = stat.correctCount ?? 0;
        const total = correct + (stat.incorrectCount ?? 0);
        return { correct, total, pct: total > 0 ? Math.round(correct / total * 100) : null };
      }
      const sessions = hist[String(idx)];
      if (!sessions || sessions.length === 0) return { correct: 0, total: 0, pct: null };
      const correct = sessions.reduce((s, r) => s + r.correct, 0);
      const total = sessions.reduce((s, r) => s + r.total, 0);
      return { correct, total, pct: total > 0 ? Math.round(correct / total * 100) : null };
    });
  }, [targetExam, domains, uid, domainStats]);

  // しっかり対策「ドメインフィルタ」の対象表示用: 選出ロジックと同じ「直近10回優先」で
  // ドメイン別正答率(0..1、未挑戦は null)を算出する（表示と実際の優先対象を一致させる）。
  const focusDomainAcc = useMemo(() => {
    if (!targetExam) return [] as { name: string; acc: number | null }[];
    const hist = readDomainHistory(targetExam, uid);
    return (EXAM_DOMAINS[targetExam] ?? []).map((name, idx) => {
      const stat = domainStats.find(s => tagIdMatches(s.tagId, targetExam, idx));
      const recent = (stat?.recentResults ?? []).slice(-10);
      let acc: number | null = null;
      if (recent.length > 0) {
        acc = recent.filter(Boolean).length / recent.length;
      } else if (stat && ((stat.correctCount ?? 0) + (stat.incorrectCount ?? 0)) > 0) {
        acc = (stat.correctCount ?? 0) / ((stat.correctCount ?? 0) + (stat.incorrectCount ?? 0));
      } else {
        const sessions = hist[String(idx)];
        if (sessions && sessions.length > 0) {
          const c = sessions.reduce((s, r) => s + r.correct, 0);
          const t = sessions.reduce((s, r) => s + r.total, 0);
          acc = t === 0 ? null : c / t;
        }
      }
      return { name, acc };
    });
  }, [targetExam, uid, domainStats]);

  const hasPrimaryDraft = primaryMode === 'focused' ? hasFocusedDraft : hasQuickDraft;
  const resumePrimary = primaryMode === 'focused' ? resumeFocusedExercise : resumeQuickExercise;
  const primaryLoading = primaryMode === 'focused' ? focusedLoading : quickLoading;
  const primaryLoadPct = primaryMode === 'focused' ? focusedLoadPct : quickLoadPct;
  const primaryBg = primaryMode === 'focused' ? 'var(--color-points)' : 'var(--color-accent)';
  const primaryColor = primaryMode === 'focused' ? 'var(--color-on-level)' : 'var(--color-btn-primary-text)';
  const primarySpinnerBorder = primaryMode === 'focused' ? '2px solid rgba(255,255,255,0.3)' : '2px solid rgba(0,0,0,0.2)';
  const primarySpinnerTop = primaryMode === 'focused' ? 'var(--color-on-level)' : 'var(--color-btn-primary-text)';
  const discardPrimaryDraft = primaryMode === 'focused' ? discardFocusedDraft : discardQuickDraft;
  const startPrimary = primaryMode === 'focused' ? startFocusedExercise : startQuickExercise;

  // Shift+Enter で表示中のプライマリ開始ボタンを発火（Web版のみ）
  const startKeyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  startKeyRef.current = (e: KeyboardEvent) => {
    if (isMobile || !(e.key === 'Enter' && (e.ctrlKey || e.metaKey))) return;
    const el = e.target as HTMLElement | null;
    const tag = el?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
    if (showQuickModal || showFocusedModal || showCombinedDetail || showWebQuickMenu || showFocusedMenu || revealService) return;
    e.preventDefault();
    if (hasPrimaryDraft) resumePrimary();
    else if (targetExam && !primaryLoading) startPrimary();
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => startKeyRef.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // Esc で開いているオーバレイを閉じる（最前面を優先）
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (showCombinedDetail) setShowCombinedDetail(false);
      else if (revealService) setRevealService(null);
      else if (showQuickModal) setShowQuickModal(false);
      else if (showFocusedModal) setShowFocusedModal(false);
      else if (showWebQuickMenu) setShowWebQuickMenu(false);
      else if (showFocusedMenu) setShowFocusedMenu(false);
      else return;
      e.stopPropagation();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [showCombinedDetail, revealService, showQuickModal, showFocusedModal, showWebQuickMenu, showFocusedMenu]);

  // ログイン経験者は、認証確定(authLoading完了)まで未ログイン用UI(日めくり記事等)を描画しない。
  // 未ログイン/初回訪問ユーザー(hadPriorSession=false)は従来どおり即表示する。
  if (authLoading && !user && hadPriorSession()) {
    return (
      <PageLayout maxWidth={HOME_MAX_WIDTH} style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }} className="page-container">
        <div className="sherpa-spinner" style={{ width: 28, height: 28, borderWidth: 3 }} />
      </PageLayout>
    );
  }

  // 目標演習量カード。モバイルは従来どおり先頭（左カラム）、デスクトップは
  // 「今日の行動」をまとめた右カラムの先頭に置くため、両方から使えるよう変数にする。
  const dailyGoalCard = (
      <Card
        data-kbnav="1"
        padding="var(--spacing-md)"
        style={{ marginBottom: 'var(--spacing-md)', cursor: 'pointer' }}
        onClick={() => navigate('/aws/mypage')}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <span style={{ color: 'var(--color-text-sub)', display: 'flex', alignItems: 'center' }}>
            <IconTarget size={13} />
          </span>
          <span style={{ fontWeight: 700, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-main)' }}>
            {ja ? '目標演習量' : 'Daily Goal'}
          </span>
          {ja && <span style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-sub)' }}>※達成で<span style={{ color: 'var(--color-points)', fontWeight: 700 }}>+10p</span>！</span>}
          <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--font-size-sm2)', fontWeight: 700, color: dailyCount >= dailyGoal ? 'var(--color-success)' : 'var(--color-text-sub)' }}>
            {dailyCount >= dailyGoal && <IconCircleCheck size={14} />}
            {dailyCount} / {dailyGoal}{ja ? '問' : 'Q'}
          </span>
        </div>
        <div style={{ height: 6, borderRadius: 3, background: 'var(--color-border)', overflow: 'hidden' }}>
          {(() => {
            const barColor = dailyCount >= dailyGoal
              ? 'linear-gradient(90deg, var(--color-points), #4dd9d9)'
              : 'linear-gradient(90deg, var(--color-points), #00cccc)';
            return (
              <div style={{ height: '100%', width: `${Math.min(100, (dailyCount / dailyGoal) * 100)}%`, borderRadius: 3, background: barColor, transformOrigin: 'left center', animation: 'growWidth 0.45s cubic-bezier(0.34, 1.56, 0.64, 1) both' }} />
            );
          })()}
        </div>
      </Card>
  );

  // 成績パネルの共通 props（「実力の現在地」「推移と記録」で同じデータを渡す）
  const perfProps = {
    domainAccList, estimatedScore, passScore, lang, isMobile, uid, domainStats,
    scoreHistory: serverScoreHistory ?? undefined,
    sessionScoreLog: serverSessionScoreLog ?? undefined,
    nodeWindow,
    onNodeWindowChange: (w: 5 | 10) => { setNodeWindow(w); localStorage.setItem(`scoreWindow_${uid}`, String(w)); },
  };

  // デスクトップのパネル見出し（カード内の小見出し）
  const panelHeading = (icon: React.ReactNode, text: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
      <span style={{ color: 'var(--color-text-sub)', display: 'flex', alignItems: 'center' }}>{icon}</span>
      <span style={{ fontWeight: 700, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-main)' }}>{text}</span>
    </div>
  );

  return (
    <PageLayout maxWidth={HOME_MAX_WIDTH} className="page-container">
      {/* ダッシュボード本体。デスクトップは役割で2カラムに分ける。
            左（2fr）= 成績: 「実力の現在地」「推移と記録」＝これまでの結果を見る
            右（1fr）= 今日の行動: 「目標演習量」「日めくり」「苦手分析」＝今日やること
          モバイルは従来どおり縦一列（目標演習量 → サマリー → 日めくり）で変更なし。
          alignItems:'stretch'（既定）で両カラムの高さを揃え、右カラムは
          flexDirection:'column'+最後のパネルへの flex:1 で、短い方の最終パネルの
          下端を左カラムの下端に合わせる（ページ最下部でパネルの底が揃うように）。 */}
      <div style={isMobile ? undefined : { display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gap: 'var(--spacing-md)' }}>
      <div>

      {/* ── 目標演習量（モバイルのみ先頭。デスクトップは右カラム＝今日の行動へ） ── */}
      {isMobile && dailyGoalCard}

      {/* ── デスクトップ「実力の現在地」──
          予想スコアとドメイン別の内訳は同じデータの粒度違いなので、
          サマリー(バー)と内訳(ノード)を二重に出さず、この1パネルに統合する。 */}
      {!isMobile && targetExam && (
        <Card padding="var(--spacing-md)" style={{ marginBottom: 'var(--spacing-md)' }}>
          {panelHeading(<IconChart size={13} />, ja ? '実力の現在地' : 'Where You Stand')}
          <CombinedDetailModal targetExam={targetExam} {...perfProps} inline="score" />
        </Card>
      )}

      {/* ── デスクトップ「推移と記録」──
          時系列で見るもの(セッション別推移・日次最高点・ハイスコア)をまとめる。 */}
      {!isMobile && targetExam && (
        <Card padding="var(--spacing-md)" style={{ marginBottom: 'var(--spacing-md)' }}>
          {panelHeading(<IconTrendingUp size={13} />, ja ? '推移と記録' : 'Trend & Records')}
          <CombinedDetailModal targetExam={targetExam} {...perfProps} inline="trend" />
        </Card>
      )}

      {/* ── ドメイン別正答率 + 予想スコア（モバイルのみ。タップでモーダル詳細）──
          デスクトップは上の「実力の現在地」に統合済みのため出さない。 */}
      {isMobile && (
      <Card
        data-kbnav="1"
        padding="var(--spacing-md)"
        style={{ marginBottom: 'var(--spacing-md)', cursor: (isMobile && targetExam && !statsLoading) ? 'pointer' : 'default', position: 'relative' }}
        onClick={() => { if (isMobile && targetExam && !statsLoading) setShowCombinedDetail(true); }}
      >
        <div style={isMobile ? { display: 'flex', flexDirection: 'column-reverse' } : { display: 'flex', gap: 0 }}>

          {/* ドメイン別正答率 */}
          <div style={isMobile ? {} : { flex: 1, minWidth: 0, paddingRight: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 8 }}>
              <span style={{ color: 'var(--color-text-sub)', display: 'flex', alignItems: 'center' }}>
                <IconChart size={12} />
              </span>
              <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-text-sub)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                {ja ? 'ドメイン別正答率' : 'Domain Accuracy'}
              </span>
            </div>
            {!targetExam ? (
              <div style={{ color: 'var(--color-text-light)', fontSize: 'var(--font-size-sm)', fontStyle: 'italic' }}>
                {ja ? '試験を選択してください' : 'Select an exam'}
              </div>
            ) : statsLoading ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {[65, 80, 50, 72, 60].map((w, i) => (
                  <div key={i}><div className="skeleton" style={{ height: 12, width: `${w}%`, borderRadius: 3, marginBottom: 3 }} /><div className="skeleton" style={{ height: 5, width: '100%', borderRadius: 3 }} /></div>
                ))}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {domains.map((d, i) => {
                  const nodeResults = domainNodeResultsMap[d] ?? [];
                  const correctInNodes = nodeResults.filter(v => !!v).length;
                  const barPct = nodeResults.length > 0 ? correctInNodes / nodeWindow * 100 : null;
                  const grade = getGrade(barPct);
                  const label = d;
                  return (
                    <div key={d}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3 }}>
                        <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 800, color: 'var(--color-primary)', minWidth: 14, flexShrink: 0, textAlign: 'center' }}>{grade}</span>
                        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-sub)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{label}</span>
                      </div>
                      <div style={{ height: 5, background: 'var(--color-border)', borderRadius: 3, overflow: 'hidden' }}>
                        {barPct !== null && <div style={{ width: `${barPct}%`, minWidth: barPct === 0 ? 3 : undefined, height: '100%', borderRadius: 3, background: 'var(--bar-gradient-primary)', transformOrigin: 'left center', animation: `growWidth 0.45s cubic-bezier(0.34, 1.56, 0.64, 1) ${i * 30}ms both` }} />}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 区切り線（モバイル: 横線、デスクトップ: 縦線） */}
          {isMobile
            ? <div style={{ height: 1, background: 'var(--color-border)', margin: '10px 0' }} />
            : <div style={{ width: 1, background: 'var(--color-border)', flexShrink: 0 }} />
          }

          {/* 予想スコア */}
          <div style={isMobile ? {} : { flex: 1, minWidth: 0, paddingLeft: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ color: 'var(--color-text-sub)', display: 'flex', alignItems: 'center' }}>
                  <IconTrendingUp size={12} />
                </span>
                <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-text-sub)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  {/* 集計対象（直近N問）は詳細オーバーレイで切り替えられる。
                      表示中のスコアが何問を根拠にしているかタイトルで分かるようにする。 */}
                  {ja ? `予想スコア（直近${nodeWindow}問）` : `Est. Score (last ${nodeWindow})`}
                </span>
              </div>
              {/* 更新ボタンはログイン専用の機能だが、ゲスト時に要素ごと消すと
                  この行の高さが変わり、以降のセクションの位置がゲスト/ログインでずれる。
                  領域は常に確保し、ゲストでは不可視＋操作不可にして骨格を揃える。 */}
              <button
                onClick={e => { e.stopPropagation(); refreshStats(); }}
                disabled={!user || statsLoading || statsRefreshing}
                aria-hidden={!user}
                tabIndex={user ? undefined : -1}
                title={ja ? '成績を更新' : 'Refresh stats'}
                aria-label={ja ? '成績を更新' : 'Refresh stats'}
                style={{
                    width: 35, height: 35, borderRadius: '50%',
                    border: '1px solid var(--color-border)',
                    background: 'transparent',
                    color: 'var(--color-primary)',
                    cursor: (statsLoading || statsRefreshing) ? 'default' : 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    opacity: (statsLoading || statsRefreshing) ? 0.5 : 1,
                    flexShrink: 0,
                    visibility: user ? 'visible' : 'hidden',
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                    style={{ animation: (statsLoading || statsRefreshing) ? 'sherpa-spin 0.8s linear infinite' : 'none' }}>
                    <polyline points="23 4 23 10 17 10"/>
                    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                  </svg>
                </button>
            </div>
            {!targetExam ? (
              <div style={{ color: 'var(--color-text-light)', fontSize: 'var(--font-size-sm)', fontStyle: 'italic' }}>
                {ja ? '試験を選択してください' : 'Select an exam'}
              </div>
            ) : statsLoading ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div className="skeleton" style={{ height: 28, width: '55%', borderRadius: 6 }} />
                <div className="skeleton" style={{ height: 7, width: '100%', borderRadius: 4 }} />
              </div>
            ) : estimatedScore === null ? (
              <div style={{ color: 'var(--color-text-light)', fontSize: 'var(--font-size-sm)', fontStyle: 'italic' }}>
                {ja ? '演習データがありません' : 'No practice data yet'}
              </div>
            ) : (
              <>
                {(() => {
                  // 合格ラインはバー上の細い境目線＋数値ラベルだけで示す。
                  // バー自体・スコア数値は下のドメイン別正答率と統一して常に青（合格圏でも変えない）。
                  // ただし右上の「合格」ラベルだけは、達成時にチェック＋緑で目標達成を伝える。
                  const passPct = passScore !== null ? (passScore / 1000) * 100 : 0;
                  const reachedPass = passScore !== null && estimatedScore >= passScore;
                  return (
                    <>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 6 }}>
                        <span style={{ fontSize: 'var(--font-size-h2)', fontWeight: 800, color: 'var(--color-primary)', letterSpacing: '-0.5px' }}>{estimatedScore}</span>
                        <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-light)' }}>/1000</span>
                        {scoreDelta !== null && (
                          <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 700, color: scoreDelta > 0 ? 'var(--color-success)' : scoreDelta < 0 ? 'var(--color-danger)' : 'var(--color-text-light)' }}>
                            {scoreDelta > 0 ? `+${scoreDelta}` : scoreDelta < 0 ? `${scoreDelta}` : '±0'}
                          </span>
                        )}
                        {passScore !== null && (
                          <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-size-2xs)', fontWeight: reachedPass ? 700 : 600, color: reachedPass ? 'var(--color-success)' : 'var(--color-text-light)', whiteSpace: 'nowrap' }}>
                            {reachedPass && <IconCircleCheck size={12} />}
                            {reachedPass
                              ? (ja ? `合格：${passScore}点` : `Pass: ${passScore}`)
                              : (ja ? `合格 ${passScore}` : `Pass ${passScore}`)}
                          </span>
                        )}
                      </div>
                      <div style={{ position: 'relative', height: 7, background: 'var(--color-border)', borderRadius: 4, overflow: 'hidden' }}>
                        {/* 実力バー（常に青。合格圏でも色は変えない） */}
                        <div style={{ position: 'relative', width: `${Math.min(100, (estimatedScore / 1000) * 100)}%`, height: '100%', borderRadius: 4, background: 'var(--bar-gradient-primary)', transformOrigin: 'left center', animation: 'growWidth 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) both' }} />
                        {/* 合格ラインの境目 */}
                        {passScore !== null && (
                          <div style={{ position: 'absolute', left: `${passPct}%`, top: 0, bottom: 0, width: 2, marginLeft: -1, background: 'var(--color-bg-white)', opacity: 0.9 }} />
                        )}
                      </div>
                    </>
                  );
                })()}
              </>
            )}
          </div>

        </div>

      </Card>
      )}

      </div>
      <div style={isMobile ? undefined : { display: 'flex', flexDirection: 'column' }}>

      {/* ── 目標演習量（デスクトップは「今日の行動」列の先頭） ── */}
      {!isMobile && dailyGoalCard}

      {/* ── 日めくりAWSサービス ── */}
      <TodayServiceSection
        lang={lang}
        userId={user?.userId}
        authReady={!authLoading}
        onNavigateEncyclopedia={() => navigate('/aws/encyclopedia')}
        onReveal={svc => setRevealService(svc)}
        isMobile={isMobile}
      />

      {/* ── 苦手分析（デスクトップ・ログイン専用。ゲストは非表示） ──
          マイページ苦手分析タブの要約。詳細はクリックでマイページへ遷移して見る。
          flex:1 + 中央寄せで、右カラム最後のパネルとして左カラムの下端まで
          自然に伸ばし、ページ最下部でパネルの底を左カラムに揃える。 */}
      {!isMobile && user && targetExam && (
        <Card
          padding="var(--spacing-md)"
          // 未解放のときは中身が1行だけなので伸ばさない（空の大きな枠が壊れて見えた）
          style={{ marginTop: 'var(--spacing-md)', cursor: 'pointer', flex: effectiveFocusedUnlocked ? 1 : undefined, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}
          onClick={() => navigate('/aws/mypage', { state: { tab: 'analysis' } })}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
            <span style={{ color: 'var(--color-text-sub)', display: 'flex', alignItems: 'center' }}>
              <IconTrendingUp size={13} />
            </span>
            <span style={{ fontWeight: 700, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-main)' }}>
              {ja ? '苦手分析' : 'Weak Point Analysis'}
            </span>
          </div>
          {!effectiveFocusedUnlocked ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderRadius: 8, background: 'var(--color-bg-main)' }}>
              <IconLock size={14} />
              <span style={{ fontSize: 'var(--font-size-sm2)', color: 'var(--color-text-sub)' }}>
                {!answeredCountReady
                  ? (ja ? '演習量を確認中...' : 'Checking progress...')
                  : (ja ? `あと${Math.max(0, FOCUSED_UNLOCK_THRESHOLD - answeredCount)}問でアンロック` : `${Math.max(0, FOCUSED_UNLOCK_THRESHOLD - answeredCount)} more to unlock`)}
              </span>
            </div>
          ) : weakDomains.length === 0 && weakQuestions.length === 0 ? (
            <p style={{ margin: 0, fontSize: 'var(--font-size-sm2)', color: 'var(--color-text-light)' }}>
              {ja ? '目立った苦手はありません' : 'No weak points found'}
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {weakDomains.length > 0 && (
                <div>
                  <div style={{ fontSize: 'var(--font-size-2xs)', fontWeight: 700, color: 'var(--color-text-light)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>
                    {ja ? '苦手ドメイン' : 'Weak Domains'}
                  </div>
                  {weakDomains.map(({ domain, pct }) => (
                    <div key={domain} style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 'var(--font-size-sm2)', color: 'var(--color-text-main)', lineHeight: 1.6 }}>
                      <span style={{ fontWeight: 700, color: 'var(--color-danger)' }}>{Math.round(pct * 100)}%</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{domain}</span>
                    </div>
                  ))}
                </div>
              )}
              {weakQuestions.length > 0 && (
                <div>
                  <div style={{ fontSize: 'var(--font-size-2xs)', fontWeight: 700, color: 'var(--color-text-light)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>
                    {ja ? '間違えやすい問題' : 'Frequent Mistakes'}
                  </div>
                  {weakQuestions.slice(0, 2).map(q => (
                    <div key={q.questionId} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-sub)', lineHeight: 1.5, marginBottom: 4 }}>
                      <span style={{ flexShrink: 0, fontWeight: 700, color: 'var(--color-danger)', background: 'var(--color-danger-light)', borderRadius: 4, padding: '1px 5px' }}>
                        ×{q.incorrectCount}
                      </span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.questionText}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      </div>
      </div>

      {ohineriUi}

      {revealService && (
        <DailyServiceRevealModal
          service={revealService}
          lang={lang}
          onClose={() => { setRevealService(null); navigate('/aws/'); }}
          onNavigateEncyclopedia={() => { setRevealService(null); navigate('/aws/encyclopedia'); }}
          onStartExercise={() => setRevealService(null)}
        />
      )}

      {showUnlockModal && (
        <FeatureUnlockModal
          lang={lang}
          onClose={() => setShowUnlockModal(false)}
          onStart={() => { setShowUnlockModal(false); startFocusedExercise(); }}
        />
      )}

      {/* 非ログイン時バナーは廃止（ゲスト/ログインで骨格を揃えるため）。
          ログイン導線はヘッダーのアカウントアイコンと、ロック機能下の
          「ログインが必要です」の案内が担う。 */}

      {/* ── サクッと演習ボタン（デスクトップ固定） ── */}
      {!isMobile && createPortal(
        <div style={{ position: 'fixed', bottom: 16, left: 'var(--content-left, 0px)', right: 0, zIndex: 150 }}>
          <div style={{ maxWidth: HOME_MAX_WIDTH, margin: '0 auto', padding: '0 var(--spacing-lg)', display: 'flex', gap: 6 }}>
            {hasPrimaryDraft ? (
              <div style={{ flex: 1, position: 'relative' }}>
                {showWebQuickMenu && (
                  <>
                    <div onClick={() => setShowWebQuickMenu(false)} style={{ position: 'fixed', inset: 0, zIndex: 199 }} />
                    <div style={{ position: 'absolute', bottom: '110%', left: 0, right: 0, zIndex: 200, background: 'var(--color-bg-white)', borderRadius: 'var(--border-radius-md)', boxShadow: 'var(--box-shadow-up)', border: '1px solid var(--color-border)', padding: '8px', marginBottom: 6 }}>
                      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-sub)', textAlign: 'center', marginBottom: 8 }}>
                        {ja ? 'セッションを上書きして新しく開始します' : 'This will overwrite the current session'}
                      </div>
                      <Button variant="outline" size="sm" fullWidth style={{ height: 36, borderColor: primaryMode === 'focused' ? 'var(--color-points)' : 'var(--color-accent)', color: primaryMode === 'focused' ? 'var(--color-points)' : 'var(--color-accent)' }} onClick={() => { setShowWebQuickMenu(false); discardPrimaryDraft(); startPrimary(); }}>
                        {ja ? `新規に開始（${primaryMode === 'focused' ? 'しっかり対策' : 'サクッと演習'}）` : `Start New (${primaryMode === 'focused' ? 'Focused' : 'Quick'})`}
                      </Button>
                      <div style={{ marginTop: 6 }}>
                        {primaryMode === 'quick' ? (
                          <>
                            {effectiveFocusedUnlocked && <div style={{ textAlign: 'center', fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-light)', marginBottom: 4 }}>{ja ? '苦手・不正解問題を重点演習' : 'Focuses on weak/incorrect questions'}</div>}
                            <button
                              disabled={!targetExam || !user || !effectiveFocusedUnlocked}
                              onClick={() => { setShowWebQuickMenu(false); switchMode('focused'); }}
                              style={{ width: '100%', height: 36, padding: '0 12px', border: `1.5px solid ${(!targetExam || !user || !effectiveFocusedUnlocked) ? 'var(--color-border)' : 'var(--color-points)'}`, borderRadius: 'var(--border-radius-full)', cursor: (!targetExam || !user || !effectiveFocusedUnlocked) ? 'default' : 'pointer', background: 'transparent', color: (!targetExam || !user || !effectiveFocusedUnlocked) ? 'var(--color-text-light)' : 'var(--color-points)', fontWeight: 600, fontSize: 'var(--font-size-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}
                            >
                              {!effectiveFocusedUnlocked && <IconLock size={13} />}
                              {ja ? 'しっかり対策モード' : 'Switch to Focused'}
                            </button>
                            {!effectiveFocusedUnlocked && user && (
                              <div style={{ textAlign: 'center', fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-light)', marginTop: 3 }}>
                                {!answeredCountReady ? (ja ? '演習量を確認中...' : 'Checking progress...') : ja ? `現在${answeredCount}問 / あと${FOCUSED_UNLOCK_THRESHOLD - answeredCount}問で解放` : `${answeredCount} answered / ${FOCUSED_UNLOCK_THRESHOLD - answeredCount} more to unlock`}
                              </div>
                            )}
                            {!user && <div style={{ textAlign: 'center', fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-light)', marginTop: 3 }}>{ja ? 'ログインが必要です' : 'Login required'}</div>}
                          </>
                        ) : (
                          <>
                            <div style={{ textAlign: 'center', fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-light)', marginBottom: 4 }}>{ja ? '全ドメインを幅広く均等に出題' : 'Broad, even coverage across domains'}</div>
                            <button disabled={!targetExam} onClick={() => { setShowWebQuickMenu(false); switchMode('quick'); }} style={{ width: '100%', height: 36, padding: '0 12px', border: '1.5px solid var(--color-accent)', borderRadius: 'var(--border-radius-full)', cursor: !targetExam ? 'default' : 'pointer', background: 'transparent', color: 'var(--color-accent)', fontWeight: 600, fontSize: 'var(--font-size-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                              {ja ? 'サクッと演習モード' : 'Switch to Quick'}
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </>
                )}
                <div style={{ display: 'flex', height: 44, borderRadius: 22, overflow: 'hidden' }}>
                  <button
                    disabled={!targetExam || primaryLoading}
                    onClick={resumePrimary}
                    style={{ flex: 1, height: 44, border: 'none', background: primaryBg, color: primaryColor, fontWeight: 600, fontSize: 'var(--font-size-base)', cursor: (!targetExam || primaryLoading) ? 'default' : 'pointer', paddingLeft: 16, paddingRight: 8 }}
                  >
                    {primaryLoading ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 14, height: 14, border: primarySpinnerBorder, borderTopColor: primarySpinnerTop, borderRadius: '50%', animation: 'sherpa-spin 0.7s linear infinite', flexShrink: 0 }} />
                        {ja ? `準備中... ${primaryLoadPct}%` : `Loading... ${primaryLoadPct}%`}
                      </span>
                    ) : (
                    <>
                      {primaryMode === 'quick' ? (ja ? 'サクッと演習を再開' : 'Quick (Resume)') : (ja ? 'しっかり対策を再開' : 'Focused (Resume)')}
                      {ja && primaryMode === 'quick' && quickDraft?.results != null && quickDraft?.questions != null && (() => { const tot = quickDraft.questionIds?.length ?? quickDraft.questions.length; return <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 400, opacity: 0.85 }}>（{Math.min(quickDraft.results.length + 1, tot)}/{tot}問）</span>; })()}
                      {ja && primaryMode !== 'quick' && focusedDraft?.results != null && focusedDraft?.questions != null && (() => { const tot = focusedDraft.questionIds?.length ?? focusedDraft.questions.length; return <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 400, opacity: 0.85 }}>（{Math.min(focusedDraft.results.length + 1, tot)}/{tot}問）</span>; })()}
                      <span style={{ marginLeft: 8, display: 'inline-flex', verticalAlign: 'middle' }}><KeyHint /></span>
                    </>
                  )}
                  </button>
                  <button
                    onClick={() => setShowWebQuickMenu(v => !v)}
                    style={{ width: 44, height: 44, border: 'none', borderLeft: '2px solid rgba(255,255,255,0.4)', background: primaryBg, color: primaryColor, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
                    aria-label={ja ? '新規で開始メニュー' : 'Start new menu'}
                  >
                    <IconChevronUp size={16} />
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ flex: 1, position: 'relative' }}>
                {showFocusedMenu && (
                  <>
                    <div onClick={() => setShowFocusedMenu(false)} style={{ position: 'fixed', inset: 0, zIndex: 199 }} />
                    <div style={{ position: 'absolute', bottom: '110%', left: 0, right: 0, zIndex: 200, background: 'var(--color-bg-white)', borderRadius: 'var(--border-radius-md)', boxShadow: 'var(--box-shadow-up)', border: '1px solid var(--color-border)', padding: '8px', marginBottom: 6 }}>
                      {primaryMode === 'quick' ? (
                        <>
                          {effectiveFocusedUnlocked && <div style={{ textAlign: 'center', fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-light)', marginBottom: 4 }}>{ja ? '苦手・不正解問題を重点演習' : 'Focuses on weak/incorrect questions'}</div>}
                          <button
                            disabled={!targetExam || !user || !effectiveFocusedUnlocked}
                            onClick={() => { setShowFocusedMenu(false); switchMode('focused'); }}
                            style={{ width: '100%', height: 36, padding: '0 12px', border: `1.5px solid ${(!targetExam || !user || !effectiveFocusedUnlocked) ? 'var(--color-border)' : 'var(--color-points)'}`, borderRadius: 'var(--border-radius-full)', cursor: (!targetExam || !user || !effectiveFocusedUnlocked) ? 'default' : 'pointer', background: 'transparent', color: (!targetExam || !user || !effectiveFocusedUnlocked) ? 'var(--color-text-light)' : 'var(--color-points)', fontWeight: 600, fontSize: 'var(--font-size-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}
                          >
                            {!effectiveFocusedUnlocked && <IconLock size={13} />}
                            {ja ? 'しっかり対策モード' : 'Switch to Focused'}
                          </button>
                          {!effectiveFocusedUnlocked && user && (
                            <div style={{ textAlign: 'center', fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-light)', marginTop: 3 }}>
                              {!answeredCountReady ? (ja ? '演習量を確認中...' : 'Checking progress...') : ja ? `現在${answeredCount}問 / あと${FOCUSED_UNLOCK_THRESHOLD - answeredCount}問で解放` : `${answeredCount} answered / ${FOCUSED_UNLOCK_THRESHOLD - answeredCount} more to unlock`}
                            </div>
                          )}
                          {!user && <div style={{ textAlign: 'center', fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-light)', marginTop: 3 }}>{ja ? 'ログインが必要です' : 'Login required'}</div>}
                        </>
                      ) : (
                        <>
                          <div style={{ textAlign: 'center', fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-light)', marginBottom: 4 }}>{ja ? '全ドメインを幅広く均等に出題' : 'Broad, even coverage across domains'}</div>
                          <button disabled={!targetExam} onClick={() => { setShowFocusedMenu(false); switchMode('quick'); }} style={{ width: '100%', height: 36, padding: '0 12px', border: '1.5px solid var(--color-accent)', borderRadius: 'var(--border-radius-full)', cursor: !targetExam ? 'default' : 'pointer', background: 'transparent', color: 'var(--color-accent)', fontWeight: 600, fontSize: 'var(--font-size-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            {ja ? 'サクッと演習モード' : 'Switch to Quick'}
                          </button>
                        </>
                      )}
                    </div>
                  </>
                )}
                <div data-tutorial="start" style={{ display: 'flex', height: 44, borderRadius: 22, overflow: 'hidden' }}>
                  {primaryMode === 'quick' ? (
                    <button
                      disabled={!targetExam || quickLoading}
                      onClick={() => { if (targetExam && !quickLoading) startQuickExercise(); }}
                      style={{ flex: 1, height: 44, border: 'none', background: 'var(--color-accent)', color: 'var(--color-btn-primary-text)', fontWeight: 600, fontSize: 'var(--font-size-base)', cursor: (!targetExam || quickLoading) ? 'default' : 'pointer', paddingLeft: 16, paddingRight: 8 }}
                    >
                      {quickLoading ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ width: 14, height: 14, border: '2px solid rgba(0,0,0,0.2)', borderTopColor: '#16191f', borderRadius: '50%', animation: 'sherpa-spin 0.7s linear infinite', flexShrink: 0 }} />
                          {ja ? `準備中... ${quickLoadPct}%` : `Loading... ${quickLoadPct}%`}
                        </span>
                      ) : (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                          {ja ? 'サクッと演習を開始' : 'Quick'}
                          <KeyHint />
                        </span>
                      )}
                    </button>
                  ) : (
                    <button
                      disabled={!targetExam || focusedLoading}
                      onClick={() => { if (targetExam && !focusedLoading) startFocusedExercise(); }}
                      style={{ flex: 1, height: 44, border: 'none', background: 'var(--color-points)', color: 'var(--color-on-level)', fontWeight: 600, fontSize: 'var(--font-size-base)', cursor: (!targetExam || focusedLoading) ? 'default' : 'pointer', paddingLeft: 16, paddingRight: 8 }}
                    >
                      {focusedLoading ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ width: 14, height: 14, border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', borderRadius: '50%', animation: 'sherpa-spin 0.7s linear infinite', flexShrink: 0 }} />
                          {ja ? `準備中... ${focusedLoadPct}%` : `Loading... ${focusedLoadPct}%`}
                        </span>
                      ) : (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                          {ja ? 'しっかり対策を開始' : 'Focused'}
                          <KeyHint />
                        </span>
                      )}
                    </button>
                  )}
                  <button
                    onClick={() => setShowFocusedMenu(v => !v)}
                    style={{ width: 44, height: 44, border: 'none', borderLeft: '2px solid rgba(255,255,255,0.4)', background: primaryMode === 'focused' ? 'var(--color-points)' : 'var(--color-accent)', color: primaryMode === 'focused' ? 'var(--color-on-level)' : 'var(--color-btn-primary-text)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
                    aria-label={primaryMode === 'quick' ? (ja ? 'しっかり対策' : 'Focused practice') : (ja ? 'サクッと演習' : 'Quick practice')}
                  >
                    <IconChevronUp size={16} />
                  </button>
                </div>
              </div>
            )}
            <button
              onClick={() => {
                if (primaryMode === 'focused') { const fp = loadFocusedPrefs(uid); savedFocusedPrefsRef.current = fp; setDraftFocusedPrefs({ ...fp }); setShowFocusedModal(true); }
                else { const p = loadQuickPrefs(uid); const d = { ...p, domains: storedDomainsToNames(targetExam ?? 'SAA', p.domains) }; savedQuickPrefsRef.current = d; setDraftPrefs(d); setShowQuickModal(true); }
              }}
              style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', height: 44, width: 132, border: `1.5px solid ${primaryMode === 'focused' ? 'var(--color-points)' : 'var(--color-primary)'}`, borderRadius: 'var(--border-radius-full)', background: 'var(--color-bg-white)', cursor: 'pointer', color: primaryMode === 'focused' ? 'var(--color-points)' : 'var(--color-primary)', fontWeight: 600, fontSize: 'var(--font-size-base)' }}
            >
              {ja ? '設定' : 'Settings'}
            </button>
          </div>
        </div>
      , document.body)}

      {/* ── サクッと演習ボタン（モバイル固定） ── */}
      {isMobile && (
        <>
          {/* プルアップパネル：新規で開始（セッションあり時のみ） */}
          {hasPrimaryDraft && showNewPanel && (
            <>
              <div onClick={() => setShowNewPanel(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 210 }} />
              <div style={{ position: 'fixed', bottom: 116, left: 0, right: 0, zIndex: 211, background: 'var(--color-bg-white)', borderRadius: 'var(--border-radius-lg) var(--border-radius-lg) 0 0', padding: '14px 12px 12px', boxShadow: 'var(--box-shadow-up)', animation: 'slideUp 0.22s ease' }}>
                <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', textAlign: 'center', marginBottom: 10 }}>
                  {ja ? 'セッションを上書きして開始します' : 'This will overwrite the current session'}
                </div>
                <Button variant="outline" fullWidth style={{ height: 44, borderColor: primaryMode === 'focused' ? 'var(--color-points)' : 'var(--color-accent)', color: primaryMode === 'focused' ? 'var(--color-points)' : 'var(--color-accent)' }} onClick={() => { setShowNewPanel(false); discardPrimaryDraft(); startPrimary(); }}>
                  {ja ? `新規に開始（${primaryMode === 'focused' ? 'しっかり対策' : 'サクッと演習'}）` : `Start New (${primaryMode === 'focused' ? 'Focused' : 'Quick'})`}
                </Button>
                <div style={{ marginTop: 8 }}>
                  {primaryMode === 'quick' ? (
                    <>
                      {effectiveFocusedUnlocked && <div style={{ textAlign: 'center', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)', marginBottom: 4 }}>{ja ? '苦手・不正解問題を重点演習' : 'Focuses on weak/incorrect questions'}</div>}
                      <button
                        disabled={!targetExam || !user || !effectiveFocusedUnlocked}
                        onClick={() => { setShowNewPanel(false); switchMode('focused'); }}
                        style={{ width: '100%', height: 44, border: `1.5px solid ${(!targetExam || !user || !effectiveFocusedUnlocked) ? 'var(--color-border)' : 'var(--color-points)'}`, borderRadius: 'var(--border-radius-full)', cursor: (!targetExam || !user || !effectiveFocusedUnlocked) ? 'default' : 'pointer', background: 'transparent', color: (!targetExam || !user || !effectiveFocusedUnlocked) ? 'var(--color-text-light)' : 'var(--color-points)', fontWeight: 600, fontSize: 'var(--font-size-base)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                      >
                        {!effectiveFocusedUnlocked && <IconLock size={15} />}
                        {ja ? 'しっかり対策モード' : 'Switch to Focused'}
                      </button>
                      {!effectiveFocusedUnlocked && user && (
                        <div style={{ textAlign: 'center', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)', marginTop: 4 }}>
                          {!answeredCountReady ? (ja ? '演習量を確認中...' : 'Checking progress...') : ja ? `現在${answeredCount}問 / あと${FOCUSED_UNLOCK_THRESHOLD - answeredCount}問で解放` : `${answeredCount} answered / ${FOCUSED_UNLOCK_THRESHOLD - answeredCount} more to unlock`}
                        </div>
                      )}
                      {!user && <div style={{ textAlign: 'center', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)', marginTop: 4 }}>{ja ? 'ログインが必要です' : 'Login required'}</div>}
                    </>
                  ) : (
                    <>
                      <button disabled={!targetExam} onClick={() => { setShowNewPanel(false); switchMode('quick'); }} style={{ width: '100%', height: 44, border: '1.5px solid var(--color-accent)', borderRadius: 'var(--border-radius-full)', cursor: !targetExam ? 'default' : 'pointer', background: 'transparent', color: 'var(--color-accent)', fontWeight: 600, fontSize: 'var(--font-size-base)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {ja ? 'サクッと演習モード' : 'Switch to Quick'}
                      </button>
                    </>
                  )}
                </div>
              </div>
            </>
          )}
          {/* プルアップパネル：セカンダリモード（セッションなし時） */}
          {!hasPrimaryDraft && showFocusedMenu && (
            <>
              <div onClick={() => setShowFocusedMenu(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 210 }} />
              <div style={{ position: 'fixed', bottom: 116, left: 0, right: 0, zIndex: 211, background: 'var(--color-bg-white)', borderRadius: 'var(--border-radius-lg) var(--border-radius-lg) 0 0', padding: '14px 12px 12px', boxShadow: 'var(--box-shadow-up)', animation: 'slideUp 0.22s ease' }}>
                {primaryMode === 'quick' ? (
                  <>
                    {effectiveFocusedUnlocked && <div style={{ textAlign: 'center', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)', marginBottom: 4 }}>{ja ? '苦手・不正解問題を重点演習' : 'Focuses on weak/incorrect questions'}</div>}
                    <button
                      disabled={!targetExam || !user || !effectiveFocusedUnlocked}
                      onClick={() => { setShowFocusedMenu(false); switchMode('focused'); }}
                      style={{ width: '100%', height: 44, border: `1.5px solid ${(!targetExam || !user || !effectiveFocusedUnlocked) ? 'var(--color-border)' : 'var(--color-points)'}`, borderRadius: 'var(--border-radius-full)', cursor: (!targetExam || !user || !effectiveFocusedUnlocked) ? 'default' : 'pointer', background: 'transparent', color: (!targetExam || !user || !effectiveFocusedUnlocked) ? 'var(--color-text-light)' : 'var(--color-points)', fontWeight: 600, fontSize: 'var(--font-size-base)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                    >
                      {!effectiveFocusedUnlocked && <IconLock size={15} />}
                      {ja ? 'しっかり対策モード' : 'Switch to Focused'}
                    </button>
                    {!effectiveFocusedUnlocked && user && (
                      <div style={{ textAlign: 'center', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)', marginTop: 4 }}>
                        {!answeredCountReady ? (ja ? '演習量を確認中...' : 'Checking progress...') : ja ? `現在${answeredCount}問 / あと${FOCUSED_UNLOCK_THRESHOLD - answeredCount}問で解放` : `${answeredCount} answered / ${FOCUSED_UNLOCK_THRESHOLD - answeredCount} more to unlock`}
                      </div>
                    )}
                    {!user && <div style={{ textAlign: 'center', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)', marginTop: 4 }}>{ja ? 'ログインが必要です' : 'Login required'}</div>}
                  </>
                ) : (
                  <>
                    <button disabled={!targetExam} onClick={() => { setShowFocusedMenu(false); switchMode('quick'); }} style={{ width: '100%', height: 44, border: '1.5px solid var(--color-accent)', borderRadius: 'var(--border-radius-full)', cursor: !targetExam ? 'default' : 'pointer', background: 'transparent', color: 'var(--color-accent)', fontWeight: 600, fontSize: 'var(--font-size-base)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {ja ? 'サクッと演習モード' : 'Switch to Quick'}
                    </button>
                  </>
                )}
              </div>
            </>
          )}
          {createPortal(<div style={{ position: 'fixed', bottom: 56, left: 0, right: 0, zIndex: 150, background: 'var(--color-bg-white)', borderTop: '1px solid var(--color-border)', padding: '8px 12px', display: 'flex', gap: 6, boxShadow: 'var(--box-shadow-up)' }}>
            {hasPrimaryDraft ? (
              /* スプリットピル：続きから再開 + ↑ */
              <div style={{ flex: 1, display: 'flex', height: 44, borderRadius: 22, overflow: 'hidden', opacity: !targetExam ? 0.5 : 1 }}>
                <button
                  disabled={!targetExam || primaryLoading}
                  onClick={resumePrimary}
                  style={{ flex: 1, height: 44, border: 'none', background: primaryBg, color: primaryColor, fontWeight: 600, fontSize: 'var(--font-size-base)', cursor: !targetExam || primaryLoading ? 'default' : 'pointer', paddingLeft: 16, paddingRight: 8 }}
                >
                  {primaryLoading ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ width: 14, height: 14, border: primarySpinnerBorder, borderTopColor: primarySpinnerTop, borderRadius: '50%', animation: 'sherpa-spin 0.7s linear infinite', flexShrink: 0 }} />
                      {ja ? `準備中... ${primaryLoadPct}%` : `Loading... ${primaryLoadPct}%`}
                    </span>
                  ) : (
                    <>
                      {primaryMode === 'quick' ? (ja ? 'サクッと演習を再開' : 'Quick (Resume)') : (ja ? 'しっかり対策を再開' : 'Focused (Resume)')}
                      {ja && primaryMode === 'quick' && quickDraft?.results != null && quickDraft?.questions != null && (() => { const tot = quickDraft.questionIds?.length ?? quickDraft.questions.length; return <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 400, opacity: 0.85 }}>（{Math.min(quickDraft.results.length + 1, tot)}/{tot}問）</span>; })()}
                      {ja && primaryMode !== 'quick' && focusedDraft?.results != null && focusedDraft?.questions != null && (() => { const tot = focusedDraft.questionIds?.length ?? focusedDraft.questions.length; return <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 400, opacity: 0.85 }}>（{Math.min(focusedDraft.results.length + 1, tot)}/{tot}問）</span>; })()}
                    </>
                  )}
                </button>
                <button
                  onClick={() => setShowNewPanel(v => !v)}
                  style={{ width: 44, height: 44, border: 'none', borderLeft: '2px solid rgba(255,255,255,0.4)', background: primaryBg, color: primaryColor, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
                  aria-label={ja ? '新規で開始メニュー' : 'Start new menu'}
                >
                  <IconChevronUp size={16} />
                </button>
              </div>
            ) : (
              /* スプリットピル：primaryMode依存 */
              <div data-tutorial="start" style={{ flex: 1, display: 'flex', height: 44, borderRadius: 22, overflow: 'hidden', opacity: !targetExam ? 0.5 : 1 }}>
                {primaryMode === 'quick' ? (
                  <button
                    disabled={!targetExam || quickLoading}
                    onClick={() => { if (targetExam && !quickLoading) startQuickExercise(); }}
                    style={{ flex: 1, height: 44, border: 'none', background: 'var(--color-accent)', color: 'var(--color-btn-primary-text)', fontWeight: 600, fontSize: 'var(--font-size-base)', cursor: !targetExam || quickLoading ? 'default' : 'pointer', paddingLeft: 16, paddingRight: 8 }}
                  >
                    {quickLoading ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 14, height: 14, border: '2px solid rgba(0,0,0,0.2)', borderTopColor: '#16191f', borderRadius: '50%', animation: 'sherpa-spin 0.7s linear infinite', flexShrink: 0 }} />
                        {ja ? `準備中... ${quickLoadPct}%` : `Loading... ${quickLoadPct}%`}
                      </span>
                    ) : (ja ? 'サクッと演習を開始' : 'Quick')}
                  </button>
                ) : (
                  <button
                    disabled={!targetExam || focusedLoading}
                    onClick={() => { if (targetExam && !focusedLoading) startFocusedExercise(); }}
                    style={{ flex: 1, height: 44, border: 'none', background: 'var(--color-points)', color: 'var(--color-on-level)', fontWeight: 600, fontSize: 'var(--font-size-base)', cursor: !targetExam || focusedLoading ? 'default' : 'pointer', paddingLeft: 16, paddingRight: 8 }}
                  >
                    {focusedLoading ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 14, height: 14, border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', borderRadius: '50%', animation: 'sherpa-spin 0.7s linear infinite', flexShrink: 0 }} />
                        {ja ? `準備中... ${focusedLoadPct}%` : `Loading... ${focusedLoadPct}%`}
                      </span>
                    ) : (ja ? 'しっかり対策を開始' : 'Focused')}
                  </button>
                )}
                <button
                  onClick={() => setShowFocusedMenu(v => !v)}
                  style={{ width: 44, height: 44, border: 'none', borderLeft: '2px solid rgba(255,255,255,0.4)', background: primaryMode === 'focused' ? 'var(--color-points)' : 'var(--color-accent)', color: primaryMode === 'focused' ? 'var(--color-on-level)' : 'var(--color-btn-primary-text)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
                  aria-label={primaryMode === 'quick' ? (ja ? 'しっかり対策' : 'Focused practice') : (ja ? 'サクッと演習' : 'Quick practice')}
                >
                  <IconChevronUp size={16} />
                </button>
              </div>
            )}
            {/* 設定アイコン（常に表示） */}
            <button
              onClick={() => {
                if (primaryMode === 'focused') { const fp = loadFocusedPrefs(uid); savedFocusedPrefsRef.current = fp; setDraftFocusedPrefs({ ...fp }); setShowFocusedModal(true); }
                else { const p = loadQuickPrefs(uid); const d = { ...p, domains: storedDomainsToNames(targetExam ?? 'SAA', p.domains) }; savedQuickPrefsRef.current = d; setDraftPrefs(d); setShowQuickModal(true); }
              }}
              style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 44, height: 44, border: `1.5px solid ${primaryMode === 'focused' ? 'var(--color-points)' : 'var(--color-primary)'}`, borderRadius: '50%', background: 'transparent', cursor: 'pointer', color: primaryMode === 'focused' ? 'var(--color-points)' : 'var(--color-primary)' }}
              aria-label={ja ? '設定' : 'Settings'}
            >
              <IconSettings size={18} />
            </button>
          </div>, document.body)}
        </>
      )}

      {/* ── サクッと演習 設定モーダル ── */}
      {showQuickModal && (
        <div
          data-kbscope="1" role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={e => { if (e.target === e.currentTarget) setShowQuickModal(false); }}
          onTouchStart={e => e.stopPropagation()}
          onTouchMove={e => e.stopPropagation()}
        >
          <div style={{ background: 'var(--color-bg-white)', borderRadius: 'var(--border-radius-lg)', width: '100%', maxWidth: 420, boxShadow: 'var(--box-shadow-md)', maxHeight: isMobile ? '75vh' : '78vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {/* ヘッダー固定 */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '20px 24px 0', flexShrink: 0 }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 'var(--font-size-h3)', fontWeight: 700, color: 'var(--color-accent)' }}>
                  {ja ? 'サクッと演習 設定' : 'Quick Practice Settings'}
                </h3>
                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)', marginTop: 2 }}>
                  {ja ? '全ドメインを幅広く均等に出題' : 'Broad, even coverage across domains'}
                </div>
              </div>
              <button onClick={() => setShowQuickModal(false)} style={{ border: 'none', background: 'none', fontSize: 'var(--font-size-xl)', cursor: 'pointer', color: 'var(--color-text-sub)', padding: '4px 8px', lineHeight: 1 }}>✕</button>
            </div>
            {/* スクロール可能なコンテンツ */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '0 24px' }}>
              <div style={{ marginBottom: 16, paddingTop: 16 }}>
                {/* 出題数 */}
                <div style={{ padding: '14px 0', borderBottom: '1px solid var(--color-border)' }}>
                  <div style={{ fontWeight: 500, fontSize: 'var(--font-size-base)', color: 'var(--color-text-main)', marginBottom: 8 }}>
                    {ja ? '出題数' : 'Question Count'}
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {[5, 10, 20].map(n => {
                      const sel = (draftPrefs.questionCount ?? 5) === n;
                      return (
                        <button
                          key={n}
                          onClick={() => setDraftPrefs(p => ({ ...p, questionCount: n }))}
                          style={{ flex: 1, height: 36, border: `1.5px solid ${sel ? 'var(--color-primary)' : 'var(--color-border)'}`, borderRadius: 'var(--border-radius-full)', cursor: 'pointer', background: 'transparent', color: 'var(--color-text-main)', fontWeight: sel ? 700 : 600, fontSize: 'var(--font-size-sm)', transition: 'all 0.15s' }}
                        >
                          {n}{ja ? '問' : 'Q'}
                        </button>
                      );
                    })}
                  </div>
                </div>
                {/* 基礎知識(オリジナル資格)の混在（対応資格がある場合のみ表示） */}
                {targetExam && COMPANION_EXAM[targetExam] && (
                  <div style={{ padding: '14px 0', borderBottom: '1px solid var(--color-border)' }}>
                    <div style={{ fontWeight: 500, fontSize: 'var(--font-size-base)', color: 'var(--color-text-main)', marginBottom: 8 }}>
                      {ja ? '基礎知識' : 'Prerequisite Knowledge'}
                    </div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={includeCompanionPref(draftPrefs)}
                        onChange={() => setDraftPrefs(p => ({ ...p, includeCompanion: !includeCompanionPref(p) }))}
                        style={{ width: 16, height: 16, flexShrink: 0, accentColor: 'var(--color-primary)' }}
                      />
                      <span style={{ flex: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, fontSize: 'var(--font-size-sm)', fontWeight: includeCompanionPref(draftPrefs) ? 700 : 500, color: 'var(--color-text-main)' }}>
                        <span>
                          {ja ? (
                            <><span style={{ color: EXAM_LEVEL_COLORS.Additional }}>{`基礎知識（${companionLabel(COMPANION_EXAM[targetExam])}）`}</span>を含める</>
                          ) : (
                            <>Include <span style={{ color: EXAM_LEVEL_COLORS.Additional }}>{companionLabel(COMPANION_EXAM[targetExam])}</span></>
                          )}
                        </span>
                        {statusCounts?.companionTotal != null && <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: includeCompanionPref(draftPrefs) ? EXAM_LEVEL_COLORS.Additional : 'var(--color-text-light)', flexShrink: 0 }}>{statusCounts.companionTotal}{ja ? '問' : ''}</span>}
                      </span>
                    </label>
                    <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)', marginTop: 2 }}>
                      {ja ? 'ドメイン別統計・予想スコアには反映されません' : "Doesn't count toward domain stats or estimated score"}
                    </div>
                  </div>
                )}
                {/* ブックマークフィルタ（独立トグル・上乗せ） */}
                <div style={{ padding: '14px 0', borderBottom: '1px solid var(--color-border)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
                    <span style={{ fontWeight: 500, fontSize: 'var(--font-size-base)', color: 'var(--color-text-main)' }}>
                      {ja ? 'ブックマークフィルタ' : 'Bookmark Filter'}
                    </span>
                    {!!targetExam && COMPANION_EXAM[targetExam] && includeCompanionPref(draftPrefs) && (
                      <span style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-light)', flexShrink: 0 }}>
                        {ja ? '全体数（基礎知識問題数）' : 'Total (prerequisite count)'}
                      </span>
                    )}
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={quickBookmark(draftPrefs)}
                      onChange={() => setDraftPrefs(p => ({ ...p, bookmarkOnly: !quickBookmark(p), quickFilter: p.quickFilter === 'bookmark' ? 'none' : p.quickFilter }))}
                      style={{ width: 16, height: 16, flexShrink: 0, accentColor: 'var(--color-primary)' }}
                    />
                    <span style={{ flex: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, fontSize: 'var(--font-size-sm)', fontWeight: quickBookmark(draftPrefs) ? 700 : 500, color: 'var(--color-text-main)' }}>
                      <span>{ja ? 'ブックマークを優先' : 'Prioritize Bookmarked'}</span>
                      {(() => {
                        const useC = includeCompanionPref(draftPrefs);
                        const bcnt = statusCounts ? (useC ? statusCounts.bookmarked : statusCounts.targetOnlyBookmarked) : undefined;
                        return bcnt != null && <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: quickBookmark(draftPrefs) ? 'var(--color-primary)' : 'var(--color-text-light)', flexShrink: 0 }}>{bcnt}{ja ? '問' : ''}{useC && statusCounts?.companionBookmarked != null && `（${statusCounts.companionBookmarked}${ja ? '問' : ''}）`}</span>;
                      })()}
                    </span>
                  </label>
                </div>
                {/* 基礎知識資格自身が目標の時: 対応する公式資格でも同じ問題が出ることを案内（トグルなし） */}
                {targetExam && isNonAwsExam(targetExam) && officialExamsForCompanion(targetExam).length > 0 && (
                  <div style={{ padding: '14px 0', borderBottom: '1px solid var(--color-border)' }}>
                    <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)' }}>
                      {ja
                        ? `※${officialExamsForCompanion(targetExam).join('、')}でも演習可能です`
                        : `※Also included when practicing ${officialExamsForCompanion(targetExam).join(', ')}`}
                    </div>
                  </div>
                )}
                {/* 回答状況フィルタ（排他・しっかり対策と同一） */}
                <div style={{ padding: '14px 0', borderBottom: targetExam && (EXAM_DOMAINS[targetExam] ?? []).length > 0 ? '1px solid var(--color-border)' : 'none' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
                    <span style={{ fontWeight: 500, fontSize: 'var(--font-size-base)', color: 'var(--color-text-main)' }}>
                      {ja ? '回答状況フィルタ' : 'Answer-Status Filter'}
                    </span>
                    {!!targetExam && COMPANION_EXAM[targetExam] && includeCompanionPref(draftPrefs) && (
                      <span style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-light)', flexShrink: 0 }}>
                        {ja ? '全体数（基礎知識問題数）' : 'Total (prerequisite count)'}
                      </span>
                    )}
                  </div>
                  {(() => {
                    const curQ = resolveQuickPriority(draftPrefs);
                    return ([
                      ['none',       ja ? '指定なし' : 'None', ''],
                      ['unanswered', ja ? '未回答を優先' : 'Unanswered', ja ? 'まだ解いていない問題' : 'Questions not yet answered'],
                      ['incorrect',  ja ? '不正解を優先' : 'Incorrect', ja ? '過去に間違えた問題' : 'Previously answered incorrectly'],
                      ['notcorrect', ja ? '未正解を優先' : 'Not Correct', ja ? '未回答＋不正解（まだ正解していない問題）' : 'Unanswered + incorrect (not yet correct)'],
                    ] as ['none' | 'unanswered' | 'incorrect' | 'notcorrect', string, string][]).map(([val, label, desc]) => {
                      const selected = curQ === val;
                      const quickUseCompanion = includeCompanionPref(draftPrefs);
                      const cnt = statusCounts ? (statusCounts as any)[quickUseCompanion ? val : TARGET_ONLY_COUNT_KEY[val]] as number | undefined : undefined;
                      const companionCnt = quickUseCompanion && statusCounts ? (statusCounts as any)[COMPANION_COUNT_KEY[val]] as number | undefined : undefined;
                      return (
                        <label key={val} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 0', cursor: 'pointer' }}>
                          <input
                            type="radio"
                            name="quickPriority"
                            checked={selected}
                            onChange={() => setDraftPrefs(p => ({ ...p, quickPriority: val }))}
                            style={{ width: 16, height: 16, flexShrink: 0, marginTop: 2, accentColor: 'var(--color-primary)' }}
                          />
                          <span style={{ flex: 1 }}>
                            <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, fontSize: 'var(--font-size-sm)', fontWeight: selected ? 700 : 500, color: 'var(--color-text-main)' }}>
                              <span>{label}</span>
                              {cnt != null && <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: selected ? 'var(--color-primary)' : 'var(--color-text-light)', flexShrink: 0 }}>{cnt}{ja ? '問' : ''}{companionCnt != null && `（${companionCnt}${ja ? '問' : ''}）`}</span>}
                            </span>
                            {desc && <span style={{ display: 'block', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)' }}>{desc}</span>}
                          </span>
                        </label>
                      );
                    });
                  })()}
                </div>
                {targetExam && (EXAM_DOMAINS[targetExam] ?? []).length > 0 && (
                  <div style={{ padding: '14px 0' }}>
                    <div style={{ fontWeight: 500, fontSize: 'var(--font-size-base)', color: 'var(--color-text-main)', marginBottom: 8 }}>
                      {ja ? 'ドメインフィルタ' : 'Domain Filter'}
                    </div>
                    {/* 全て */}
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', cursor: 'pointer', marginBottom: 4, paddingBottom: 8, borderBottom: '1px solid color-mix(in srgb, var(--color-text-light) 20%, transparent)' }}>
                      <input
                        type="checkbox"
                        checked={(EXAM_DOMAINS[targetExam] ?? []).every(d => (draftPrefs.domains ?? []).includes(d))}
                        onChange={() => {
                          const all = EXAM_DOMAINS[targetExam] ?? [];
                          setDraftPrefs(p => ({ ...p, domains: all.every(d => (p.domains ?? []).includes(d)) ? [] : all }));
                        }}
                        style={{ width: 16, height: 16, flexShrink: 0, accentColor: 'var(--color-primary)' }}
                      />
                      <span style={{ flex: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--color-text-main)' }}>
                        <span>{ja ? '全て' : 'All'}</span>
                        {quickDomainCounts && <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-text-light)', flexShrink: 0 }}>{Object.values(quickDomainCounts).reduce((s, n) => s + n, 0)}{ja ? '問' : ''}</span>}
                      </span>
                    </label>
                    {(EXAM_DOMAINS[targetExam] ?? []).map(domain => {
                      const selDoms: string[] = draftPrefs.domains ?? [];
                      const checked = selDoms.includes(domain);
                      const dCnt = quickDomainCounts ? (quickDomainCounts[domain] ?? 0) : undefined;
                      return (
                        <label key={domain} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => setDraftPrefs(p => {
                              const cur: string[] = p.domains ?? [];
                              return { ...p, domains: checked ? cur.filter(d => d !== domain) : [...cur, domain] };
                            })}
                            style={{ width: 16, height: 16, flexShrink: 0, accentColor: 'var(--color-primary)' }}
                          />
                          <span style={{ flex: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-main)', lineHeight: 1.4 }}>
                            <span>{domain}</span>
                            {dCnt != null && <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-text-light)', flexShrink: 0 }}>{dCnt}{ja ? '問' : ''}</span>}
                          </span>
                        </label>
                      );
                    })}
                    {(draftPrefs.domains ?? []).length === 0 && (
                      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-danger)', marginTop: 4 }}>
                        {ja ? '1つ以上選択してください' : 'Select at least one domain'}
                      </div>
                    )}
                  </div>
                )}
              </div>
              {/* その他 */}
              <div style={{ padding: '14px 0', borderTop: '1px solid var(--color-border)' }}>
                <div style={{ fontWeight: 500, fontSize: 'var(--font-size-base)', color: 'var(--color-text-main)', marginBottom: 8 }}>
                  {ja ? 'その他' : 'Other'}
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={draftPrefs.strikeEnabled === true}
                    onChange={() => setDraftPrefs(p => ({ ...p, strikeEnabled: p.strikeEnabled === true ? false : true }))}
                    style={{ width: 16, height: 16, flexShrink: 0, accentColor: 'var(--color-primary)' }}
                  />
                  <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-main)' }}>
                    {ja ? '消去法機能をオン' : 'Enable elimination mode'}
                  </span>
                </label>
                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)', marginTop: 4, lineHeight: 1.5 }}>
                  ※ {ja ? '選択肢のテキストをタップすると取り消し線を引いて選択肢を絞り込める機能です' : 'Tap choice text to strike through and narrow down options'}
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0', cursor: 'pointer', marginTop: 8 }}>
                  <input
                    type="checkbox"
                    checked={draftPrefs.hideColumn === true}
                    onChange={() => setDraftPrefs(p => ({ ...p, hideColumn: !p.hideColumn }))}
                    style={{ width: 16, height: 16, flexShrink: 0, accentColor: 'var(--color-primary)' }}
                  />
                  <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-main)' }}>
                    {ja ? 'コラム（豆知識）を非表示' : 'Hide column tips'}
                  </span>
                </label>
              </div>
            </div>
            {/* 保存ボタン固定 */}
            {(() => {
              const isDisabled = targetExam !== null && (EXAM_DOMAINS[targetExam] ?? []).length > 0 && (draftPrefs.domains ?? []).length === 0;
              const quickDirty = JSON.stringify(draftPrefs) !== JSON.stringify(savedQuickPrefsRef.current);
              const flipped = !quickDirty || quickSaving;
              return (
                <div style={{ flexShrink: 0, borderTop: '1px solid var(--color-border)', padding: '10px 16px', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, minHeight: 64 }}>
                  {quickSaveMsg && (
                    <span style={{ fontSize: 'var(--font-size-sm2)', fontWeight: 700, color: quickSaveMsg === 'saved' ? 'var(--color-success)' : 'var(--color-text-sub)', animation: 'sherpa-save-msg 2s ease-in-out both' }}>
                      {quickSaveMsg === 'saved' ? `✓ ${ja ? '保存しました' : 'Saved'}` : (ja ? '保存済です' : 'Already saved')}
                    </span>
                  )}
                  <div style={{ position: 'relative', flexShrink: 0 }}>
                    {quickDirty && !isDisabled && (
                      <span style={{ position: 'absolute', top: -2, right: -2, width: 10, height: 10, borderRadius: '50%', background: SAVE_BURST_COLOR, border: '1.5px solid var(--color-bg-white)', zIndex: 1, pointerEvents: 'none' }} />
                    )}
                    <button
                      ref={saveBtnQuickRef}
                      disabled={isDisabled || quickSaving}
                      onClick={() => {
                        if (!quickDirty) {
                          setQuickSaveMsg('already');
                          setTimeout(() => setQuickSaveMsg(null), 2000);
                          return;
                        }
                        localStorage.setItem(`quickExercisePrefs_${uid}`, JSON.stringify({ ...draftPrefs, domains: domainsToIndices(targetExam ?? 'SAA', draftPrefs.domains ?? []) }));
                        savedQuickPrefsRef.current = draftPrefs;
                        setQuickSaveMsg('saved');
                        setTimeout(() => setQuickSaveMsg(null), 2000);
                        setQuickSaving(true);
                        setTimeout(() => setQuickSaving(false), 600);
                        const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
                        if (!reduceMotion) {
                          const r = saveBtnQuickRef.current?.getBoundingClientRect();
                          if (r) setQuickBurst({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
                        }
                        // 保存アニメーション（約0.6s）完了の1秒後に自動で閉じる（変更保存時のみ）
                        setTimeout(() => setShowQuickModal(false), 1600);
                      }}
                      style={{ width: 44, height: 44, flexShrink: 0, padding: 0, border: 'none', background: 'transparent', cursor: (isDisabled || quickSaving) ? 'default' : 'pointer', opacity: isDisabled ? 0.5 : 1, perspective: 600, transition: 'none' }}
                    >
                      <div style={{ position: 'relative', width: '100%', height: '100%', transformStyle: 'preserve-3d', transition: quickSaving ? 'transform 0.55s cubic-bezier(.45,.05,.3,1)' : 'none', transform: flipped ? 'rotateY(180deg)' : 'rotateY(0deg)' }}>
                        {/* 表面：未保存（白ベース・色枠） */}
                        <span style={{ position: 'absolute', inset: 0, backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%', border: '2px solid var(--color-accent)', background: 'var(--color-bg-white)', color: 'var(--color-accent)', boxShadow: 'var(--box-shadow-pop)' }}>
                          <IconSave size={22} />
                        </span>
                        {/* 裏面：保存済（オレンジ塗り・白アイコン） */}
                        <span style={{ position: 'absolute', inset: 0, backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden', transform: 'rotateY(180deg)', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%', background: 'var(--color-accent)', color: 'var(--color-btn-primary-text)', boxShadow: 'var(--box-shadow-pop)' }}>
                          <IconSaveCheck size={22} />
                        </span>
                      </div>
                    </button>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* ── しっかり対策 設定モーダル ── */}
      {showFocusedModal && (
        <div
          data-kbscope="1" role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={e => { if (e.target === e.currentTarget) setShowFocusedModal(false); }}
          onTouchStart={e => e.stopPropagation()}
          onTouchMove={e => e.stopPropagation()}
        >
          <div style={{ background: 'var(--color-bg-white)', borderRadius: 'var(--border-radius-lg)', width: '100%', maxWidth: 420, boxShadow: 'var(--box-shadow-md)', maxHeight: isMobile ? '75vh' : '78vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {/* ヘッダー固定 */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '20px 24px 0', flexShrink: 0 }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 'var(--font-size-h3)', fontWeight: 700, color: 'var(--color-points)' }}>
                  {ja ? 'しっかり対策 設定' : 'Focused Practice Settings'}
                </h3>
                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)', marginTop: 2 }}>
                  {ja ? '苦手・弱点を集中的に出題' : 'Concentrates on your weak spots'}
                </div>
              </div>
              <button onClick={() => setShowFocusedModal(false)} style={{ border: 'none', background: 'none', fontSize: 'var(--font-size-xl)', cursor: 'pointer', color: 'var(--color-text-sub)', padding: '4px 8px', lineHeight: 1 }}>✕</button>
            </div>
            {/* スクロール可能なコンテンツ */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '0 24px' }}>
              <div style={{ marginBottom: 20, paddingTop: 16 }}>
                {/* 出題数 */}
                <div style={{ padding: '14px 0', borderBottom: '1px solid var(--color-border)' }}>
                  <div style={{ fontWeight: 500, fontSize: 'var(--font-size-base)', color: 'var(--color-text-main)', marginBottom: 8 }}>
                    {ja ? '出題数' : 'Question Count'}
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {[5, 10, 20, 30].map(n => {
                      const sel = (draftFocusedPrefs.questionCount ?? 5) === n;
                      return (
                        <button
                          key={n}
                          onClick={() => setDraftFocusedPrefs(p => ({ ...p, questionCount: n }))}
                          style={{ flex: 1, height: 36, border: `1.5px solid ${sel ? 'var(--color-primary)' : 'var(--color-border)'}`, borderRadius: 'var(--border-radius-full)', cursor: 'pointer', background: 'transparent', color: 'var(--color-text-main)', fontWeight: sel ? 700 : 600, fontSize: 'var(--font-size-sm)', transition: 'all 0.15s' }}
                        >
                          {n}{ja ? '問' : 'Q'}
                        </button>
                      );
                    })}
                  </div>
                </div>
                {/* 基礎知識(オリジナル資格)の混在（対応資格がある場合のみ表示） */}
                {targetExam && COMPANION_EXAM[targetExam] && (
                  <div style={{ padding: '14px 0', borderBottom: '1px solid var(--color-border)' }}>
                    <div style={{ fontWeight: 500, fontSize: 'var(--font-size-base)', color: 'var(--color-text-main)', marginBottom: 8 }}>
                      {ja ? '基礎知識' : 'Prerequisite Knowledge'}
                    </div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={includeCompanionPref(draftFocusedPrefs)}
                        onChange={() => setDraftFocusedPrefs(p => ({ ...p, includeCompanion: !includeCompanionPref(p) }))}
                        style={{ width: 16, height: 16, flexShrink: 0, accentColor: 'var(--color-primary)' }}
                      />
                      <span style={{ flex: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, fontSize: 'var(--font-size-sm)', fontWeight: includeCompanionPref(draftFocusedPrefs) ? 700 : 500, color: 'var(--color-text-main)' }}>
                        <span>
                          {ja ? (
                            <><span style={{ color: EXAM_LEVEL_COLORS.Additional }}>{`基礎知識（${companionLabel(COMPANION_EXAM[targetExam])}）`}</span>を含める</>
                          ) : (
                            <>Include <span style={{ color: EXAM_LEVEL_COLORS.Additional }}>{companionLabel(COMPANION_EXAM[targetExam])}</span></>
                          )}
                        </span>
                        {statusCounts?.companionTotal != null && <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: includeCompanionPref(draftFocusedPrefs) ? EXAM_LEVEL_COLORS.Additional : 'var(--color-text-light)', flexShrink: 0 }}>{statusCounts.companionTotal}{ja ? '問' : ''}</span>}
                      </span>
                    </label>
                    <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)', marginTop: 2 }}>
                      {ja ? 'ドメイン別統計・予想スコアには反映されません' : "Doesn't count toward domain stats or estimated score"}
                    </div>
                  </div>
                )}
                {/* ブックマークフィルタ（独立トグル・上乗せ） */}
                <div style={{ padding: '14px 0', borderBottom: '1px solid var(--color-border)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
                    <span style={{ fontWeight: 500, fontSize: 'var(--font-size-base)', color: 'var(--color-text-main)' }}>
                      {ja ? 'ブックマークフィルタ' : 'Bookmark Filter'}
                    </span>
                    {!!targetExam && COMPANION_EXAM[targetExam] && includeCompanionPref(draftFocusedPrefs) && (
                      <span style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-light)', flexShrink: 0 }}>
                        {ja ? '全体数（基礎知識問題数）' : 'Total (prerequisite count)'}
                      </span>
                    )}
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={focusBookmarkOn(draftFocusedPrefs)}
                      onChange={() => setDraftFocusedPrefs(p => ({ ...p, focusBookmark: !focusBookmarkOn(p) }))}
                      style={{ width: 16, height: 16, flexShrink: 0, accentColor: 'var(--color-primary)' }}
                    />
                    <span style={{ flex: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, fontSize: 'var(--font-size-sm)', fontWeight: focusBookmarkOn(draftFocusedPrefs) ? 700 : 500, color: 'var(--color-text-main)' }}>
                      <span>{ja ? 'ブックマークを優先' : 'Prioritize Bookmarked'}</span>
                      {(() => {
                        const useC = includeCompanionPref(draftFocusedPrefs);
                        const bcnt = statusCounts ? (useC ? statusCounts.bookmarked : statusCounts.targetOnlyBookmarked) : undefined;
                        return bcnt != null && <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: focusBookmarkOn(draftFocusedPrefs) ? 'var(--color-primary)' : 'var(--color-text-light)', flexShrink: 0 }}>{bcnt}{ja ? '問' : ''}{useC && statusCounts?.companionBookmarked != null && `（${statusCounts.companionBookmarked}${ja ? '問' : ''}）`}</span>;
                      })()}
                    </span>
                  </label>
                </div>
                {/* 基礎知識資格自身が目標の時: 対応する公式資格でも同じ問題が出ることを案内（トグルなし） */}
                {targetExam && isNonAwsExam(targetExam) && officialExamsForCompanion(targetExam).length > 0 && (
                  <div style={{ padding: '14px 0', borderBottom: '1px solid var(--color-border)' }}>
                    <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)' }}>
                      {ja
                        ? `※${officialExamsForCompanion(targetExam).join('、')}でも演習可能です`
                        : `※Also included when practicing ${officialExamsForCompanion(targetExam).join(', ')}`}
                    </div>
                  </div>
                )}
                {/* 回答状況フィルタ（排他） */}
                <div style={{ padding: '14px 0', borderBottom: '1px solid var(--color-border)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
                    <span style={{ fontWeight: 500, fontSize: 'var(--font-size-base)', color: 'var(--color-text-main)' }}>
                      {ja ? '回答状況フィルタ' : 'Answer-Status Filter'}
                    </span>
                    {!!targetExam && COMPANION_EXAM[targetExam] && includeCompanionPref(draftFocusedPrefs) && (
                      <span style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-light)', flexShrink: 0 }}>
                        {ja ? '全体数（基礎知識問題数）' : 'Total (prerequisite count)'}
                      </span>
                    )}
                  </div>
                  {(() => {
                    const curPriority = resolveFocusPriority(draftFocusedPrefs);
                    return ([
                      ['none',       ja ? '指定なし' : 'None', ''],
                      ['unanswered', ja ? '未回答を優先' : 'Unanswered', ja ? 'まだ解いていない問題' : 'Questions not yet answered'],
                      ['incorrect',  ja ? '不正解を優先' : 'Incorrect', ja ? '過去に間違えた問題' : 'Previously answered incorrectly'],
                      ['notcorrect', ja ? '未正解を優先' : 'Not Correct', ja ? '未回答＋不正解（まだ正解していない問題）' : 'Unanswered + incorrect (not yet correct)'],
                    ] as [FocusPriority, string, string][]).map(([val, label, desc]) => {
                      const selected = curPriority === val;
                      const focusedUseCompanion = includeCompanionPref(draftFocusedPrefs);
                      const cnt = statusCounts ? (statusCounts as any)[focusedUseCompanion ? val : TARGET_ONLY_COUNT_KEY[val]] as number | undefined : undefined;
                      const companionCnt = focusedUseCompanion && statusCounts ? (statusCounts as any)[COMPANION_COUNT_KEY[val]] as number | undefined : undefined;
                      return (
                        <label key={val} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 0', cursor: 'pointer' }}>
                          <input
                            type="radio"
                            name="focusPriority"
                            checked={selected}
                            onChange={() => setDraftFocusedPrefs(p => ({ ...p, focusPriority: val }))}
                            style={{ width: 16, height: 16, flexShrink: 0, marginTop: 2, accentColor: 'var(--color-primary)' }}
                          />
                          <span style={{ flex: 1 }}>
                            <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, fontSize: 'var(--font-size-sm)', fontWeight: selected ? 700 : 500, color: 'var(--color-text-main)' }}>
                              <span>{label}</span>
                              {cnt != null && <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: selected ? 'var(--color-primary)' : 'var(--color-text-light)', flexShrink: 0 }}>{cnt}{ja ? '問' : ''}{companionCnt != null && `（${companionCnt}${ja ? '問' : ''}）`}</span>}
                            </span>
                            {desc && <span style={{ display: 'block', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)' }}>{desc}</span>}
                          </span>
                        </label>
                      );
                    });
                  })()}
                </div>
                {/* 正答率フィルタ（排他・問題ごとの累計正答率・未満） */}
                <div style={{ padding: '14px 0', borderBottom: '1px solid var(--color-border)' }}>
                  <div style={{ fontWeight: 500, fontSize: 'var(--font-size-base)', color: 'var(--color-text-main)', marginBottom: 8 }}>
                    {ja ? '正答率フィルタ' : 'Accuracy Filter'}
                  </div>
                  {(() => {
                    const curAcc = resolveFocusAccuracy(draftFocusedPrefs);
                    return ([
                      ['none',    ja ? '指定なし' : 'None'],
                      ['below50', ja ? '正答率50%未満を優先' : 'Below 50%'],
                      ['below66', ja ? '正答率66%未満を優先' : 'Below 66%'],
                      ['below75', ja ? '正答率75%未満を優先' : 'Below 75%'],
                    ] as [FocusAccuracy, string][]).map(([val, label]) => {
                      const selected = curAcc === val;
                      const cnt = statusCounts ? (statusCounts as any)[val] as number | undefined : undefined;
                      return (
                        <label key={val} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', cursor: 'pointer' }}>
                          <input
                            type="radio"
                            name="focusAccuracy"
                            checked={selected}
                            onChange={() => setDraftFocusedPrefs(p => ({ ...p, focusAccuracy: val }))}
                            style={{ width: 16, height: 16, flexShrink: 0, accentColor: 'var(--color-primary)' }}
                          />
                          <span style={{ flex: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, fontSize: 'var(--font-size-sm)', fontWeight: selected ? 700 : 500, color: 'var(--color-text-main)' }}>
                            <span>{label}</span>
                            {cnt != null && <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: selected ? 'var(--color-primary)' : 'var(--color-text-light)', flexShrink: 0 }}>{cnt}{ja ? '問' : ''}</span>}
                          </span>
                        </label>
                      );
                    });
                  })()}
                </div>
                {/* ドメインフィルタ（分野別の正答率） */}
                <div style={{ padding: '14px 0' }}>
                  <div style={{ fontWeight: 500, fontSize: 'var(--font-size-base)', color: 'var(--color-text-main)', marginBottom: 2 }}>
                    {ja ? 'ドメインフィルタ' : 'Domain Filter'}
                  </div>
                  <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)', lineHeight: 1.5, marginBottom: 8 }}>
                    {ja
                      ? '各ドメインの直近10回の正答率で苦手を判定（マイページ苦手分析と同じ。未演習は常に対象）'
                      : "Weakness judged by each domain's last-10 accuracy (same as My Page analysis; unattempted always included)"}
                  </div>
                  {([
                    ['none',    ja ? '指定なし' : 'None'],
                    ['below40', ja ? '正答率40%以下のドメインを優先' : 'Prioritize domains ≤40%'],
                    ['below60', ja ? '正答率60%以下のドメインを優先' : 'Prioritize domains ≤60%'],
                    ['below80', ja ? '正答率80%以下のドメインを優先' : 'Prioritize domains ≤80%'],
                  ] as [string, string][]).map(([val, label]) => {
                    const selected = (draftFocusedPrefs.focusDomain ?? 'below80') === val;
                    // 各しきい値の直下に、実際に優先対象となるドメインを常時表示（未挑戦は常に対象）。指定なしは表示しない。
                    const threshold = val === 'below40' ? 0.4 : val === 'below60' ? 0.6 : val === 'below80' ? 0.8 : 0;
                    const targets = val === 'none' ? [] : focusDomainAcc.filter(d => d.acc == null || d.acc < threshold);
                    const sep = ja ? '、' : ', ';
                    const names = targets
                      .map(d => d.acc == null ? `${d.name}${ja ? '（未挑戦）' : ' (new)'}` : `${d.name} ${Math.round(d.acc * 100)}%`)
                      .join(sep);
                    return (
                      <label key={val} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 0', cursor: 'pointer' }}>
                        <input
                          type="radio"
                          name="focusDomain"
                          checked={selected}
                          onChange={() => setDraftFocusedPrefs(p => ({ ...p, focusDomain: val }))}
                          style={{ width: 16, height: 16, flexShrink: 0, marginTop: 2, accentColor: 'var(--color-primary)' }}
                        />
                        <span style={{ flex: 1 }}>
                          <span style={{ display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: selected ? 600 : 400, color: 'var(--color-text-main)' }}>{label}</span>
                          {val !== 'none' && (
                            <span style={{ display: 'block', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)', lineHeight: 1.5, marginTop: 2 }}>
                              {targets.length === 0 ? (ja ? '（対象なし）' : '(none)') : `（${names}）`}
                            </span>
                          )}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)', marginBottom: 16 }}>
                {ja ? '※ 優先条件に合う問題が少ない場合は、他の問題で補充します' : '* If not enough questions match, others will be included to fill the count'}
              </div>
              {/* その他 */}
              <div style={{ padding: '14px 0', borderTop: '1px solid var(--color-border)' }}>
                <div style={{ fontWeight: 500, fontSize: 'var(--font-size-base)', color: 'var(--color-text-main)', marginBottom: 8 }}>
                  {ja ? 'その他' : 'Other'}
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={draftFocusedPrefs.strikeEnabled === true}
                    onChange={() => setDraftFocusedPrefs(p => ({ ...p, strikeEnabled: p.strikeEnabled === true ? false : true }))}
                    style={{ width: 16, height: 16, flexShrink: 0, accentColor: 'var(--color-primary)' }}
                  />
                  <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-main)' }}>
                    {ja ? '消去法機能をオン' : 'Enable elimination mode'}
                  </span>
                </label>
                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)', marginTop: 4, lineHeight: 1.5 }}>
                  ※ {ja ? '選択肢のテキストをタップすると取り消し線を引いて選択肢を絞り込める機能です' : 'Tap choice text to strike through and narrow down options'}
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0', cursor: 'pointer', marginTop: 8 }}>
                  <input
                    type="checkbox"
                    checked={draftFocusedPrefs.hideColumn === true}
                    onChange={() => setDraftFocusedPrefs(p => ({ ...p, hideColumn: !p.hideColumn }))}
                    style={{ width: 16, height: 16, flexShrink: 0, accentColor: 'var(--color-primary)' }}
                  />
                  <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-main)' }}>
                    {ja ? 'コラム（豆知識）を非表示' : 'Hide column tips'}
                  </span>
                </label>
              </div>
            </div>
            {/* 保存ボタン固定 */}
            {(() => {
              const focusedDirty = JSON.stringify(draftFocusedPrefs) !== JSON.stringify(savedFocusedPrefsRef.current);
              const flipped = !focusedDirty || focusedSaving;
              return (
                <div style={{ flexShrink: 0, borderTop: '1px solid var(--color-border)', padding: '10px 16px', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, minHeight: 64 }}>
                  {focusedSaveMsg && (
                    <span style={{ fontSize: 'var(--font-size-sm2)', fontWeight: 700, color: focusedSaveMsg === 'saved' ? 'var(--color-success)' : 'var(--color-text-sub)', animation: 'sherpa-save-msg 2s ease-in-out both' }}>
                      {focusedSaveMsg === 'saved' ? `✓ ${ja ? '保存しました' : 'Saved'}` : (ja ? '保存済です' : 'Already saved')}
                    </span>
                  )}
                  <div style={{ position: 'relative', flexShrink: 0 }}>
                    {focusedDirty && (
                      <span style={{ position: 'absolute', top: -2, right: -2, width: 10, height: 10, borderRadius: '50%', background: SAVE_BURST_COLOR, border: '1.5px solid var(--color-bg-white)', zIndex: 1, pointerEvents: 'none' }} />
                    )}
                    <button
                      ref={saveBtnFocusedRef}
                      onClick={() => {
                        if (!focusedDirty) {
                          setFocusedSaveMsg('already');
                          setTimeout(() => setFocusedSaveMsg(null), 2000);
                          return;
                        }
                        localStorage.setItem(`focusedExercisePrefs_${uid}`, JSON.stringify(draftFocusedPrefs));
                        savedFocusedPrefsRef.current = draftFocusedPrefs;
                        setFocusedSaveMsg('saved');
                        setTimeout(() => setFocusedSaveMsg(null), 2000);
                        setFocusedSaving(true);
                        setTimeout(() => setFocusedSaving(false), 600);
                        const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
                        if (!reduceMotion) {
                          const r = saveBtnFocusedRef.current?.getBoundingClientRect();
                          if (r) setFocusedBurst({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
                        }
                        // 保存アニメーション（約0.6s）完了の1秒後に自動で閉じる（変更保存時のみ）
                        setTimeout(() => setShowFocusedModal(false), 1600);
                      }}
                      disabled={focusedSaving}
                      style={{ width: 44, height: 44, flexShrink: 0, padding: 0, border: 'none', background: 'transparent', cursor: focusedSaving ? 'default' : 'pointer', perspective: 600, transition: 'none' }}
                    >
                      <div style={{ position: 'relative', width: '100%', height: '100%', transformStyle: 'preserve-3d', transition: focusedSaving ? 'transform 0.55s cubic-bezier(.45,.05,.3,1)' : 'none', transform: flipped ? 'rotateY(180deg)' : 'rotateY(0deg)' }}>
                        {/* 表面：未保存（白ベース・色枠） */}
                        <span style={{ position: 'absolute', inset: 0, backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%', border: '2px solid var(--color-accent)', background: 'var(--color-bg-white)', color: 'var(--color-accent)', boxShadow: 'var(--box-shadow-pop)' }}>
                          <IconSave size={22} />
                        </span>
                        {/* 裏面：保存済（オレンジ塗り・白アイコン） */}
                        <span style={{ position: 'absolute', inset: 0, backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden', transform: 'rotateY(180deg)', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%', background: 'var(--color-accent)', color: 'var(--color-btn-primary-text)', boxShadow: 'var(--box-shadow-pop)' }}>
                          <IconSaveCheck size={22} />
                        </span>
                      </div>
                    </button>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* 成績詳細モーダル（デスクトップは常時展開表示のためモーダルは使わない） */}
      {isMobile && showCombinedDetail && targetExam && (
        <CombinedDetailModal targetExam={targetExam} domainAccList={domainAccList} estimatedScore={estimatedScore} passScore={passScore} lang={lang} isMobile={isMobile} uid={uid} domainStats={domainStats} scoreHistory={serverScoreHistory ?? undefined} sessionScoreLog={serverSessionScoreLog ?? undefined} nodeWindow={nodeWindow} onNodeWindowChange={w => { setNodeWindow(w); localStorage.setItem(`scoreWindow_${uid}`, String(w)); }} onClose={() => setShowCombinedDetail(false)} />
      )}

      {/* オンボーディング（目標資格未設定） */}
      {showOnboarding && (
        <ExamSelectOverlay
          targetExam={targetExam}
          uid={uid}
          lang={lang}
          isMobile={isMobile}
          onboarding
          onSelect={(exam) => {
            setTargetExam(exam);
            if (user) syncTargetExamToServer(user.userId, uid, exam);
            // 初回のみ：保存時にパネルを自動で閉じ、ホームの演習開始チュートリアルを開始する
            if (typeof window !== 'undefined' && !localStorage.getItem(ONBOARDING_TUTORIAL_KEY)) {
              localStorage.setItem(ONBOARDING_TUTORIAL_KEY, '1');
              setShowOnboarding(false);
              // オーバーレイのアンマウント後に開始ボタンが描画されてから表示する
              setTimeout(() => setShowStartTutorial(true), 400);
            }
          }}
          // onClose は渡さない：目標資格未設定のうちは閉じられないようにする（onClose未指定=非表示）
        />
      )}

      {/* 初回オンボーディング：演習開始へのスポットライト誘導 */}
      {showStartTutorial && (
        <StartTutorialSpotlight
          targetSelector='[data-tutorial="start"]'
          message={ja ? 'さっそく1問目を解いてみよう！' : 'Try your first question now!'}
          skipLabel={ja ? 'スキップ' : 'Skip'}
          onClose={() => setShowStartTutorial(false)}
        />
      )}
      {(quickLoading || focusedLoading) && <div style={{ position: 'fixed', inset: 0, zIndex: 9000, cursor: 'wait' }} onTouchStart={e => e.stopPropagation()} onTouchMove={e => e.stopPropagation()} onTouchEnd={e => e.stopPropagation()} />}
      {quickBurst && <ConfirmBurst x={quickBurst.x} y={quickBurst.y} color={SAVE_BURST_COLOR} onDone={() => setQuickBurst(null)} />}
      {focusedBurst && <ConfirmBurst x={focusedBurst.x} y={focusedBurst.y} color={SAVE_BURST_COLOR} onDone={() => setFocusedBurst(null)} />}
    </PageLayout>
  );
}
