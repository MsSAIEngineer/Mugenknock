'use client';
import React, { useEffect, useState } from 'react';
import { lockBodyScroll } from '../utils/bodyScrollLock';
import { useNavigate } from '@/compat/react-router-dom';
import { updatePassword, deleteUser, updateUserAttributes } from 'aws-amplify/auth';
import { API_ENDPOINT, EXAM_TYPES, EXAM_LEVEL, EXAM_CONFIGS } from '../constants';
import { deleteCached, deleteCachedByPrefix } from '../utils/cache';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import { useTheme } from '../contexts/ThemeContext';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import { IconChevronLeft, IconChevronRight, IconSun, IconMoon, IconTrash } from '../components/Icons';

type SessionSummary = { examType: string; count: number; lastDate: string | null };

const formatDate = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
};

function SettingsGroup({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      background: 'var(--color-bg-white)',
      borderRadius: 'var(--border-radius-lg)',
      border: '1px solid var(--color-border)',
      overflow: 'hidden',
    }}>
      {children}
    </div>
  );
}

function SettingsRow({
  label, value, onClick, danger = false, last = false,
}: {
  label: string; value?: React.ReactNode; onClick?: () => void; danger?: boolean; last?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center',
        padding: '14px 16px', border: 'none',
        borderBottom: last ? 'none' : '1px solid var(--color-border)',
        background: onClick && hovered ? 'var(--color-bg-main)' : 'transparent',
        cursor: onClick ? 'pointer' : 'default',
        color: danger ? 'var(--color-danger)' : 'var(--color-text-main)',
        fontSize: 'var(--font-size-base)',
        transition: 'background 0.15s',
        gap: 12,
      }}
    >
      <span style={{ flex: 1, fontWeight: 400 }}>{label}</span>
      {value !== undefined && (
        <span style={{ color: 'var(--color-text-light)', fontSize: 'var(--font-size-sm)', marginRight: 4, flexShrink: 0 }}>
          {value}
        </span>
      )}
      {onClick && <IconChevronRight />}
    </button>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 'var(--font-size-xs)', fontWeight: 700,
      color: 'var(--color-text-light)', textTransform: 'uppercase',
      letterSpacing: '0.5px', padding: '0 4px', marginBottom: 6,
    }}>
      {children}
    </div>
  );
}

function Modal({ onClose, title, children }: { onClose: () => void; title: string; children: React.ReactNode }) {
  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: 'var(--color-bg-white)', borderRadius: 'var(--border-radius-lg)', padding: '24px 24px 20px', width: '100%', maxWidth: 'var(--modal-width-md)', boxShadow: 'var(--box-shadow-md)', maxHeight: window.innerWidth < 768 ? '66vh' : '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontSize: 'var(--font-size-h3)', fontWeight: 700, color: 'var(--color-text-main)' }}>{title}</h3>
          <button onClick={onClose} style={{ border: 'none', background: 'none', fontSize: 'var(--font-size-xl)', cursor: 'pointer', color: 'var(--color-text-sub)', padding: '4px 8px', lineHeight: 1 }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', fontWeight: 700, marginBottom: 6 }}>
      {children}
    </div>
  );
}

function TextInput({ type = 'text', value, onChange, placeholder, onFocus, onBlur }: {
  type?: string; value: string; onChange: (v: string) => void;
  placeholder?: string; onFocus?: () => void; onBlur?: () => void;
}) {
  return (
    <input
      type={type} value={value} onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      style={{ width: '100%', padding: '9px 12px', border: '1px solid var(--color-border)', borderRadius: 'var(--border-radius-md)', fontSize: 'var(--font-size-base)', boxSizing: 'border-box', outline: 'none', background: 'var(--color-bg-white)', color: 'var(--color-text-main)' }}
      onFocus={e => { e.currentTarget.style.borderColor = 'var(--color-primary)'; onFocus?.(); }}
      onBlur={e => { e.currentTarget.style.borderColor = 'var(--color-border)'; onBlur?.(); }}
    />
  );
}

