'use client';
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { API_ENDPOINT, ADMIN_EMAIL, EXAM_TYPES, EXAM_DOMAINS, EXAM_CONFIGS, EXAM_LEVEL, EXAM_SUPPLEMENTARY_RULES, toDomainIndex, qDomainName, isNonAwsExam } from '../constants';
// 資格別の生成プロンプト本文（夜間 instructions/*.txt から prebuild で自動生成・唯一ソース）
import { EXAM_INSTRUCTIONS, COMMON_RULES } from '../data/originalInstructions';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import MfaSetupCard from '../components/admin/MfaSetupCard';
import { ServiceIcon, isServiceIconKey, IconChevronDown, IconChevronRight, IconCopy, IconCheck, IconClose, IconCircleX, IconAlertTriangle, IconThumbsUp, IconThumbsDown, IconLightbulb, IconEye, IconPenLine, IconArrowRight, IconArrowLeft, IconPencil, IconTrash, IconRefreshCw } from '../components/Icons';
import { useTheme, CustomColors } from '../contexts/ThemeContext';
import { useHorizontalScrollHint } from '../hooks/useHorizontalScrollHint';

const adminFetch = async (url: string, options: RequestInit = {}): Promise<Response> => {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  return fetch(url, {
    ...options,
    headers: {
      ...(options.headers as Record<string, string> ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
};

type Question = {
  questionId: string;
  examType: string;
  domain?: string;
  questionText: string;
  choices: string[];
  correctAnswers: string[];
  correctAnswerIndices?: number[];
  explanation: string;
  isMultiple: boolean;
  createdAt?: string;
  updatedAt?: string;
  validityCheckedAt?: string;
};

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
};

type Report = {
  questionId: string;
  reportId: string;
  userId: string;
  category?: string;
  message: string;
  reportedAt: string;
};

const REPORT_CATEGORY_LABEL: Record<string, string> = {
  question_error:    '問題文の誤り',
  choice_error:      '選択肢・正解の誤り',
  explanation_error: '解説の誤り',
  followup_error:    'ASK AI の質問の誤り',
  other:             'その他',
};

type Tip = {
  tipId: string;
  examType: string;
  title: string;
  content: string;
};

type Release = {
  releaseId: string;
  date: string;
  title: string;
  body: string;
};

type Announcement = {
  announcementId: string;
  title: string;
  body: string;
  status: 'draft' | 'published';
  createdAt: string;
  publishedAt: string | null;
};

type ImportQuestion = {
  examType?: string;
  domain?: string;
  questionText: string;
  choices: string[];
  correctAnswers: string[];
  correctAnswerIndices?: number[];
  explanation?: string;
  isMultiple?: boolean;
};

type Tab = 'questions' | 'reports' | 'tips' | 'columnideas' | 'import' | 'releases' | 'announcements' | 'scan' | 'messages' | 'dailyservice' | 'theme' | 'admins' | 'about' | 'deleteuser' | 'passcomments' | 'growth';
type Group = 'content' | 'ops' | 'settings';

const TAB_GROUPS: { key: Group; label: string; tabs: Tab[] }[] = [
  { key: 'content',  label: 'コンテンツ', tabs: ['questions', 'import', 'growth', 'scan', 'tips', 'columnideas', 'dailyservice', 'releases', 'passcomments'] },
  { key: 'ops',      label: '運営',       tabs: ['announcements', 'reports', 'messages', 'deleteuser'] },
  { key: 'settings', label: '設定',       tabs: ['theme', 'admins', 'about'] },
];
const TAB_LABELS: Record<Tab, string> = {
  questions: '問題管理', import: '問題追加', tips: 'コラム管理', columnideas: 'コラムのネタ',
  releases: 'リリースノート', dailyservice: '日めくりAWSサービス',
  announcements: 'お知らせ管理',
  reports: '通報確認', scan: 'スキャン結果', messages: 'メッセージ', deleteuser: 'データ削除', growth: '生成状況',
  theme: 'テーマ設定', admins: '管理者設定', about: 'サイト情報', passcomments: '合格コメント',
};
function getGroupForTab(t: Tab): Group {
  for (const g of TAB_GROUPS) if ((g.tabs as Tab[]).includes(t)) return g.key;
  return 'content';
}

const ANNOUNCEMENT_BUG_REPORT_TEMPLATE = `【不具合の内容】


【影響範囲】


【対応状況】
現在調査中です。復旧までしばらくお待ちください。`;

type DailyServiceItem = {
  serviceId: string;
  name: string;
  shortName?: string;
  category?: string;
  icon: string;
  description: string;
  trivia?: string;
  docUrl?: string;
  order: number;
  isActive: boolean;
  createdAt?: string;
};

type ContactMessage = {
  messageId: string;
  subject: string;
  message: string;
  userId: string;
  sentAt: string;
};

type FixProposal = {
  questionText?: string;
  choices?: string[];
  correctAnswers?: string[];
  explanation?: string;
  choiceExplanations?: string[];
};

type ValidityEditLog = {
  action: 'fixed';
  checkedAt: string;
  reason: string;
  changes?: {
    questionText?: { before: string; after: string };
    choices?: { before: string[]; after: string[] };
    correctAnswers?: { before: string[]; after: string[] };
    explanation?: { before: string; after: string };
  };
};

type FlaggedQuestion = {
  questionId: string;
  examType: string;
  questionText: string;
  choices?: string[];
  correctAnswers?: string[];
  explanation?: string;
  domain?: string;
  isMultiple?: boolean;
  validityCheckedAt?: string;
  validityEditLog?: string;
  isHidden?: boolean;
  // 監査で指摘されたが事実誤りではないため自動修正されなかった内容（人の判断が要る）
  auditNote?: string;
  auditFlaggedAt?: string;
  // 人の確認待ち（docs/10-ops-review.md 4.1〜4.3）。answer-change=AIが正解を変えようとした / ai-delete=AIが削除を提案 / sample=抜き取り検査
  reviewReason?: string;
  humanReviewRequestedAt?: string;
  choiceExplanations?: string[];
  // 旧フィールド（後方互換）
  validityRating?: number;
  validityNote?: string;
  fixProposalJson?: string;
};

type EditForm = {
  examType: string;
  domain: string;
  questionText: string;
  questionTextEn: string;
  choices: string[];
  choicesEn: string[];
  correctAnswers: string[];
  explanation: string;
  explanationEn: string;
  isMultiple: boolean;
};

const THEME_COLOR_LABELS: { key: string; label: string; group?: string }[] = [
  { key: '--color-primary',        label: 'メインカラー（青）',           group: 'ブランド' },
  { key: '--color-primary-hover',  label: 'メインカラー・ホバー',          group: 'ブランド' },
  { key: '--color-primary-light',  label: 'メインカラー・薄',             group: 'ブランド' },
  { key: '--color-secondary',      label: 'セカンダリ（ナビ・ヘッダー）',   group: 'ブランド' },
  { key: '--color-accent',         label: 'アクセント / Primaryボタン背景', group: 'ボタン' },
  { key: '--color-accent-hover',   label: 'Primaryボタン・ホバー',         group: 'ボタン' },
  { key: '--color-accent-dark',    label: 'Primaryボタン・押下',           group: 'ボタン' },
  { key: '--color-btn-primary-text', label: 'Primaryボタン・文字色',       group: 'ボタン' },
  { key: '--color-bg-main',        label: 'ページ背景',                   group: '背景' },
  { key: '--color-bg-white',       label: 'カード背景',                   group: '背景' },
  { key: '--color-text-main',      label: 'テキスト・メイン',             group: 'テキスト' },
  { key: '--color-text-sub',       label: 'テキスト・サブ',               group: 'テキスト' },
  { key: '--color-text-light',     label: 'テキスト・薄',                 group: 'テキスト' },
  { key: '--color-border',         label: 'ボーダー',                     group: 'その他' },
  { key: '--color-danger',         label: 'エラー・危険',                 group: 'その他' },
  { key: '--color-success',        label: '成功・正解',                   group: 'その他' },
];

const DEFAULT_COLORS: CustomColors = {
  '--color-primary':          '#006CE0',
  '--color-primary-hover':    '#0055B3',
  '--color-primary-light':    '#E8F3FF',
  '--color-secondary':        '#232f3e',
  '--color-accent':           '#ff9900',
  '--color-accent-hover':     '#ec7211',
  '--color-accent-dark':      '#cc7a00',
  '--color-btn-primary-text': '#16191f',
  '--color-bg-main':          '#f2f3f3',
  '--color-bg-white':         '#ffffff',
  '--color-text-main':        '#16191f',
  '--color-text-sub':         '#545b64',
  '--color-text-light':       '#879596',
  '--color-border':           '#eaeded',
  '--color-danger':           '#d13212',
  '--color-success':          '#037f0c',
};

// ─────────────────────────────────────────────────────────────
// 一覧の並び替え（各タブ共通）
// ─────────────────────────────────────────────────────────────
type SortOption = { key: string; label: string };

// 'field_asc' / 'field_desc' 形式のキーで配列を並び替える。
// accessors に無いフィールドが来たら（保存済み設定が古い等）元の順序をそのまま返す。
// 値が未設定のものは昇順・降順どちらでも末尾に送る。未設定を先頭に集めても探しづらいだけのため。
function sortItems<T>(
  items: T[],
  sortKey: string,
  accessors: Record<string, (x: T) => string | number | undefined | null>,
): T[] {
  const sep = sortKey.lastIndexOf('_');
  const field = sortKey.slice(0, sep);
  const dir = sortKey.slice(sep + 1) === 'asc' ? 1 : -1;
  const get = accessors[field];
  if (!get) return items;
  const isEmpty = (v: unknown) => v === undefined || v === null || v === '';
  return [...items].sort((a, b) => {
    const va = get(a), vb = get(b);
    if (isEmpty(va) && isEmpty(vb)) return 0;
    if (isEmpty(va)) return 1;
    if (isEmpty(vb)) return -1;
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    return String(va).localeCompare(String(vb), 'ja') * dir;
  });
}

function SortSelect({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: SortOption[] }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-xs)' }}>
      <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)', fontWeight: 700 }}>並び替え</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{
          padding: '5px 10px', border: '1px solid var(--color-border)',
          borderRadius: 'var(--border-radius-md)', fontSize: 'var(--font-size-sm)',
          background: 'var(--color-bg-white)', color: 'var(--color-text-main)',
          cursor: 'pointer', outline: 'none',
        }}>
        {options.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
      </select>
    </label>
  );
}

// ─────────────────────────────────────────────────────────────
// 問題プレビューモーダル（演習時の見え方を再現）
// ─────────────────────────────────────────────────────────────
const CHOICE_LABELS_P = ['A', 'B', 'C', 'D', 'E'];
const stripLabelP = (s: string) => s.replace(/^[A-E]\.\s*/, '');

