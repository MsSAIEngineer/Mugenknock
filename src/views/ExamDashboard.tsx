'use client';
import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from '@/compat/react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import { useTheme } from '../contexts/ThemeContext';
import { useIsMobile } from '../hooks/useWindowWidth';
import { IconChevronLeft, IconChevronDown, IconExternalLink } from '../components/Icons';
import MarkdownText from '../components/ui/MarkdownText';
import {
  EXAM_TYPES, EXAM_CONFIGS, EXAM_LEVEL, EXAM_DOMAINS, PASS_RATE,
  EXAM_DESC_JA, EXAM_DESC_EN, DOMAIN_WEIGHTS, API_ENDPOINT, EXAM_OFFICIAL_URLS,
  isNonAwsExam, levelLabel,
} from '../constants';
import { syncTargetExamToServer, resetExercisePrefsOnExamChange } from '../utils/preferences';

const LEVEL_ORDER = ['Foundational', 'Associate', 'Professional', 'Specialty', 'Additional'] as const;

const LEVEL_COLOR: Record<string, { bg: string; text: string; border: string }> = {
  Foundational: { bg: '#f0f8ff', text: '#2563eb', border: '#bfdbfe' },
  Associate:    { bg: '#f0fdf4', text: '#16a34a', border: '#bbf7d0' },
  Professional: { bg: '#fdf4ff', text: '#9333ea', border: '#e9d5ff' },
  Specialty:    { bg: '#fff7ed', text: '#ea580c', border: '#fed7aa' },
  Additional:   { bg: '#f0fdfa', text: '#0d9488', border: '#99f6e4' },
};