export default function Account() {
  const { user, signOut } = useAuth();
  const { lang, setLang } = useLanguage();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();

  const [summaries, setSummaries] = useState<Record<string, SessionSummary>>({});
  const [loading, setLoading] = useState(true);
  const [confirmingExam, setConfirmingExam] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deletedExams, setDeletedExams] = useState<Set<string>>(new Set());

  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordChanging, setPasswordChanging] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState(false);

  const [showEmailModal, setShowEmailModal] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [emailChanging, setEmailChanging] = useState(false);
  const [emailError, setEmailError] = useState('');
  const [emailSuccess, setEmailSuccess] = useState(false);

  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [accountDeleting, setAccountDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  const [showDataModal, setShowDataModal] = useState(false);

  const [showResetModal, setShowResetModal] = useState(false);
  const [resetConfirmation, setResetConfirmation] = useState('');
  const [resetExecuting, setResetExecuting] = useState(false);
  const [resetError, setResetError] = useState('');
  const [resetDone, setResetDone] = useState(false);

  const [showThemeModal, setShowThemeModal] = useState(false);
  const uid = user?.userId ?? 'guest';
  // localStorage にそのexamTypeのデータが残っているか確認
  const hasLocalData = (et: string): boolean => {
    try {
      const hist = JSON.parse(localStorage.getItem(`domain_history_${et}_${uid}`) ?? '{}');
      if (Object.values(hist).some((s: any) => (s as any[]).length > 0)) return true;
      const scoreHist = JSON.parse(localStorage.getItem(`score_history_${et}_${uid}`) ?? '[]');
      if (scoreHist.length > 0) return true;
      return false;
    } catch { return false; }
  };

  useEffect(() => {
    const anyOpen = showPasswordModal || showEmailModal || showDeleteModal || showDataModal || showResetModal || showThemeModal;
    if (!anyOpen) return;
    return lockBodyScroll();
  }, [showPasswordModal, showEmailModal, showDeleteModal, showDataModal, showResetModal, showThemeModal]);

  useEffect(() => {
    if (!user) return;
    // Sessions と UserTagStats を並行取得
    // 資格ごとの実施回数・最終日を集計（保持上限=直近365件内での件数）。
    const sessionsFetch = fetch(`${API_ENDPOINT}/users/me/sessions?userId=${user.userId}&limit=365`)
      .then(r => r.json())
      .then(d => {
        const map: Record<string, SessionSummary> = {};
        for (const s of d.items ?? []) {
          const et = s.examType;
          if (!map[et]) map[et] = { examType: et, count: 0, lastDate: null };
          map[et].count++;
          const date = s.endedAt || s.startedAt;
          if (!map[et].lastDate || date > map[et].lastDate!) map[et].lastDate = date;
        }
        setSummaries(map);
      });

    sessionsFetch.catch(console.error).finally(() => setLoading(false));
  }, [user]);

  const handleDelete = async (et: string) => {
    if (!user) return;
    setDeleting(et);
    try {
      await fetch(`${API_ENDPOINT}/users/me/data?userId=${user.userId}&examType=${et}`, { method: 'DELETE' });
      // ローカルの成績・スコア履歴もリセット
      localStorage.removeItem(`domain_history_${et}_${uid}`);
      localStorage.removeItem(`domain_results_${et}_${uid}`);
      localStorage.removeItem(`score_history_${et}_${uid}`);
      localStorage.removeItem(`score_today_${et}_${uid}`);
      localStorage.removeItem(`score_prev_${et}_${uid}`);
      // domainStats のセッションキャッシュを無効化（Home等が次回再フェッチする）
      deleteCachedByPrefix(`ustats_${user.userId}`);
      setDeletedExams(prev => new Set(prev).add(et));
      setSummaries(prev => { const next = { ...prev }; delete next[et]; return next; });
    } catch (err) { console.error(err); }
    finally { setDeleting(null); setConfirmingExam(null); }
  };

  const handlePasswordChange = async () => {
    if (!oldPassword || !newPassword) { setPasswordError(lang === 'ja' ? 'すべてのフィールドを入力してください' : 'Please fill all fields'); return; }
    if (newPassword !== confirmPassword) { setPasswordError(lang === 'ja' ? 'パスワードが一致しません' : 'Passwords do not match'); return; }
    if (newPassword.length < 8) { setPasswordError(lang === 'ja' ? 'パスワードは8文字以上にしてください' : 'Password must be at least 8 characters'); return; }
    setPasswordChanging(true); setPasswordError('');
    try {
      await updatePassword({ oldPassword, newPassword });
      setPasswordSuccess(true);
      setOldPassword(''); setNewPassword(''); setConfirmPassword('');
      setTimeout(() => { setShowPasswordModal(false); setPasswordSuccess(false); }, 2000);
    } catch (err: any) {
      setPasswordError(err.message || (lang === 'ja' ? 'パスワード変更に失敗しました' : 'Failed to change password'));
    } finally { setPasswordChanging(false); }
  };

  const handleEmailChange = async () => {
    if (!newEmail) { setEmailError(lang === 'ja' ? 'メールアドレスを入力してください' : 'Please enter email address'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) { setEmailError(lang === 'ja' ? '有効なメールアドレスを入力してください' : 'Please enter a valid email address'); return; }
    setEmailChanging(true); setEmailError('');
    try {
      await updateUserAttributes({ userAttributes: { email: newEmail } });
      setEmailSuccess(true); setNewEmail('');
      setTimeout(() => { setShowEmailModal(false); setEmailSuccess(false); }, 2000);
    } catch (err: any) {
      setEmailError(err.message || (lang === 'ja' ? 'メールアドレス変更に失敗しました' : 'Failed to change email'));
    } finally { setEmailChanging(false); }
  };

  const handleAccountDelete = async () => {
    if (deleteConfirmation.toLowerCase() !== 'delete') { setDeleteError(lang === 'ja' ? '"DELETE"と入力してください' : 'Please type "DELETE" to confirm'); return; }
    setAccountDeleting(true); setDeleteError('');
    try {
      await deleteUser();
      localStorage.clear();
      sessionStorage.clear();
      await signOut();
      navigate('/login', { replace: true });
    } catch (err: any) {
      setDeleteError(err.message || (lang === 'ja' ? 'アカウント削除に失敗しました' : 'Failed to delete account'));
      setAccountDeleting(false);
    }
  };

  const handleReset = async () => {
    if (resetConfirmation.toLowerCase() !== 'reset') { setResetError(lang === 'ja' ? '"RESET"と入力してください' : 'Please type "RESET" to confirm'); return; }
    if (!user) return;
    setResetExecuting(true); setResetError('');
    try {
      const res = await fetch(`${API_ENDPOINT}/users/me/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.userId }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let msg = '初期化に失敗しました';
        try { msg = JSON.parse(text).error || msg; } catch {}
        throw new Error(msg);
      }
      const { resetAt } = await res.json();
      const uid = user.userId;
      // 「ログイン直後のまっさらな状態」に戻すため、端末表示系（言語・テーマ・サイドバー）だけ残し、
      // 演習設定・ヒント・トグル等の実績/体験データは全て消す。
      const KEEP = new Set([
        `lang_${uid}`, `theme_${uid}`, `sidebarOpen_${uid}`,
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
      // resetAt をセット → Home.tsx の二重クリアを防ぐ
      if (resetAt) localStorage.setItem(`lastReset_${uid}`, resetAt);
      sessionStorage.removeItem(`_ts_ustats_${uid}`);
      setResetDone(true);
    } catch (err: any) {
      setResetError(err.message || (lang === 'ja' ? '初期化に失敗しました' : 'Reset failed'));
      setResetExecuting(false);
    }
  };

  const ja = lang === 'ja';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: 'var(--color-bg-main)', fontFamily: 'inherit' }}>

      {/* ── ヘッダー ── */}
      <header style={{
        height: 56, minHeight: 56, background: 'var(--color-bg-white)',
        display: 'flex', alignItems: 'center',
        padding: '0 8px 0 4px',
        borderBottom: '1px solid var(--color-border)',
        flexShrink: 0,
        position: 'sticky', top: 0, zIndex: 100,
      }}>
        <button
          onClick={() => navigate('/aws/')}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 44, height: 44, border: 'none', background: 'none',
            cursor: 'pointer', color: 'var(--color-text-main)', borderRadius: 8,
            flexShrink: 0,
            transition: 'background 0.15s',
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'var(--color-bg-main)'}
          onMouseLeave={e => e.currentTarget.style.background = 'none'}
        >
          <IconChevronLeft size={22} />
        </button>
        <div onClick={() => navigate('/aws/')} style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
          <img src="/mugen-icon.png"   alt="無限ノック" style={{ height: 28, width: 'auto', display: 'block', flexShrink: 0 }} />
          <img src="/mugen-header.png" alt=""           style={{ height: 28, width: 'auto', display: 'block', flexShrink: 0 }} />
        </div>
      </header>

    <div style={{ flex: 1, overflowY: 'auto' }}>
    <div style={{ maxWidth: 900, margin: '0 auto', padding: 'var(--spacing-lg) var(--spacing-md) 48px' }} className="page-container">

      {/* ユーザー情報ヘッダー */}
      {user && (
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{
            width: 64, height: 64, borderRadius: '50%',
            background: 'var(--color-secondary)', color: 'white',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 26, fontWeight: 700, margin: '0 auto 12px',
          }}>
            {(user.email?.[0] ?? '?').toUpperCase()}
          </div>
          <div style={{ fontWeight: 700, fontSize: 'var(--font-size-lg)', color: 'var(--color-text-main)', marginBottom: 2 }}>
            {user.email?.split('@')[0]}
          </div>
          <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-light)' }}>
            {user.email}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

        {/* アカウント設定 */}
        {user && (
          <div>
            <SectionTitle>{ja ? 'アカウント設定' : 'Account'}</SectionTitle>
            <SettingsGroup>
              <SettingsRow
                label={ja ? 'メールアドレス' : 'Email'}
                value={user.email}
                onClick={() => { setEmailError(''); setEmailSuccess(false); setNewEmail(''); setShowEmailModal(true); }}
              />
              <SettingsRow
                label={ja ? 'パスワード' : 'Password'}
                value="••••••••"
                onClick={() => { setPasswordError(''); setPasswordSuccess(false); setOldPassword(''); setNewPassword(''); setConfirmPassword(''); setShowPasswordModal(true); }}
                last
              />
            </SettingsGroup>
          </div>
        )}

        {/* 表示設定 */}
        <div>
          <SectionTitle>{ja ? '表示設定' : 'Display'}</SectionTitle>
          <SettingsGroup>
            <SettingsRow
              label={ja ? '外観' : 'Appearance'}
              value={theme === 'light' ? (ja ? 'ライト' : 'Light') : (ja ? 'ダーク' : 'Dark')}
              onClick={() => setShowThemeModal(true)}
              last
            />
          </SettingsGroup>
        </div>

        {/* データ管理 */}
        {user && (
          <div>
            <SectionTitle>{ja ? 'データ管理' : 'Data'}</SectionTitle>
            <SettingsGroup>
              <SettingsRow
                label={ja ? '試験データの管理' : 'Manage Exam Data'}
                value={(() => {
                  const count = EXAM_TYPES.filter(et => !deletedExams.has(et) && (summaries[et] || hasLocalData(et))).length;
                  return count > 0 ? `${count}${ja ? '資格' : ' exams'}` : (ja ? 'データなし' : 'No data');
                })()}
                onClick={() => { setConfirmingExam(null); setShowDataModal(true); }}
              />
              <SettingsRow
                label={ja ? 'アカウントを初期化' : 'Reset Account Data'}
                onClick={() => { setResetConfirmation(''); setResetError(''); setResetDone(false); setShowResetModal(true); }}
                danger last
              />
            </SettingsGroup>
          </div>
        )}

        {/* ログアウト */}
        {user && (
          <div>
            <SettingsGroup>
              <SettingsRow
                label={ja ? 'ログアウト' : 'Sign Out'}
                onClick={async () => { await signOut(); navigate('/login', { replace: true }); }}
                last
              />
            </SettingsGroup>
          </div>
        )}

        {/* ログイン */}
        {!user && (
          <div>
            <SettingsGroup>
              <SettingsRow label={ja ? 'ログイン' : 'Sign In'} onClick={() => navigate('/login')} last />
            </SettingsGroup>
          </div>
        )}

        {/* アカウント削除 */}
        {user && (
          <div>
            <SettingsGroup>
              <SettingsRow
                label={ja ? 'アカウントを削除' : 'Delete Account'}
                onClick={() => { setDeleteConfirmation(''); setDeleteError(''); setShowDeleteModal(true); }}
                danger last
              />
            </SettingsGroup>
          </div>
        )}
      </div>

      {/* ── 試験データ管理モーダル ── */}
      {showDataModal && (
        <Modal onClose={() => { setShowDataModal(false); setConfirmingExam(null); }} title={ja ? '試験データの管理' : 'Manage Exam Data'}>
          <p style={{ margin: '0 0 16px', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', lineHeight: 1.6 }}>
            {ja
              ? '各資格の回答履歴・セッション・統計データを削除できます。削除したデータは復元できません。'
              : 'Delete answer history, sessions, and stats for each certification. This action cannot be undone.'}
          </p>
          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '24px 0' }}>
              <div className="sherpa-spinner" style={{ width: 24, height: 24, borderWidth: 2 }} />
            </div>
          ) : (() => {
            const visible = EXAM_TYPES.filter(et =>
              !deletedExams.has(et) && (summaries[et] || hasLocalData(et))
            );
            if (visible.length === 0) return (
              <div style={{ padding: '16px 0', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-light)', fontStyle: 'italic', textAlign: 'center' }}>
                {ja ? '削除可能なデータがありません' : 'No data to delete'}
              </div>
            );
            return (
              <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--border-radius-lg)', overflow: 'hidden' }}>
                {visible.map((et, i) => {
                  const summary = summaries[et];
                  const isConfirming = confirmingExam === et;
                  const isDeleting = deleting === et;
                  return (
                    <div key={et} style={{ padding: '12px 16px', borderBottom: i < visible.length - 1 ? '1px solid var(--color-border)' : 'none' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                            <Badge variant="secondary">{et}</Badge>
                            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)' }}>{EXAM_LEVEL[et]}</span>
                          </div>
                          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)' }}>
                            {summary
                              ? `${summary.count}${ja ? 'セッション' : ' sessions'}${summary.lastDate ? ` · ${ja ? '最終' : 'Last'}: ${formatDate(summary.lastDate)}` : ''}`
                              : (ja ? 'セッションなし（成績データあり）' : 'No sessions (stats data exists)')}
                          </div>
                        </div>
                        {!isConfirming && (
                          <button
                            type="button"
                            onClick={() => setConfirmingExam(et)}
                            aria-label={ja ? `${et} のデータを削除` : `Delete ${et} data`}
                            title={ja ? 'データを削除' : 'Delete data'}
                            style={{ flexShrink: 0, width: 44, height: 44, borderRadius: '50%', border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-danger)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                          >
                            <IconTrash size={18} />
                          </button>
                        )}
                      </div>
                      {isDeleting && (
                        <div style={{ marginTop: 10, padding: '10px 12px', background: 'var(--color-bg-main)', borderRadius: 'var(--border-radius-md)', display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span className="sherpa-spinner" style={{ width: 16, height: 16, borderWidth: 2, flexShrink: 0 }} />
                          <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)' }}>
                            {ja ? `${et} のデータを削除中...` : `Deleting ${et} data...`}
                          </span>
                        </div>
                      )}
                      {isConfirming && !isDeleting && (
                        <div style={{ marginTop: 10, padding: '10px 12px', background: 'var(--color-feedback-incorrect-bg)', borderRadius: 'var(--border-radius-md)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                          <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-danger)', fontWeight: 500 }}>
                            {ja ? `${et} のデータを削除しますか？` : `Delete all data for ${et}?`}
                          </span>
                          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                            <Button variant="danger" size="sm" onClick={() => handleDelete(et)}>
                              {ja ? '削除する' : 'Delete'}
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => setConfirmingExam(null)}>
                              {ja ? 'キャンセル' : 'Cancel'}
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </Modal>
      )}

      {/* ── メールアドレス変更モーダル ── */}
      {showEmailModal && (
        <Modal onClose={() => setShowEmailModal(false)} title={ja ? 'メールアドレス変更' : 'Change Email'}>
          {emailSuccess ? (
            <div style={{ textAlign: 'center', padding: '24px 0' }}>
              <div style={{ fontSize: 40, marginBottom: 12, color: 'var(--color-success)' }}>✓</div>
              <p style={{ color: 'var(--color-success)', fontWeight: 700, margin: 0 }}>
                {ja ? 'メールアドレスを変更しました' : 'Email changed successfully'}
              </p>
            </div>
          ) : (
            <>
              <div style={{ marginBottom: 16 }}>
                <FieldLabel>{ja ? '現在のメールアドレス' : 'Current Email'}</FieldLabel>
                <div style={{ padding: '9px 12px', background: 'var(--color-bg-main)', borderRadius: 'var(--border-radius-md)', fontSize: 'var(--font-size-base)', color: 'var(--color-text-sub)' }}>
                  {user?.email}
                </div>
              </div>
              <div style={{ marginBottom: 20 }}>
                <FieldLabel>{ja ? '新しいメールアドレス' : 'New Email'} <span style={{ color: 'var(--color-danger)' }}>*</span></FieldLabel>
                <TextInput type="email" value={newEmail} onChange={setNewEmail} placeholder={ja ? '新しいメールアドレス' : 'New email address'} />
              </div>
              {emailError && <p style={{ margin: '0 0 12px', fontSize: 'var(--font-size-sm)', color: 'var(--color-danger)' }}>{emailError}</p>}
              <div style={{ display: 'flex', gap: 8 }}>
                <Button onClick={handleEmailChange} disabled={emailChanging} variant="primary" style={{ flex: 1 }}>
                  {emailChanging ? (ja ? '変更中...' : 'Changing...') : (ja ? '変更する' : 'Change')}
                </Button>
                <Button onClick={() => setShowEmailModal(false)} variant="outline" disabled={emailChanging}>{ja ? 'キャンセル' : 'Cancel'}</Button>
              </div>
            </>
          )}
        </Modal>
      )}

      {/* ── パスワード変更モーダル ── */}
      {showPasswordModal && (
        <Modal onClose={() => !passwordChanging && setShowPasswordModal(false)} title={ja ? 'パスワード変更' : 'Change Password'}>
          {passwordSuccess ? (
            <div style={{ textAlign: 'center', padding: '24px 0' }}>
              <div style={{ fontSize: 40, marginBottom: 12, color: 'var(--color-success)' }}>✓</div>
              <p style={{ color: 'var(--color-success)', fontWeight: 700, margin: 0 }}>
                {ja ? 'パスワードを変更しました' : 'Password changed successfully'}
              </p>
            </div>
          ) : (
            <>
              <div style={{ marginBottom: 16 }}>
                <FieldLabel>{ja ? '現在のパスワード' : 'Current Password'}</FieldLabel>
                <TextInput type="password" value={oldPassword} onChange={setOldPassword} />
              </div>
              <div style={{ marginBottom: 16 }}>
                <FieldLabel>{ja ? '新しいパスワード' : 'New Password'}</FieldLabel>
                <TextInput type="password" value={newPassword} onChange={setNewPassword} />
              </div>
              <div style={{ marginBottom: 20 }}>
                <FieldLabel>{ja ? 'パスワード確認' : 'Confirm Password'}</FieldLabel>
                <TextInput type="password" value={confirmPassword} onChange={setConfirmPassword} />
              </div>
              {passwordError && <p style={{ margin: '0 0 12px', fontSize: 'var(--font-size-sm)', color: 'var(--color-danger)' }}>{passwordError}</p>}
              <div style={{ display: 'flex', gap: 8 }}>
                <Button onClick={handlePasswordChange} disabled={passwordChanging} variant="primary" style={{ flex: 1 }}>
                  {passwordChanging ? (ja ? '変更中...' : 'Changing...') : (ja ? '変更する' : 'Change')}
                </Button>
                <Button onClick={() => setShowPasswordModal(false)} variant="outline" disabled={passwordChanging}>{ja ? 'キャンセル' : 'Cancel'}</Button>
              </div>
            </>
          )}
        </Modal>
      )}


      {/* ── 外観選択モーダル ── */}
      {showThemeModal && (
        <Modal onClose={() => setShowThemeModal(false)} title={ja ? '外観' : 'Appearance'}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0, border: '1px solid var(--color-border)', borderRadius: 'var(--border-radius-lg)', overflow: 'hidden' }}>
            {/* アイコンは要素ではなくコンポーネント参照で持つ（データ配列に JSX を埋めない） */}
            {([['light', ja ? 'ライト' : 'Light', IconSun], ['dark', ja ? 'ダーク' : 'Dark', IconMoon]] as const).map(([th, label, Icon], i, arr) => (
              <button
                key={th}
                onClick={() => { if (theme !== th) toggleTheme(); setShowThemeModal(false); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '14px 16px', border: 'none',
                  borderBottom: i < arr.length - 1 ? '1px solid var(--color-border)' : 'none',
                  background: theme === th ? 'var(--color-primary-light)' : 'transparent',
                  cursor: 'pointer', fontSize: 'var(--font-size-base)',
                  color: theme === th ? 'var(--color-primary)' : 'var(--color-text-main)',
                  fontWeight: theme === th ? 700 : 400,
                }}
              >
                <span style={{ color: theme === th ? 'var(--color-primary)' : 'var(--color-text-sub)' }}><Icon /></span>
                <span style={{ flex: 1 }}>{label}</span>
                {theme === th && <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>}
              </button>
            ))}
          </div>
        </Modal>
      )}

      {/* ── アカウント初期化モーダル ── */}
      {showResetModal && (
        <Modal onClose={() => !resetExecuting && setShowResetModal(false)} title={ja ? 'アカウントを初期化' : 'Reset Account Data'}>
          {resetDone ? (
            <div style={{ textAlign: 'center', padding: '24px 0' }}>
              <div style={{ fontSize: 40, marginBottom: 12, color: 'var(--color-success)' }}>✓</div>
              <p style={{ color: 'var(--color-success)', fontWeight: 700, margin: '0 0 20px' }}>
                {ja ? '初期化が完了しました' : 'Reset complete'}
              </p>
              <Button onClick={() => { window.location.href = '/aws/'; }} variant="primary">
                {ja ? 'ホームへ' : 'Go to Home'}
              </Button>
            </div>
          ) : (
            <>
              <p style={{ margin: '0 0 16px', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', lineHeight: 1.6 }}>
                {ja
                  ? '演習履歴・成績・ポイント・ブックマーク・図鑑データをすべて削除し、ログイン直後の状態に戻します。メールアドレスとパスワードは保持されます。'
                  : 'Deletes all exercise history, stats, points, bookmarks, and encyclopedia data. Email and password are kept.'}
              </p>
              <div style={{ marginBottom: 20 }}>
                <FieldLabel>{ja ? '確認のため "RESET" と入力してください' : 'Type "RESET" to confirm'}</FieldLabel>
                <TextInput value={resetConfirmation} onChange={setResetConfirmation} placeholder="RESET" />
              </div>
              {resetError && <p style={{ margin: '0 0 12px', fontSize: 'var(--font-size-sm)', color: 'var(--color-danger)' }}>{resetError}</p>}
              {resetExecuting && (
                <div style={{ marginBottom: 16, padding: '10px 12px', background: 'var(--color-bg-main)', borderRadius: 'var(--border-radius-md)', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className="sherpa-spinner" style={{ width: 16, height: 16, borderWidth: 2, flexShrink: 0 }} />
                  <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)' }}>
                    {ja ? 'データを削除しています。しばらくお待ちください...' : 'Deleting your data. Please wait...'}
                  </span>
                </div>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <Button
                  onClick={handleReset}
                  disabled={resetExecuting || resetConfirmation.toLowerCase() !== 'reset'}
                  variant="danger"
                  style={{ flex: 1 }}
                >
                  {resetExecuting ? (ja ? '初期化中...' : 'Resetting...') : (ja ? '初期化する' : 'Reset')}
                </Button>
                <Button onClick={() => setShowResetModal(false)} variant="outline" disabled={resetExecuting}>{ja ? 'キャンセル' : 'Cancel'}</Button>
              </div>
            </>
          )}
        </Modal>
      )}

      {/* ── アカウント削除モーダル ── */}
      {showDeleteModal && (
        <Modal onClose={() => !accountDeleting && setShowDeleteModal(false)} title={ja ? 'アカウントを削除' : 'Delete Account'}>
          <p style={{ margin: '0 0 16px', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', lineHeight: 1.6 }}>
            {ja
              ? 'アカウントを完全に削除します。この操作は取り消せません。すべてのデータが失われます。'
              : 'This will permanently delete your account. This action cannot be undone. All your data will be lost.'}
          </p>
          <div style={{ marginBottom: 20 }}>
            <FieldLabel>{ja ? '確認のため "DELETE" と入力してください' : 'Type "DELETE" to confirm'}</FieldLabel>
            <TextInput value={deleteConfirmation} onChange={setDeleteConfirmation} placeholder="DELETE" />
          </div>
          {deleteError && <p style={{ margin: '0 0 12px', fontSize: 'var(--font-size-sm)', color: 'var(--color-danger)' }}>{deleteError}</p>}
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={handleAccountDelete} disabled={accountDeleting || deleteConfirmation.toLowerCase() !== 'delete'} variant="danger" style={{ flex: 1 }}>
              {accountDeleting ? (ja ? '削除中...' : 'Deleting...') : (ja ? '削除する' : 'Delete')}
            </Button>
            <Button onClick={() => setShowDeleteModal(false)} variant="outline" disabled={accountDeleting}>{ja ? 'キャンセル' : 'Cancel'}</Button>
          </div>
        </Modal>
      )}
    </div>
    </div>
    </div>
  );
}
