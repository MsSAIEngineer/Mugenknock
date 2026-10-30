'use client';
import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation } from '@/compat/react-router-dom';
import { API_ENDPOINT, EXAM_DOMAINS, EXAM_DOMAIN_SERVICES, EXAM_TYPES, EXAM_CONFIGS, DOMAIN_RATE_WARNING, DOMAIN_RATE_CAUTION, PASS_SCORES, EXAM_LEVEL, EXAM_LEVEL_COLORS, tint, levelText, levelOn, tagIdMatches, toDomainIndex, isNonAwsExam } from '../constants';
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
  EXAM_ICON_COMPONENTS, IconSave, IconSaveCheck, IconCopy, IconCheck, IconTrophy, IconCircleCheck, IconCircleX, IconExternalLink, IconFileText, IconTrash, IconX } from '../components/Icons';
import ExamSelectOverlay, { EXAM_DESC, EXAM_URLS, EXAM_GUIDE_PDF_URLS, ConfirmBurst } from '../components/ExamSelectOverlay';
import Confetti from '../components/Confetti';
import KeyHint from '../components/KeyHint';


function jstToday(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function daysUntil(dateStr: string): number {
  const examDate = new Date(dateStr + 'T00:00:00+09:00');
  const today = new Date(new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10) + 'T00:00:00+09:00');
  return Math.round((examDate.getTime() - today.getTime()) / 86400000);
}

// 六角形バッジ。中は常に白地（ダークでは地色）で、縁とアイコンの色だけで状態を示す:
// 取得済み = レベル色の縁＋レベル色のアイコン、未取得 = グレーの縁＋グレーのアイコン。
// 縁は clip-path の二重重ねだと斜辺だけ太さが変わって見えるため、SVG の stroke で描いて全辺を同じ太さにする。
// 縁の太さは全バッジ共通（幅の6%・最小2px）で、目標資格・取得済み・未取得で揃える。
function HexBadge({ Icon, color, iconColor, size, spin }: {
  Icon?: React.FC<{ size?: number }>; color: string; iconColor?: string; size: number; spin?: boolean;
}) {
  const h = Math.round(size * 1.15);
  const sw = Math.max(2, Math.round(size * 0.06));
  const x0 = sw / 2, x1 = size - sw / 2, y0 = sw / 2, y1 = h - sw / 2;
  const inner = y1 - y0;
  const points = [
    [size / 2, y0], [x1, y0 + inner * 0.25], [x1, y0 + inner * 0.75],
    [size / 2, y1], [x0, y0 + inner * 0.75], [x0, y0 + inner * 0.25],
  ].map(([x, y]) => `${x},${y}`).join(' ');
  return (
    <div style={{ position: 'relative', width: size, height: h, flexShrink: 0, animation: spin ? 'certHexSpin 0.52s ease' : undefined }}>
      <svg width={size} height={h} viewBox={`0 0 ${size} ${h}`} style={{ position: 'absolute', inset: 0, overflow: 'visible' }} aria-hidden>
        <polygon points={points} fill="var(--color-bg-white)" style={{ stroke: color }} strokeWidth={sw} strokeLinejoin="round" />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: iconColor ?? color }}>
        {Icon && <Icon size={Math.round(size * 0.42)} />}
      </div>
    </div>
  );
}
function CertHexBadge({ exam, obtained, color, size, spin }: {
  exam: string; obtained: boolean; color: string; size: number; spin?: boolean;
}) {
  return <HexBadge Icon={EXAM_ICON_COMPONENTS[exam]} color={obtained ? color : tint('var(--color-text-light)', 45)} iconColor={obtained ? color : 'var(--color-text-light)'} size={size} spin={spin} />;
}