export default function ExamDashboard() {
  const { user } = useAuth();
  const { lang } = useLanguage();
  useTheme();
  const navigate = useNavigate();
  const ja = lang === 'ja';
  const isMobile = useIsMobile();
  const uid = user?.userId ?? 'guest';

  const [selectedExam, setSelectedExam] = useState<string>(
    () => localStorage.getItem(`targetExam_${uid}`) ?? 'SAA'
  );

  const handleChange = (et: string) => {
    resetExercisePrefsOnExamChange(uid, localStorage.getItem(`targetExam_${uid}`), et);
    localStorage.setItem(`targetExam_${uid}`, et);
    setSelectedExam(et);
    window.dispatchEvent(new CustomEvent('targetExamChanged', { detail: et }));
    if (user) syncTargetExamToServer(user.userId, uid, et);
  };

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
        setSearchQuery('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filteredExams = EXAM_TYPES.filter(et => {
    const q = searchQuery.toLowerCase();
    if (!q) return true;
    return et.toLowerCase().includes(q) ||
      (EXAM_CONFIGS[et]?.fullName ?? '').toLowerCase().includes(q) ||
      (EXAM_CONFIGS[et]?.examCode ?? '').toLowerCase().includes(q);
  });

  const [passComments, setPassComments] = useState<Record<string, string>>({});
  useEffect(() => {
    fetch(`${API_ENDPOINT}/settings/pass-comments`)
      .then(r => r.json())
      .then(d => setPassComments(d.comments ?? {}))
      .catch(() => {});
  }, []);

  const cfg = EXAM_CONFIGS[selectedExam];
  const level = EXAM_LEVEL[selectedExam] ?? '';
  const passRate = PASS_RATE[selectedExam];
  const domains = EXAM_DOMAINS[selectedExam] ?? [];
  const weights = DOMAIN_WEIGHTS[selectedExam] ?? [];
  const desc = ja ? EXAM_DESC_JA[selectedExam] : EXAM_DESC_EN[selectedExam];
  const lc = LEVEL_COLOR[level] ?? LEVEL_COLOR.Associate;
  const passComment = passComments[selectedExam];
  const officialUrls = EXAM_OFFICIAL_URLS[selectedExam];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--color-bg-main)', fontFamily: 'inherit' }}>
      {/* ── ヘッダー ── */}
      <header style={{
        height: 56, minHeight: 56, background: 'var(--color-bg-white)',
        display: 'flex', alignItems: 'center',
        padding: '0 16px 0 8px',
        borderBottom: '1px solid var(--color-border)',
        flexShrink: 0, position: 'sticky', top: 0, zIndex: 100,
      }}>
        <button
          onClick={() => navigate(-1)}
          aria-label={ja ? '戻る' : 'Back'}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 44, height: 44, border: 'none', background: 'none',
            cursor: 'pointer', color: 'var(--color-text-main)', borderRadius: 8,
            flexShrink: 0, transition: 'background 0.15s',
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'var(--color-bg-main)'}
          onMouseLeave={e => e.currentTarget.style.background = 'none'}
        >
          <IconChevronLeft size={22} />
        </button>
        <span style={{ fontWeight: 700, fontSize: 'var(--font-size-lg)', color: 'var(--color-text-main)' }}>
          {ja ? '資格ダッシュボード' : 'Exam Dashboard'}
        </span>
      </header>

      {/* ── スクロール可能なコンテンツ ── */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ maxWidth: 640, margin: '0 auto', padding: 'var(--spacing-lg) var(--spacing-md) 48px', display: 'flex', flexDirection: 'column', gap: 'var(--spacing-lg)' }}>

          {/* ── 資格選択 ── */}
          <div ref={dropdownRef} style={{ position: 'relative' }}>
            <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-text-light)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8 }}>
              {ja ? '目標資格' : 'Target Certification'}
            </div>

            {/* トリガー */}
            <button
              onClick={() => {
                setDropdownOpen(v => !v);
              }}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                background: 'var(--color-bg-white)',
                border: `1px solid ${dropdownOpen ? 'var(--color-primary)' : 'var(--color-border)'}`,
                borderRadius: dropdownOpen ? '10px 10px 0 0' : 10,
                padding: '10px 14px', cursor: 'pointer', textAlign: 'left',
                transition: 'border-color 0.15s',
              }}
            >
              <span style={{ fontSize: 'var(--font-size-sm2)', fontWeight: 800, color: 'var(--color-primary)', fontFamily: 'monospace', flexShrink: 0 }}>{selectedExam}</span>
              <span style={{ fontSize: 'var(--font-size-sm2)', color: 'var(--color-text-main)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {EXAM_CONFIGS[selectedExam]?.fullName}
              </span>
              <span style={{ flexShrink: 0, color: 'var(--color-text-light)', transform: dropdownOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
                <IconChevronDown size={16} />
              </span>
            </button>

            {/* ドロップダウン */}
            {dropdownOpen && (
              <div style={{
                position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 200,
                background: 'var(--color-bg-white)',
                border: '1px solid var(--color-primary)', borderTop: 'none',
                borderRadius: '0 0 10px 10px',
                boxShadow: 'var(--box-shadow-lg)',
                overflow: 'hidden',
              }}>
                {/* 検索入力 */}
                <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    ref={inputRef}
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    placeholder={ja ? '資格名・コードで検索...' : 'Search by name or code...'}
                    style={{
                      flex: 1, border: 'none', outline: 'none',
                      background: 'transparent',
                      fontSize: 'var(--font-size-sm2)', color: 'var(--color-text-main)',
                      padding: 0,
                    }}
                  />
                  {searchQuery && (
                    <button onClick={() => setSearchQuery('')} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--color-text-light)', fontSize: 'var(--font-size-base)', padding: '0 2px', lineHeight: 1 }}>✕</button>
                  )}
                </div>

                {/* リスト */}
                <div style={{ maxHeight: 260, overflowY: 'auto' }}>
                  {filteredExams.length === 0 ? (
                    <div style={{ padding: '12px 14px', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-light)', textAlign: 'center' }}>
                      {ja ? '見つかりません' : 'No results'}
                    </div>
                  ) : filteredExams.map(et => {
                    const lc2 = LEVEL_COLOR[EXAM_LEVEL[et] ?? ''] ?? LEVEL_COLOR.Associate;
                    const isSelected = et === selectedExam;
                    return (
                      <button
                        key={et}
                        onClick={() => { handleChange(et); setDropdownOpen(false); setSearchQuery(''); }}
                        style={{
                          width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                          padding: '9px 14px', border: 'none',
                          background: isSelected ? 'var(--color-primary-light)' : 'transparent',
                          cursor: 'pointer', textAlign: 'left', transition: 'background 0.1s',
                        }}
                        onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'var(--color-bg-main)'; }}
                        onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
                      >
                        <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 800, color: 'var(--color-primary)', fontFamily: 'monospace', minWidth: 32, flexShrink: 0 }}>{et}</span>
                        <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-main)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {EXAM_CONFIGS[et]?.fullName}
                        </span>
                        <span style={{ fontSize: 'var(--font-size-2xs)', fontWeight: 700, padding: '2px 7px', borderRadius: 'var(--border-radius-sm)', background: lc2.bg, color: lc2.text, border: `1px solid ${lc2.border}`, flexShrink: 0 }}>
                          {EXAM_LEVEL[et]}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* ── 資格情報カード ── */}
          <div style={{ border: '1px solid var(--color-border)', borderRadius: 12, overflow: 'hidden', background: 'var(--color-bg-white)', boxShadow: 'var(--box-shadow-pop)' }}>

            {/* カードヘッダー */}
            <div style={{ padding: '20px 20px 16px', borderBottom: '1px solid var(--color-border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
                <span style={{
                  fontSize: 'var(--font-size-xs)', fontWeight: 700, letterSpacing: '0.4px',
                  padding: '3px 10px', borderRadius: 'var(--border-radius-sm)',
                  background: lc.bg, color: lc.text,
                  border: `1px solid ${lc.border}`,
                }}>
                  {levelLabel(level, ja)}
                </span>
                {/* 資格コードは本番試験の情報。オリジナル(非AWS)カードでは表示しない */}
                {!isNonAwsExam(selectedExam) && (
                  <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-light)', fontWeight: 600, fontFamily: 'monospace' }}>
                    {cfg?.examCode}
                  </span>
                )}
              </div>
              <h1 style={{ margin: 0, fontSize: 'var(--font-size-h3)', fontWeight: 700, color: 'var(--color-text-main)', lineHeight: 1.3 }}>
                {cfg?.fullName ?? selectedExam}
              </h1>
              {desc && (
                <p style={{ margin: '8px 0 0', fontSize: 'var(--font-size-sm2)', color: 'var(--color-text-sub)', lineHeight: 1.5 }}>
                  {desc}
                </p>
              )}
              {isNonAwsExam(selectedExam) && (
                <div style={{
                  marginTop: 12, padding: '10px 12px',
                  background: LEVEL_COLOR.Additional.bg,
                  border: `1px solid ${LEVEL_COLOR.Additional.border}`,
                  borderRadius: 8,
                  fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', lineHeight: 1.6,
                }}>
                  <div style={{ fontWeight: 700, color: LEVEL_COLOR.Additional.text, marginBottom: 4 }}>
                    {ja ? 'これはAWS認定資格ではありません' : 'This is not an AWS certification'}
                  </div>
                  {ja
                    ? 'AWS資格の多くは、AWSサービス以外の実務知識を前提としています（例：ANSは5年以上のネットワーク実務経験を推奨）。この「Additional」カードは、そうした前提となるAWS外の基礎知識（機械学習・データベース・ネットワーク）を補うための独自の演習で、認定資格そのものではありません。'
                    : 'Many AWS certifications assume prior non-AWS, hands-on knowledge (e.g., ANS recommends 5+ years of networking experience). These "Additional" cards are our own practice sets to fill that assumed foundational knowledge (ML, databases, networking) — they are not certifications.'}
                </div>
              )}
              {officialUrls && (
                <div style={{ display: 'flex', gap: 16, marginTop: 12, flexWrap: 'wrap' }}>
                  <a
                    href={officialUrls.page}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--font-size-sm)', color: 'var(--color-primary)', textDecoration: 'none', fontWeight: 600 }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                      <circle cx="12" cy="12" r="10"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/><path d="M2 12h20"/>
                    </svg>
                    {ja ? '公式ページ' : 'Official Page'}
                    <IconExternalLink size={12} />
                  </a>
                  <a
                    href={officialUrls.guide}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--font-size-sm)', color: 'var(--color-primary)', textDecoration: 'none', fontWeight: 600 }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
                    </svg>
                    {ja ? '試験ガイド PDF' : 'Exam Guide PDF'}
                    <IconExternalLink size={12} />
                  </a>
                </div>
              )}
            </div>

            {/* 試験ルール（本番形式の情報。オリジナル(非AWS)カードでは表示しない） */}
            {!isNonAwsExam(selectedExam) && (
              <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--color-border)' }}>
                <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-text-light)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 12 }}>
                  {ja ? '試験ルール' : 'Exam Rules'}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                  {[
                    { label: ja ? '問題数' : 'Questions', value: `${cfg?.totalQuestions}${ja ? '問' : ''}` },
                    { label: ja ? '制限時間' : 'Time Limit', value: `${cfg?.timeLimitMin}${ja ? '分' : ' min'}` },
                    { label: ja ? '合格点' : 'Pass Score', value: `${passRate}%` },
                  ].map(({ label, value }) => (
                    <div key={label} style={{ background: 'var(--color-bg-main)', borderRadius: 8, padding: '12px 14px', textAlign: 'center' }}>
                      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)', fontWeight: 600, marginBottom: 4 }}>{label}</div>
                      <div style={{ fontSize: 'var(--font-size-xl)', fontWeight: 800, color: 'var(--color-text-main)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 出題ドメイン */}
            <div style={{ padding: '16px 20px' }}>
              <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-text-light)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 12 }}>
                {ja ? '出題ドメイン' : 'Exam Domains'}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {domains.map((d, i) => (
                  <div key={d} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-primary)', minWidth: 24, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                      {i + 1}
                    </span>
                    <span style={{ fontSize: 'var(--font-size-sm2)', color: 'var(--color-text-main)', lineHeight: 1.4, flex: 1 }}>{d}</span>
                    {weights[i] !== undefined && (
                      <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 700, color: 'var(--color-text-sub)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                        {weights[i]}%
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* 合格コメント */}
            {passComment && (
              <div style={{ padding: '16px 20px', borderTop: '1px solid var(--color-border)' }}>
                <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-text-light)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>
                  {ja ? '合格コメント' : 'Pass Comment'}
                </div>
                {/* 管理画面から Markdown で投稿されるため、目標資格設定オーバーレイと同じレンダラーを使う。
                    以前は生テキスト描画で `**太字**` の記号がそのまま見えていた。 */}
                <div style={{ fontSize: 'var(--font-size-sm2)', color: 'var(--color-text-main)', lineHeight: 1.7 }}>
                  <MarkdownText text={passComment} />
                </div>
              </div>
            )}

          </div>

        </div>
      </div>
    </div>
  );
}