function QuestionPreviewModal({ onClose, initId = '' }: { onClose: () => void; initId?: string }) {
  const [input, setInput] = useState(initId);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [question, setQuestion] = useState<any>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [answered, setAnswered] = useState(false);

  const loadQuestion = React.useCallback(async (val?: string) => {
    const target = val ?? input;
    setError(''); setQuestion(null); setSelected([]); setAnswered(false);
    const trimmed = target.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('{')) {
      try { setQuestion(JSON.parse(trimmed)); return; } catch { setError('JSONの形式が正しくありません'); return; }
    }
    setLoading(true);
    try {
      const res = await adminFetch(`${API_ENDPOINT}/admin/questions/${encodeURIComponent(trimmed)}`);
      if (!res.ok) { setError('問題が見つかりません'); return; }
      setQuestion(await res.json());
    } catch { setError('取得に失敗しました'); }
    finally { setLoading(false); }
  }, [input]);

  // initId が指定された場合は自動ロード
  React.useEffect(() => {
    if (initId) loadQuestion(initId);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps


  const choices: string[] = question?.choices ?? [];
  const correctAnswers: string[] = question?.correctAnswers ?? [];
  const correctIndices: number[] = question?.correctAnswerIndices ?? [];
  const isMultiple: boolean = question?.isMultiple ?? false;
  const choiceExplanations: string[] = question?.choiceExplanations ?? [];

  const isCorrectChoice = (_c: string, idx: number) => correctIndices.includes(idx);

  // ユーザー画面と同じ正誤判定（選択集合 == 正解集合）
  const selectedIdx = selected.map(c => choices.indexOf(c)).filter(i => i >= 0);
  const isAllCorrect = selectedIdx.length === correctIndices.length && selectedIdx.every(i => correctIndices.includes(i));

  const toggle = (c: string) => {
    if (answered) return;
    if (isMultiple) {
      setSelected(prev => prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c]);
    } else {
      setSelected([c]);
    }
  };

  const getChoiceColor = (c: string, idx: number) => {
    if (!answered) {
      return selected.includes(c) ? 'var(--color-primary)' : 'var(--color-border)';
    }
    const correct = isCorrectChoice(c, idx);
    const userSelected = selected.includes(c);
    if (correct) return 'var(--color-success)';
    if (userSelected && !correct) return 'var(--color-danger)';
    return 'var(--color-border)';
  };
  const getChoiceBg = (c: string, idx: number) => {
    if (!answered) return selected.includes(c) ? 'var(--color-primary-light)' : 'var(--color-bg-white)';
    const correct = isCorrectChoice(c, idx);
    const userSelected = selected.includes(c);
    if (correct) return 'rgba(var(--color-success-rgb, 3,127,12),0.07)';
    if (userSelected) return 'rgba(var(--color-danger-rgb, 209,50,18),0.07)';
    return 'var(--color-bg-white)';
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 2000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '24px 16px', overflowY: 'auto' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: 'var(--color-bg-white)', borderRadius: 12, width: '100%', maxWidth: 'var(--modal-width-lg)', boxShadow: 'var(--box-shadow-lg)', position: 'relative' }}>
        {/* ヘッダー */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--color-border)' }}>
          <span style={{ fontWeight: 700, fontSize: 15 }}>問題プレビュー（演習時の表示を再現）</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-sub)', lineHeight: 0, padding: '0 4px', display: 'inline-flex', alignItems: 'center' }}><IconClose /></button>
        </div>

        <div style={{ padding: '16px 20px' }}>
          {/* 入力エリア */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder={'問題ID（例: saa-abc12345）またはJSON {"questionText":...} を入力'}
              rows={2}
              style={{ flex: 1, padding: '8px 10px', border: '1px solid var(--color-border)', borderRadius: 6, fontSize: 13, resize: 'vertical', fontFamily: 'monospace', outline: 'none' }}
              onFocus={e => e.currentTarget.style.borderColor = 'var(--color-primary)'}
              onBlur={e => e.currentTarget.style.borderColor = 'var(--color-border)'}
            />
            <button
              onClick={() => loadQuestion()}
              disabled={loading || !input.trim()}
              style={{ padding: '8px 16px', background: 'var(--color-primary)', color: '#fff', border: 'none', borderRadius: 6, cursor: input.trim() ? 'pointer' : 'default', fontWeight: 700, fontSize: 13, alignSelf: 'flex-start', opacity: !input.trim() ? 0.5 : 1 }}
            >
              {loading ? '取得中...' : '表示'}
            </button>
          </div>
          {error && <p style={{ color: 'var(--color-danger)', fontSize: 13, marginBottom: 12 }}>{error}</p>}

          {/* 問題プレビュー */}
          {question && (
            <div>
              {/* ヘッダー情報 */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, fontSize: 12, color: 'var(--color-text-sub)' }}>
                <span style={{ fontFamily: 'monospace', background: 'var(--color-bg-main)', padding: '2px 8px', borderRadius: 4, border: '1px solid var(--color-border)' }}>{question.questionId ?? '（入力JSON）'}</span>
                {question.examType && <span style={{ background: 'var(--color-secondary)', color: '#fff', padding: '2px 8px', borderRadius: 4, fontWeight: 700 }}>{question.examType}</span>}
                {isMultiple && <span style={{ border: '1.5px solid var(--color-border)', borderRadius: 4, padding: '2px 8px', color: 'var(--color-text-sub)', fontWeight: 700 }}>複数選択</span>}
              </div>

              {/* 問題文 */}
              <p style={{ fontSize: 15, lineHeight: 1.7, marginBottom: 20, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {question.questionText}
              </p>

              {/* 選択肢 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
                {choices.map((c, idx) => (
                  <button
                    key={idx}
                    onClick={() => toggle(c)}
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: 10, textAlign: 'left',
                      padding: '10px 14px', borderRadius: 8, cursor: answered ? 'default' : 'pointer',
                      border: `1.5px solid ${getChoiceColor(c, idx)}`,
                      background: getChoiceBg(c, idx),
                      transition: 'all 0.15s',
                    }}
                  >
                    <span style={{ fontWeight: 700, fontSize: 13, color: getChoiceColor(c, idx), flexShrink: 0, minWidth: 18 }}>{CHOICE_LABELS_P[idx]}.</span>
                    <span style={{ fontSize: 14, lineHeight: 1.5, wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>{stripLabelP(c)}</span>
                    {answered && isCorrectChoice(c, idx) && <span style={{ marginLeft: 'auto', color: 'var(--color-success)', flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}><IconCheck size={15} /></span>}
                    {answered && selected.includes(c) && !isCorrectChoice(c, idx) && <span style={{ marginLeft: 'auto', color: 'var(--color-danger)', flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}><IconCircleX size={15} /></span>}
                  </button>
                ))}
              </div>

              {/* 回答ボタン or リセット */}
              <div style={{ display: 'flex', gap: 8, marginBottom: answered ? 20 : 0 }}>
                {!answered ? (
                  <button
                    onClick={() => { if (selected.length > 0) setAnswered(true); }}
                    disabled={selected.length === 0}
                    style={{ padding: '10px 24px', background: selected.length > 0 ? 'var(--color-accent)' : 'var(--color-border)', color: selected.length > 0 ? 'var(--color-btn-primary-text)' : 'var(--color-text-light)', border: 'none', borderRadius: 'var(--border-radius-md)', fontWeight: 700, cursor: selected.length > 0 ? 'pointer' : 'default', fontSize: 14 }}
                  >
                    回答する
                  </button>
                ) : (
                  <button
                    onClick={() => { setSelected([]); setAnswered(false); }}
                    style={{ padding: '8px 18px', background: 'none', border: '1.5px solid var(--color-primary)', color: 'var(--color-primary)', borderRadius: 'var(--border-radius-md)', fontWeight: 700, cursor: 'pointer', fontSize: 13 }}
                  >
                    リセット
                  </button>
                )}
              </div>

              {/* 解説（ユーザー画面の結果パネルを再現：色付きフィードバック＋正解サマリ＋選択肢別解説） */}
              {answered && (
                <div style={{
                  background: isAllCorrect ? 'var(--color-feedback-correct-bg)' : 'var(--color-feedback-incorrect-bg)',
                  borderLeft: `8px solid ${isAllCorrect ? 'var(--color-success)' : 'var(--color-danger)'}`,
                  padding: '16px 20px', borderRadius: 'var(--border-radius-sm)',
                }}>
                  <h3 style={{ margin: '0 0 8px', fontSize: 15, color: isAllCorrect ? 'var(--color-success)' : 'var(--color-danger)' }}>
                    {isAllCorrect ? '正解' : '不正解'}
                  </h3>
                  <p style={{ margin: '0 0 12px', fontSize: 14 }}>
                    <strong>正解: </strong>
                    {correctAnswers.map((ca) => {
                      const si = choices.findIndex(c => stripLabelP(c) === stripLabelP(ca));
                      return si >= 0 ? `${CHOICE_LABELS_P[si]}. ${stripLabelP(ca)}` : stripLabelP(ca);
                    }).join(' / ')}
                  </p>
                  <div style={{ fontSize: 14, lineHeight: 1.6 }}>
                    <strong>解説</strong>
                    {(() => {
                      const items = choices.map((_, i) => ({
                        i, label: CHOICE_LABELS_P[i],
                        isCorrect: correctIndices.includes(i),
                        expl: choiceExplanations[i] ?? '',
                      }));
                      const sorted = [...items.filter(x => x.isCorrect), ...items.filter(x => !x.isCorrect)];
                      if (choiceExplanations.length > 0) {
                        return (
                          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {sorted.map(item => (
                              <div key={item.i} style={{ wordBreak: 'break-word' }}>
                                <span style={{ fontWeight: 700, color: item.isCorrect ? 'var(--color-success)' : 'var(--color-text-sub)', marginRight: 4 }}>
                                  {item.label}.{item.isCorrect ? ' (正解)' : ''}
                                </span>
                                <span style={{ whiteSpace: 'pre-wrap' }}>{item.expl}</span>
                              </div>
                            ))}
                          </div>
                        );
                      }
                      return <div style={{ marginTop: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{question.explanation}</div>;
                    })()}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Admin() {
  // 2段階認証の設定欄に出す自分のメール（ID トークンから）
  const [myEmail, setMyEmail] = useState('');
  useEffect(() => {
    fetchAuthSession().then(sess => setMyEmail(String(sess.tokens?.idToken?.payload?.email ?? ''))).catch(() => {});
  }, []);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  useEffect(() => {
    const h = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);
  // サブタブ行(.admin-tabs)は9タブ分あり、モバイル幅には収まらず横スクロールで見せている
  // （src/index.css の .admin-tabs で overflow-x:auto 済み）が、スクロールバーが出ない
  // モバイルブラウザでは「続きがある」ことに気づけず、末尾のタブが見切れて見えていた。
  // チートシート/目標資格オーバーレイのレベルタブと同じ対策（右端フェード）を適用する。
  const adminTabsHint = useHorizontalScrollHint(isMobile);
  // 直前に開いていたタブ/画面を復元する（不正・廃止済みのキーは無視して既定へ）
  const [tab, setTab] = useState<Tab>(() => {
    try {
      const saved = localStorage.getItem('adminActiveTab');
      if (saved && Object.prototype.hasOwnProperty.call(TAB_LABELS, saved)) return saved as Tab;
    } catch {}
    return 'questions';
  });
  useEffect(() => {
    try { localStorage.setItem('adminActiveTab', tab); } catch {}
  }, [tab]);
  // 選択中のサブタブが横スクロール行内で見切れないよう位置を合わせる（資格カード行と同じ方式）
  useEffect(() => {
    const row = adminTabsHint.ref.current;
    const btn = row?.querySelector<HTMLElement>(`[data-tab="${tab}"]`);
    if (!row || !btn) return;
    const bLeft = btn.offsetLeft;
    const bRight = bLeft + btn.offsetWidth;
    const viewLeft = row.scrollLeft;
    if (bRight > viewLeft + row.clientWidth) {
      row.scrollTo({ left: bRight - row.clientWidth + 8, behavior: 'smooth' });
    } else if (bLeft < viewLeft) {
      row.scrollTo({ left: Math.max(0, bLeft - 8), behavior: 'smooth' });
    }
  }, [tab, isMobile, adminTabsHint.ref]);
  const [adminError, setAdminError] = useState<string | null>(null);
  const { customColors, customColorsEnabled, applyColors, setCustomColorsEnabled } = useTheme();
  const [themeColors, setThemeColors] = useState<CustomColors>(() => ({ ...DEFAULT_COLORS, ...customColors }));
  const [themeEnabled, setThemeEnabled] = useState(customColorsEnabled);
  const [themeSaving, setThemeSaving] = useState(false);
  const [themeSaved, setThemeSaved] = useState(false);

  // サイト情報
  const [aboutSections, setAboutSections] = useState<Record<string, string>>({ privacy: '', terms: '', operator: '' });
  const [aboutSaving, setAboutSaving] = useState(false);
  const [aboutSaved, setAboutSaved] = useState(false);
  const [aboutLoading, setAboutLoading] = useState(false);

  // データ削除
  const [delEmail, setDelEmail] = useState('');
  const [delExecuting, setDelExecuting] = useState(false);
  const [delDone, setDelDone] = useState(false);
  const [delError, setDelError] = useState('');

  // 合格コメント
  const [passComments, setPassComments] = useState<Record<string, string>>({});
  const [passCommentExam, setPassCommentExam] = useState('SAA');
  const [passCommentText, setPassCommentText] = useState('');
  const [passCommentSaving, setPassCommentSaving] = useState(false);
  const [passCommentSaved, setPassCommentSaved] = useState(false);

  // 生成状況
  const [growthData, setGrowthData] = useState<{ dates: string[]; created: number[]; verified: number[] } | null>(null);
  const [growthLoading, setGrowthLoading] = useState(false);

  // 管理者設定
  const [adminEmails, setAdminEmails] = useState<string[]>([]);
  const [adminEmailsLoading, setAdminEmailsLoading] = useState(false);
  const [adminEmailsError, setAdminEmailsError] = useState<string | null>(null);
  const [newAdminEmail, setNewAdminEmail] = useState('');
  const [adminSaving, setAdminSaving] = useState(false);
  const [adminSaved, setAdminSaved] = useState(false);

  // 問題管理
  const [questions, setQuestions] = useState<Question[]>([]);
  const [examFilter, setExamFilter] = useState('ALL');
  const [tagFilter, setTagFilter] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [domainFilter, setDomainFilter] = useState('');
  const [keyword, setKeyword] = useState('');
  const [keywordInput, setKeywordInput] = useState('');
  const [sortBy, setSortBy] = useState<'id_asc' | 'updatedAt_desc' | 'updatedAt_asc' | 'validityCheckedAt_desc' | 'validityCheckedAt_asc' | 'createdAt_desc' | 'createdAt_asc' | 'correctRate_asc' | 'correctRate_desc' | 'attempts_desc' | 'attempts_asc'>('id_asc');
  const [loadingQ, setLoadingQ] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<Record<string, Question>>({});
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);
  const [totalQuestions, setTotalQuestions] = useState(0);
  const PAGE_SIZE = 100;

  // 通報
  const [reports, setReports] = useState<Report[]>([]);
  const [loadingR, setLoadingR] = useState(false);

  // 問題インポート
  const [importExamType, setImportExamType] = useState('SAA');
  const [importJson, setImportJson] = useState('');
  const [importParsed, setImportParsed] = useState<ImportQuestion[] | null>(null);
  const [importError, setImportError] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ count: number; ids: string[] } | null>(null);
  const [importMismatchTypes, setImportMismatchTypes] = useState<string[]>([]);
  const [promptTopic, setPromptTopic] = useState('');
  const [promptCount, setPromptCount] = useState('5');
  const [promptCopied, setPromptCopied] = useState(false);

  // コラム管理
  const [tips, setTips] = useState<Tip[]>([]);
  const [loadingT, setLoadingT] = useState(false);
  const [editingTip, setEditingTip] = useState<Tip | null>(null);
  const [tipForm, setTipForm] = useState({ examType: 'ALL', title: '', content: '' });
  const [showTipForm, setShowTipForm] = useState(false);
  const [tipImportJson, setTipImportJson] = useState('');
  const [tipImportParsed, setTipImportParsed] = useState<{ examType?: string; title: string; content: string }[] | null>(null);
  const [tipImportError, setTipImportError] = useState('');
  const [tipImporting, setTipImporting] = useState(false);
  const [tipImportResult, setTipImportResult] = useState<number | null>(null);
  const [tipImportExamType, setTipImportExamType] = useState('ALL');
  const [showTipImport, setShowTipImport] = useState(false);
  const [tipPromptTopic, setTipPromptTopic] = useState('');
  const [tipPromptCount, setTipPromptCount] = useState('5');
  const [tipPromptExamType, setTipPromptExamType] = useState('SAA');
  const [tipPromptCopied, setTipPromptCopied] = useState(false);
  const [showTipPrompt, setShowTipPrompt] = useState(false);

  // コラムのネタ（gcs スクリプトで裏取り→コラム化する種）
  const [columnIdeas, setColumnIdeas] = useState<any[]>([]);
  const [loadingCI, setLoadingCI] = useState(false);
  const [ciText, setCiText] = useState('');
  const [ciExamType, setCiExamType] = useState('ALL');
  const [ciNote, setCiNote] = useState('');
  const [ciSaving, setCiSaving] = useState(false);
  const [ciShowUsed, setCiShowUsed] = useState(false);

  // メッセージ
  const [messages, setMessages] = useState<ContactMessage[]>([]);
  const [loadingMsg, setLoadingMsg] = useState(false);

  // 今日のサービス
  const [dailyServices, setDailyServices] = useState<DailyServiceItem[]>([]);
  const [loadingDS, setLoadingDS] = useState(false);
  const [editingDS, setEditingDS] = useState<DailyServiceItem | null>(null);
  const [showDSForm, setShowDSForm] = useState(false);
  const emptyDSForm = { name: '', shortName: '', category: '', icon: '☁️', description: '', trivia: '', docUrl: '', order: 0, isActive: true };
  const [dsForm, setDsForm] = useState(emptyDSForm);
  const [dsSort, setDsSort] = useState('order_asc');
  // 一覧タブの並び順（タブごとに独立）
  const [reportSort, setReportSort] = useState('reportedAt_desc');
  const [tipSort, setTipSort] = useState('title_asc');
  const [ciSort, setCiSort] = useState('createdAt_desc');
  const [relSort, setRelSort] = useState('date_desc');
  const [annSort, setAnnSort] = useState('createdAt_desc');
  const [msgSort, setMsgSort] = useState('sentAt_desc');
  // 画像パスのアイコンが実際に読み込めなかった serviceId。
  // DB に icon 文字列があってもファイルが未デプロイなら 404 になるので、
  // 実表示の onError でしか検出できない。抽選対象から外す判断の材料として出す。
  const [dsBrokenIcons, setDsBrokenIcons] = useState<Set<string>>(new Set());

  // リリースノート管理
  const [releases, setReleases] = useState<Release[]>([]);
  const [loadingRel, setLoadingRel] = useState(false);
  const [editingRelease, setEditingRelease] = useState<Release | null>(null);
  const [releaseForm, setReleaseForm] = useState({ date: '', title: '', body: '' });
  const [showReleaseForm, setShowReleaseForm] = useState(false);

  // お知らせ管理
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [loadingAnn, setLoadingAnn] = useState(false);
  const [editingAnnouncement, setEditingAnnouncement] = useState<Announcement | null>(null);
  const [annForm, setAnnForm] = useState({ title: '', body: '' });
  const [showAnnForm, setShowAnnForm] = useState(false);

  const fetchSummary = useCallback(async (sd?: string) => {
    try {
      const params = sd ? `?sinceDate=${encodeURIComponent(sd)}` : '';
      const res = await adminFetch(`${API_ENDPOINT}/admin/questions/summary${params}`);
      if (!res.ok) return;
      const data = await res.json();
      setExamCounts(data.examCounts || {});
      setDomainCountsByExam(data.domainCounts || {});
      if (data.validityCheckedCount != null) setValidityCheckedCount(data.validityCheckedCount);
      if (data.followUpCount        != null) setFollowUpCount(data.followUpCount);
      setFollowUpByCount(data.followUpByCount ?? null);
      setValidityCheckedSinceCount(data.validityCheckedSinceCount ?? null);
      setFollowUpSinceCount(data.followUpSinceCount ?? null);
      setCreatedSinceCount(data.createdSinceCount ?? null);
      setExerciseCounts(data.exerciseCounts || {});
      setExerciseCorrectCounts(data.exerciseCorrectCounts || {});
    } catch (err) {
      console.error(err);
    }
  }, []);

  const fetchQuestions = useCallback(async (page = 0) => {
    setLoadingQ(true);
    setAdminError(null);
    try {
      const params = new URLSearchParams();
      if (examFilter !== 'ALL') params.set('examType', examFilter);
      if (keyword.trim()) params.set('keyword', keyword.trim());
      if (tagFilter.trim()) params.set('tag', tagFilter.trim());
      // domainFilter はドメイン名。正準キー（index）に変換して送信する。
      if (domainFilter) { const di = toDomainIndex(examFilter, domainFilter); if (di >= 0) params.set('domain', String(di)); }
      params.set('page', String(page));
      params.set('pageSize', String(PAGE_SIZE));
      params.set('sort', sortBy);
      const res = await adminFetch(`${API_ENDPOINT}/admin/questions?${params}`);
      if (res.status === 401 || res.status === 403) {
        setAdminError('管理者アカウントでログインしてください。');
        setQuestions([]);
        return;
      }
      const data = await res.json();
      const items: Question[] = data.items || [];
      setQuestions(items);
      setCurrentPage(data.page ?? page);
      setTotalQuestions(data.total ?? items.length);
    } catch (err) {
      console.error(err);
      setAdminError('APIの接続に失敗しました。');
    } finally {
      setLoadingQ(false);
    }
  }, [examFilter, keyword, tagFilter, domainFilter, sortBy, PAGE_SIZE]);


  const fetchReports = useCallback(async () => {
    setLoadingR(true);
    try {
      const res = await adminFetch(`${API_ENDPOINT}/admin/reports`);
      const data = await res.json();
      setReports(data.items || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingR(false);
    }
  }, []);

  const deleteReport = async (reportId: string, questionId: string) => {
    try {
      await adminFetch(`${API_ENDPOINT}/admin/reports/${reportId}?questionId=${encodeURIComponent(questionId)}`, { method: 'DELETE' });
      setReports(prev => prev.filter(r => r.reportId !== reportId));
    } catch (err) { console.error(err); }
  };

  const fetchTips = useCallback(async () => {
    setLoadingT(true);
    try {
      const res = await adminFetch(`${API_ENDPOINT}/admin/tips`);
      const data = await res.json();
      setTips(data.items || []);
    } catch (err) { console.error(err); } finally { setLoadingT(false); }
  }, []);

  const fetchColumnIdeas = useCallback(async () => {
    setLoadingCI(true);
    try {
      const res = await adminFetch(`${API_ENDPOINT}/admin/column-ideas`);
      const data = await res.json();
      setColumnIdeas(data.items || []);
    } catch (err) { console.error(err); } finally { setLoadingCI(false); }
  }, []);

  const addColumnIdea = async () => {
    if (!ciText.trim()) return;
    setCiSaving(true);
    try {
      await adminFetch(`${API_ENDPOINT}/admin/column-ideas`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: ciText.trim(), examType: ciExamType, note: ciNote.trim() }),
      });
      setCiText(''); setCiNote('');
      fetchColumnIdeas();
    } catch (err) { console.error(err); } finally { setCiSaving(false); }
  };

  const setColumnIdeaStatus = async (ideaId: string, status: 'pending' | 'used') => {
    try {
      await adminFetch(`${API_ENDPOINT}/admin/column-ideas/${ideaId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      setColumnIdeas(prev => prev.map(i => i.ideaId === ideaId ? { ...i, status } : i));
    } catch (err) { console.error(err); }
  };

  const deleteColumnIdea = async (ideaId: string) => {
    if (!window.confirm('このネタを完全に削除しますか？')) return;
    try {
      await adminFetch(`${API_ENDPOINT}/admin/column-ideas/${ideaId}`, { method: 'DELETE' });
      setColumnIdeas(prev => prev.filter(i => i.ideaId !== ideaId));
    } catch (err) { console.error(err); }
  };

  const fetchReleases = useCallback(async () => {
    setLoadingRel(true);
    try {
      const res = await adminFetch(`${API_ENDPOINT}/admin/releases`);
      const data = await res.json();
      setReleases(data.items || []);
    } catch (err) { console.error(err); } finally { setLoadingRel(false); }
  }, []);

  const fetchAnnouncements = useCallback(async () => {
    setLoadingAnn(true);
    try {
      const res = await adminFetch(`${API_ENDPOINT}/admin/announcements`);
      const data = await res.json();
      setAnnouncements(data.items || []);
    } catch (err) { console.error(err); } finally { setLoadingAnn(false); }
  }, []);

  const fetchMessages = useCallback(async () => {
    setLoadingMsg(true);
    try {
      const res = await adminFetch(`${API_ENDPOINT}/admin/messages`);
      const data = await res.json();
      setMessages(data.items || []);
    } catch (err) { console.error(err); } finally { setLoadingMsg(false); }
  }, []);

  const fetchDailyServices = useCallback(async () => {
    setLoadingDS(true);
    try {
      const res = await adminFetch(`${API_ENDPOINT}/admin/daily-services`);
      const data = await res.json();
      setDailyServices(data.items || []);
    } catch (err) { console.error(err); } finally { setLoadingDS(false); }
  }, []);

  const saveDailyService = async () => {
    if (!dsForm.name.trim() || !dsForm.description.trim()) {
      alert('サービス名と説明は必須です');
      return;
    }
    try {
      if (editingDS) {
        await adminFetch(`${API_ENDPOINT}/admin/daily-services/${editingDS.serviceId}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(dsForm),
        });
      } else {
        await adminFetch(`${API_ENDPOINT}/admin/daily-services`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(dsForm),
        });
      }
      setShowDSForm(false);
      setEditingDS(null);
      setDsForm(emptyDSForm);
      fetchDailyServices();
    } catch (err) { console.error(err); }
  };

  const deleteDailyService = async (serviceId: string) => {
    if (!window.confirm('このサービスを削除しますか？')) return;
    try {
      await adminFetch(`${API_ENDPOINT}/admin/daily-services/${serviceId}`, { method: 'DELETE' });
      setDailyServices(prev => prev.filter(s => s.serviceId !== serviceId));
    } catch (err) { console.error(err); }
  };


  const handleDeleteMessage = async (m: ContactMessage) => {
    if (!window.confirm('このメッセージを削除しますか？')) return;
    try {
      await adminFetch(`${API_ENDPOINT}/admin/messages/${m.messageId}`, { method: 'DELETE' });
      setMessages(prev => prev.filter(x => x.messageId !== m.messageId));
    } catch (err) { console.error(err); }
  };

  const handleSaveRelease = async () => {
    if (!releaseForm.date || !releaseForm.title.trim() || !releaseForm.body.trim()) return;
    try {
      if (editingRelease) {
        await adminFetch(`${API_ENDPOINT}/admin/releases/${editingRelease.releaseId}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(releaseForm),
        });
      } else {
        await adminFetch(`${API_ENDPOINT}/admin/releases`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(releaseForm),
        });
      }
      setShowReleaseForm(false);
      setEditingRelease(null);
      setReleaseForm({ date: '', title: '', body: '' });
      fetchReleases();
    } catch (err) { console.error(err); }
  };

  const handleDeleteRelease = async (r: Release) => {
    if (!window.confirm(`「${r.title}」を削除しますか？`)) return;
    try {
      await adminFetch(`${API_ENDPOINT}/admin/releases/${r.releaseId}`, { method: 'DELETE' });
      setReleases(prev => prev.filter(x => x.releaseId !== r.releaseId));
    } catch (err) { console.error(err); }
  };

  const handleSaveAnnouncement = async () => {
    if (!annForm.title.trim() || !annForm.body.trim()) return;
    try {
      if (editingAnnouncement) {
        await adminFetch(`${API_ENDPOINT}/admin/announcements/${editingAnnouncement.announcementId}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(annForm),
        });
      } else {
        await adminFetch(`${API_ENDPOINT}/admin/announcements`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(annForm),
        });
      }
      setShowAnnForm(false);
      setEditingAnnouncement(null);
      setAnnForm({ title: '', body: '' });
      fetchAnnouncements();
    } catch (err) { console.error(err); }
  };

  const handleSaveAndPublishAnnouncement = async () => {
    if (!annForm.title.trim() || !annForm.body.trim()) return;
    try {
      const res = await adminFetch(`${API_ENDPOINT}/admin/announcements`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(annForm),
      });
      const { announcementId } = await res.json();
      await adminFetch(`${API_ENDPOINT}/admin/announcements/${announcementId}/publish`, { method: 'POST' });
      setShowAnnForm(false);
      setAnnForm({ title: '', body: '' });
      fetchAnnouncements();
    } catch (err) { console.error(err); }
  };

  const handlePublishAnnouncement = async (a: Announcement) => {
    try {
      await adminFetch(`${API_ENDPOINT}/admin/announcements/${a.announcementId}/publish`, { method: 'POST' });
      fetchAnnouncements();
    } catch (err) { console.error(err); }
  };

  const handleUnpublishAnnouncement = async (a: Announcement) => {
    if (!window.confirm(`「${a.title}」を取り下げますか？`)) return;
    try {
      await adminFetch(`${API_ENDPOINT}/admin/announcements/${a.announcementId}/unpublish`, { method: 'POST' });
      fetchAnnouncements();
    } catch (err) { console.error(err); }
  };

  const handleDeleteAnnouncement = async (a: Announcement) => {
    if (!window.confirm(`「${a.title}」を削除しますか？`)) return;
    try {
      await adminFetch(`${API_ENDPOINT}/admin/announcements/${a.announcementId}`, { method: 'DELETE' });
      setAnnouncements(prev => prev.filter(x => x.announcementId !== a.announcementId));
    } catch (err) { console.error(err); }
  };

  const [flaggedQuestions, setFlaggedQuestions] = useState<FlaggedQuestion[]>([]);
  const [loadingFlagged, setLoadingFlagged] = useState(false);
  const [validityFilter, setValidityFilter] = useState<'all' | 'fixed' | 'hidden' | 'audit' | 'review'>('review');
  const [validityTotalCount, setValidityTotalCount] = useState(0);
  const [scanExamFilter, setScanExamFilter] = useState<string>('ALL');
  const [scanSort, setScanSort] = useState<'date_desc' | 'date_asc'>('date_desc');
  // ページング（全件返すと 17MB になり Lambda の 6MB 上限を超えるため）
  const [flaggedHasMore, setFlaggedHasMore] = useState(false);
  const [flaggedMatched, setFlaggedMatched] = useState(0);
  const [flaggedChecked, setFlaggedChecked] = useState(0);
  const [flaggedFixedCount, setFlaggedFixedCount] = useState(0);
  const [flaggedAuditCount, setFlaggedAuditCount] = useState(0);
  const [flaggedReviewCount, setFlaggedReviewCount] = useState(0);
  const [loadingMoreFlagged, setLoadingMoreFlagged] = useState(false);
  const FLAGGED_PAGE_SIZE = 100;

  // 問題数カウント
  const [examCounts, setExamCounts] = useState<Record<string, number>>({});
  const [domainCountsByExam, setDomainCountsByExam] = useState<Record<string, Record<string, number>>>({});
  const [validityCheckedCount, setValidityCheckedCount] = useState<number | null>(null);
  const [followUpCount, setFollowUpCount] = useState<number | null>(null);
  const [followUpByCount, setFollowUpByCount] = useState<Record<string, number> | null>(null);
  const [sinceDate, setSinceDate] = useState('');
  const [validityCheckedSinceCount, setValidityCheckedSinceCount] = useState<number | null>(null);
  const [followUpSinceCount, setFollowUpSinceCount] = useState<number | null>(null);
  const [createdSinceCount, setCreatedSinceCount] = useState<number | null>(null);
  const [exerciseCounts, setExerciseCounts] = useState<Record<string, number>>({});
  const [exerciseCorrectCounts, setExerciseCorrectCounts] = useState<Record<string, number>>({});

  // 問題プレビュー
  const [showPreview, setShowPreview] = useState(false);
  const [previewInitId, setPreviewInitId] = useState('');

  // 問題IDコピー
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyQuestionId = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    navigator.clipboard.writeText(id).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(prev => prev === id ? null : prev), 1500);
    });
  };

  // 問題編集
  const EMPTY_EDIT_FORM: EditForm = { examType: 'SAA', domain: '', questionText: '', questionTextEn: '', choices: ['', '', '', ''], choicesEn: ['', '', '', ''], correctAnswers: [], explanation: '', explanationEn: '', isMultiple: false };
  const [editingQuestion, setEditingQuestion] = useState<{ id: string } | null>(null);
  const [editForm, setEditForm] = useState<EditForm>(EMPTY_EDIT_FORM);
  const [saving, setSaving] = useState(false);

  const openEdit = async (q: Question | FlaggedQuestion) => {
    setEditingQuestion({ id: q.questionId });
    setEditForm(EMPTY_EDIT_FORM);
    // ALLスキャン時はexplanationが省略されているため個別取得する
    let full: any = q;
    if ((q as Question).explanation === undefined) {
      try {
        const res = await adminFetch(`${API_ENDPOINT}/admin/questions/${q.questionId}`);
        if (res.ok) full = await res.json();
      } catch {}
    }
    const choices = full.choices || ['', '', '', ''];
    // domain は DB では整数 index。フォームのドロップダウンはドメイン名で扱うため変換する。
    const domainName = typeof full.domain === 'number'
      ? (EXAM_DOMAINS[full.examType]?.[full.domain] ?? '')
      : (full.domain || '');
    setEditForm({
      examType: full.examType,
      domain: domainName,
      questionText: full.questionText,
      questionTextEn: full.questionTextEn || '',
      choices,
      choicesEn: full.choicesEn || choices.map(() => ''),
      correctAnswers: full.correctAnswers || [],
      explanation: full.explanation || '',
      explanationEn: full.explanationEn || '',
      isMultiple: full.isMultiple || false,
    });
  };

  const handleSaveQuestion = async () => {
    if (!editingQuestion) return;
    setSaving(true);
    try {
      const payload: any = { ...editForm, updatedAt: new Date().toISOString() };
      if (!payload.questionTextEn?.trim()) delete payload.questionTextEn;
      if (!payload.explanationEn?.trim()) delete payload.explanationEn;
      const choicesEn = payload.choicesEn?.filter((c: string) => c.trim());
      if (!choicesEn?.length) delete payload.choicesEn;
      const res = await adminFetch(`${API_ENDPOINT}/admin/questions/${editingQuestion.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('保存失敗');
      const updated = { ...payload, questionId: editingQuestion.id };
      setQuestions(prev => prev.map(q => q.questionId === editingQuestion.id ? { ...q, ...updated } : q));
      setFlaggedQuestions(prev => prev.map(q => q.questionId === editingQuestion.id ? { ...q, ...updated } : q));
      setEditingQuestion(null);
    } catch (err) {
      alert('保存に失敗しました');
    } finally {
      setSaving(false);
    }
  };

  const updateChoice = (index: number, value: string) => {
    const oldChoice = editForm.choices[index];
    const newChoices = [...editForm.choices];
    newChoices[index] = value;
    const newCorrect = editForm.correctAnswers.map(c => c === oldChoice ? value : c);
    setEditForm(f => ({ ...f, choices: newChoices, correctAnswers: newCorrect }));
  };

  // 絞り込み・並べ替えはサーバ側。ページ内だけに効くと件数表示と食い違うため。
  const flaggedQuery = (
    filter: 'all' | 'fixed' | 'hidden' | 'audit' | 'review',
    exam: string,
    sort: 'date_desc' | 'date_asc',
    offset: number,
  ) => new URLSearchParams({
    filter, sort, examType: exam,
    limit: String(FLAGGED_PAGE_SIZE), offset: String(offset),
  }).toString();

  const applyFlaggedMeta = (data: any) => {
    setValidityTotalCount(data.totalCount || 0);
    setFlaggedMatched(data.matchedCount || 0);
    setFlaggedChecked(data.checkedCount || 0);
    setFlaggedFixedCount(data.fixedCount || 0);
    setFlaggedAuditCount(data.auditCount || 0);
    setFlaggedReviewCount(data.reviewCount || 0);
    setFlaggedHasMore(!!data.hasMore);
  };

  const fetchFlagged = async (
    filter: 'all' | 'fixed' | 'hidden' | 'audit' | 'review' = validityFilter,
    exam: string = scanExamFilter,
    sort: 'date_desc' | 'date_asc' = scanSort,
  ) => {
    setLoadingFlagged(true);
    try {
      const res = await adminFetch(`${API_ENDPOINT}/admin/questions/flagged?${flaggedQuery(filter, exam, sort, 0)}`);
      const data = await res.json();
      setFlaggedQuestions(data.items || []);
      applyFlaggedMeta(data);
    } catch (err) { console.error(err); }
    setLoadingFlagged(false);
  };

  const fetchMoreFlagged = async () => {
    setLoadingMoreFlagged(true);
    try {
      const res = await adminFetch(
        `${API_ENDPOINT}/admin/questions/flagged?${flaggedQuery(validityFilter, scanExamFilter, scanSort, flaggedQuestions.length)}`);
      const data = await res.json();
      setFlaggedQuestions(prev => [...prev, ...(data.items || [])]);
      applyFlaggedMeta(data);
    } catch (err) { console.error(err); }
    setLoadingMoreFlagged(false);
  };

  const handleApplyFix = async (q: FlaggedQuestion) => {
    if (!q.fixProposalJson) return;
    const fix: FixProposal = JSON.parse(q.fixProposalJson);
    if (!window.confirm('修正案を適用しますか？\n問題文・選択肢・解説が上書きされます。')) return;
    await adminFetch(`${API_ENDPOINT}/admin/questions/${q.questionId}/apply-fix`, { method: 'POST' });
    setFlaggedQuestions(prev => prev.map(x =>
      x.questionId === q.questionId
        ? { ...x, fixProposalJson: undefined, validityNote: '修正適用済',
            ...(x.humanReviewRequestedAt ? { humanReviewRequestedAt: undefined, reviewReason: undefined, isHidden: false } : {}),
            ...(fix.questionText  ? { questionText: fix.questionText }   : {}),
            ...(fix.choices       ? { choices: fix.choices }             : {}),
            ...(fix.correctAnswers? { correctAnswers: fix.correctAnswers }: {}),
            ...(fix.explanation   ? { explanation: fix.explanation }     : {}),
          }
        : x
    ));
    if (q.humanReviewRequestedAt) setFlaggedReviewCount(c => Math.max(0, c - 1));
  };

  const handleRejectFix = async (q: FlaggedQuestion) => {
    await adminFetch(`${API_ENDPOINT}/admin/questions/${q.questionId}/reject-fix`, { method: 'POST' });
    setFlaggedQuestions(prev => prev.map(x =>
      x.questionId === q.questionId
        ? { ...x, fixProposalJson: undefined, ...(x.humanReviewRequestedAt ? { humanReviewRequestedAt: undefined, reviewReason: undefined, isHidden: false } : {}) }
        : x
    ));
    if (q.humanReviewRequestedAt) setFlaggedReviewCount(c => Math.max(0, c - 1));
  };

  // 人の確認（抜き取り検査・AI の削除提案）。ok=問題なし→表示 / ng=誤りあり→非表示のまま
  const handleHumanReview = async (q: FlaggedQuestion, result: 'ok' | 'ng') => {
    const note = result === 'ng' ? (window.prompt('どこが誤りか（任意。検証の観点を足すときの材料になります）') ?? '') : '';
    const res = await adminFetch(`${API_ENDPOINT}/admin/questions/${q.questionId}/human-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result, note }),
    });
    if (!res.ok) { window.alert('記録できませんでした'); return; }
    setFlaggedQuestions(prev => prev.map(x =>
      x.questionId === q.questionId ? { ...x, humanReviewRequestedAt: undefined, reviewReason: undefined, isHidden: result === 'ng' } : x
    ));
    setFlaggedReviewCount(c => Math.max(0, c - 1));
  };

  const handleVisibility = async (q: FlaggedQuestion, hide: boolean) => {
    await adminFetch(`${API_ENDPOINT}/admin/questions/${q.questionId}/visibility`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isHidden: hide }),
    });
    setFlaggedQuestions(prev => prev.map(x =>
      x.questionId === q.questionId ? { ...x, isHidden: hide } : x
    ));
  };

  useEffect(() => {
    setCurrentPage(0);
    fetchQuestions(0);
    setSelectedIds(new Set());
    if (examFilter === 'ALL') fetchSummary(sinceDate || undefined);
  }, [examFilter, keyword, tagFilter, domainFilter, sortBy]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (examFilter === 'ALL') fetchSummary(sinceDate || undefined);
  }, [sinceDate]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tab === 'reports') fetchReports(); }, [tab]);
  useEffect(() => { if (tab === 'tips') fetchTips(); }, [tab]);
  useEffect(() => { if (tab === 'columnideas') fetchColumnIdeas(); }, [tab]);
  useEffect(() => { if (tab === 'releases') fetchReleases(); }, [tab]);
  useEffect(() => { if (tab === 'announcements') fetchAnnouncements(); }, [tab]);
  useEffect(() => { if (tab === 'scan') fetchFlagged(validityFilter); }, [tab]);
  useEffect(() => { if (tab === 'messages') fetchMessages(); }, [tab]);
  useEffect(() => { if (tab === 'dailyservice') fetchDailyServices(); }, [tab]);
  useEffect(() => { fetchDailyServices(); }, []); // pre-fetch for tab count
  useEffect(() => { if (tab === 'admins') fetchAdminEmails(); }, [tab]);
  useEffect(() => { if (tab === 'growth') fetchGrowthData(); }, [tab]);
  useEffect(() => { if (tab === 'about') fetchAboutContent(); }, [tab]);
  useEffect(() => {
    if (tab !== 'passcomments') return;
    fetch(`${API_ENDPOINT}/settings/pass-comments`)
      .then(r => r.json())
      .then(d => {
        const comments = d.comments ?? {};
        setPassComments(comments);
        // 関数形式で最新の passCommentExam を取得してテキストを設定
        setPassCommentExam(exam => {
          setPassCommentText(comments[exam] ?? '');
          return exam;
        });
      })
      .catch(() => {});
  }, [tab]);

  const fetchGrowthData = async () => {
    setGrowthLoading(true);
    try {
      const res = await fetch(`${API_ENDPOINT}/questions/growth-stats`);
      const json = await res.json();
      const daily = json.daily ?? {};
      const dates: string[] = (daily.dates ?? []).slice(-7);
      const allDates: string[] = daily.dates ?? [];
      const start = allDates.length - 7;
      setGrowthData({
        dates,
        created:  (daily.created  ?? []).slice(start),
        verified: (daily.verified ?? []).slice(start),
      });
    } catch {
      setGrowthData(null);
    } finally {
      setGrowthLoading(false);
    }
  };

  const fetchAdminEmails = async () => {
    setAdminEmailsLoading(true);
    setAdminEmailsError(null);
    try {
      const res = await adminFetch(`${API_ENDPOINT}/admin/settings/admins`);
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      setAdminEmails(data.emails ?? []);
    } catch {
      setAdminEmailsError('管理者リストの取得に失敗しました。Lambda のデプロイが必要な場合があります。');
    }
    setAdminEmailsLoading(false);
  };

  const saveAdminEmails = async (emails: string[]) => {
    setAdminSaving(true);
    setAdminSaved(false);
    try {
      await adminFetch(`${API_ENDPOINT}/admin/settings/admins`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails }),
      });
      setAdminEmails(emails);
      setAdminSaved(true);
      setTimeout(() => setAdminSaved(false), 3000);
    } catch { alert('保存に失敗しました'); }
    setAdminSaving(false);
  };

  const addAdminEmail = () => {
    const email = newAdminEmail.trim().toLowerCase();
    if (!email || !email.includes('@')) return;
    if (adminEmails.includes(email)) { setNewAdminEmail(''); return; }
    const next = [...adminEmails, email];
    setNewAdminEmail('');
    saveAdminEmails(next);
  };

  const removeAdminEmail = (email: string) => {
    saveAdminEmails(adminEmails.filter(e => e !== email));
  };

  const executeDeletion = async () => {
    if (!delEmail.trim()) return;
    if (!window.confirm(`${delEmail.trim()} のすべてのデータを削除します。この操作は取り消せません。\n\n続行しますか？`)) return;
    setDelExecuting(true);
    setDelError('');
    setDelDone(false);
    try {
      const res = await adminFetch(`${API_ENDPOINT}/admin/direct-delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: delEmail.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { setDelError(data.error || '削除に失敗しました'); setDelExecuting(false); return; }
      setDelDone(true);
    } catch { setDelError('通信エラーが発生しました'); }
    setDelExecuting(false);
  };

  const fetchAboutContent = async () => {
    setAboutLoading(true);
    try {
      const res = await fetch(`${API_ENDPOINT}/settings/about`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setAboutSections(prev => ({ ...prev, ...data.sections }));
    } catch {}
    setAboutLoading(false);
  };

  const saveAboutSection = async (key: string, value: string) => {
    setAboutSaving(true);
    setAboutSaved(false);
    try {
      const next = { ...aboutSections, [key]: value };
      await adminFetch(`${API_ENDPOINT}/admin/settings/about`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sections: next }),
      });
      setAboutSections(next);
      setAboutSaved(true);
      setTimeout(() => setAboutSaved(false), 3000);
    } catch { alert('保存に失敗しました'); }
    setAboutSaving(false);
  };

  const handleSaveTip = async () => {
    if (!tipForm.title.trim() || !tipForm.content.trim()) return;
    try {
      if (editingTip) {
        await adminFetch(`${API_ENDPOINT}/admin/tips/${editingTip.tipId}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(tipForm)
        });
      } else {
        await adminFetch(`${API_ENDPOINT}/admin/tips`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(tipForm)
        });
      }
      setShowTipForm(false);
      setEditingTip(null);
      setTipForm({ examType: 'ALL', title: '', content: '' });
      fetchTips();
    } catch (err) { console.error(err); }
  };

  const handleDeleteTip = async (tip: Tip) => {
    if (!window.confirm(`「${tip.title}」を削除しますか？`)) return;
    try {
      await adminFetch(`${API_ENDPOINT}/admin/tips/${tip.tipId}`, { method: 'DELETE' });
      setTips(prev => prev.filter(t => t.tipId !== tip.tipId));
    } catch (err) { console.error(err); }
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSelectedIds(new Set());
    fetchQuestions();
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedIds(
      selectedIds.size === questions.length && questions.length > 0
        ? new Set()
        : new Set(questions.map(q => q.questionId))
    );
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    if (!window.confirm(`${selectedIds.size}件の問題を削除しますか？\nこの操作は取り消せません。`)) return;
    setBulkDeleting(true);
    try {
      await Promise.all(
        Array.from(selectedIds).map(id =>
          adminFetch(`${API_ENDPOINT}/admin/questions/${id}`, { method: 'DELETE' })
        )
      );
      const deleted = selectedIds;
      setQuestions(prev => prev.filter(q => !deleted.has(q.questionId)));
      if (expandedId && deleted.has(expandedId)) setExpandedId(null);
      setSelectedIds(new Set());
    } catch (err) {
      alert('一部の削除に失敗しました');
    } finally {
      setBulkDeleting(false);
    }
  };

  const handleDelete = async (q: Question) => {
    if (!window.confirm(`「${q.questionId}」を削除しますか？\n\n${q.questionText.slice(0, 60)}…`)) return;
    setDeletingId(q.questionId);
    try {
      const res = await adminFetch(`${API_ENDPOINT}/admin/questions/${q.questionId}`, { method: 'DELETE' });
      if (res.ok) {
        setQuestions(prev => prev.filter(item => item.questionId !== q.questionId));
        if (expandedId === q.questionId) setExpandedId(null);
      } else {
        alert('削除に失敗しました');
      }
    } catch (err) {
      alert('削除に失敗しました');
    } finally {
      setDeletingId(null);
    }
  };

  const totalCount = useMemo(() => Object.values(examCounts).reduce((a, b) => a + b, 0), [examCounts]);

  const tabStyle = (t: Tab): React.CSSProperties => ({
    padding: '10px 16px',
    border: 'none',
    borderBottom: tab === t ? '3px solid var(--color-primary)' : '3px solid transparent',
    background: 'none',
    cursor: 'pointer',
    fontWeight: tab === t ? 700 : 400,
    color: tab === t ? 'var(--color-text-main)' : 'var(--color-text-sub)',
    fontSize: 'var(--font-size-md)',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  });

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: isMobile ? 'var(--spacing-md) var(--spacing-sm)' : 'var(--spacing-xl) var(--spacing-lg)', color: 'var(--color-text-main)' }} className="admin-container">

      {/* ── 問題編集モーダル ── */}
      {editingQuestion && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflowY: 'auto', padding: 'var(--spacing-xl) var(--spacing-md)' }}
          onClick={e => { if (e.target === e.currentTarget) setEditingQuestion(null); }}>
          <Card style={{ width: '100%', maxWidth: 'var(--modal-width-lg)', flexShrink: 0, boxShadow: 'var(--box-shadow-md)' }} padding="var(--spacing-xl)">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-lg)' }}>
              <h3 style={{ margin: 0, fontSize: 'var(--font-size-h3)', fontWeight: 700, color: 'var(--color-text-main)' }}>問題を編集</h3>
              <button onClick={() => setEditingQuestion(null)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--color-text-sub)', padding: '4px 8px', lineHeight: 0, display: 'inline-flex', alignItems: 'center' }}><IconClose /></button>
            </div>

            {/* 試験種別 */}
            <div style={{ marginBottom: 'var(--spacing-md)' }}>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', fontWeight: 700, marginBottom: 6 }}>試験種別</div>
              <div style={{ display: 'flex', gap: 'var(--spacing-sm)', flexWrap: 'wrap' }}>
                {EXAM_TYPES.map(t => (
                  <Button
                    key={t}
                    type="button"
                    variant={editForm.examType === t ? 'primary' : 'outline'}
                    size="sm"
                    onClick={() => setEditForm(f => ({ ...f, examType: t }))}
                  >
                    {t}
                  </Button>
                ))}
              </div>
            </div>

            {/* ドメイン（公式ガイドのドメインから選択。保存時に index へ正規化される） */}
            <div style={{ marginBottom: 'var(--spacing-md)' }}>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', fontWeight: 700, marginBottom: 6 }}>ドメイン</div>
              <select value={editForm.domain} onChange={e => setEditForm(f => ({ ...f, domain: e.target.value }))}
                style={{ width: '100%', padding: '8px 12px', border: '1px solid var(--color-border)', borderRadius: 'var(--border-radius-md)', fontSize: 'var(--font-size-base)', boxSizing: 'border-box', outline: 'none', background: 'var(--color-bg-white)' }}
                onFocus={e => e.currentTarget.style.borderColor = 'var(--color-primary)'}
                onBlur={e => e.currentTarget.style.borderColor = 'var(--color-border)'}>
                <option value="">（ドメインを選択）</option>
                {(EXAM_DOMAINS[editForm.examType] ?? []).map((d, i) => (
                  <option key={d} value={d}>{`D${i + 1}. ${d}`}</option>
                ))}
              </select>
            </div>

            {/* 問題文 */}
            <div style={{ marginBottom: 'var(--spacing-md)' }}>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', fontWeight: 700, marginBottom: 6 }}>問題文（日本語）</div>
              <textarea value={editForm.questionText} onChange={e => setEditForm(f => ({ ...f, questionText: e.target.value }))}
                rows={4}
                style={{ width: '100%', padding: '8px 12px', border: '1px solid var(--color-border)', borderRadius: 'var(--border-radius-md)', fontSize: 'var(--font-size-base)', resize: 'vertical', boxSizing: 'border-box', outline: 'none', lineHeight: 1.6 }}
                onFocus={e => e.currentTarget.style.borderColor = 'var(--color-primary)'}
                onBlur={e => e.currentTarget.style.borderColor = 'var(--color-border)'} />
            </div>

            {/* 問題文（英語） */}
            <div style={{ marginBottom: 'var(--spacing-md)' }}>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', fontWeight: 700, marginBottom: 6 }}>問題文（English・任意）</div>
              <textarea value={editForm.questionTextEn} onChange={e => setEditForm(f => ({ ...f, questionTextEn: e.target.value }))}
                rows={3} placeholder="English question text (optional)"
                style={{ width: '100%', padding: '8px 12px', border: '1px solid var(--color-border)', borderRadius: 'var(--border-radius-md)', fontSize: 'var(--font-size-base)', resize: 'vertical', boxSizing: 'border-box', outline: 'none', lineHeight: 1.6 }}
                onFocus={e => e.currentTarget.style.borderColor = 'var(--color-primary)'}
                onBlur={e => e.currentTarget.style.borderColor = 'var(--color-border)'} />
            </div>

            {/* 選択肢 */}
            <div style={{ marginBottom: 'var(--spacing-md)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', fontWeight: 700 }}>選択肢（チェックで正解）</div>
                <Button type="button" variant="outline" size="sm" onClick={() => setEditForm(f => ({ ...f, choices: [...f.choices, ''] }))}>
                  ＋ 追加
                </Button>
              </div>
              {editForm.choices.map((choice, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)', marginBottom: 'var(--spacing-xs)' }}>
                  <input type="checkbox"
                    checked={editForm.correctAnswers.includes(choice)}
                    onChange={() => setEditForm(f => ({
                      ...f,
                      correctAnswers: f.correctAnswers.includes(choice)
                        ? f.correctAnswers.filter(c => c !== choice)
                        : [...f.correctAnswers, choice]
                    }))}
                    style={{ width: 16, height: 16, cursor: 'pointer', flexShrink: 0, accentColor: 'var(--color-primary)' }} />
                  <input value={choice} onChange={e => updateChoice(i, e.target.value)}
                    placeholder={`選択肢 ${i + 1}`}
                    style={{ flex: 1, padding: '8px 12px', border: `1.5px solid ${editForm.correctAnswers.includes(choice) ? 'var(--color-success)' : 'var(--color-border)'}`, borderRadius: 'var(--border-radius-md)', fontSize: 'var(--font-size-sm)',
                      background: editForm.correctAnswers.includes(choice) ? 'var(--color-feedback-correct-bg)' : 'var(--color-bg-white)',
                      color: editForm.correctAnswers.includes(choice) ? 'var(--color-success)' : 'var(--color-text-main)', outline: 'none' }}
                    onFocus={e => { if (!editForm.correctAnswers.includes(choice)) e.currentTarget.style.borderColor = 'var(--color-primary)'; }}
                    onBlur={e => { if (!editForm.correctAnswers.includes(choice)) e.currentTarget.style.borderColor = 'var(--color-border)'; }} />
                  {editForm.choices.length > 2 && (
                    <button type="button" onClick={() => setEditForm(f => ({
                      ...f,
                      choices: f.choices.filter((_, idx) => idx !== i),
                      correctAnswers: f.correctAnswers.filter(c => c !== choice)
                    }))}
                      style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--color-text-light)', padding: '0 4px', flexShrink: 0, lineHeight: 0, display: 'inline-flex', alignItems: 'center' }}><IconClose /></button>
                  )}
                </div>
              ))}
            </div>

            {/* 選択肢（英語） */}
            <div style={{ marginBottom: 'var(--spacing-md)' }}>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', fontWeight: 700, marginBottom: 6 }}>選択肢（English・任意）</div>
              {editForm.choices.map((_, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)', marginBottom: 'var(--spacing-xs)' }}>
                  <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-light)', width: 20, flexShrink: 0 }}>{i + 1}.</span>
                  <input
                    value={editForm.choicesEn[i] ?? ''}
                    onChange={e => {
                      const next = [...editForm.choicesEn];
                      while (next.length <= i) next.push('');
                      next[i] = e.target.value;
                      setEditForm(f => ({ ...f, choicesEn: next }));
                    }}
                    placeholder={`Choice ${i + 1} in English (optional)`}
                    style={{ flex: 1, padding: '8px 12px', border: '1px solid var(--color-border)', borderRadius: 'var(--border-radius-md)', fontSize: 'var(--font-size-sm)', outline: 'none' }}
                    onFocus={e => e.currentTarget.style.borderColor = 'var(--color-primary)'}
                    onBlur={e => e.currentTarget.style.borderColor = 'var(--color-border)'} />
                </div>
              ))}
            </div>

            {/* 解説 */}
            <div style={{ marginBottom: 'var(--spacing-md)' }}>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', fontWeight: 700, marginBottom: 6 }}>解説（日本語）</div>
              <textarea value={editForm.explanation} onChange={e => setEditForm(f => ({ ...f, explanation: e.target.value }))}
                rows={5}
                style={{ width: '100%', padding: '8px 12px', border: '1px solid var(--color-border)', borderRadius: 'var(--border-radius-md)', fontSize: 'var(--font-size-base)', resize: 'vertical', boxSizing: 'border-box', outline: 'none', lineHeight: 1.6 }}
                onFocus={e => e.currentTarget.style.borderColor = 'var(--color-primary)'}
                onBlur={e => e.currentTarget.style.borderColor = 'var(--color-border)'} />
            </div>

            {/* 解説（英語） */}
            <div style={{ marginBottom: 'var(--spacing-md)' }}>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', fontWeight: 700, marginBottom: 6 }}>解説（English・任意）</div>
              <textarea value={editForm.explanationEn} onChange={e => setEditForm(f => ({ ...f, explanationEn: e.target.value }))}
                rows={4} placeholder="English explanation (optional)"
                style={{ width: '100%', padding: '8px 12px', border: '1px solid var(--color-border)', borderRadius: 'var(--border-radius-md)', fontSize: 'var(--font-size-base)', resize: 'vertical', boxSizing: 'border-box', outline: 'none', lineHeight: 1.6 }}
                onFocus={e => e.currentTarget.style.borderColor = 'var(--color-primary)'}
                onBlur={e => e.currentTarget.style.borderColor = 'var(--color-border)'} />
            </div>

            {/* 複数選択 */}
            <div style={{ display: 'flex', gap: 'var(--spacing-md)', marginBottom: 'var(--spacing-lg)', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 4 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)', cursor: 'pointer', fontSize: 'var(--font-size-base)', color: 'var(--color-text-main)' }}>
                  <input type="checkbox" checked={editForm.isMultiple} onChange={e => setEditForm(f => ({ ...f, isMultiple: e.target.checked }))}
                    style={{ width: 16, height: 16, accentColor: 'var(--color-primary)' }} />
                  複数選択問題
                </label>
              </div>
            </div>

            {/* ボタン */}
            <div style={{ display: 'flex', gap: 'var(--spacing-sm)', borderTop: '1px solid var(--color-border)', paddingTop: 'var(--spacing-md)' }}>
              <Button onClick={handleSaveQuestion} disabled={saving} variant="primary">
                {saving ? '保存中...' : '保存'}
              </Button>
              <Button onClick={() => setEditingQuestion(null)} variant="outline">
                キャンセル
              </Button>
            </div>
          </Card>
        </div>
      )}

      <h2 style={{ fontSize: 'var(--font-size-xxl)', fontWeight: 700, margin: '0 0 var(--spacing-xl)' }}>管理画面</h2>

      {adminError && (
        <Card padding="var(--spacing-md) var(--spacing-lg)" style={{ background: 'var(--color-danger-light)', borderColor: 'var(--color-danger)', marginBottom: 'var(--spacing-xl)', display: 'flex', alignItems: 'center', gap: 'var(--spacing-md)' }}>
          <span style={{ color: 'var(--color-warning)', display: 'inline-flex', alignItems: 'center' }}><IconAlertTriangle size={20} /></span>
          <div>
            <div style={{ fontWeight: 700, color: 'var(--color-danger)', fontSize: 'var(--font-size-base)' }}>{adminError}</div>
            <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', marginTop: 2 }}>
              ヘッダー右上のアイコンからログインし、管理者アカウント（{' '}
              <span style={{ fontFamily: 'monospace' }}>yuzuki2002110@gmail.com</span>
              {' '}）でサインインしてください。
            </div>
          </div>
        </Card>
      )}

      {/* ── グループナビゲーション ── */}
      {(() => {
        const activeGroup = getGroupForTab(tab);
        return (
          <div style={{ marginBottom: 'var(--spacing-xl)' }}>
            {/* グループ選択 */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 'var(--spacing-sm)', overflowX: 'auto', flexWrap: 'nowrap' }}>
              {TAB_GROUPS.map(g => (
                <button
                  key={g.key}
                  onClick={() => setTab(g.tabs[0])}
                  style={{
                    padding: '5px 16px', border: 'none', borderRadius: 'var(--border-radius-md)', cursor: 'pointer',
                    fontWeight: 600, fontSize: 'var(--font-size-sm)',
                    background: activeGroup === g.key ? 'var(--color-primary)' : 'var(--color-bg-main)',
                    color: activeGroup === g.key ? '#fff' : 'var(--color-text-sub)',
                    transition: 'background 0.15s',
                  }}
                >
                  {g.label}
                </button>
              ))}
            </div>
            {/* サブタブ */}
            <div
              className="admin-tabs"
              ref={adminTabsHint.ref}
              style={{ borderBottom: '1px solid var(--color-border)', display: 'flex', overflowX: 'auto', flexWrap: 'nowrap', ...adminTabsHint.maskStyle }}
            >
              {TAB_GROUPS.find(g => g.key === activeGroup)!.tabs.map(t => (
                <button key={t} data-tab={t} style={tabStyle(t)} onClick={() => setTab(t)}>
                  {t === 'messages' && messages.length > 0
                    ? `メッセージ (${messages.length})`
                    : t === 'dailyservice' && dailyServices.length > 0
                    ? `日めくりAWSサービス(${dailyServices.length})`
                    : TAB_LABELS[t]}
                </button>
              ))}
            </div>
          </div>
        );
      })()}

      {/* ── 問題管理 ── */}
      {tab === 'questions' && (
        <div>
          {/* ヘッダー行 */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 10 }}>
            <button
              onClick={() => setShowPreview(true)}
              style={{ padding: '5px 14px', background: 'transparent', color: 'var(--color-text-sub)', border: '1.5px solid var(--color-border)', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
              プレビュー
            </button>
            <button
              onClick={() => { fetchQuestions(currentPage); fetchSummary(sinceDate || undefined); }}
              style={{ padding: '5px 14px', background: 'transparent', color: 'var(--color-primary)', border: '1.5px solid var(--color-primary)', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', fontSize: 13, fontWeight: 700 }} title="再読み込み">
              <IconRefreshCw size={14} />
            </button>
          </div>
          {/* カバレッジ */}
          {totalCount > 0 && (validityCheckedCount != null || followUpCount != null) && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 8 }}>
                {[
                  { label: 'AI確認', count: validityCheckedCount, sinceCount: validityCheckedSinceCount, color: 'var(--color-primary)' },
                  { label: 'ASK AI 質問', count: followUpCount, sinceCount: followUpSinceCount, color: 'var(--color-accent)' },
                ].map(({ label, count, sinceCount, color }) => count == null ? null : (
                  <div key={label} style={{ flex: '1 1 200px', minWidth: 200 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--color-text-sub)', marginBottom: 4 }}>
                      <span style={{ fontWeight: 600 }}>{label}</span>
                      <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {count.toLocaleString()} / {totalCount.toLocaleString()}
                        <span style={{ marginLeft: 6, fontWeight: 700, color }}>{Math.round(count / totalCount * 100)}%</span>
                      </span>
                    </div>
                    <div style={{ height: 6, borderRadius: 9999, background: 'var(--color-border)', overflow: 'hidden' }}>
                      <div style={{ height: '100%', borderRadius: 9999, background: color, width: `${Math.min(100, count / totalCount * 100)}%`, transition: 'width 0.4s' }} />
                    </div>
                    {label === 'ASK AI 質問' && followUpByCount && (
                      <div style={{ marginTop: 4, fontSize: 11, color: 'var(--color-text-sub)', fontVariantNumeric: 'tabular-nums' }}>
                        {[1, 2, 3].map(n => `${n}つ ${(followUpByCount[n] ?? 0).toLocaleString()}`).join('　')}
                        （1問最大3つ）
                      </div>
                    )}
                    {sinceDate && sinceCount != null && createdSinceCount != null && (
                      <div style={{ marginTop: 4, display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--color-text-sub)' }}>
                        <span>{sinceDate.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$2/$3')}以降の新規問題</span>
                        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                          {sinceCount.toLocaleString()} / {createdSinceCount.toLocaleString()}
                          {createdSinceCount > 0 && (
                            <span style={{ marginLeft: 6, fontWeight: 700, color }}>{Math.round(sinceCount / createdSinceCount * 100)}%</span>
                          )}
                        </span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--color-text-sub)' }}>
                <span>確認済み（日付以降）:</span>
                <input
                  type="date"
                  value={sinceDate}
                  onChange={e => setSinceDate(e.target.value)}
                  style={{ fontSize: 12, padding: '2px 6px', border: '1px solid var(--color-border)', borderRadius: 6, color: 'var(--color-text-main)', background: 'var(--color-bg-white)', cursor: 'pointer' }}
                />
                {sinceDate && (
                  <button onClick={() => setSinceDate('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-light)', padding: '2px 4px', lineHeight: 0, display: 'inline-flex', alignItems: 'center' }}><IconClose /></button>
                )}
              </div>
            </div>
          )}

          {/* 検索バー */}
          <form onSubmit={handleSearch} style={{ marginBottom: 16 }}>
            {/* 試験種別 */}
            {(() => {
              const totalExercise = Object.values(exerciseCounts).reduce((a, b) => a + b, 0);
              const totalCorrect = Object.values(exerciseCorrectCounts).reduce((a, b) => a + b, 0);
              const hasExercise = totalExercise > 0;
              const examBtn = (type: string) => {
                const exCnt = exerciseCounts[type] ?? 0;
                const exCor = exerciseCorrectCounts[type] ?? 0;
                const rate = exCnt > 0 ? Math.round(exCor / exCnt * 100) : null;
                return (
                  <button key={type} type="button" onClick={() => { setExamFilter(type); setDomainFilter(''); }}
                    style={{
                      padding: '4px 12px', border: examFilter === type ? '2px solid' : '1.5px solid', borderRadius: 6, cursor: 'pointer',
                      background: examFilter === type ? 'var(--color-primary-light)' : 'transparent',
                      color: examFilter === type ? 'var(--color-primary)' : 'var(--color-text-sub)',
                      borderColor: examFilter === type ? 'var(--color-primary)' : 'var(--color-border)',
                      fontWeight: examFilter === type ? 700 : 400, fontSize: 13,
                      lineHeight: 1.3,
                    }}>
                    {type === 'ALL' ? (
                      <span>
                        ALL{totalCount > 0 ? `(${totalCount})` : ''}
                        {hasExercise && <span style={{ fontSize: 11, color: examFilter === 'ALL' ? 'var(--color-primary)' : 'var(--color-text-light)', marginLeft: 4, fontVariantNumeric: 'tabular-nums' }}>{totalExercise.toLocaleString()}回 {Math.round(totalCorrect / totalExercise * 100)}%</span>}
                      </span>
                    ) : (
                      <span>
                        {type}{examCounts[type] != null ? `(${examCounts[type]})` : ''}
                        {exCnt > 0 && <span style={{ fontSize: 11, color: examFilter === type ? 'var(--color-primary)' : 'var(--color-text-light)', marginLeft: 4, fontVariantNumeric: 'tabular-nums', display: 'block' }}>{exCnt.toLocaleString()}回{rate != null ? ` ${rate}%` : ''}</span>}
                      </span>
                    )}
                  </button>
                );
              };
              const levels = ['Foundational', 'Business', 'Associate', 'Professional', 'Specialty', 'Additional'] as const;
              const byLevel: Record<string, string[]> = {};
              for (const t of EXAM_TYPES) {
                const lv = EXAM_LEVEL[t] ?? 'Other';
                (byLevel[lv] ??= []).push(t);
              }
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    {examBtn('ALL')}
                  </div>
                  {levels.map(lv => byLevel[lv]?.length ? (
                    <div key={lv} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 11, color: 'var(--color-text-light)', fontWeight: 700, minWidth: isMobile ? 56 : 88, textAlign: 'right', flexShrink: 0 }}>{isMobile ? lv.slice(0, 4) : lv}</span>
                      <span style={{ width: 1, height: 16, background: 'var(--color-border)', display: 'inline-block', flexShrink: 0 }} />
                      {byLevel[lv].map(t => examBtn(t))}
                    </div>
                  ) : null)}
                </div>
              );
            })()}

            {/* ドメインフィルタ（試験種別が選択されている場合のみ） */}
            {examFilter !== 'ALL' && (
              <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <button type="button" onClick={() => setDomainFilter('')}
                  style={{ padding: '4px 10px', border: domainFilter === '' ? '2px solid' : '1.5px solid', borderRadius: 6, cursor: 'pointer', fontSize: 12,
                    background: domainFilter === '' ? 'var(--color-primary-light)' : 'transparent',
                    color: domainFilter === '' ? 'var(--color-primary)' : 'var(--color-text-sub)',
                    borderColor: domainFilter === '' ? 'var(--color-primary)' : 'var(--color-border)',
                    fontWeight: domainFilter === '' ? 700 : 400 }}>
                  全ドメイン{examCounts[examFilter] != null ? `(${examCounts[examFilter]})` : ''}
                </button>
                <span style={{ width: 1, height: 16, background: 'var(--color-border)', display: 'inline-block', flexShrink: 0 }} />
                {EXAM_DOMAINS[examFilter]?.map(d => (
                  <button key={d} type="button" onClick={() => setDomainFilter(domainFilter === d ? '' : d)}
                    style={{ padding: '4px 10px', border: domainFilter === d ? '2px solid' : '1.5px solid', borderRadius: 6, cursor: 'pointer', fontSize: 12,
                      background: domainFilter === d ? 'var(--color-primary-light)' : 'transparent',
                      color: domainFilter === d ? 'var(--color-primary)' : 'var(--color-text-sub)',
                      borderColor: domainFilter === d ? 'var(--color-primary)' : 'var(--color-border)',
                      fontWeight: domainFilter === d ? 700 : 400 }}>
                    {d}{domainCountsByExam[examFilter]?.[d] != null ? `(${domainCountsByExam[examFilter][d]})` : ''}
                  </button>
                ))}
              </div>
            )}

            {/* ソート */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 12, color: 'var(--color-text-sub)', fontWeight: 700, flexShrink: 0 }}>ソート:</span>
              <select
                value={sortBy}
                onChange={e => { setSortBy(e.target.value as typeof sortBy); setCurrentPage(0); }}
                style={{ padding: '5px 10px', border: '1px solid var(--color-border)', borderRadius: 6, fontSize: 13, background: 'var(--color-bg-white)', color: 'var(--color-text-main)', cursor: 'pointer', outline: 'none' }}
              >
                <option value="id_asc">ID (昇順)</option>
                <option value="createdAt_desc">作成日 (新しい順)</option>
                <option value="createdAt_asc">作成日 (古い順)</option>
                <option value="updatedAt_desc">最終編集 (新しい順)</option>
                <option value="updatedAt_asc">最終編集 (古い順)</option>
                <option value="validityCheckedAt_desc">AI確認 (新しい順)</option>
                <option value="validityCheckedAt_asc">AI確認 (古い順)</option>
                <option value="correctRate_asc">正答率 (低い順)</option>
                <option value="correctRate_desc">正答率 (高い順)</option>
                <option value="attempts_desc">演習回数 (多い順)</option>
                <option value="attempts_asc">演習回数 (少ない順)</option>
              </select>
            </div>

            {/* キーワード・タグ検索（チップ形式） */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div style={{ flex: 2, minWidth: 180 }}>
                <input
                  value={keywordInput}
                  onChange={e => setKeywordInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      const kw = keywordInput.trim();
                      setKeyword(kw);
                      setKeywordInput('');
                    }
                  }}
                  placeholder="問題ID・問題文で検索 (Enter で確定)"
                  style={{ width: '100%', padding: '6px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, outline: 'none', boxSizing: 'border-box' }}
                  onFocus={e => e.currentTarget.style.borderColor = 'var(--color-primary)'}
                  onBlur={e => e.currentTarget.style.borderColor = 'var(--color-border)'}
                />
                {keyword && (
                  <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '2px 8px 2px 10px', background: 'var(--color-primary-light)', color: 'var(--color-primary)', borderRadius: 4, fontSize: 12, fontWeight: 600 }}>
                      {keyword}
                      <button onClick={() => setKeyword('')}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-primary)', fontSize: 15, lineHeight: 1, padding: '0 0 0 2px', display: 'flex', alignItems: 'center' }}>×</button>
                    </span>
                  </div>
                )}
              </div>
              <div style={{ flex: 1, minWidth: 140 }}>
                <input
                  value={tagInput}
                  onChange={e => setTagInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      const tag = tagInput.trim();
                      setTagFilter(tag);
                      setTagInput('');
                    }
                  }}
                  placeholder="タグで絞り込み (Enter で確定)"
                  style={{ width: '100%', padding: '6px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, outline: 'none', boxSizing: 'border-box' }}
                  onFocus={e => e.currentTarget.style.borderColor = 'var(--color-primary)'}
                  onBlur={e => e.currentTarget.style.borderColor = 'var(--color-border)'}
                />
                {tagFilter && (
                  <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '2px 8px 2px 10px', background: 'var(--color-primary-light)', color: 'var(--color-primary)', borderRadius: 4, fontSize: 12, fontWeight: 600 }}>
                      {tagFilter}
                      <button onClick={() => setTagFilter('')}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-primary)', fontSize: 15, lineHeight: 1, padding: '0 0 0 2px', display: 'flex', alignItems: 'center' }}>×</button>
                    </span>
                  </div>
                )}
              </div>
            </div>
          </form>

          {/* 件数・一括削除バー */}
          {/* コラムのネタタブで同じパターン(外側・内側ともflexWrap無し)がモバイルで
              テキストの文字単位改行崩れを起こしたため、ここも同様に折り返し可能にしておく。 */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
            <p style={{ color: 'var(--color-text-sub)', fontSize: 13, margin: 0 }}>
              {loadingQ ? '読み込み中...' : totalQuestions > 0
                ? `${totalQuestions} 件中 ${currentPage * PAGE_SIZE + 1}–${Math.min((currentPage + 1) * PAGE_SIZE, totalQuestions)} 件表示`
                : `${questions.length} 件`}
            </p>
            {selectedIds.size > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, color: 'var(--color-primary)', fontWeight: 700 }}>{selectedIds.size}件選択中</span>
                <button
                  onClick={handleBulkDelete}
                  disabled={bulkDeleting}
                  style={{
                    padding: '6px 16px', fontSize: 13, fontWeight: 700, borderRadius: 'var(--border-radius-md)', cursor: bulkDeleting ? 'default' : 'pointer',
                    background: bulkDeleting ? 'var(--color-border)' : 'var(--color-bg-white)',
                    color: bulkDeleting ? 'var(--color-text-light)' : 'var(--color-danger)',
                    border: `1.5px solid ${bulkDeleting ? 'var(--color-border)' : 'var(--color-danger)'}`
                  }}>
                  {bulkDeleting ? '削除中...' : `${selectedIds.size}件を削除`}
                </button>
                <button
                  onClick={() => setSelectedIds(new Set())}
                  style={{ padding: '6px 12px', fontSize: 13, fontWeight: 700, borderRadius: 'var(--border-radius-md)', cursor: 'pointer', background: 'transparent', color: 'var(--color-text-sub)', border: '1px solid var(--color-border)' }}>
                  選択解除
                </button>
              </div>
            )}
          </div>

          {/* 全選択ヘッダー */}
          {questions.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px', background: 'var(--color-bg-main)', border: '1px solid #eaeded', borderRadius: 6, marginBottom: 4 }}>
              <input
                type="checkbox"
                checked={selectedIds.size === questions.length}
                onChange={toggleSelectAll}
                style={{ width: 16, height: 16, cursor: 'pointer', flexShrink: 0 }}
              />
              <span style={{ fontSize: 12, color: 'var(--color-text-sub)', fontWeight: 700 }}>
                {selectedIds.size === questions.length ? '全選択解除' : '全選択'}
              </span>
            </div>
          )}

          {/* 問題リスト */}
          {loadingQ && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {[0, 1, 2, 3, 4].map(i => (
                <div key={i} style={{ border: '1px solid #eaeded', borderRadius: 6, padding: '14px 16px', background: 'var(--color-bg-white)' }}>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <div className="skeleton" style={{ width: 16, height: 16, borderRadius: 3, flexShrink: 0 }} />
                    <div className="skeleton" style={{ width: 52, height: 18, borderRadius: 4 }} />
                    <div className="skeleton" style={{ flex: 1, height: 16, borderRadius: 4 }} />
                    <div className="skeleton" style={{ width: 80, height: 14, borderRadius: 4 }} />
                  </div>
                </div>
              ))}
            </div>
          )}
          {!loadingQ && questions.map(q => (
            <div key={q.questionId} style={{ border: '1px solid #eaeded', borderRadius: 6, marginBottom: 4, overflow: 'hidden', boxShadow: 'var(--box-shadow-sm)', background: selectedIds.has(q.questionId) ? 'var(--color-primary-light)' : 'transparent' }}>
              {/* ヘッダー行 */}
              <div
                onClick={() => {
                  const next = expandedId === q.questionId ? null : q.questionId;
                  setExpandedId(next);
                  if (next && !expandedDetail[next]) {
                    adminFetch(`${API_ENDPOINT}/admin/questions/${next}`)
                      .then(r => r.json()).then(d => setExpandedDetail(prev => ({ ...prev, [next]: d })));
                  }
                }}
                style={{ display: 'flex', alignItems: 'center', padding: isMobile ? '10px 10px' : '10px 16px', cursor: 'pointer', background: selectedIds.has(q.questionId) ? 'var(--color-primary-light)' : expandedId === q.questionId ? 'var(--color-bg-main)' : 'var(--color-bg-white)', gap: isMobile ? 6 : 10 }}>
                <input
                  type="checkbox"
                  checked={selectedIds.has(q.questionId)}
                  onChange={() => toggleSelect(q.questionId)}
                  onClick={e => e.stopPropagation()}
                  style={{ width: 16, height: 16, cursor: 'pointer', flexShrink: 0 }}
                />
                <span style={{ color: 'var(--color-text-sub)', flexShrink: 0, display: 'flex' }}>{expandedId === q.questionId ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}</span>
                <Badge variant="secondary">{q.examType}</Badge>
                {!isMobile && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                    <span style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--color-text-sub)' }}>{q.questionId}</span>
                    <button
                      onClick={e => copyQuestionId(e, q.questionId)}
                      title="IDをコピー"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: copiedId === q.questionId ? 'var(--color-success)' : 'var(--color-text-light)', display: 'flex', alignItems: 'center', flexShrink: 0 }}
                    >
                      {copiedId === q.questionId ? <IconCheck size={12} /> : <IconCopy size={12} />}
                    </button>
                  </span>
                )}
                <span style={{ fontSize: 14, color: 'var(--color-text-main)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {q.questionText}
                </span>
                {!isMobile && (() => {
                  // 全ユーザー実測正答率（正解率が極端な問題の品質監視用）
                  const ga = Number((q as any).globalAttempts ?? 0);
                  const gc = Number((q as any).globalCorrect ?? 0);
                  if (ga < 1) return null;
                  const acc = Math.round(gc / ga * 100);
                  const color = ga >= 10 && acc >= 90 ? 'var(--color-warning, #e67e22)' : ga >= 10 && acc <= 20 ? 'var(--color-danger)' : 'var(--color-text-light)';
                  return (
                    <span title={`全ユーザーの回答 ${ga}件中 ${gc}件正解`} style={{ fontSize: 11, color, fontWeight: 700, flexShrink: 0, whiteSpace: 'nowrap' }}>
                      正答率 {acc}% ({ga})
                    </span>
                  );
                })()}
                {!isMobile && (() => {
                  // 演習画面の👍👎の集計（問題改善の指標。ユーザー側には合計を出していない）
                  const up = Number((q as any).reactionUp ?? 0);
                  const down = Number((q as any).reactionDown ?? 0);
                  if (up === 0 && down === 0) return null;
                  return (
                    <span title={`参考になった ${up} / 分かりにくい ${down}`} style={{ fontSize: 11, flexShrink: 0, whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ color: up > 0 ? 'var(--color-primary)' : 'var(--color-text-light)', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-xs)' }}><IconThumbsUp size={13} />{up}</span>
                      <span style={{ color: down > 0 ? 'var(--color-danger)' : 'var(--color-text-light)', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-xs)' }}><IconThumbsDown size={13} />{down}</span>
                    </span>
                  );
                })()}
                {!isMobile && q.validityCheckedAt && (
                  <span style={{ fontSize: 11, color: 'var(--color-text-light)', flexShrink: 0, whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 3 }}>
                    <span style={{ color: 'var(--color-success)', display: 'inline-flex', alignItems: 'center' }}><IconCheck size={12} /></span>
                    AI: {fmtDate(q.validityCheckedAt)}
                  </span>
                )}
                {!isMobile && q.updatedAt && (
                  <span style={{ fontSize: 11, color: 'var(--color-text-light)', flexShrink: 0, whiteSpace: 'nowrap' }}>
                    編集: {fmtDate(q.updatedAt)}
                  </span>
                )}
                <button
                  onClick={e => { e.stopPropagation(); setPreviewInitId(q.questionId); setShowPreview(true); }}
                  title="演習時の見え方をプレビュー"
                  style={{ padding: '4px 10px', background: 'transparent', color: 'var(--color-text-sub)', border: '1px solid var(--color-border)', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', fontSize: 12, fontWeight: 700, flexShrink: 0, lineHeight: 0, display: 'inline-flex', alignItems: 'center' }}>
                  <IconEye size={14} />
                </button>
                <button
                  onClick={e => { e.stopPropagation(); openEdit(q); }}
                  style={{ padding: '4px 9px', background: 'transparent', color: 'var(--color-text-sub)', border: '1px solid var(--color-border)', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', fontSize: 12, fontWeight: 700, flexShrink: 0 }} title="編集">
                  <IconPencil size={14} />
                </button>
                <button
                  onClick={e => { e.stopPropagation(); handleDelete(q); }}
                  disabled={deletingId === q.questionId}
                  style={{
                    padding: '4px 12px',
                    background: 'transparent',
                    color: deletingId === q.questionId ? 'var(--color-text-light)' : 'var(--color-danger)',
                    border: `1.5px solid ${deletingId === q.questionId ? 'var(--color-border)' : 'var(--color-danger)'}`,
                    borderRadius: 'var(--border-radius-md)',
                    cursor: deletingId === q.questionId ? 'default' : 'pointer',
                    fontSize: 12,
                    fontWeight: 700,
                    flexShrink: 0
                  }} title={deletingId === q.questionId ? '削除中...' : '削除'}>
                  <IconTrash size={14} />
                </button>
              </div>

              {/* 展開詳細 */}
              {expandedId === q.questionId && (() => {
                const detail = expandedDetail[q.questionId];
                return (
                  <div style={{ padding: '14px 16px', borderTop: '1px solid #e8e8e8', background: 'var(--color-bg-main)', fontSize: 13 }}>
                    <p style={{ fontWeight: 'bold', marginTop: 0, whiteSpace: 'pre-wrap' }}>{q.questionText}</p>
                    {q.isMultiple && <p style={{ color: 'var(--color-text-info)', fontSize: 12 }}>複数選択</p>}

                    <div style={{ marginBottom: 12 }}>
                      {q.choices.map((c, i) => {
                        const isCorrect = q.correctAnswerIndices?.includes(i);
                        return (
                          <div key={i} style={{
                            padding: '6px 10px', marginBottom: 4, borderRadius: 6,
                            background: isCorrect ? 'var(--color-feedback-correct-bg)' : 'var(--color-bg-main)',
                            border: `1.5px solid ${isCorrect ? 'var(--color-success)' : 'var(--color-border)'}`,
                            color: isCorrect ? 'var(--color-success)' : 'var(--color-text-sub)',
                          }}>
                            <span style={{ whiteSpace: 'pre-wrap', display: 'inline-flex', alignItems: 'baseline', gap: 'var(--spacing-xs)' }}>{isCorrect && <span style={{ display: 'inline-flex', alignSelf: 'center' }}><IconCheck size={13} /></span>}{c}</span>
                          </div>
                        );
                      })}
                    </div>

                    <div style={{ background: 'var(--color-primary-light)', borderRadius: 6, padding: '10px 12px', marginBottom: 10, color: 'var(--color-text-main)', lineHeight: 1.6 }}>
                      <strong>解説：</strong>
                      {detail
                        ? <span style={{ whiteSpace: 'pre-wrap' }}>{detail.explanation ?? '（解説なし）'}</span>
                        : <span style={{ color: 'var(--color-text-light)' }}>読み込み中…</span>}
                    </div>

                    {qDomainName(q as any) && (
                      <div style={{ fontSize: 12, color: 'var(--color-text-sub)', marginBottom: 4 }}>
                        ドメイン: <span style={{ fontWeight: 700 }}>{qDomainName(q as any)}</span>
                      </div>
                    )}
                    <div style={{ color: 'var(--color-text-light)', fontSize: 11, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                      {q.createdAt && <span>作成: {fmtDate(q.createdAt)}</span>}
                      {q.updatedAt && <span>編集: {fmtDate(q.updatedAt)}</span>}
                      {q.validityCheckedAt && <span>AI確認: {fmtDate(q.validityCheckedAt)}</span>}
                    </div>
                  </div>
                );
              })()}
            </div>
          ))}

          {!loadingQ && questions.length === 0 && (
            <p style={{ color: 'var(--color-text-light)', textAlign: 'center', padding: 40 }}>問題が見つかりません</p>
          )}

          {/* ページネーション */}
          {totalQuestions > PAGE_SIZE && !loadingQ && (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, marginTop: 20, padding: '12px 0' }}>
              <button
                onClick={() => { fetchQuestions(currentPage - 1); setSelectedIds(new Set()); }}
                disabled={currentPage === 0}
                style={{ padding: '6px 16px', borderRadius: 'var(--border-radius-md)', border: '1px solid var(--color-border)', background: currentPage === 0 ? 'var(--color-bg-main)' : 'var(--color-bg-white)', color: currentPage === 0 ? 'var(--color-text-light)' : 'var(--color-text-main)', cursor: currentPage === 0 ? 'default' : 'pointer', fontWeight: 700, fontSize: 13 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', verticalAlign: '-2px', marginRight: 'var(--spacing-xs)' }}><IconArrowLeft size={13} /></span>前
              </button>
              <span style={{ fontSize: 13, color: 'var(--color-text-sub)' }}>
                {currentPage + 1} / {Math.ceil(totalQuestions / PAGE_SIZE)} ページ
              </span>
              <button
                onClick={() => { fetchQuestions(currentPage + 1); setSelectedIds(new Set()); }}
                disabled={(currentPage + 1) * PAGE_SIZE >= totalQuestions}
                style={{ padding: '6px 16px', borderRadius: 'var(--border-radius-md)', border: '1px solid var(--color-border)', background: (currentPage + 1) * PAGE_SIZE >= totalQuestions ? 'var(--color-bg-main)' : 'var(--color-bg-white)', color: (currentPage + 1) * PAGE_SIZE >= totalQuestions ? 'var(--color-text-light)' : 'var(--color-text-main)', cursor: (currentPage + 1) * PAGE_SIZE >= totalQuestions ? 'default' : 'pointer', fontWeight: 700, fontSize: 13 }}>
                次<span style={{ display: 'inline-flex', alignItems: 'center', verticalAlign: '-2px', marginLeft: 'var(--spacing-xs)' }}><IconArrowRight size={13} /></span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── 生成状況 ── */}
      {tab === 'growth' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
            <button
              onClick={fetchGrowthData}
              style={{ padding: '5px 14px', background: 'transparent', color: 'var(--color-primary)', border: '1.5px solid var(--color-primary)', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', fontSize: 13, fontWeight: 700 }} title="再読み込み">
              <IconRefreshCw size={14} />
            </button>
          </div>
          {growthLoading ? (
            <p style={{ color: 'var(--color-text-light)', fontSize: 13 }}>読み込み中...</p>
          ) : !growthData ? (
            <p style={{ color: 'var(--color-text-light)', fontSize: 13 }}>データを取得できませんでした</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'var(--color-bg-main)' }}>
                    <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 700, color: 'var(--color-text-sub)', borderBottom: '1px solid var(--color-border)', whiteSpace: 'nowrap' }}>日付</th>
                    <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700, color: 'var(--color-primary)', borderBottom: '1px solid var(--color-border)', whiteSpace: 'nowrap' }}>生成数</th>
                    <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700, color: 'var(--color-text-sub)', borderBottom: '1px solid var(--color-border)', whiteSpace: 'nowrap' }}>確認数</th>
                  </tr>
                </thead>
                <tbody>
                  {[...growthData.dates].reverse().map((date, ri) => {
                    const i = growthData.dates.length - 1 - ri;
                    const created = growthData.created[i];
                    const verified = growthData.verified[i];
                    const isToday = date === new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
                    return (
                      <tr key={date} style={{ background: isToday ? 'rgba(var(--color-primary-rgb, 0,112,243),0.04)' : undefined }}>
                        <td style={{ padding: '9px 12px', borderBottom: '1px solid var(--color-border)', color: 'var(--color-text-main)', fontWeight: isToday ? 700 : 400, whiteSpace: 'nowrap' }}>
                          {date}{isToday && <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--color-primary)', fontWeight: 700 }}>今日</span>}
                        </td>
                        <td style={{ padding: '9px 12px', textAlign: 'right', borderBottom: '1px solid var(--color-border)', fontWeight: created > 0 ? 700 : 400, color: created > 0 ? 'var(--color-primary)' : 'var(--color-text-light)', fontVariantNumeric: 'tabular-nums' }}>
                          {created > 0 ? `+${created}` : '—'}
                        </td>
                        <td style={{ padding: '9px 12px', textAlign: 'right', borderBottom: '1px solid var(--color-border)', fontWeight: verified > 0 ? 700 : 400, color: verified > 0 ? 'var(--color-text-main)' : 'var(--color-text-light)', fontVariantNumeric: 'tabular-nums' }}>
                          {verified > 0 ? verified : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── 通報確認 ── */}
      {tab === 'reports' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            <p style={{ color: 'var(--color-text-light)', fontSize: 13, margin: 0 }}>
              {loadingR ? '読み込み中...' : `${reports.length} 件`}
            </p>
            <SortSelect value={reportSort} onChange={setReportSort} options={[
              { key: 'reportedAt_desc', label: '通報日時（新しい順）' },
              { key: 'reportedAt_asc', label: '通報日時（古い順）' },
              { key: 'category_asc', label: 'カテゴリ' },
              { key: 'questionId_asc', label: '問題ID' },
            ]} />
          </div>

          {sortItems(reports, reportSort, {
            reportedAt: r => r.reportedAt,
            category: r => r.category,
            questionId: r => r.questionId,
          }).map(r => (
            <div key={r.reportId} style={{ border: '1px solid #eaeded', borderRadius: 6, padding: '14px 16px', marginBottom: 8, background: 'var(--color-bg-white)', boxShadow: 'var(--box-shadow-sm)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8, gap: 8 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontFamily: 'monospace', fontSize: 12, background: 'var(--color-bg-main)', padding: '2px 8px', borderRadius: 6, color: 'var(--color-text-sub)', border: '1px solid #d1d5db' }}>
                    {r.questionId}
                  </span>
                  {r.category && (
                    <span style={{ fontSize: 11, background: 'var(--color-bg-warning)', color: 'var(--color-text-warning)', padding: '2px 8px', borderRadius: 4, fontWeight: 700, border: '1px solid #ffc107' }}>
                      {REPORT_CATEGORY_LABEL[r.category] ?? r.category}
                    </span>
                  )}
                  <span style={{ fontSize: 12, color: 'var(--color-text-sub)' }}>
                    {new Date(r.reportedAt).toLocaleString('ja-JP')}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button
                    onClick={() => {
                      setTab('questions');
                      setKeyword(r.questionId);
                      setTimeout(() => fetchQuestions(), 100);
                    }}
                    style={{ fontSize: 12, padding: '4px 12px', border: '1.5px solid var(--color-primary)', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', background: 'transparent', color: 'var(--color-primary)', fontWeight: 700 }}>
                    問題を確認
                  </button>
                  <button
                    onClick={() => deleteReport(r.reportId, r.questionId)}
                    style={{ fontSize: 12, padding: '4px 12px', border: '1px solid #d1d5db', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', background: 'transparent', color: 'var(--color-text-sub)', fontWeight: 700 }}
                    title="解決済みとして削除">
                    <span style={{ display: 'inline-flex', alignItems: 'center', verticalAlign: '-2px', marginRight: 'var(--spacing-xs)' }}><IconCheck size={13} /></span>解決済み
                  </button>
                </div>
              </div>
              <p style={{ margin: '0 0 6px', color: 'var(--color-text-main)', fontSize: 14 }}>{r.message || '（メッセージなし）'}</p>
              <p style={{ margin: 0, fontSize: 12, color: 'var(--color-text-sub)' }}>通報者: {r.userId}</p>
            </div>
          ))}

          {!loadingR && reports.length === 0 && (
            <p style={{ color: 'var(--color-text-light)', textAlign: 'center', padding: 40 }}>通報はありません</p>
          )}
        </div>
      )}

      {/* ── 問題追加 ── */}
      {tab === 'import' && (() => {
        const EXAMPLE = JSON.stringify([
          {
            examType: "SAA",
            domain: "セキュアなアーキテクチャの設計",
            questionText: "Amazon S3バケットへのアクセスを特定のVPCからのみに制限するために使用すべきものはどれですか？",
            choices: ["バケットACL", "S3バケットポリシーとVPCエンドポイント", "IAMユーザーポリシー", "セキュリティグループ"],
            correctAnswerIndices: [1],
            explanation: "VPCエンドポイントを使用しS3バケットポリシーでaws:sourceVpceを条件にすることでVPC外からのアクセスを制限できます。",
            choiceExplanations: [
              "バケットACLはオブジェクト単位の権限管理であり、VPC単位でのアクセス制限はできません。",
              "VPCエンドポイント経由のアクセスのみ許可する条件をS3バケットポリシーに設定することで、指定VPCからのアクセスに制限できます。",
              "IAMユーザーポリシーはユーザー単位の権限であり、アクセス元のVPCを条件にすることはできません。",
              "セキュリティグループはEC2等のインスタンス向けのファイアウォールで、S3バケットには適用できません。",
            ],
            isMultiple: false
          }
        ], null, 2);

        const handleParse = () => {
          setImportError('');
          setImportParsed(null);
          setImportResult(null);
          setImportMismatchTypes([]);
          try {
            const parsed = JSON.parse(importJson);
            if (!Array.isArray(parsed)) throw new Error('配列形式にしてください');
            for (const q of parsed) {
              if (!q.questionText) throw new Error('questionText が必要です');
              if (!Array.isArray(q.choices) || q.choices.length < 2) throw new Error('choices は2つ以上必要です');
              // 正解指定は correctAnswerIndices（数値配列・AIプロンプトが出力する正準形式）または
              // correctAnswers（文字列配列・旧形式/手動入力）のどちらかがあればよい。
              // バックエンド(buildQuestionWriteFields)も同様にどちらか一方で受け付ける。
              const hasIndices = Array.isArray(q.correctAnswerIndices) && q.correctAnswerIndices.length > 0;
              const hasAnswers = Array.isArray(q.correctAnswers) && q.correctAnswers.length > 0;
              if (!hasIndices && !hasAnswers) throw new Error('correctAnswerIndices または correctAnswers が必要です');
              // 0 は有効な domain インデックス（バックエンドの qDomainIndex は数値も受ける）ため
              // falsy 判定にしない。未設定（null/undefined/空文字）だけを弾く。
              const domainRaw: unknown = q.domain;
              if (domainRaw == null || domainRaw === '') throw new Error(`domain が未設定の問題があります（questionText: ${String(q.questionText ?? '').slice(0, 30)}…）`);
            }
            setImportParsed(parsed);
            const mismatched = [...new Set(
              parsed
                .filter((q: ImportQuestion) => q.examType && q.examType !== importExamType)
                .map((q: ImportQuestion) => q.examType as string)
            )];
            setImportMismatchTypes(mismatched);
          } catch (e: any) {
            setImportError(e.message || 'JSONの形式が正しくありません');
          }
        };

        const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = ev => {
            setImportJson(ev.target?.result as string);
            setImportParsed(null);
            setImportResult(null);
            setImportError('');
            setImportMismatchTypes([]);
          };
          reader.readAsText(file);
          e.target.value = '';
        };

        const handleImport = async () => {
          if (!importParsed) return;
          setImporting(true);
          setImportResult(null);
          try {
            const res = await adminFetch(`${API_ENDPOINT}/admin/questions`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ examType: importExamType, questions: importParsed })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || '失敗しました');
            setImportResult({ count: data.count, ids: data.created });
            setImportJson('');
            setImportParsed(null);
          } catch (e: any) {
            setImportError(e.message);
          } finally {
            setImporting(false);
          }
        };

        return (
          <div>
            {/* 設定 */}
            <div style={{ display: 'flex', gap: 24, marginBottom: 20, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 12, color: 'var(--color-text-light)', marginBottom: 6 }}>試験種別</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {EXAM_TYPES.map(t => (
                    <button key={t} onClick={() => setImportExamType(t)}
                      style={{ padding: '4px 12px', border: importExamType === t ? '2px solid' : '1.5px solid', borderRadius: 6, cursor: 'pointer', fontSize: 13,
                        borderColor: importExamType === t ? 'var(--color-primary)' : 'var(--color-border)',
                        background: importExamType === t ? 'var(--color-primary-light)' : 'transparent',
                        color: importExamType === t ? 'var(--color-primary)' : 'var(--color-text-sub)',
                        fontWeight: importExamType === t ? 700 : 400 }}>
                      {t}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* AIプロンプト生成 */}
            {(() => {
              const examFull = `${EXAM_CONFIGS[importExamType]?.fullName} (${EXAM_CONFIGS[importExamType]?.examCode})`;
              const topic = promptTopic.trim();
              const count = parseInt(promptCount) || 5;
              const nonAws = isNonAwsExam(importExamType);
              // 夜間生成と同一の本文（instructions/*.txt 由来）を作成方針として使う。AWS 資格も含む
              // （以前はオリジナルカードだけで、AWS 資格には試験ガイド概要・難易度が入らなかった）。
              // ※ EXAM_SUPPLEMENTARY_RULES はこの本文に内包されるため、本文がある資格では二重に付けない。
              const instBody = EXAM_INSTRUCTIONS[importExamType] ?? '';
              const promptIntro = nonAws
                ? 'あなたは技術系の学習教材の作成の専門家です。（これはAWS認定資格ではなく、基礎知識を問うオリジナル演習です）'
                : 'あなたはAWS認定試験の問題作成の専門家です。';
              const prompt = `${promptIntro}
以下の条件に従い、${nonAws ? '演習' : '試験'}問題を${count}問作成し、JSON配列のみを出力してください（前後の説明文は不要）。
本サービスは日本語のみで提供します。英語フィールドは出力しないでください。
${instBody ? `\n【${nonAws ? 'この演習カード' : 'この試験'}の作成方針（夜間生成と共通）】\n${instBody}\n` : ''}
【試験】${examFull}
${topic ? `【トピック / キーワード】${topic}` : '【トピック / キーワード】指定なし（全ドメインから均等に出題すること）'}

【作問ルール】
・選択肢は単一正解なら4つ、複数正解なら5つ（うち正解2つ）。ラベルなし・テキストのみ（"A." "B." 等の接頭辞を付けない）
・単一正解の場合は isMultiple: false、複数正解は isMultiple: true
・正解は correctAnswerIndices（choices 配列内の正解の位置を 0 始まりの整数配列で指定）で表すこと。これが唯一の正解指定です（例: choices[1] が正解なら [1]、複数正解なら [0,2]）。correctAnswers 等の文字列での正解指定は不要
・explanation（全体解説）は正解がなぜ要件を満たすかの核心のみ。各不正解の理由は choiceExplanations に書く（字数は下の品質基準に従う）
・難易度・文体は上記「作成方針」に従うこと
・選択肢の長さのバランスは下の品質基準に従う（正解だけ極端に長い・短いで推測できないようにする）
・examType には "${importExamType}" を必ず設定すること
・domain は必須フィールド。null・空文字・省略は不可。以下のいずれか1つを文字列でそのまま設定すること（保存時に内部インデックスへ変換されます）:
  ${EXAM_DOMAINS[importExamType]?.map((d, i) => `${i === 0 ? '' : '  '}${d}`).join('\n  ')}
・choiceExplanations は choices と必ず同じ順序・同じ数で生成すること（正解はなぜ正解か、不正解はなぜ不正解か。字数・書き方は下の品質基準に従う）
・同じ決め手（同じ正解・同じ判断根拠）の問題を複数作らない。${count}問の論点はそれぞれ別にすること
・選択肢にはその用語・答えのみを簡潔に記載し、用語の説明・定義文・略語の展開を選択肢内に含めないこと（不要なヒントになるため。説明・比較・理由・略語の意味は choiceExplanations／explanation 側に書く）
・略語が何の略かは選択肢ではなく解説側で説明すること: explanation・choiceExplanations で重要な略語を初出で英語フルスペル併記して展開する（例 解説内で「BLEU(Bilingual Evaluation Understudy)」）。選択肢本文には展開を入れない
${!instBody && EXAM_SUPPLEMENTARY_RULES[importExamType] ? `${EXAM_SUPPLEMENTARY_RULES[importExamType]}\n` : ''}${COMMON_RULES ? `\n【品質基準（夜間生成と共通）】\n${COMMON_RULES}\n` : ''}
【出力形式】
[
  {
    "examType": "${importExamType}",
    "domain": "${EXAM_DOMAINS[importExamType]?.[0] ?? ''}",
    "questionText": "問題文（日本語）",
    "choices": ["選択肢1", "選択肢2", "選択肢3", "選択肢4"],
    "correctAnswerIndices": [0],
    "explanation": "解説文（日本語）",
    "choiceExplanations": ["選択肢0の解説", "選択肢1の解説", "選択肢2の解説", "選択肢3の解説"],
    "isMultiple": false
  }
]`;

              const copyPrompt = () => {
                navigator.clipboard.writeText(prompt);
                setPromptCopied(true);
                setTimeout(() => setPromptCopied(false), 2000);
              };

              return (
                <div style={{ marginBottom: 16, background: 'var(--color-bg-main)', border: '1px solid #eaeded', borderRadius: 6, padding: '16px', boxShadow: 'var(--box-shadow-sm)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <div style={{ fontWeight: 'bold', fontSize: 14, color: '#232f3e' }}>AIプロンプト生成</div>
                    {(promptTopic || promptCount !== '5') && (
                      <button onClick={() => { setPromptTopic(''); setPromptCount('5'); }}
                        style={{ padding: '4px 12px', background: 'transparent', border: '1px solid #d1d5db', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: 'var(--color-text-sub)' }}>
                        リセット
                      </button>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: 180 }}>
                      <div style={{ fontSize: 11, color: 'var(--color-text-light)', marginBottom: 4 }}>トピック / キーワード（任意）</div>
                      <input value={promptTopic} onChange={e => setPromptTopic(e.target.value)}
                        placeholder="例: S3のセキュリティ、EC2のネットワーク"
                        style={{ width: '100%', padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, boxSizing: 'border-box' }} />
                    </div>
                    <div style={{ width: 80 }}>
                      <div style={{ fontSize: 11, color: 'var(--color-text-light)', marginBottom: 4 }}>問題数</div>
                      <input type="number" value={promptCount} onChange={e => setPromptCount(e.target.value)}
                        min={1} max={20}
                        style={{ width: '100%', padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, boxSizing: 'border-box' }} />
                    </div>
                  </div>

                  <div style={{ position: 'relative' }}>
                    <pre style={{ background: 'var(--color-bg-white)', border: '1px solid #d1d5db', borderRadius: 6, padding: '12px 14px',
                      fontSize: 12, fontFamily: 'monospace', whiteSpace: 'pre-wrap', margin: 0,
                      color: '#333', lineHeight: 1.6, maxHeight: 260, overflowY: 'auto' }}>
                      {prompt}
                    </pre>
                    <button onClick={copyPrompt}
                      style={{ position: 'absolute', top: 8, right: 8,
                        padding: '4px 12px', fontSize: 12, borderRadius: 'var(--border-radius-md)', cursor: 'pointer',
                        background: promptCopied ? 'var(--color-feedback-correct-bg)' : 'var(--color-bg-white)',
                        color: promptCopied ? 'var(--color-success)' : 'var(--color-primary)',
                        border: `1.5px solid ${promptCopied ? 'var(--color-success)' : 'var(--color-primary)'}`,
                        transition: 'all 0.2s', fontWeight: 700 }}>
                      {promptCopied ? <><span style={{ display: 'inline-flex', alignItems: 'center', verticalAlign: '-2px', marginRight: 'var(--spacing-xs)' }}><IconCheck size={13} /></span>コピー済み</> : 'コピー'}
                    </button>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--color-text-light)', marginTop: 6 }}>
                    このプロンプトをChatGPT / Claude / Gemini に貼り付け → 出力JSONをそのまま下の「問題インポート」欄へ
                  </div>
                </div>
              );
            })()}

            <hr style={{ border: 'none', borderTop: '1px solid #e0e0e0', margin: '24px 0 20px' }} />

            {/* 問題インポート（JSON） */}
            <div style={{ fontSize: 12, color: 'var(--color-text-light)', marginBottom: 6, fontWeight: 700 }}>問題インポート</div>
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, gap: 8, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 12, color: 'var(--color-text-light)' }}>JSONを貼り付けまたはファイルをアップロード</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {importJson && (
                    <button onClick={() => { setImportJson(''); setImportParsed(null); setImportResult(null); setImportError(''); setImportMismatchTypes([]); }}
                      style={{ padding: '5px 12px', background: 'transparent', border: '1px solid #d1d5db', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: 'var(--color-text-sub)' }}>
                      クリア
                    </button>
                  )}
                  <label style={{ padding: '5px 12px', background: 'var(--color-bg-main)', border: '1px solid #d1d5db', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
                    ファイルを選択
                    <input type="file" accept=".json" onChange={handleFileUpload} style={{ display: 'none' }} />
                  </label>
                </div>
              </div>
              <textarea value={importJson} onChange={e => { setImportJson(e.target.value); setImportParsed(null); setImportResult(null); setImportError(''); setImportMismatchTypes([]); }}
                placeholder={EXAMPLE}
                rows={12}
                style={{ width: '100%', padding: '10px', border: '1px solid #d1d5db', borderRadius: 6,
                  fontSize: 13, fontFamily: 'monospace', resize: 'vertical', boxSizing: 'border-box',
                  background: 'var(--color-bg-main)' }} />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
              <button onClick={handleParse} disabled={!importJson.trim()}
                style={{ padding: '8px 20px', background: importJson.trim() ? 'var(--color-text-sub)' : 'var(--color-border)',
                  color: importJson.trim() ? 'white' : 'var(--color-text-light)', border: 'none', borderRadius: 'var(--border-radius-md)', cursor: importJson.trim() ? 'pointer' : 'default', fontWeight: 700, fontSize: 14 }}>
                構文チェック
              </button>
              {importParsed && (
                <button onClick={handleImport} disabled={importing}
                  style={{ padding: '8px 24px', background: importing ? 'var(--color-border)' : 'transparent',
                    color: importing ? 'var(--color-text-light)' : 'var(--color-primary)', border: `1.5px solid ${importing ? 'var(--color-border)' : 'var(--color-primary)'}`, borderRadius: 'var(--border-radius-md)', cursor: importing ? 'default' : 'pointer', fontWeight: 700, fontSize: 14 }}>
                  {importing ? 'インポート中...' : `${importParsed.length}件をインポート`}
                </button>
              )}
            </div>

            {importParsed && !importResult && (
              <div style={{ marginBottom: importMismatchTypes.length > 0 ? 8 : 16, padding: '10px 14px', background: 'var(--color-primary-light)', border: '1px solid #aab7b8', borderRadius: 6, fontSize: 13, color: 'var(--color-primary)' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', verticalAlign: '-2px', marginRight: 'var(--spacing-xs)' }}><IconCheck size={14} /></span>{importParsed.length}件の問題を認識しました。「{importExamType}」としてインポートします。
              </div>
            )}
            {importMismatchTypes.length > 0 && !importResult && (
              <div style={{ marginBottom: 16, padding: '10px 14px', background: '#fff8e1', border: '1.5px solid #f9a825', borderRadius: 6, fontSize: 13, color: '#7c4d00' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', verticalAlign: '-2px', marginRight: 'var(--spacing-xs)' }}><IconAlertTriangle size={14} /></span>JSON内に選択中の試験種別（<strong>{importExamType}</strong>）と異なる examType が含まれています：<strong>{importMismatchTypes.join(', ')}</strong>。
                該当問題はドロップダウンではなく <strong>JSON内の examType のままインポート</strong>されます。意図的でない場合はドロップダウンを正しい試験種別に切り替えてください。
              </div>
            )}
            {importError && (
              <div style={{ marginBottom: 16, padding: '10px 14px', background: 'var(--color-danger-light)', border: '1px solid #f5a09b', borderRadius: 6, fontSize: 13, color: 'var(--color-danger)' }}>
                エラー: {importError}
              </div>
            )}
            {importResult && (
              <div style={{ marginBottom: 16, padding: '14px 16px', background: '#eafaf1', border: '1px solid #6eb57d', borderRadius: 6 }}>
                <div style={{ fontWeight: 'bold', color: '#27ae60', marginBottom: 6 }}><span style={{ display: 'inline-flex', alignItems: 'center', verticalAlign: '-2px', marginRight: 'var(--spacing-xs)' }}><IconCheck size={14} /></span>{importResult.count}件をインポートしました</div>
                <div style={{ fontSize: 12, color: '#555', fontFamily: 'monospace' }}>{importResult.ids.join(', ')}</div>
              </div>
            )}
          </div>
        );
      })()}

      {/* ── コラム管理 ── */}
      {tab === 'tips' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <p style={{ color: 'var(--color-text-light)', fontSize: 13, margin: 0 }}>
              {loadingT ? '読み込み中...' : `${tips.length} 件`}
            </p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <SortSelect value={tipSort} onChange={setTipSort} options={[
                { key: 'title_asc', label: 'タイトル（A→Z）' },
                { key: 'title_desc', label: 'タイトル（Z→A）' },
                { key: 'examType_asc', label: '試験種別' },
              ]} />
              <button onClick={() => { setShowTipPrompt(v => !v); setShowTipImport(false); setShowTipForm(false); }}
                style={{ padding: '7px 16px', background: showTipPrompt ? 'var(--color-primary-light)' : 'transparent', color: 'var(--color-primary)', border: '1.5px solid var(--color-primary)', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
                AIプロンプト
              </button>
              <button onClick={() => { setShowTipImport(v => !v); setShowTipForm(false); setShowTipPrompt(false); }}
                style={{ padding: '7px 16px', background: showTipImport ? 'var(--color-primary-light)' : 'transparent', color: 'var(--color-primary)', border: '1.5px solid var(--color-primary)', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
                JSONインポート
              </button>
              <button onClick={() => { setEditingTip(null); setTipForm({ examType: 'ALL', title: '', content: '' }); setShowTipForm(true); setShowTipImport(false); setShowTipPrompt(false); }}
                style={{ padding: '7px 16px', background: 'transparent', color: 'var(--color-primary)', border: '1.5px solid var(--color-primary)', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
                ＋ 手動追加
              </button>
            </div>
          </div>

          {/* AIプロンプト生成 */}
          {showTipPrompt && (() => {
            const tipExamFull = tipPromptExamType === 'ALL'
              ? 'AWS認定試験全般'
              : `${EXAM_CONFIGS[tipPromptExamType]?.fullName} (${EXAM_CONFIGS[tipPromptExamType]?.examCode})`;
            const topic = tipPromptTopic.trim();
            const count = parseInt(tipPromptCount) || 5;
            const prompt = `あなたはAWSクラウドの教育コンテンツ作成の専門家です。
以下の条件に従い、学習コラム（豆知識）を${count}件作成し、JSON配列のみを出力してください（前後の説明文は不要）。

【対象試験】${tipExamFull}
${topic ? `【トピック / キーワード】${topic}` : '【トピック / キーワード】指定なし（対象試験の範囲から幅広く作成すること）'}

【作成ルール】
・タイトルは30字以内で、内容を端的に表すこと
・本文は100〜250字程度で、試験に役立つ実践的な知識を書くこと
・「〜です。〜ます。」調の丁寧語で統一すること
・AWSサービスの具体的な特徴・制限・ベストプラクティスを含めること
・試験に出やすい落とし穴や覚え方のヒントがあれば含めること
${tipPromptExamType !== 'ALL' ? `・examType には "${tipPromptExamType}" を設定すること` : '・examType には対象試験に応じて "CLF" / "SAA" / "SAP" / "ALL" のいずれかを設定すること'}

【出力形式】
[
  {
    "examType": "${tipPromptExamType === 'ALL' ? 'SAA' : tipPromptExamType}",
    "title": "コラムタイトル",
    "content": "コラム本文（100〜250字）"
  }
]`;

            const copyPrompt = () => {
              navigator.clipboard.writeText(prompt);
              setTipPromptCopied(true);
              setTimeout(() => setTipPromptCopied(false), 2000);
            };

            return (
              <div style={{ border: '1px solid #eaeded', borderRadius: 6, padding: '20px 24px', marginBottom: 20, background: 'var(--color-bg-main)', boxShadow: 'var(--box-shadow-sm)' }}>
                <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--color-text-main)', marginBottom: 14 }}>AIプロンプト生成</div>

                <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <div>
                    <div style={{ fontSize: 12, color: 'var(--color-text-sub)', fontWeight: 700, marginBottom: 6 }}>対象試験</div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      {['ALL', 'CLF', 'SAA', 'SAP', 'DOP', 'AIF', 'AIB', 'MLA', 'AIP'].map(t => (
                        <React.Fragment key={t}>
                          <button type="button" onClick={() => setTipPromptExamType(t)}
                            style={{ padding: '4px 12px', border: tipPromptExamType === t ? '2px solid' : '1.5px solid', borderRadius: 6, cursor: 'pointer', fontSize: 13,
                              borderColor: tipPromptExamType === t ? 'var(--color-primary)' : 'var(--color-border)',
                              background: tipPromptExamType === t ? 'var(--color-primary-light)' : 'transparent',
                              color: tipPromptExamType === t ? 'var(--color-primary)' : 'var(--color-text-sub)',
                              fontWeight: tipPromptExamType === t ? 700 : 400 }}>
                            {t}
                          </button>
                          {t === 'ALL' && <span style={{ width: 1, height: 16, background: 'var(--color-border)', display: 'inline-block', flexShrink: 0 }} />}
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <div style={{ fontSize: 12, color: 'var(--color-text-sub)', fontWeight: 700, marginBottom: 6 }}>トピック / キーワード（任意）</div>
                    <input value={tipPromptTopic} onChange={e => setTipPromptTopic(e.target.value)}
                      placeholder="例: S3のライフサイクル、EC2のインスタンスタイプ"
                      style={{ width: '100%', padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, boxSizing: 'border-box', outline: 'none' }}
                      onFocus={e => e.currentTarget.style.borderColor = 'var(--color-primary)'}
                      onBlur={e => e.currentTarget.style.borderColor = 'var(--color-border)'}
                    />
                  </div>
                  <div style={{ width: 80 }}>
                    <div style={{ fontSize: 12, color: 'var(--color-text-sub)', fontWeight: 700, marginBottom: 6 }}>件数</div>
                    <input type="number" value={tipPromptCount} onChange={e => setTipPromptCount(e.target.value)}
                      min={1} max={20}
                      style={{ width: '100%', padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, boxSizing: 'border-box', outline: 'none' }}
                      onFocus={e => e.currentTarget.style.borderColor = 'var(--color-primary)'}
                      onBlur={e => e.currentTarget.style.borderColor = 'var(--color-border)'}
                    />
                  </div>
                </div>

                <div style={{ position: 'relative' }}>
                  <pre style={{ background: 'var(--color-bg-white)', border: '1px solid #d1d5db', borderRadius: 6, padding: '12px 14px',
                    fontSize: 12, fontFamily: 'monospace', whiteSpace: 'pre-wrap', margin: 0,
                    color: 'var(--color-text-main)', lineHeight: 1.6, maxHeight: 280, overflowY: 'auto' }}>
                    {prompt}
                  </pre>
                  <button onClick={copyPrompt}
                    style={{ position: 'absolute', top: 8, right: 8,
                      padding: '4px 12px', fontSize: 12, borderRadius: 'var(--border-radius-md)', cursor: 'pointer',
                      background: tipPromptCopied ? 'var(--color-feedback-correct-bg)' : 'var(--color-bg-white)',
                      color: tipPromptCopied ? 'var(--color-success)' : 'var(--color-primary)',
                      border: `1.5px solid ${tipPromptCopied ? 'var(--color-success)' : 'var(--color-primary)'}`,
                      transition: 'all 0.2s', fontWeight: 700 }}>
                    {tipPromptCopied ? <><span style={{ display: 'inline-flex', alignItems: 'center', verticalAlign: '-2px', marginRight: 'var(--spacing-xs)' }}><IconCheck size={13} /></span>コピー済み</> : 'コピー'}
                  </button>
                </div>
                <div style={{ fontSize: 11, color: 'var(--color-text-light)', marginTop: 6 }}>
                  このプロンプトをChatGPT / Claude / Gemini に貼り付け → 出力JSONを「JSONインポート」に貼り付けて登録
                </div>
              </div>
            );
          })()}

          {/* JSONインポートフォーム */}
          {showTipImport && (
            <div style={{ border: '1px solid #eaeded', borderRadius: 6, padding: '20px 24px', marginBottom: 20, background: 'var(--color-bg-main)', boxShadow: 'var(--box-shadow-sm)' }}>
              <h4 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 700 }}>コラムJSONインポート</h4>

              {/* デフォルト試験種別 */}
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 12, color: 'var(--color-text-sub)', fontWeight: 700, marginBottom: 6 }}>
                  デフォルト試験種別 <span style={{ fontWeight: 400 }}>（JSON内に examType がない場合に使用）</span>
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  {['ALL', 'CLF', 'SAA', 'SAP'].map(t => (
                    <React.Fragment key={t}>
                      <button type="button" onClick={() => setTipImportExamType(t)}
                        style={{ padding: '5px 14px', border: tipImportExamType === t ? '2px solid' : '1.5px solid', borderRadius: 6, cursor: 'pointer', fontSize: 13,
                          background: tipImportExamType === t ? 'var(--color-primary-light)' : 'transparent',
                          color: tipImportExamType === t ? 'var(--color-primary)' : 'var(--color-text-sub)',
                          borderColor: tipImportExamType === t ? 'var(--color-primary)' : 'var(--color-border)',
                          fontWeight: tipImportExamType === t ? 700 : 400 }}>
                        {t}
                      </button>
                      {t === 'ALL' && <span style={{ width: 1, height: 16, background: 'var(--color-border)', display: 'inline-block', flexShrink: 0 }} />}
                    </React.Fragment>
                  ))}
                </div>
              </div>

              {/* JSON入力 */}
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12, color: 'var(--color-text-sub)', fontWeight: 700, marginBottom: 6 }}>JSON</div>
                <textarea
                  value={tipImportJson}
                  onChange={e => { setTipImportJson(e.target.value); setTipImportParsed(null); setTipImportError(''); setTipImportResult(null); }}
                  placeholder={JSON.stringify([{ examType: 'SAA', title: 'S3の結果整合性について', content: 'Amazon S3は強力な結果整合性を提供しており...' }], null, 2)}
                  rows={10}
                  style={{ width: '100%', padding: '10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, fontFamily: 'monospace', resize: 'vertical', boxSizing: 'border-box', background: 'var(--color-bg-white)', outline: 'none' }}
                  onFocus={e => e.currentTarget.style.borderColor = 'var(--color-primary)'}
                  onBlur={e => e.currentTarget.style.borderColor = 'var(--color-border)'}
                />
              </div>

              {/* エラー・結果 */}
              {tipImportError && (
                <div style={{ marginBottom: 12, padding: '10px 14px', background: '#fdf2f2', border: '1px solid #f5a09b', borderRadius: 6, fontSize: 13, color: 'var(--color-danger)' }}>
                  エラー: {tipImportError}
                </div>
              )}
              {tipImportParsed && !tipImportResult && (
                <div style={{ marginBottom: 12, padding: '10px 14px', background: 'var(--color-primary-light)', border: '1px solid #aab7b8', borderRadius: 6, fontSize: 13, color: 'var(--color-primary)' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', verticalAlign: '-2px', marginRight: 'var(--spacing-xs)' }}><IconCheck size={14} /></span>{tipImportParsed.length}件を認識しました
                </div>
              )}
              {tipImportResult !== null && (
                <div style={{ marginBottom: 12, padding: '10px 14px', background: '#eafaf1', border: '1px solid #6eb57d', borderRadius: 6, fontSize: 13, color: 'var(--color-success)', fontWeight: 700 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', verticalAlign: '-2px', marginRight: 'var(--spacing-xs)' }}><IconCheck size={14} /></span>{tipImportResult}件をインポートしました
                </div>
              )}

              {/* ボタン */}
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => {
                    setTipImportError('');
                    setTipImportParsed(null);
                    setTipImportResult(null);
                    try {
                      const parsed = JSON.parse(tipImportJson);
                      if (!Array.isArray(parsed)) throw new Error('配列形式にしてください');
                      for (const t of parsed) {
                        if (!t.title?.trim()) throw new Error('title が必要です');
                        if (!t.content?.trim()) throw new Error('content が必要です');
                      }
                      setTipImportParsed(parsed);
                    } catch (e: any) {
                      setTipImportError(e.message || 'JSONの形式が正しくありません');
                    }
                  }}
                  disabled={!tipImportJson.trim()}
                  style={{ padding: '7px 20px', background: tipImportJson.trim() ? 'var(--color-text-sub)' : 'var(--color-border)', color: tipImportJson.trim() ? 'white' : 'var(--color-text-light)', border: 'none', borderRadius: 'var(--border-radius-md)', cursor: tipImportJson.trim() ? 'pointer' : 'default', fontSize: 13, fontWeight: 700 }}>
                  構文チェック
                </button>
                {tipImportParsed && (
                  <button
                    onClick={async () => {
                      setTipImporting(true);
                      setTipImportResult(null);
                      try {
                        const res = await adminFetch(`${API_ENDPOINT}/admin/tips/bulk`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ tips: tipImportParsed, defaultExamType: tipImportExamType })
                        });
                        const data = await res.json();
                        if (!res.ok) throw new Error(data.error || '失敗しました');
                        setTipImportResult(data.count);
                        setTipImportJson('');
                        setTipImportParsed(null);
                        fetchTips();
                      } catch (e: any) {
                        setTipImportError(e.message);
                      } finally {
                        setTipImporting(false);
                      }
                    }}
                    disabled={tipImporting}
                    style={{ padding: '7px 24px', background: tipImporting ? 'var(--color-border)' : 'transparent', color: tipImporting ? 'var(--color-text-light)' : 'var(--color-primary)', border: `1.5px solid ${tipImporting ? 'var(--color-border)' : 'var(--color-primary)'}`, borderRadius: 'var(--border-radius-md)', cursor: tipImporting ? 'default' : 'pointer', fontSize: 13, fontWeight: 700 }}>
                    {tipImporting ? 'インポート中...' : `${tipImportParsed.length}件をインポート`}
                  </button>
                )}
              </div>

              {/* フォーマット説明 */}
              <div style={{ marginTop: 16, padding: '12px 16px', background: 'var(--color-bg-main)', borderRadius: 6, fontSize: 12, color: 'var(--color-text-sub)' }}>
                <strong style={{ display: 'block', marginBottom: 4 }}>JSONフォーマット</strong>
                各オブジェクトに <code>title</code>（必須）、<code>content</code>（必須）、<code>examType</code>（任意: ALL / CLF / SAA / SAP）を含めてください。
                examType を省略するとデフォルト試験種別が使用されます。
              </div>
            </div>
          )}

          {/* フォーム */}
          {showTipForm && (
            <div style={{ border: '1px solid #eaeded', borderRadius: 6, padding: 20, marginBottom: 20, background: 'var(--color-bg-main)', boxShadow: 'var(--box-shadow-sm)' }}>
              <h4 style={{ margin: '0 0 14px', fontSize: 15, fontWeight: 700, color: 'var(--color-text-main)' }}>{editingTip ? 'コラムを編集' : '新規コラム'}</h4>
              <div style={{ display: 'flex', gap: 6, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                {['ALL', 'CLF', 'SAA', 'SAP'].map(t => (
                  <React.Fragment key={t}>
                    <button type="button" onClick={() => setTipForm(f => ({ ...f, examType: t }))}
                      style={{ padding: '4px 12px', border: tipForm.examType === t ? '2px solid' : '1.5px solid', borderRadius: 6, cursor: 'pointer', fontSize: 13,
                        borderColor: tipForm.examType === t ? 'var(--color-primary)' : 'var(--color-border)',
                        background: tipForm.examType === t ? 'var(--color-primary-light)' : 'transparent',
                        color: tipForm.examType === t ? 'var(--color-primary)' : 'var(--color-text-sub)',
                        fontWeight: tipForm.examType === t ? 700 : 400 }}>
                      {t}
                    </button>
                    {t === 'ALL' && <span style={{ width: 1, height: 16, background: 'var(--color-border)', display: 'inline-block', flexShrink: 0 }} />}
                  </React.Fragment>
                ))}
              </div>
              <input
                value={tipForm.title}
                onChange={e => setTipForm(f => ({ ...f, title: e.target.value }))}
                placeholder="タイトル"
                style={{ width: '100%', padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, marginBottom: 8, boxSizing: 'border-box', outline: 'none' }}
                onFocus={e => e.currentTarget.style.borderColor = 'var(--color-primary)'}
                onBlur={e => e.currentTarget.style.borderColor = 'var(--color-border)'}
              />
              <textarea
                value={tipForm.content}
                onChange={e => setTipForm(f => ({ ...f, content: e.target.value }))}
                placeholder="内容"
                rows={4}
                style={{ width: '100%', padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, resize: 'vertical', boxSizing: 'border-box', outline: 'none' }}
                onFocus={e => e.currentTarget.style.borderColor = 'var(--color-primary)'}
                onBlur={e => e.currentTarget.style.borderColor = 'var(--color-border)'}
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 12, borderTop: '1px solid #eaeded', paddingTop: 12 }}>
                <button onClick={handleSaveTip}
                  style={{ padding: '7px 20px', background: '#ff9900', color: '#fff', border: '1px solid transparent', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', fontWeight: 700, fontSize: 14 }}>
                  保存
                </button>
                <button onClick={() => { setShowTipForm(false); setEditingTip(null); }}
                  style={{ padding: '7px 16px', border: '1px solid var(--color-border)', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', background: 'transparent', fontWeight: 700, fontSize: 14 }}>
                  キャンセル
                </button>
              </div>
            </div>
          )}

          {/* コラム一覧 */}
          {sortItems(tips, tipSort, {
            title: t => t.title,
            examType: t => t.examType,
          }).map(tip => (
            <div key={tip.tipId} style={{ border: '1px solid #eaeded', borderRadius: 6, padding: '12px 16px', marginBottom: 8, background: 'var(--color-bg-white)', boxShadow: 'var(--box-shadow-sm)' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <span style={{
                  background: '#232f3e',
                  color: 'white', fontSize: 11, padding: '2px 8px', borderRadius: 12, flexShrink: 0, marginTop: 2, fontWeight: 700,
                }}>{tip.examType}</span>
                <div style={{ flex: 1 }}>
                  <p style={{ margin: '0 0 4px', fontWeight: 700, fontSize: 14, color: 'var(--color-text-main)' }}>{tip.title}</p>
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--color-text-sub)', lineHeight: 1.6 }}>{tip.content}</p>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button onClick={() => { setEditingTip(tip); setTipForm({ examType: tip.examType, title: tip.title, content: tip.content }); setShowTipForm(true); }}
                    style={{ padding: '4px 10px', border: '1px solid var(--color-border)', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', background: 'transparent', fontSize: 12, fontWeight: 700 }} title="編集">
                    <IconPencil size={14} />
                  </button>
                  <button onClick={() => handleDeleteTip(tip)}
                    style={{ padding: '4px 10px', background: 'transparent', color: 'var(--color-danger)', border: '1px solid #d13212', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', fontSize: 12, fontWeight: 700 }} title="削除">
                    <IconTrash size={14} />
                  </button>
                </div>
              </div>
            </div>
          ))}

          {!loadingT && tips.length === 0 && (
            <p style={{ color: 'var(--color-text-light)', textAlign: 'center', padding: 40 }}>コラムはありません</p>
          )}
        </div>
      )}

      {/* ── コラムのネタ管理 ── */}
      {tab === 'columnideas' && (() => {
        const pending = columnIdeas.filter(i => i.status !== 'used');
        const used = columnIdeas.filter(i => i.status === 'used');
        const list = ciShowUsed ? used : pending;
        return (
          <div>
            <div style={{ fontSize: 13, color: 'var(--color-text-sub)', lineHeight: 1.7, marginBottom: 16, padding: '12px 16px', background: 'var(--color-bg-main)', borderRadius: 6, border: '1px solid var(--color-border)' }}>
              面白い AWS のネタをここに投稿しておくと、ローカルで <code style={{ background: 'var(--color-bg-white)', padding: '1px 6px', borderRadius: 4, fontWeight: 700 }}>gcs</code> コマンドを実行したときに、各ネタを公式ドキュメントで裏取りしてコラム（コラム管理タブに反映）に仕上げます。コラム化されたネタは自動的に「無効化（使用済み）」になり、履歴として残ります。
            </div>

            {/* 投稿フォーム */}
            <div style={{ border: '1px solid #eaeded', borderRadius: 6, padding: '20px 24px', marginBottom: 20, background: 'var(--color-bg-main)', boxShadow: 'var(--box-shadow-sm)' }}>
              <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--color-text-main)', marginBottom: 14 }}>ネタを投稿</div>
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12, color: 'var(--color-text-sub)', fontWeight: 700, marginBottom: 6 }}>ネタ（収集したAWS関連の面白い話・トリビア・気づきなど）</div>
                <textarea
                  value={ciText}
                  onChange={e => setCiText(e.target.value)}
                  placeholder="例: S3 は元々 2006 年にローンチされた AWS 最初のサービスの一つで、当初の SLA は…"
                  rows={4}
                  style={{ width: '100%', padding: '10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, resize: 'vertical', boxSizing: 'border-box', background: 'var(--color-bg-white)', outline: 'none', lineHeight: 1.6 }}
                  onFocus={e => e.currentTarget.style.borderColor = 'var(--color-primary)'}
                  onBlur={e => e.currentTarget.style.borderColor = 'var(--color-border)'}
                />
              </div>
              <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--color-text-sub)', fontWeight: 700, marginBottom: 6 }}>対象試験</div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    {['ALL', 'CLF', 'SAA', 'SAP', 'DOP', 'AIF', 'AIB', 'MLA', 'AIP'].map(t => (
                      <React.Fragment key={t}>
                        <button type="button" onClick={() => setCiExamType(t)}
                          style={{ padding: '4px 12px', border: ciExamType === t ? '2px solid' : '1.5px solid', borderRadius: 6, cursor: 'pointer', fontSize: 13,
                            borderColor: ciExamType === t ? 'var(--color-primary)' : 'var(--color-border)',
                            background: ciExamType === t ? 'var(--color-primary-light)' : 'transparent',
                            color: ciExamType === t ? 'var(--color-primary)' : 'var(--color-text-sub)',
                            fontWeight: ciExamType === t ? 700 : 400 }}>
                          {t}
                        </button>
                        {t === 'ALL' && <span style={{ width: 1, height: 16, background: 'var(--color-border)', display: 'inline-block', flexShrink: 0 }} />}
                      </React.Fragment>
                    ))}
                  </div>
                </div>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div style={{ fontSize: 12, color: 'var(--color-text-sub)', fontWeight: 700, marginBottom: 6 }}>メモ / 参考URL（任意・裏取りのヒント）</div>
                  <input value={ciNote} onChange={e => setCiNote(e.target.value)}
                    placeholder="例: 公式ブログ https://aws.amazon.com/...、出典など"
                    style={{ width: '100%', padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, boxSizing: 'border-box', outline: 'none' }}
                    onFocus={e => e.currentTarget.style.borderColor = 'var(--color-primary)'}
                    onBlur={e => e.currentTarget.style.borderColor = 'var(--color-border)'}
                  />
                </div>
              </div>
              <button onClick={addColumnIdea} disabled={!ciText.trim() || ciSaving}
                style={{ padding: '8px 24px', background: (!ciText.trim() || ciSaving) ? 'var(--color-border)' : 'var(--color-primary)', color: (!ciText.trim() || ciSaving) ? 'var(--color-text-light)' : 'var(--color-btn-primary-text)', border: 'none', borderRadius: 'var(--border-radius-md)', cursor: (!ciText.trim() || ciSaving) ? 'default' : 'pointer', fontSize: 13, fontWeight: 700 }}>
                {ciSaving ? '投稿中...' : '＋ ネタを投稿'}
              </button>
            </div>

            {/* 一覧 切替 */}
            {/* モバイル(390px)で外側行・内側ボタン群ともflexWrap無しだったため、
                「未使用 0 件 / 使用済み 0 件」の長いテキストが幅を奪われて
                文字単位で改行される崩れが発生していた。両方に折り返しを許可する。 */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
              <p style={{ color: 'var(--color-text-light)', fontSize: 13, margin: 0 }}>
                {loadingCI ? '読み込み中...' : `未使用 ${pending.length} 件 / 使用済み ${used.length} 件`}
              </p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button onClick={() => setCiShowUsed(false)}
                  style={{ padding: '6px 14px', background: !ciShowUsed ? 'var(--color-primary-light)' : 'transparent', color: 'var(--color-primary)', border: '1.5px solid var(--color-primary)', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>未使用</button>
                <button onClick={() => setCiShowUsed(true)}
                  style={{ padding: '6px 14px', background: ciShowUsed ? 'var(--color-primary-light)' : 'transparent', color: 'var(--color-primary)', border: '1.5px solid var(--color-primary)', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>使用済み</button>
                <SortSelect value={ciSort} onChange={setCiSort} options={[
                  { key: 'createdAt_desc', label: '投稿日（新しい順）' },
                  { key: 'createdAt_asc', label: '投稿日（古い順）' },
                  { key: 'examType_asc', label: '試験種別' },
                ]} />
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {sortItems(list, ciSort, {
                createdAt: (i: any) => i.createdAt,
                examType: (i: any) => i.examType,
              }).map(idea => (
                <div key={idea.ideaId} style={{ border: '1px solid var(--color-border)', borderRadius: 8, padding: '14px 16px', background: 'var(--color-bg-white)', opacity: idea.status === 'used' ? 0.7 : 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-primary)', background: 'var(--color-primary-light)', padding: '2px 10px', borderRadius: 4 }}>{idea.examType || 'ALL'}</span>
                    {idea.status === 'used'
                      ? <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-light)', background: 'var(--color-bg-main)', padding: '2px 10px', borderRadius: 4, border: '1px solid var(--color-border)' }}>使用済み</span>
                      : <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-success)', background: 'var(--color-feedback-correct-bg)', padding: '2px 10px', borderRadius: 4 }}>未使用</span>}
                    <span style={{ fontSize: 11, color: 'var(--color-text-light)', marginLeft: 'auto' }}>{(idea.createdAt || '').slice(0, 10)}</span>
                  </div>
                  <div style={{ fontSize: 14, color: 'var(--color-text-main)', lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{idea.text}</div>
                  {idea.note && (
                    <div style={{ fontSize: 12, color: 'var(--color-text-sub)', marginTop: 6, wordBreak: 'break-word', display: 'flex', alignItems: 'flex-start', gap: 'var(--spacing-xs)' }}><span style={{ flexShrink: 0, marginTop: 2 }}><IconPenLine size={12} /></span>{idea.note}</div>
                  )}
                  {idea.resultTipId && (
                    <div style={{ fontSize: 11, color: 'var(--color-text-light)', marginTop: 6 }}>→ コラム化済み（tipId: {idea.resultTipId}）</div>
                  )}
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    {idea.status === 'used'
                      ? <button onClick={() => setColumnIdeaStatus(idea.ideaId, 'pending')}
                          style={{ padding: '5px 14px', background: 'transparent', color: 'var(--color-primary)', border: '1.5px solid var(--color-primary)', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>再有効化</button>
                      : <button onClick={() => setColumnIdeaStatus(idea.ideaId, 'used')}
                          style={{ padding: '5px 14px', background: 'transparent', color: 'var(--color-text-sub)', border: '1.5px solid var(--color-border)', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>無効化</button>}
                    <button onClick={() => deleteColumnIdea(idea.ideaId)}
                      style={{ padding: '5px 14px', background: 'transparent', color: 'var(--color-danger)', border: '1.5px solid var(--color-danger)', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>削除</button>
                  </div>
                </div>
              ))}
              {!loadingCI && list.length === 0 && (
                <p style={{ color: 'var(--color-text-light)', textAlign: 'center', padding: 40 }}>
                  {ciShowUsed ? '使用済みのネタはありません' : '未使用のネタはありません'}
                </p>
              )}
            </div>
          </div>
        );
      })()}

      {/* ── リリースノート管理 ── */}
      {tab === 'releases' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <p style={{ color: 'var(--color-text-light)', fontSize: 13, margin: 0 }}>
              {loadingRel ? '読み込み中...' : `${releases.length} 件`}
            </p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <SortSelect value={relSort} onChange={setRelSort} options={[
              { key: 'date_desc', label: '日付（新しい順）' },
              { key: 'date_asc', label: '日付（古い順）' },
              { key: 'title_asc', label: 'タイトル（A→Z）' },
            ]} />
            <button
              onClick={() => {
                setEditingRelease(null);
                setReleaseForm({ date: new Date().toISOString().slice(0, 10), title: '', body: '' });
                setShowReleaseForm(true);
              }}
              style={{ padding: '7px 16px', background: 'transparent', color: 'var(--color-primary)', border: '1.5px solid var(--color-primary)', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
              ＋ 新規追加
            </button>
            </div>
          </div>

          {showReleaseForm && (
            <div style={{ border: '1px solid #eaeded', borderRadius: 6, padding: '20px 24px', marginBottom: 20, background: 'var(--color-bg-main)', boxShadow: 'var(--box-shadow-sm)' }}>
              <h4 style={{ margin: '0 0 14px', fontSize: 15, fontWeight: 700, color: 'var(--color-text-main)' }}>
                {editingRelease ? 'リリースノートを編集' : '新規リリースノート'}
              </h4>
              <div style={{ marginBottom: 10 }}>
                <label style={{ display: 'block', fontSize: 12, color: 'var(--color-text-sub)', fontWeight: 700, marginBottom: 4 }}>日付</label>
                <input
                  type="date" value={releaseForm.date}
                  onChange={e => setReleaseForm(f => ({ ...f, date: e.target.value }))}
                  style={{ padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, outline: 'none' }}
                  onFocus={e => e.currentTarget.style.borderColor = 'var(--color-primary)'}
                  onBlur={e => e.currentTarget.style.borderColor = 'var(--color-border)'}
                />
              </div>
              <div style={{ marginBottom: 10 }}>
                <label style={{ display: 'block', fontSize: 12, color: 'var(--color-text-sub)', fontWeight: 700, marginBottom: 4 }}>タイトル</label>
                <input
                  value={releaseForm.title}
                  onChange={e => setReleaseForm(f => ({ ...f, title: e.target.value }))}
                  placeholder="例：問題追加・機能改善"
                  style={{ width: '100%', padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, boxSizing: 'border-box', outline: 'none' }}
                  onFocus={e => e.currentTarget.style.borderColor = 'var(--color-primary)'}
                  onBlur={e => e.currentTarget.style.borderColor = 'var(--color-border)'}
                />
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', fontSize: 12, color: 'var(--color-text-sub)', fontWeight: 700, marginBottom: 4 }}>本文</label>
                <textarea
                  value={releaseForm.body}
                  onChange={e => setReleaseForm(f => ({ ...f, body: e.target.value }))}
                  placeholder="変更内容を記入してください"
                  rows={5}
                  style={{ width: '100%', padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, resize: 'vertical', boxSizing: 'border-box', outline: 'none' }}
                  onFocus={e => e.currentTarget.style.borderColor = 'var(--color-primary)'}
                  onBlur={e => e.currentTarget.style.borderColor = 'var(--color-border)'}
                />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={handleSaveRelease}
                  style={{ padding: '7px 20px', background: '#ff9900', color: '#fff', border: '1px solid transparent', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', fontWeight: 700, fontSize: 14 }}>
                  保存
                </button>
                <button onClick={() => { setShowReleaseForm(false); setEditingRelease(null); }}
                  style={{ padding: '7px 16px', border: '1px solid var(--color-border)', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', background: 'transparent', fontWeight: 700, fontSize: 14 }}>
                  キャンセル
                </button>
              </div>
            </div>
          )}

          {sortItems(releases, relSort, {
            date: r => r.date,
            title: r => r.title,
          }).map(r => (
            <div key={r.releaseId} style={{ border: '1px solid #eaeded', borderRadius: 6, padding: '14px 18px', marginBottom: 8, background: 'var(--color-bg-white)', boxShadow: 'var(--box-shadow-sm)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, color: '#879596', fontWeight: 700, marginBottom: 3 }}>{r.date}</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-text-main)', marginBottom: 4 }}>{r.title}</div>
                  <div style={{ fontSize: 13, color: 'var(--color-text-sub)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{r.body}</div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button
                    onClick={() => { setEditingRelease(r); setReleaseForm({ date: r.date, title: r.title, body: r.body }); setShowReleaseForm(true); }}
                    style={{ padding: '4px 10px', border: '1px solid var(--color-border)', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', background: 'transparent', fontSize: 12, fontWeight: 700 }} title="編集">
                    <IconPencil size={14} />
                  </button>
                  <button
                    onClick={() => handleDeleteRelease(r)}
                    style={{ padding: '4px 10px', background: 'transparent', color: 'var(--color-danger)', border: '1px solid #d13212', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', fontSize: 12, fontWeight: 700 }} title="削除">
                    <IconTrash size={14} />
                  </button>
                </div>
              </div>
            </div>
          ))}

          {!loadingRel && releases.length === 0 && (
            <p style={{ color: 'var(--color-text-light)', textAlign: 'center', padding: 40 }}>リリースノートはありません</p>
          )}
        </div>
      )}

      {/* ── お知らせ管理 ── */}
      {tab === 'announcements' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <p style={{ color: 'var(--color-text-light)', fontSize: 13, margin: 0 }}>
              {loadingAnn ? '読み込み中...' : `${announcements.length} 件`}
            </p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <SortSelect value={annSort} onChange={setAnnSort} options={[
              { key: 'createdAt_desc', label: '作成日（新しい順）' },
              { key: 'createdAt_asc', label: '作成日（古い順）' },
              { key: 'publishedAt_desc', label: '公開日（新しい順）' },
              { key: 'status_asc', label: '状態（下書き→公開中）' },
              { key: 'title_asc', label: 'タイトル（A→Z）' },
            ]} />
            <button
              onClick={() => {
                setEditingAnnouncement(null);
                setAnnForm({ title: '', body: ANNOUNCEMENT_BUG_REPORT_TEMPLATE });
                setShowAnnForm(true);
              }}
              style={{ padding: '7px 16px', background: 'transparent', color: 'var(--color-primary)', border: '1.5px solid var(--color-primary)', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
              ＋ 新規追加
            </button>
            </div>
          </div>

          {showAnnForm && (
            <div style={{ border: '1px solid #eaeded', borderRadius: 6, padding: '20px 24px', marginBottom: 20, background: 'var(--color-bg-main)', boxShadow: 'var(--box-shadow-sm)' }}>
              <h4 style={{ margin: '0 0 14px', fontSize: 15, fontWeight: 700, color: 'var(--color-text-main)' }}>
                {editingAnnouncement ? 'お知らせを編集' : '新規お知らせ'}
              </h4>
              <div style={{ marginBottom: 10 }}>
                <label style={{ display: 'block', fontSize: 12, color: 'var(--color-text-sub)', fontWeight: 700, marginBottom: 4 }}>タイトル</label>
                <input
                  value={annForm.title}
                  onChange={e => setAnnForm(f => ({ ...f, title: e.target.value }))}
                  placeholder="例：一部の問題で選択肢が表示されない不具合について"
                  style={{ width: '100%', padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, boxSizing: 'border-box', outline: 'none' }}
                  onFocus={e => e.currentTarget.style.borderColor = 'var(--color-primary)'}
                  onBlur={e => e.currentTarget.style.borderColor = 'var(--color-border)'}
                />
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', fontSize: 12, color: 'var(--color-text-sub)', fontWeight: 700, marginBottom: 4 }}>本文</label>
                <textarea
                  value={annForm.body}
                  onChange={e => setAnnForm(f => ({ ...f, body: e.target.value }))}
                  placeholder="ユーザーに伝える内容を記入してください"
                  rows={5}
                  style={{ width: '100%', padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, resize: 'vertical', boxSizing: 'border-box', outline: 'none' }}
                  onFocus={e => e.currentTarget.style.borderColor = 'var(--color-primary)'}
                  onBlur={e => e.currentTarget.style.borderColor = 'var(--color-border)'}
                />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {editingAnnouncement ? (
                  <button onClick={handleSaveAnnouncement}
                    style={{ padding: '7px 20px', background: '#ff9900', color: '#fff', border: '1px solid transparent', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', fontWeight: 700, fontSize: 14 }}>
                    保存
                  </button>
                ) : (
                  <>
                    <button onClick={handleSaveAnnouncement}
                      style={{ padding: '7px 20px', border: '1px solid var(--color-border)', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', background: 'transparent', fontWeight: 700, fontSize: 14 }}>
                      下書き保存
                    </button>
                    <button onClick={handleSaveAndPublishAnnouncement}
                      style={{ padding: '7px 20px', background: '#ff9900', color: '#fff', border: '1px solid transparent', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', fontWeight: 700, fontSize: 14 }}>
                      今すぐ送信
                    </button>
                  </>
                )}
                <button onClick={() => { setShowAnnForm(false); setEditingAnnouncement(null); }}
                  style={{ padding: '7px 16px', border: '1px solid var(--color-border)', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', background: 'transparent', fontWeight: 700, fontSize: 14 }}>
                  キャンセル
                </button>
              </div>
            </div>
          )}

          {sortItems(announcements, annSort, {
            createdAt: a => a.createdAt,
            publishedAt: a => a.publishedAt,
            title: a => a.title,
            status: a => a.status,
          }).map(a => (
            <div key={a.announcementId} style={{ border: '1px solid #eaeded', borderRadius: 6, padding: '12px 14px', marginBottom: 8, background: 'var(--color-bg-white)', boxShadow: 'var(--box-shadow-sm)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={{
                  fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4, flexShrink: 0,
                  background: a.status === 'published' ? '#e6f4ea' : 'var(--color-bg-main)',
                  color: a.status === 'published' ? 'var(--color-success)' : 'var(--color-text-sub)',
                }}>
                  {a.status === 'published' ? '公開中' : '下書き'}
                </span>
                <span style={{ fontSize: 12, color: '#879596', fontWeight: 700, flexShrink: 0 }}>
                  {(a.publishedAt || a.createdAt)?.slice(0, 10)}
                </span>
              </div>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-text-main)', marginBottom: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.title}</div>
              <div style={{ fontSize: 13, color: 'var(--color-text-sub)', lineHeight: 1.5, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const, marginBottom: 10 }}>
                {a.body.replace(/\n+/g, ' ')}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button
                  onClick={() => { setEditingAnnouncement(a); setAnnForm({ title: a.title, body: a.body }); setShowAnnForm(true); }}
                  style={{ padding: '4px 10px', border: '1px solid var(--color-border)', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', background: 'transparent', fontSize: 12, fontWeight: 700 }} title="編集">
                  <IconPencil size={14} />
                </button>
                {a.status === 'published' ? (
                  <button
                    onClick={() => handleUnpublishAnnouncement(a)}
                    style={{ padding: '4px 10px', border: '1px solid var(--color-border)', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', background: 'transparent', fontSize: 12, fontWeight: 700 }}>
                    取り下げ
                  </button>
                ) : (
                  <button
                    onClick={() => handlePublishAnnouncement(a)}
                    style={{ padding: '4px 10px', background: '#ff9900', color: '#fff', border: '1px solid transparent', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
                    送信
                  </button>
                )}
                <button
                  onClick={() => handleDeleteAnnouncement(a)}
                  style={{ padding: '4px 10px', background: 'transparent', color: 'var(--color-danger)', border: '1px solid #d13212', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', fontSize: 12, fontWeight: 700 }} title="削除">
                  <IconTrash size={14} />
                </button>
              </div>
            </div>
          ))}

          {!loadingAnn && announcements.length === 0 && (
            <p style={{ color: 'var(--color-text-light)', textAlign: 'center', padding: 40 }}>お知らせはありません</p>
          )}
        </div>
      )}
      {tab === 'scan' && (() => {
        // 絞り込み・並べ替え・件数はサーバ側で確定済み（ページングのため）。
        const filteredFlagged = flaggedQuestions;
        const fixedCount = flaggedFixedCount;

        return (
          <div>
            {/* 進捗・統計 */}
            {!loadingFlagged && totalCount > 0 && validityFilter !== 'hidden' && validityFilter !== 'review' && (
              <div style={{ background: 'var(--color-bg-main)', border: '1px solid #eaeded', borderRadius: 8, padding: '14px 18px', marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
                  <div style={{ fontSize: 13, color: 'var(--color-text-sub)' }}>
                    確認済み <strong style={{ color: 'var(--color-text-main)', fontSize: 15 }}>{flaggedChecked}</strong> / {totalCount} 問
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--color-text-light)' }}>
                    未確認 {totalCount - flaggedChecked} 問
                  </div>
                </div>
                <div style={{ height: 8, background: 'var(--color-border)', borderRadius: 9999, overflow: 'hidden' }}>
                  <div style={{ height: '100%', background: 'var(--color-primary)', borderRadius: 9999, width: `${Math.min(100, (flaggedChecked / totalCount) * 100)}%`, transition: 'width 0.4s' }} />
                </div>
              </div>
            )}

            {/* フィルター・再読み込み */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {([
                  { key: 'review', label: `人の確認待ち (${flaggedReviewCount})` },
                  { key: 'all', label: '全チェック済み' },
                  { key: 'fixed', label: `AI修正済み (${fixedCount})` },
                  { key: 'audit', label: `監査指摘あり (${flaggedAuditCount})` },
                  { key: 'hidden', label: '非表示中' },
                ] as const).map(({ key, label }) => (
                  <button key={key} onClick={() => { setValidityFilter(key); fetchFlagged(key); }}
                    style={{ padding: '6px 14px', border: validityFilter === key ? '2px solid' : '1.5px solid', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', fontSize: 13, fontWeight: validityFilter === key ? 700 : 400,
                      background: validityFilter === key ? 'var(--color-primary-light)' : 'transparent',
                      color: validityFilter === key ? 'var(--color-primary)' : 'var(--color-text-sub)',
                      borderColor: validityFilter === key ? 'var(--color-primary)' : 'var(--color-border)', }}>
                    {label}
                    {key === 'all' && !loadingFlagged && validityFilter === 'all' && ` (${flaggedChecked})`}
                  </button>
                ))}
              </div>
              <button onClick={() => fetchFlagged(validityFilter)}
                style={{ padding: '6px 16px', background: 'transparent', color: 'var(--color-primary)', border: '1.5px solid var(--color-primary)', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
                再読み込み
              </button>
            </div>

            {/* 絞り込み・並べ替え（サーバ側で適用） */}
            {!loadingFlagged && flaggedQuestions.length > 0 && (
              <div style={{ background: '#f8f9fa', border: '1px solid #eaeded', borderRadius: 8, padding: '12px 16px', marginBottom: 16, display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
                {/* 試験種別 */}
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#879596', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>試験種別</div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                    {(['ALL', ...EXAM_TYPES] as string[]).map(et => (
                      <React.Fragment key={et}>
                        <button onClick={() => { setScanExamFilter(et); fetchFlagged(validityFilter, et, scanSort); }}
                          style={{ padding: '3px 10px', border: scanExamFilter === et ? '2px solid' : '1.5px solid', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', fontSize: 12, fontWeight: scanExamFilter === et ? 700 : 400,
                            background: scanExamFilter === et ? 'var(--color-secondary)' : 'transparent',
                            color: scanExamFilter === et ? 'white' : 'var(--color-text-sub)',
                            borderColor: scanExamFilter === et ? 'var(--color-secondary)' : 'var(--color-border)', }}>
                          {et}
                        </button>
                        {et === 'ALL' && <span style={{ width: 1, height: 14, background: 'var(--color-border)', display: 'inline-block', flexShrink: 0 }} />}
                      </React.Fragment>
                    ))}
                  </div>
                </div>

                {/* ソート */}
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#879596', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>並べ替え</div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {([
                      { key: 'date_desc', label: '新→古' },
                      { key: 'date_asc', label: '古→新' },
                    ] as const).map(({ key, label }) => (
                      <button key={key} onClick={() => { setScanSort(key); fetchFlagged(validityFilter, scanExamFilter, key); }}
                        style={{ padding: '3px 10px', border: scanSort === key ? '2px solid' : '1.5px solid', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', fontSize: 12, fontWeight: scanSort === key ? 700 : 400,
                          background: scanSort === key ? 'var(--color-primary-light)' : 'transparent',
                          color: scanSort === key ? 'var(--color-primary)' : 'var(--color-text-sub)',
                          borderColor: scanSort === key ? 'var(--color-primary)' : 'var(--color-border)', }}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 件数（表示中 / 条件に一致する全件） */}
                <div style={{ marginLeft: 'auto', alignSelf: 'flex-end', fontSize: 12, color: '#879596' }}>
                  {flaggedQuestions.length} / {flaggedMatched} 件
                </div>
              </div>
            )}

            {loadingFlagged && <p style={{ color: 'var(--color-text-sub)', fontSize: 13, padding: 20, textAlign: 'center' }}>読み込み中...</p>}

            {!loadingFlagged && flaggedQuestions.length === 0 && (
              <p style={{ color: 'var(--color-text-light)', textAlign: 'center', padding: 40 }}>
                {validityFilter === 'hidden' ? '非表示中の問題はありません' : validityFilter === 'review' ? '人の確認待ちの問題はありません' : 'チェック済みの問題はありません'}
              </p>
            )}

            {!loadingFlagged && flaggedQuestions.length > 0 && filteredFlagged.length === 0 && (
              <p style={{ color: 'var(--color-text-light)', textAlign: 'center', padding: 40 }}>フィルター条件に一致する問題はありません</p>
            )}

            {filteredFlagged.map(q => {
              const editLog: ValidityEditLog | null = (() => {
                if (!q.validityEditLog) return null;
                try { return JSON.parse(q.validityEditLog); } catch { return null; }
              })();
              const hasEdit = !!editLog;
              const borderColor = hasEdit ? '#d47500' : q.isHidden ? 'var(--color-danger)' : 'var(--color-primary)';
              return (
                <div key={q.questionId} style={{ background: 'var(--color-bg-white)', border: `1.5px solid ${q.isHidden ? 'var(--color-danger)' : 'var(--color-border)'}`, borderLeft: `4px solid ${borderColor}`, borderRadius: 6, padding: '14px 18px', marginBottom: 8, boxShadow: 'var(--box-shadow-sm)' }}>
                  {/* ヘッダー行 */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                    <span style={{ background: '#232f3e', color: 'white', fontSize: 11, padding: '2px 8px', borderRadius: 12, fontWeight: 700 }}>{q.examType}</span>
                    {qDomainName(q as any) && (
                      <span style={{ fontSize: 11, color: '#879596', background: 'var(--color-bg-main)', padding: '2px 8px', borderRadius: 12 }}>{qDomainName(q as any)}</span>
                    )}
                    {q.humanReviewRequestedAt ? null : hasEdit ? (
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#d47500', background: '#fdf3e1', padding: '2px 10px', borderRadius: 6, border: '1px solid #f5c98a' }}>
                        AI修正済
                      </span>
                    ) : (
                      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-primary)', background: 'var(--color-primary-light)', padding: '2px 10px', borderRadius: 6, border: '1px solid var(--color-primary)40' }}>
                        問題なし
                      </span>
                    )}
                    {q.isHidden && (
                      <span style={{ fontSize: 12, fontWeight: 700, color: 'white', background: 'var(--color-danger)', padding: '2px 8px', borderRadius: 6 }}>非表示中</span>
                    )}
                    {q.auditNote && (
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#9333ea', background: '#faf5ff', padding: '2px 10px', borderRadius: 6, border: '1px solid #e9d5ff' }}>
                        監査指摘
                      </span>
                    )}
                    <span style={{ fontSize: 11, color: 'var(--color-text-light)', marginLeft: 'auto', flexShrink: 0 }}>
                      AI確認: {q.validityCheckedAt ? new Date(q.validityCheckedAt).toLocaleDateString('ja-JP') : '未チェック'}
                    </span>
                  </div>

                  {/* 監査指摘（事実誤りではないため自動修正されず、人の判断が要る） */}
                  {q.auditNote && (
                    <div style={{ margin: '0 0 10px', border: '1px solid #e9d5ff', background: '#faf5ff', borderRadius: 6, padding: '8px 12px' }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: '#9333ea', marginBottom: 4 }}>
                        監査の指摘{q.auditFlaggedAt ? `（${new Date(q.auditFlaggedAt).toLocaleDateString('ja-JP')}）` : ''}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--color-text-sub)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{q.auditNote}</div>
                    </div>
                  )}

                  {/* 問題文 */}
                  <p style={{ fontSize: 13, color: 'var(--color-text-main)', margin: '0 0 8px', lineHeight: 1.6 }}>{q.questionText}</p>

                  {/* 人の確認待ち（docs/10-ops-review.md 4.1〜4.3） */}
                  {q.humanReviewRequestedAt && (() => {
                    const proposal: FixProposal | null = (() => { try { return q.fixProposalJson ? JSON.parse(q.fixProposalJson) : null; } catch { return null; } })();
                    const reasonLabel: Record<string, string> = {
                      'answer-change': 'AI が正解を変えようとしています。修正案を適用するか却下してください（確認まで非表示）',
                      'ai-delete': 'AI が削除を提案しています。問題なければ「問題なし」、誤りがあれば「誤りあり」のあと編集か削除を（確認まで非表示）',
                      'answer-changed-past': '2026-10-27 より前に、AI が人の確認なしで正解を変えた問題です。正しいか確かめてください',
                      'sample': '抜き取り検査の対象です。選択肢・正解・解説に誤りがないか確かめてください',
                    };
                    return (
                      <div style={{ margin: '0 0 var(--spacing-sm)', border: '1px solid var(--color-primary)', background: 'var(--color-primary-light)', borderRadius: 'var(--border-radius-md)', padding: 'var(--spacing-sm) var(--spacing-md)' }}>
                        <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-primary)', marginBottom: 'var(--spacing-xs)' }}>
                          人の確認待ち（{new Date(q.humanReviewRequestedAt).toLocaleDateString('ja-JP')}）
                        </div>
                        <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-main)', lineHeight: 1.6 }}>{reasonLabel[q.reviewReason || 'sample'] ?? q.reviewReason}</div>
                        {q.validityNote && <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', lineHeight: 1.6, marginTop: 'var(--spacing-xs)', whiteSpace: 'pre-wrap' }}>AI の理由: {q.validityNote}</div>}
                        {q.choices && (
                          <ol type="A" style={{ fontSize: 'var(--font-size-sm)', margin: 'var(--spacing-sm) 0 0', paddingLeft: 'var(--spacing-lg)', lineHeight: 1.6 }}>
                            {q.choices.map((c, i) => (
                              <li key={i} style={{ fontWeight: q.correctAnswers?.includes(c) ? 700 : 400 }}>
                                {q.correctAnswers?.includes(c) ? '✓ ' : ''}{c}
                              </li>
                            ))}
                          </ol>
                        )}
                        {q.explanation && <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', lineHeight: 1.6, marginTop: 'var(--spacing-sm)', whiteSpace: 'pre-wrap' }}>解説: {q.explanation}</div>}
                        {proposal && (
                          <div style={{ marginTop: 'var(--spacing-sm)', borderTop: '1px solid var(--color-border)', paddingTop: 'var(--spacing-sm)' }}>
                            <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-text-sub)', marginBottom: 'var(--spacing-xs)' }}>AI の修正案</div>
                            {proposal.questionText && <div style={{ fontSize: 'var(--font-size-sm)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>問題文: {proposal.questionText}</div>}
                            {(proposal.choices || q.choices) && (
                              <ol type="A" style={{ fontSize: 'var(--font-size-sm)', margin: 'var(--spacing-xs) 0 0', paddingLeft: 'var(--spacing-lg)', lineHeight: 1.6 }}>
                                {(proposal.choices || q.choices || []).map((c, i) => {
                                  const correct = (proposal.correctAnswers || q.correctAnswers || []).includes(c);
                                  return <li key={i} style={{ fontWeight: correct ? 700 : 400 }}>{correct ? '✓ ' : ''}{c}</li>;
                                })}
                              </ol>
                            )}
                            {proposal.explanation && <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', lineHeight: 1.6, marginTop: 'var(--spacing-xs)', whiteSpace: 'pre-wrap' }}>解説: {proposal.explanation}</div>}
                          </div>
                        )}
                        <div style={{ display: 'flex', gap: 'var(--spacing-sm)', flexWrap: 'wrap', marginTop: 'var(--spacing-sm)' }}>
                          {proposal ? (
                            <>
                              <Button size="sm" onClick={() => handleApplyFix(q)}>修正案を適用する</Button>
                              <Button size="sm" variant="outline" onClick={() => handleRejectFix(q)}>却下して元のまま表示</Button>
                            </>
                          ) : (
                            <>
                              <Button size="sm" variant="outline" onClick={() => handleHumanReview(q, 'ok')}>問題なし</Button>
                              <Button size="sm" variant="danger" onClick={() => handleHumanReview(q, 'ng')}>誤りあり</Button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })()}


                  {/* 修正ログ */}
                  {editLog && (
                    <div style={{ margin: '0 0 12px', border: '1px solid #d47500', borderRadius: 6, overflow: 'hidden' }}>
                      <div style={{ background: '#fdf3e1', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: '#d47500', textTransform: 'uppercase', letterSpacing: '0.05em' }}>AI修正ログ</span>
                        <span style={{ fontSize: 11, color: '#879596' }}>
                          {new Date(editLog.checkedAt).toLocaleString('ja-JP')}
                        </span>
                        {editLog.changes && (
                          <span style={{ fontSize: 11, color: 'var(--color-text-sub)' }}>
                            変更: {Object.keys(editLog.changes).map(k => ({ questionText: '問題文', choices: '選択肢', correctAnswers: '正解', explanation: '解説' }[k] ?? k)).join(' · ')}
                          </span>
                        )}
                      </div>
                      <div style={{ padding: '10px 12px', background: 'var(--color-bg-white)' }}>
                        <p style={{ fontSize: 12, color: 'var(--color-text-sub)', margin: '0 0 10px', lineHeight: 1.6 }}>{editLog.reason}</p>
                        {editLog.changes && Object.entries(editLog.changes).map(([field, diff]) => {
                          const fieldLabel: Record<string, string> = { questionText: '問題文', choices: '選択肢', correctAnswers: '正解', explanation: '解説' };
                          const label = fieldLabel[field] ?? field;
                          const before = Array.isArray((diff as any).before) ? (diff as any).before.join(' / ') : (diff as any).before;
                          const after = Array.isArray((diff as any).after) ? (diff as any).after.join(' / ') : (diff as any).after;
                          return (
                            <div key={field} style={{ marginBottom: 8 }}>
                              <div style={{ fontSize: 11, fontWeight: 700, color: '#879596', marginBottom: 4 }}>{label}</div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                <div style={{ fontSize: 12, padding: '5px 10px', borderRadius: 4, background: '#fff5f5', border: '1px solid #f5a09b', color: 'var(--color-danger)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                                  <span style={{ fontWeight: 700, marginRight: 6 }}>前:</span>{before}
                                </div>
                                <div style={{ fontSize: 12, padding: '5px 10px', borderRadius: 4, background: '#f0faf0', border: '1px solid #b7e5c0', color: 'var(--color-success)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                                  <span style={{ fontWeight: 700, marginRight: 6 }}>後:</span>{after}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* アクションボタン */}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button onClick={() => openEdit(q)} style={{ padding: '4px 9px', fontSize: 12, fontWeight: 700, borderRadius: 'var(--border-radius-md)', cursor: 'pointer', background: 'transparent', color: 'var(--color-text-sub)', border: '1px solid var(--color-border)' }} title="編集">
                      <IconPencil size={14} />
                    </button>
                    {q.isHidden ? (
                      <button onClick={() => handleVisibility(q, false)} style={{ padding: '4px 12px', fontSize: 12, fontWeight: 700, borderRadius: 'var(--border-radius-md)', cursor: 'pointer', background: 'transparent', color: 'var(--color-success)', border: '1px solid #037f0c' }}>
                        表示に戻す
                      </button>
                    ) : (
                      <button onClick={() => handleVisibility(q, true)} style={{ padding: '4px 12px', fontSize: 12, fontWeight: 700, borderRadius: 'var(--border-radius-md)', cursor: 'pointer', background: 'transparent', color: '#d47500', border: '1px solid #d47500' }}>
                        非表示にする
                      </button>
                    )}
                    <button
                      onClick={async () => {
                        if (!window.confirm('この問題を完全に削除しますか？')) return;
                        await adminFetch(`${API_ENDPOINT}/admin/questions/${q.questionId}`, { method: 'DELETE' });
                        setFlaggedQuestions(prev => prev.filter(x => x.questionId !== q.questionId));
                      }}
                      style={{ padding: '4px 9px', fontSize: 12, fontWeight: 700, borderRadius: 'var(--border-radius-md)', cursor: 'pointer', background: 'transparent', color: 'var(--color-danger)', border: '1px solid #d13212' }} title="削除">
                      <IconTrash size={14} />
                    </button>
                  </div>
                </div>
              );
            })}

            {/* ページング（全件一括だと 6MB 上限を超えるため 100件ずつ読む） */}
            {!loadingFlagged && flaggedHasMore && (
              <div style={{ textAlign: 'center', padding: 'var(--spacing-md) 0' }}>
                <Button variant="outline" onClick={fetchMoreFlagged} disabled={loadingMoreFlagged}>
                  {loadingMoreFlagged ? '読み込み中...' : `もっと読む（残り ${flaggedMatched - flaggedQuestions.length} 件）`}
                </Button>
              </div>
            )}
          </div>
        );
      })()}

      {/* ── メッセージ ── */}
      {tab === 'messages' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <p style={{ color: 'var(--color-text-sub)', fontSize: 13, margin: 0 }}>
              {loadingMsg ? '読み込み中...' : `${messages.length} 件`}
            </p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <SortSelect value={msgSort} onChange={setMsgSort} options={[
              { key: 'sentAt_desc', label: '受信日時（新しい順）' },
              { key: 'sentAt_asc', label: '受信日時（古い順）' },
              { key: 'subject_asc', label: '件名（A→Z）' },
            ]} />
            <button onClick={fetchMessages} style={{ padding: '6px 16px', background: 'transparent', color: 'var(--color-primary)', border: '1.5px solid var(--color-primary)', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', fontSize: 13, fontWeight: 700 }} title="再読み込み">
              <IconRefreshCw size={14} />
            </button>
            </div>
          </div>

          {!loadingMsg && messages.length === 0 && (
            <p style={{ color: 'var(--color-text-light)', textAlign: 'center', padding: 40 }}>メッセージはありません</p>
          )}

          {sortItems(messages, msgSort, {
            sentAt: m => m.sentAt,
            subject: m => m.subject,
          }).map(m => (
            <div key={m.messageId} style={{ border: '1px solid #eaeded', borderRadius: 6, padding: '16px 20px', marginBottom: 10, background: 'var(--color-bg-white)', boxShadow: 'var(--box-shadow-sm)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                <span style={{ fontSize: 12, color: '#879596' }}>
                  {new Date(m.sentAt).toLocaleString('ja-JP')}
                </span>
                <button
                  onClick={() => handleDeleteMessage(m)}
                  style={{ padding: '4px 12px', background: 'transparent', color: 'var(--color-danger)', border: '1px solid #d13212', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', fontSize: 12, fontWeight: 700, flexShrink: 0 }}
                 title="削除">
                  <IconTrash size={14} />
                </button>
              </div>
              {m.subject && (
                <p style={{ margin: '0 0 8px', fontWeight: 700, fontSize: 14, color: 'var(--color-text-main)' }}>{m.subject}</p>
              )}
              <p style={{ margin: 0, fontSize: 14, color: 'var(--color-text-main)', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{m.message}</p>
            </div>
          ))}
        </div>
      )}
      {/* ── 日めくりAWSサービス管理 ── */}
      {tab === 'dailyservice' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            <p style={{ color: 'var(--color-text-sub)', fontSize: 13, margin: 0 }}>
              {loadingDS ? '' : `${dailyServices.length} 件`}
            </p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <SortSelect value={dsSort} onChange={setDsSort} options={[
                { key: 'order_asc', label: '表示順（昇順）' },
                { key: 'order_desc', label: '表示順（降順）' },
                { key: 'createdAt_desc', label: '作成日（新しい順）' },
                { key: 'createdAt_asc', label: '作成日（古い順）' },
                { key: 'name_asc', label: 'サービス名（A→Z）' },
                { key: 'name_desc', label: 'サービス名（Z→A）' },
                { key: 'category_asc', label: 'カテゴリ' },
              ]} />
              <button onClick={fetchDailyServices}
                style={{ padding: '6px 14px', background: 'transparent', color: 'var(--color-primary)', border: '1.5px solid var(--color-primary)', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', fontSize: 13, fontWeight: 700 }} title="再読み込み">
                <IconRefreshCw size={14} />
              </button>
              <button
                onClick={() => { setEditingDS(null); setDsForm(emptyDSForm); setShowDSForm(true); }}
                style={{ padding: '6px 16px', background: '#ff9900', color: '#fff', border: 'none', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
                + 追加
              </button>
            </div>
          </div>

          {dsBrokenIcons.size > 0 && (
            <div style={{ border: '1px solid var(--color-danger)', background: '#fff5f4', borderRadius: 6, padding: '10px 14px', marginBottom: 12, fontSize: 13, color: 'var(--color-danger)', lineHeight: 1.6 }}>
              <b>アイコンを読み込めないサービスが {dsBrokenIcons.size} 件あります。</b><br />
              画像ファイルが未デプロイの可能性があります（<code>public/icons/aws/</code> に配置してコミットしてください）。
              直せない場合は「公開」をオフにすると、抽選対象からも図鑑の母数からも外れます。
            </div>
          )}

          {showDSForm && (
            <div style={{ border: '2px solid var(--color-primary)', borderRadius: 8, padding: '20px 20px 16px', marginBottom: 20, background: 'var(--color-bg-main)' }}>
              <h4 style={{ margin: '0 0 14px', fontSize: 15, color: 'var(--color-text-main)' }}>
                {editingDS ? 'サービス編集' : '新規サービス'}
              </h4>

              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 10, marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-sub)', marginBottom: 4 }}>アイコン（絵文字）</div>
                  <input value={dsForm.icon} onChange={e => setDsForm(f => ({ ...f, icon: e.target.value }))}
                    placeholder="☁️" style={{ width: '100%', padding: '7px 10px', border: '1px solid var(--color-border)', borderRadius: 6, fontSize: 20, boxSizing: 'border-box', outline: 'none', textAlign: 'center' }} />
                </div>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-sub)', marginBottom: 4 }}>表示順（小さいほど前）</div>
                  <input type="number" value={dsForm.order} onChange={e => setDsForm(f => ({ ...f, order: Number(e.target.value) }))}
                    style={{ width: '100%', padding: '7px 10px', border: '1px solid var(--color-border)', borderRadius: 6, fontSize: 14, boxSizing: 'border-box', outline: 'none' }} />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '2fr 1fr', gap: 10, marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-sub)', marginBottom: 4 }}>サービス名 *</div>
                  <input value={dsForm.name} onChange={e => setDsForm(f => ({ ...f, name: e.target.value }))}
                    placeholder="例: Amazon S3" style={{ width: '100%', padding: '7px 10px', border: '1px solid var(--color-border)', borderRadius: 6, fontSize: 14, boxSizing: 'border-box', outline: 'none' }} />
                </div>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-sub)', marginBottom: 4 }}>略称</div>
                  <input value={dsForm.shortName} onChange={e => setDsForm(f => ({ ...f, shortName: e.target.value }))}
                    placeholder="例: S3" style={{ width: '100%', padding: '7px 10px', border: '1px solid var(--color-border)', borderRadius: 6, fontSize: 14, boxSizing: 'border-box', outline: 'none' }} />
                </div>
              </div>

              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-sub)', marginBottom: 4 }}>カテゴリ</div>
                <input value={dsForm.category} onChange={e => setDsForm(f => ({ ...f, category: e.target.value }))}
                  placeholder="例: ストレージ / コンピューティング / データベース" style={{ width: '100%', padding: '7px 10px', border: '1px solid var(--color-border)', borderRadius: 6, fontSize: 14, boxSizing: 'border-box', outline: 'none' }} />
              </div>

              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-sub)', marginBottom: 4 }}>説明 *（カジュアルに）</div>
                <textarea value={dsForm.description} onChange={e => setDsForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="このサービスが何をするか、どんな場面で使うかを簡潔に"
                  rows={3} style={{ width: '100%', padding: '7px 10px', border: '1px solid var(--color-border)', borderRadius: 6, fontSize: 14, resize: 'vertical', boxSizing: 'border-box', outline: 'none' }} />
              </div>

              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-sub)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 'var(--spacing-xs)' }}><IconLightbulb size={12} />豆知識・意外な用途（任意）</div>
                <textarea value={dsForm.trivia} onChange={e => setDsForm(f => ({ ...f, trivia: e.target.value }))}
                  placeholder="「実はこんな使い方も！」「名前の由来は〇〇」など"
                  rows={2} style={{ width: '100%', padding: '7px 10px', border: '1px solid var(--color-border)', borderRadius: 6, fontSize: 14, resize: 'vertical', boxSizing: 'border-box', outline: 'none' }} />
              </div>

              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-sub)', marginBottom: 4 }}>公式ドキュメントURL（任意）</div>
                <input value={dsForm.docUrl} onChange={e => setDsForm(f => ({ ...f, docUrl: e.target.value }))}
                  placeholder="https://aws.amazon.com/jp/s3/" style={{ width: '100%', padding: '7px 10px', border: '1px solid var(--color-border)', borderRadius: 6, fontSize: 14, boxSizing: 'border-box', outline: 'none' }} />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 16, borderTop: '1px solid var(--color-border)', paddingTop: 12 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', color: 'var(--color-text-main)' }}>
                  <input type="checkbox" checked={dsForm.isActive}
                    onChange={e => setDsForm(f => ({ ...f, isActive: e.target.checked }))} />
                  公開（オフにすると抽選・図鑑の母数から外れる）
                </label>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                  <button onClick={saveDailyService}
                    style={{ padding: '7px 20px', background: '#ff9900', color: '#fff', border: 'none', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', fontWeight: 700, fontSize: 14 }}>
                    保存
                  </button>
                  <button onClick={() => { setShowDSForm(false); setEditingDS(null); setDsForm(emptyDSForm); }}
                    style={{ padding: '7px 16px', border: '1px solid var(--color-border)', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', background: 'transparent', fontWeight: 700, fontSize: 14 }}>
                    キャンセル
                  </button>
                </div>
              </div>
            </div>
          )}

          {loadingDS && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[0, 1, 2, 3].map(i => (
                <div key={i} style={{ border: '1px solid var(--color-border)', borderLeft: '4px solid var(--color-border)', borderRadius: 6, padding: '14px 16px', background: 'var(--color-bg-white)' }}>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <div className="skeleton" style={{ width: 36, height: 36, borderRadius: 6, flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="skeleton" style={{ width: 140, height: 16, borderRadius: 4, marginBottom: 8 }} />
                      <div className="skeleton" style={{ width: '80%', height: 13, borderRadius: 4 }} />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
                      <div className="skeleton" style={{ width: 44, height: 26, borderRadius: 'var(--border-radius-md)' }} />
                      <div className="skeleton" style={{ width: 44, height: 26, borderRadius: 'var(--border-radius-md)' }} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {!loadingDS && dailyServices.length === 0 && (
            <p style={{ color: 'var(--color-text-light)', textAlign: 'center', padding: 40 }}>サービスが登録されていません</p>
          )}

          {!loadingDS && sortItems(dailyServices, dsSort, {
            order: ds => Number(ds.order) || 0,
            createdAt: ds => ds.createdAt,
            name: ds => ds.name,
            category: ds => ds.category,
          }).map(ds => {
            const isImg = ds.icon.startsWith('/') || ds.icon.startsWith('http');
            const broken = dsBrokenIcons.has(ds.serviceId);
            const hidden = ds.isActive === false;
            return (
            <div key={ds.serviceId} style={{
              border: broken ? '1px solid var(--color-danger)' : '1px solid var(--color-border)',
              borderRadius: 6, padding: '12px 16px', marginBottom: 8,
              background: 'var(--color-bg-white)', opacity: hidden ? 0.6 : 1,
            }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, background: 'var(--color-bg-main)', borderRadius: 6, color: 'var(--color-primary)', fontSize: 22 }}>
                  {isImg
                    ? (broken
                        ? <span title="画像を読み込めません" style={{ color: 'var(--color-warning)', display: 'inline-flex', alignItems: 'center' }}><IconAlertTriangle size={20} /></span>
                        : <img src={ds.icon} alt={ds.name} style={{ width: 26, height: 26, objectFit: 'contain' }}
                            onError={() => setDsBrokenIcons(prev => prev.has(ds.serviceId) ? prev : new Set(prev).add(ds.serviceId))} />)
                    : isServiceIconKey(ds.icon)
                      ? <ServiceIcon name={ds.icon} size={22} />
                      : ds.icon}
                </div>
                <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                    <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--color-text-main)' }}>{ds.name}</span>
                    {ds.shortName && <span style={{ fontSize: 11, color: 'var(--color-text-light)', background: 'var(--color-bg-main)', padding: '1px 6px', borderRadius: 4 }}>{ds.shortName}</span>}
                    {ds.category && <span style={{ fontSize: 11, color: 'var(--color-primary)', background: 'var(--color-primary-light)', padding: '1px 7px', borderRadius: 12, fontWeight: 700 }}>{ds.category}</span>}
                    {broken && <span style={{ fontSize: 11, color: 'var(--color-danger)', border: '1px solid var(--color-danger)', padding: '1px 7px', borderRadius: 12, fontWeight: 700 }}>アイコン欠損</span>}
                    {hidden && <span style={{ fontSize: 11, color: 'var(--color-text-light)', border: '1px solid var(--color-border)', padding: '1px 7px', borderRadius: 12, fontWeight: 700 }}>非公開</span>}
                    <span style={{ fontSize: 11, color: 'var(--color-text-light)', marginLeft: 'auto' }}>
                      順: {ds.order}{ds.createdAt ? `　作成: ${ds.createdAt.slice(0, 10)}` : ''}
                    </span>
                  </div>
                  <p style={{ margin: '0 0 4px', fontSize: 13, color: 'var(--color-text-sub)', lineHeight: 1.5, wordBreak: 'break-word' }}>{ds.description}</p>
                  {ds.trivia && <p style={{ margin: 0, fontSize: 12, color: 'var(--color-text-light)', lineHeight: 1.5, wordBreak: 'break-word', display: 'flex', alignItems: 'flex-start', gap: 'var(--spacing-xs)' }}><span style={{ flexShrink: 0, marginTop: 2 }}><IconLightbulb size={12} /></span>{ds.trivia}</p>}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
                  <button
                    onClick={() => { setEditingDS(ds); setDsForm({ name: ds.name, shortName: ds.shortName ?? '', category: ds.category ?? '', icon: ds.icon, description: ds.description, trivia: ds.trivia ?? '', docUrl: ds.docUrl ?? '', order: ds.order, isActive: ds.isActive !== false }); setShowDSForm(true); }}
                    style={{ padding: '4px 10px', border: '1px solid var(--color-border)', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', background: 'transparent', fontSize: 11, fontWeight: 700 }} title="編集">
                    <IconPencil size={14} />
                  </button>
                  <button onClick={() => deleteDailyService(ds.serviceId)}
                    style={{ padding: '4px 10px', background: 'transparent', color: 'var(--color-danger)', border: '1px solid #d13212', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', fontSize: 11, fontWeight: 700 }} title="削除">
                    <IconTrash size={14} />
                  </button>
                </div>
              </div>
            </div>
            );
          })}
        </div>
      )}

      {/* ── テーマ設定 ── */}
      {tab === 'theme' && (
        <div style={{ maxWidth: 600 }}>
          <p style={{ color: 'var(--color-text-sub)', fontSize: 13, marginTop: 0, marginBottom: 20 }}>
            ライトモードのカラー変数を変更できます。変更は全ユーザーに即時反映されます。
          </p>

          {/* カスタムカラー 有効/無効トグル */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', background: 'var(--color-bg-white)', border: '1px solid var(--color-border)', borderRadius: 10, marginBottom: 24 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-text-main)' }}>カスタムカラーを適用する</div>
              <div style={{ fontSize: 12, color: 'var(--color-text-sub)', marginTop: 2 }}>
                オフにすると全ユーザーのカラーがデフォルトに戻ります（設定は保持されます）
              </div>
            </div>
            <button
              onClick={async () => {
                const next = !themeEnabled;
                setThemeEnabled(next);
                setCustomColorsEnabled(next);
                try {
                  await adminFetch(`${API_ENDPOINT}/admin/settings/theme`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ colors: themeColors, enabled: next }),
                  });
                } catch { /* silent */ }
              }}
              style={{
                width: 52, height: 28, borderRadius: 14, border: 'none', cursor: 'pointer',
                background: themeEnabled ? 'var(--color-primary)' : 'var(--color-border)',
                position: 'relative', transition: 'background 0.2s', flexShrink: 0, padding: 0,
              }}
              aria-label={themeEnabled ? '無効にする' : '有効にする'}
            >
              <span style={{
                position: 'absolute', top: 3, left: themeEnabled ? 26 : 3,
                width: 22, height: 22, borderRadius: '50%', background: '#fff',
                transition: 'left 0.2s', boxShadow: 'var(--box-shadow-pop)',
              }} />
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 0, marginBottom: 24 }}>
            {(['ブランド', 'ボタン', '背景', 'テキスト', 'その他'] as const).map(group => {
              const items = THEME_COLOR_LABELS.filter(c => c.group === group);
              return (
                <div key={group}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-light)', textTransform: 'uppercase', letterSpacing: '0.5px', padding: '14px 0 6px' }}>{group}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {items.map(({ key, label }) => {
                      const currentVal = themeColors[key] ?? DEFAULT_COLORS[key] ?? '#000000';
                      return (
                        <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: 'var(--color-bg-white)', border: '1px solid var(--color-border)', borderRadius: 8 }}>
                          <input
                            type="color"
                            value={currentVal}
                            onChange={e => {
                              const updated = { ...themeColors, [key]: e.target.value };
                              setThemeColors(updated);
                              applyColors(updated);
                            }}
                            style={{ width: 40, height: 32, border: 'none', borderRadius: 4, cursor: 'pointer', padding: 0, background: 'none' }}
                          />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text-main)' }}>{label}</div>
                            <div style={{ fontSize: 11, color: 'var(--color-text-light)', fontFamily: 'monospace' }}>{key}</div>
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--color-text-sub)', fontFamily: 'monospace', background: 'var(--color-bg-main)', padding: '2px 8px', borderRadius: 4, flexShrink: 0 }}>
                            {currentVal}
                          </div>
                          <button
                            onClick={() => {
                              const reset = { ...themeColors, [key]: DEFAULT_COLORS[key] };
                              setThemeColors(reset);
                              applyColors(reset);
                            }}
                            style={{ fontSize: 11, padding: '3px 8px', border: '1px solid var(--color-border)', borderRadius: 'var(--border-radius-md)', background: 'transparent', cursor: 'pointer', color: 'var(--color-text-light)', whiteSpace: 'nowrap' }}>
                            リセット
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button
              onClick={async () => {
                setThemeSaving(true);
                setThemeSaved(false);
                try {
                  await adminFetch(`${API_ENDPOINT}/admin/settings/theme`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ colors: themeColors, enabled: themeEnabled }),
                  });
                  applyColors(themeColors);
                  setThemeSaved(true);
                  setTimeout(() => setThemeSaved(false), 3000);
                } catch { alert('保存に失敗しました'); }
                setThemeSaving(false);
              }}
              disabled={themeSaving}
              style={{ padding: '8px 24px', background: '#ff9900', color: '#fff', border: 'none', borderRadius: 'var(--border-radius-md)', cursor: themeSaving ? 'default' : 'pointer', fontWeight: 700, fontSize: 14 }}>
              {themeSaving ? '保存中...' : '全ユーザーに適用'}
            </button>
            <button
              onClick={() => {
                setThemeColors({ ...DEFAULT_COLORS });
                applyColors({ ...DEFAULT_COLORS });
              }}
              style={{ padding: '8px 18px', border: '1px solid var(--color-border)', borderRadius: 'var(--border-radius-md)', cursor: 'pointer', background: 'transparent', fontSize: 13, fontWeight: 700 }}>
              すべてデフォルトに戻す
            </button>
            {themeSaved && <span style={{ fontSize: 13, color: 'var(--color-success)', fontWeight: 700 }}><span style={{ display: 'inline-flex', alignItems: 'center', verticalAlign: '-2px', marginRight: 'var(--spacing-xs)' }}><IconCheck size={13} /></span>保存しました</span>}
          </div>
        </div>
      )}

      {/* ── 管理者設定 ── */}
      {tab === 'admins' && (
        <div style={{ maxWidth: 560 }}>
          <MfaSetupCard email={myEmail} />
          <p style={{ fontSize: 13, color: 'var(--color-text-sub)', marginBottom: 20 }}>
            スーパー管理者（{ADMIN_EMAIL}）は常にアクセス可能です。追加の管理者アカウントをここで設定できます。
          </p>

          {/* 追加フォーム */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
            <input
              type="email"
              value={newAdminEmail}
              onChange={e => setNewAdminEmail(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addAdminEmail(); } }}
              placeholder="追加するメールアドレス"
              style={{ flex: 1, padding: '8px 12px', border: '1px solid var(--color-border)', borderRadius: 8, fontSize: 14, background: 'var(--color-bg-card)', color: 'var(--color-text-main)' }}
            />
            <button
              onClick={addAdminEmail}
              disabled={adminSaving || !newAdminEmail.trim()}
              style={{ padding: '8px 18px', background: 'var(--color-primary)', color: '#fff', border: 'none', borderRadius: 8, cursor: adminSaving || !newAdminEmail.trim() ? 'default' : 'pointer', fontWeight: 700, fontSize: 14, opacity: !newAdminEmail.trim() ? 0.5 : 1 }}>
              追加
            </button>
          </div>

          {/* 管理者リスト */}
          {adminEmailsLoading ? (
            <p style={{ color: 'var(--color-text-sub)', fontSize: 14 }}>読み込み中...</p>
          ) : adminEmailsError ? (
            <p style={{ color: 'var(--color-danger)', fontSize: 14 }}>{adminEmailsError}</p>
          ) : adminEmails.length === 0 ? (
            <p style={{ color: 'var(--color-text-sub)', fontSize: 14 }}>追加の管理者アカウントはありません</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {adminEmails.map(email => (
                <div key={email} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', border: '1px solid var(--color-border)', borderRadius: 8, background: 'var(--color-bg-card)' }}>
                  <span style={{ fontSize: 14, color: 'var(--color-text-main)' }}>{email}</span>
                  <button
                    onClick={() => { if (window.confirm(`${email} を管理者から削除しますか？`)) removeAdminEmail(email); }}
                    disabled={adminSaving}
                    style={{ background: 'none', border: 'none', color: 'var(--color-danger)', cursor: adminSaving ? 'default' : 'pointer', fontSize: 13, fontWeight: 700, padding: '2px 8px' }} title="削除">
                    <IconTrash size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {adminSaved && <p style={{ marginTop: 16, fontSize: 13, color: 'var(--color-success)', fontWeight: 700 }}><span style={{ display: 'inline-flex', alignItems: 'center', verticalAlign: '-2px', marginRight: 'var(--spacing-xs)' }}><IconCheck size={13} /></span>保存しました</p>}
        </div>
      )}

      {/* ── サイト情報 ── */}
      {tab === 'about' && (
        <div style={{ maxWidth: 760 }}>
          <p style={{ fontSize: 13, color: 'var(--color-text-sub)', marginBottom: 24 }}>
            「このサイトについて」ページの各セクションを編集できます。空白のままにすると、デフォルトのコンテンツが表示されます。
          </p>
          {aboutLoading ? (
            <p style={{ color: 'var(--color-text-sub)', fontSize: 14 }}>読み込み中...</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-xl)' }}>
              {[
                { key: 'privacy', label: 'プライバシーポリシー' },
                { key: 'terms', label: '利用規約' },
                { key: 'operator', label: '運営者情報' },
              ].map(({ key, label }) => (
                <div key={key}>
                  <div style={{ fontWeight: 700, fontSize: 'var(--font-size-md)', color: 'var(--color-text-main)', marginBottom: 8 }}>{label}</div>
                  <textarea
                    value={aboutSections[key] ?? ''}
                    onChange={e => setAboutSections(prev => ({ ...prev, [key]: e.target.value }))}
                    rows={12}
                    style={{
                      width: '100%', boxSizing: 'border-box', padding: '10px 12px',
                      border: '1px solid var(--color-border)', borderRadius: 8,
                      fontSize: 13, lineHeight: 1.7, fontFamily: 'inherit',
                      background: 'var(--color-bg-white)', color: 'var(--color-text-main)',
                      resize: 'vertical',
                    }}
                    placeholder={`${label}のテキストを入力（空欄=デフォルト表示）`}
                  />
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                    <button
                      onClick={() => saveAboutSection(key, aboutSections[key] ?? '')}
                      disabled={aboutSaving}
                      style={{
                        padding: '7px 20px', background: 'var(--color-primary)', color: '#fff',
                        border: 'none', borderRadius: 8, cursor: aboutSaving ? 'default' : 'pointer',
                        fontWeight: 700, fontSize: 13, opacity: aboutSaving ? 0.7 : 1,
                      }}
                    >
                      {aboutSaving ? '保存中...' : '保存'}
                    </button>
                  </div>
                </div>
              ))}
              {aboutSaved && <p style={{ fontSize: 13, color: 'var(--color-success)', fontWeight: 700 }}><span style={{ display: 'inline-flex', alignItems: 'center', verticalAlign: '-2px', marginRight: 'var(--spacing-xs)' }}><IconCheck size={13} /></span>保存しました</p>}
            </div>
          )}
        </div>
      )}

      {/* ── データ削除 ── */}
      {tab === 'deleteuser' && (
        <div style={{ maxWidth: 560 }}>
          <p style={{ fontSize: 13, color: 'var(--color-text-sub)', marginBottom: 24, lineHeight: 1.7 }}>
            指定したメールアドレスのユーザーのアプリデータ（演習履歴・成績・ブックマーク等）を削除します。<br />
            Cognitoアカウントは削除されません。
          </p>

          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <input
              type="email"
              value={delEmail}
              onChange={e => { setDelEmail(e.target.value); setDelDone(false); setDelError(''); }}
              placeholder="削除対象のメールアドレス"
              style={{ flex: 1, padding: '8px 12px', border: '1px solid var(--color-border)', borderRadius: 8, fontSize: 13, background: 'var(--color-bg-white)', color: 'var(--color-text-main)' }}
            />
          </div>

          {delError && (
            <div style={{ padding: '10px 14px', background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 8, color: '#c00', fontSize: 13, marginBottom: 16 }}>
              {delError}
            </div>
          )}

          {delDone && (
            <div style={{ padding: '10px 14px', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, color: '#166534', fontSize: 13, marginBottom: 16, fontWeight: 700 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', verticalAlign: '-2px', marginRight: 'var(--spacing-xs)' }}><IconCheck size={14} /></span>データを削除しました
            </div>
          )}

          <button
            onClick={executeDeletion}
            disabled={!delEmail.trim() || delExecuting}
            style={{ width: '100%', padding: '10px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, cursor: (!delEmail.trim() || delExecuting) ? 'default' : 'pointer', fontWeight: 700, fontSize: 14, opacity: (!delEmail.trim() || delExecuting) ? 0.6 : 1 }}
          >
            {delExecuting ? '削除中...' : 'データを削除する'}
          </button>
        </div>
      )}

      {/* ══ 合格コメント ══ */}
      {tab === 'passcomments' && (
        <div style={{ maxWidth: 600 }}>
          <h3 style={{ marginTop: 0, fontSize: 16, fontWeight: 700 }}>合格コメント管理</h3>
          <p style={{ fontSize: 13, color: 'var(--color-text-sub)', marginBottom: 20 }}>
            各資格ダッシュボードに表示される「合格コメント」を編集します。空欄にして保存するとコメントが削除されます。
          </p>

          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-text-sub)', display: 'block', marginBottom: 6 }}>資格</label>
            <select
              value={passCommentExam}
              onChange={e => {
                setPassCommentExam(e.target.value);
                setPassCommentText(passComments[e.target.value] ?? '');
                setPassCommentSaved(false);
              }}
              style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--color-border)', borderRadius: 8, fontSize: 13, background: 'var(--color-bg-white)', color: 'var(--color-text-main)', cursor: 'pointer' }}
            >
              {EXAM_TYPES.map(et => (
                <option key={et} value={et}>
                  {et} — {EXAM_CONFIGS[et]?.fullName}{passComments[et] ? ' ✓' : ''}
                </option>
              ))}
            </select>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-text-sub)', display: 'block', marginBottom: 6 }}>コメント（空欄で削除）</label>
            <textarea
              value={passCommentText}
              onChange={e => { setPassCommentText(e.target.value); setPassCommentSaved(false); }}
              rows={6}
              placeholder={`${passCommentExam} の合格コメントを入力...`}
              style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--color-border)', borderRadius: 8, fontSize: 13, resize: 'vertical', boxSizing: 'border-box', background: 'var(--color-bg-white)', color: 'var(--color-text-main)', lineHeight: 1.6 }}
            />
          </div>

          {passCommentSaved && (
            <div style={{ padding: '8px 12px', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, color: '#166534', fontSize: 13, marginBottom: 12, fontWeight: 700 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', verticalAlign: '-2px', marginRight: 'var(--spacing-xs)' }}><IconCheck size={14} /></span>保存しました
            </div>
          )}

          <button
            onClick={async () => {
              setPassCommentSaving(true);
              setPassCommentSaved(false);
              try {
                const res = await adminFetch(`${API_ENDPOINT}/admin/pass-comments`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ examType: passCommentExam, comment: passCommentText.trim() }),
                });
                if (!res.ok) throw new Error(`status ${res.status}`);
                const data = await res.json();
                setPassComments(data.comments ?? {});
                setPassCommentSaved(true);
              } catch (e) {
                alert('保存に失敗しました');
              } finally {
                setPassCommentSaving(false);
              }
            }}
            disabled={passCommentSaving}
            style={{ padding: '9px 24px', background: 'var(--color-primary)', color: '#fff', border: 'none', borderRadius: 8, cursor: passCommentSaving ? 'default' : 'pointer', fontWeight: 700, fontSize: 14, opacity: passCommentSaving ? 0.6 : 1 }}
          >
            {passCommentSaving ? '保存中...' : '保存'}
          </button>
        </div>
      )}

      {/* 問題プレビューモーダル */}
      {showPreview && <QuestionPreviewModal initId={previewInitId} onClose={() => { setShowPreview(false); setPreviewInitId(''); }} />}
    </div>
  );
}