export default function MyPage() {
  const { user } = useAuth();
  const { lang } = useLanguage();
  const navigate = useNavigate();
  const location = useLocation();
  const ja = lang === 'ja';
  const uid = user?.userId ?? 'guest';
  const isMobile = window.innerWidth < 768;

  // 苦手分析・履歴タブは記録画面（/aws/stats）へ移した（specs/007）。
  // 古いリンクや古い JS から tab 指定で来た場合は、記録画面の同じタブへ転送する
  useEffect(() => {
    const requested = (location.state as any)?.tab;
    if (requested === 'analysis' || requested === 'history') navigate('/aws/stats', { state: { tab: requested }, replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
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

  // ── 取得済資格 ──
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

  // ── オーバーレイ表示中は body スクロール・横スワイプ無効 ──
  useEffect(() => {
    const anyOpen = showSettingsEdit || showExamSelect || showWeeklyDetail || showCertOverlay;
    if (!anyOpen) return;
    return lockBodyScroll();
  }, [showSettingsEdit, showExamSelect, showWeeklyDetail, showCertOverlay]);

  // ── UI helpers ──

  return (
    <>
      <PageLayout className="page-container">

        {/* ════════ 目標 ════════ */}
          <>
            {/* 六角形バッジ共通ヘルパー */}
            {(() => {
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
                    <HexBadge Icon={ExamIcon} color={panelColor} size={46} />
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 'var(--font-size-h3)', color: levelText(panelColor), lineHeight: 1.3 }}>{mainNode}</div>
                      {level && <div style={{ fontWeight: 700, fontSize: 'var(--font-size-h3)', color: levelText(panelColor), lineHeight: 1.3 }}>{level}</div>}
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
                                        <div style={{ fontSize: 'var(--font-size-sm2)', fontWeight: 700, color: levelText(panelColor) }}>{value}</div>
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
                                {todayCount >= dailyGoal && <span style={{ display: 'inline-flex', color: 'var(--color-success)' }}><IconCheck size={14} /></span>}
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
                                          <span style={{ position: 'absolute', bottom: barH + 2, left: '50%', transform: 'translateX(-50%)', fontSize: 'var(--font-size-xs)', fontWeight: 700, color: count > 0 ? (achieved ? levelText(examColor) : 'var(--color-text-sub)') : 'var(--color-text-light)', opacity: barAnimated ? 1 : 0, transition: count > 0 ? `opacity 0.2s ease ${0.3 + staggerIdx * 0.07}s` : 'none' }}>{count}</span>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                                  {weekDays.map((d) => {
                                    const isToday = d === jstToday();
                                    const dayLabel = new Date(d + 'T12:00:00').toLocaleDateString(ja ? 'ja-JP' : 'en-US', { weekday: 'short' });
                                    return (<div key={d} style={{ flex: 1, textAlign: 'center', fontSize: 'var(--font-size-2xs)', color: isToday ? levelText(examColor) : 'var(--color-text-light)', fontWeight: isToday ? 700 : 400 }}>{dayLabel}</div>);
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
                        {todayCount >= dailyGoal && <span style={{ display: 'inline-flex', color: 'var(--color-success)' }}><IconCheck size={14} /></span>}
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
                                  fontSize: 'var(--font-size-base)', fontWeight: 800, color: levelText(examColor),
                                  opacity: circleAnimated ? 1 : 0,
                                  transform: circleAnimated ? 'scale(1)' : 'scale(0.4)',
                                  transition: `opacity 0.2s ease ${0.5 + i * 0.1}s, transform 0.25s ease ${0.5 + i * 0.1}s`,
                                }}><IconCheck size={16} /></div>
                              )}
                            </div>
                            <span style={{ fontSize: 'var(--font-size-3xs)', color: isToday ? levelText(examColor) : 'var(--color-text-light)', fontWeight: isToday ? 700 : 400 }}>{dayLabel}</span>
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
                  data-kbscope="1" role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
                  onClick={() => setShowWeeklyDetail(false)}
                >
                  <div style={{ background: 'var(--color-bg-white)', borderRadius: 'var(--border-radius-lg)', padding: 20, width: '100%', maxWidth: 'var(--modal-width-md)', boxShadow: 'var(--box-shadow-md)' }} onClick={e => e.stopPropagation()}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ color: 'var(--color-text-sub)', display: 'flex', alignItems: 'center' }}><IconTrendingUp size={15} /></span>
                        <span style={{ fontWeight: 700, fontSize: 'var(--font-size-base)', color: 'var(--color-text-main)' }}>{ja ? '週間達成状況' : 'Weekly Progress'}</span>
                      </div>
                      <button onClick={() => setShowWeeklyDetail(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-light)', fontSize: 'var(--font-size-xl)', lineHeight: 1, padding: '0 4px' }}><IconX size={20} /></button>
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
                              <span style={{ position: 'absolute', bottom: barH + 2, left: '50%', transform: 'translateX(-50%)', fontSize: 'var(--font-size-xs)', fontWeight: 700, color: count > 0 ? (achieved ? levelText(examColor) : 'var(--color-text-sub)') : 'var(--color-text-light)', opacity: popupBarAnimated ? 1 : 0, transition: count > 0 ? `opacity 0.2s ease ${0.3 + staggerIdx * 0.07}s` : 'none' }}>{count}</span>
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
                          <div key={d} style={{ flex: 1, textAlign: 'center', fontSize: 'var(--font-size-2xs)', color: isToday ? levelText(examColor) : 'var(--color-text-light)', fontWeight: isToday ? 700 : 400 }}>{dayLabel}</div>
                        );
                      })}
                    </div>

                    {/* サマリー */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', borderTop: '1px solid var(--color-border)', paddingTop: 12, marginTop: 18 }}>
                      <span>{ja ? '7日間合計' : '7-day total'}: <strong style={{ color: 'var(--color-text-main)' }}>{weekTotal}{ja ? '問' : ''}</strong></span>
                      <span>{ja ? '達成日数' : 'Achieved'}: <strong style={{ color: levelText(examColor) }}>{achievedDays}/7{ja ? '日' : ''}</strong></span>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* 設定編集ポップアップ */}
            {showSettingsEdit && (
              <div
                data-kbscope="1" role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
                onClick={() => setShowSettingsEdit(false)}
                onTouchStart={e => e.stopPropagation()}
                onTouchMove={e => e.stopPropagation()}
              >
                <div style={{ background: 'var(--color-bg-white)', borderRadius: 'var(--border-radius-lg)', padding: '24px 20px', width: '100%', maxWidth: 'var(--modal-width-sm)', boxShadow: 'var(--box-shadow-md)' }} onClick={e => e.stopPropagation()}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
                    <span style={{ fontWeight: 700, fontSize: 'var(--font-size-lg)' }}>{ja ? '目標設定' : 'Edit Settings'}</span>
                    <button onClick={() => setShowSettingsEdit(false)} style={{ width: 32, height: 32, borderRadius: '50%', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 'var(--font-size-h3)', color: 'var(--color-text-sub)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><IconX size={20} /></button>
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
                        <button onClick={() => setEditExamDate('')} aria-label={ja ? '受験日を消す' : 'Clear exam date'} title={ja ? '受験日を消す' : 'Clear exam date'} style={{ flexShrink: 0, width: 44, height: 44, borderRadius: '50%', border: '1px solid var(--color-border)', background: 'transparent', cursor: 'pointer', color: 'var(--color-text-sub)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <IconTrash size={18} />
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
                        {settingsSaveMsg === 'saved' ? <><span style={{ display: 'inline-flex', verticalAlign: '-2px', marginRight: 'var(--spacing-xs)' }}><IconCheck size={13} /></span>{ja ? '保存しました' : 'Saved'}</> : (ja ? '保存済です' : 'Already saved')}
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
              />
            )}
          </>

        {/* 取得済資格（以前は履歴タブにあった。苦手分析・解答履歴は記録画面へ移した: specs/007） */}
        {user && (
          <div style={{ marginTop: 'var(--spacing-md)' }}>
                {/* 取得済資格パネル（クリックでオーバーレイを開く） */}
                {(() => {
                  const CertHex = ({ exam, obtained, color, size = 38 }: { exam: string; obtained: boolean; color: string; size?: number }) => (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                      <CertHexBadge exam={exam} obtained={obtained} color={color} size={size} />
                      <div style={{ fontSize: 'var(--font-size-3xs)', fontWeight: 800, color: obtained ? levelText(color) : 'var(--color-text-light)', lineHeight: 1 }}>{exam}</div>
                    </div>
                  );
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
                      <div style={{ background: 'var(--color-bg-white)', borderRadius: 'var(--border-radius-lg)', width: '100%', maxWidth: 'var(--modal-width-md)', boxShadow: 'var(--box-shadow-lg)', display: 'flex', flexDirection: 'column', overflow: 'hidden', maxHeight: '80vh' }} onClick={e => e.stopPropagation()}>
                        {/* ヘッダー */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px 12px', flexShrink: 0, borderBottom: '1px solid var(--color-border)' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <IconTrophy size={16} />
                            <span style={{ fontWeight: 700, fontSize: 'var(--font-size-lg)' }}>{ja ? '取得済資格を設定' : 'Set Certifications'}</span>
                          </div>
                          <button onClick={() => setShowCertOverlay(false)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--color-text-light)', fontSize: 20, lineHeight: 1, padding: 4 }}><IconX size={20} /></button>
                        </div>
                        {/* レベルタブ */}
                        <div style={{ display: 'flex', gap: 'var(--spacing-xs)', padding: '0 var(--spacing-md)', borderBottom: '1px solid var(--color-border)', flexShrink: 0, overflowX: 'auto', scrollbarWidth: 'none' }}>
                          {CERT_LEVELS.map(lv => (
                            <button key={lv.key} ref={el => { if (el && certOverlayLevel === lv.key) el.scrollIntoView({ inline: 'center', block: 'nearest' }); }} onClick={() => setCertOverlayLevel(lv.key)} style={{ flex: '1 0 auto', whiteSpace: 'nowrap', padding: '10px var(--spacing-sm)', border: 'none', borderBottom: `3px solid ${certOverlayLevel === lv.key ? lv.color : 'transparent'}`, background: 'transparent', cursor: 'pointer', fontSize: 'var(--font-size-xs)', fontWeight: 700, color: certOverlayLevel === lv.key ? levelText(lv.color) : 'var(--color-text-light)', transition: 'color 0.15s' }}>
                              {lv.label}
                            </button>
                          ))}
                        </div>
                        {/* 資格カード */}
                        <div style={{ display: 'flex', gap: 10, padding: '20px 20px', flexWrap: 'wrap', alignContent: 'flex-start', height: 240, overflowY: 'auto' }}>
                          {currentLevel.exams.map(exam => {
                            const obtained = obtainedCerts.includes(exam);
                            const c = currentLevel.color;
                            return (
                              <button
                                key={exam}
                                onClick={e => toggleObtainedCert(exam, e.currentTarget)}
                                style={{ flexShrink: 0, width: 80, padding: '10px 6px 8px', cursor: 'pointer', borderRadius: 10, textAlign: 'center', position: 'relative', border: `2px solid ${obtained ? c : 'var(--color-border)'}`, background: obtained ? tint(c, 8) : 'var(--color-bg-card)', animation: justObtained === exam ? 'certObtainPop 0.38s cubic-bezier(.36,.07,.19,.97)' : undefined, transition: 'border-color 0.15s, background 0.15s' }}
                              >
                                {obtained && <div style={{ position: 'absolute', top: 4, right: 4, width: 18, height: 18, borderRadius: '50%', background: c, color: levelOn(c), display: 'flex', alignItems: 'center', justifyContent: 'center' }}><IconCheck size={12} /></div>}
                                {/* 六角形バッジ */}
                                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 6, perspective: 200 }}>
                                  <CertHexBadge exam={exam} obtained={obtained} color={c} size={40} spin={justObtained === exam} />
                                </div>
                                <div style={{ fontWeight: 800, fontSize: 'var(--font-size-md)', color: obtained ? levelText(c) : 'var(--color-text-sub)', lineHeight: 1 }}>{exam}</div>
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
          </div>
        )}
      </PageLayout>

    </>
  );
}
