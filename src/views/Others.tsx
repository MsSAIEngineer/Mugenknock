'use client';
import React, { useEffect, useState } from 'react';
import { useNavigate } from '@/compat/react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import { API_ENDPOINT } from '../constants';
import { IconFire, IconMail, IconMegaphone, IconInfo, IconLayoutGrid, IconSwatchBook, IconNetwork, IconCircleCheck, IconX } from '../components/Icons';
import Button from '../components/ui/Button';
import PageLayout from '../components/ui/PageLayout';
import { fetchLimits } from '../utils/dailyLimit';

const ITEMS = [
  { path: '/aws/encyclopedia',  Icon: IconLayoutGrid,  ja: 'サービス図鑑',           en: 'Service Encyclopedia',      desc_ja: '日めくりで解放されるAWSサービス一覧', desc_en: 'AWS services unlocked via daily service' },
  { path: '/aws/cheatsheet',    Icon: IconSwatchBook,  ja: 'チートシート',           en: 'Cheat Sheet',               desc_ja: '資格別のサービス・概念早見表', desc_en: 'Quick-reference guide for each certification' },
  { path: '/aws/announcements', Icon: IconMegaphone, ja: 'お知らせ',               en: 'Announcements',             desc_ja: '運営からの重要なお知らせ',     desc_en: 'Important notices from the team' },
  { path: '/aws/release-notes', Icon: IconFire,      ja: 'リリースノート',         en: 'Release Notes',             desc_ja: 'アップデート情報',             desc_en: 'App update history'       },
];

export default function Others() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { lang, t } = useLanguage();
  const ja = lang === 'ja';

  // おひねり（specs/006）: ログイン中で、機能が有効なときだけ最下部に出す
  const [showOhineri, setShowOhineri] = useState(false);
  useEffect(() => {
    if (!user) { setShowOhineri(false); return; }
    let alive = true;
    fetchLimits().then(l => { if (alive) setShowOhineri(!!l?.purchaseEnabled); });
    return () => { alive = false; };
  }, [user]);

  const [showContact, setShowContact] = useState(false);
  const [contactSubject, setContactSubject] = useState('');
  const [contactMessage, setContactMessage] = useState('');
  const [contactSending, setContactSending] = useState(false);
  const [contactDone, setContactDone] = useState(false);
  const [contactError, setContactError] = useState(false);

  const handleContactSend = async () => {
    if (!contactMessage.trim()) return;
    setContactSending(true);
    setContactError(false);
    try {
      const res = await fetch(`${API_ENDPOINT}/contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: user?.userId ?? 'anonymous',
          subject: contactSubject.trim(),
          message: contactMessage.trim(),
        }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      setContactDone(true);
      setContactSubject('');
      setContactMessage('');
    } catch {
      setContactError(true);
    } finally {
      setContactSending(false);
    }
  };

  return (
    <PageLayout>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)' }}>
        {ITEMS.map(({ path, Icon, ja: jaLabel, en: enLabel, desc_ja, desc_en }) => (
          <button
            key={path}
            onClick={() => navigate(path)}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 16,
              padding: '16px var(--spacing-md)', border: '1px solid var(--color-border)',
              borderRadius: 'var(--border-radius-lg)', background: 'var(--color-bg-white)',
              cursor: 'pointer', textAlign: 'left', transition: 'box-shadow 0.15s, border-color 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--color-primary)'; e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,108,224,0.1)'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--color-border)'; e.currentTarget.style.boxShadow = 'none'; }}
          >
            <div style={{
              width: 44, height: 44, borderRadius: 'var(--border-radius-md)', flexShrink: 0,
              background: 'var(--color-primary-light)', color: 'var(--color-primary)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Icon />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 'var(--font-size-base)', fontWeight: 700, color: 'var(--color-text-main)', marginBottom: 2 }}>
                {ja ? jaLabel : enLabel}
              </div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)' }}>
                {ja ? desc_ja : desc_en}
              </div>
            </div>
            <span style={{ color: 'var(--color-text-light)', fontSize: 'var(--font-size-lg)', flexShrink: 0 }}>›</span>
          </button>
        ))}

        {/* お問い合わせ */}
        <button
          onClick={() => { setShowContact(true); setContactDone(false); setContactError(false); }}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', gap: 16,
            padding: '16px var(--spacing-md)', border: '1px solid var(--color-border)',
            borderRadius: 'var(--border-radius-lg)', background: 'var(--color-bg-white)',
            cursor: 'pointer', textAlign: 'left', transition: 'box-shadow 0.15s, border-color 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--color-primary)'; e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,108,224,0.1)'; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--color-border)'; e.currentTarget.style.boxShadow = 'none'; }}
        >
          <div style={{
            width: 44, height: 44, borderRadius: 'var(--border-radius-md)', flexShrink: 0,
            background: 'var(--color-primary-light)', color: 'var(--color-primary)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <IconMail />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 'var(--font-size-base)', fontWeight: 700, color: 'var(--color-text-main)', marginBottom: 2 }}>
              {t('contact.sidebarLabel')}
            </div>
            <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)' }}>
              {ja ? 'ご意見・不具合報告' : 'Send feedback or report issues'}
            </div>
          </div>
          <span style={{ color: 'var(--color-text-light)', fontSize: 'var(--font-size-lg)', flexShrink: 0 }}>›</span>
        </button>

        {/* 無限ノックについて（ランディングページ） */}
        <button
          onClick={() => navigate('/?view=1')}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', gap: 16,
            padding: '16px var(--spacing-md)', border: '1px solid var(--color-border)',
            borderRadius: 'var(--border-radius-lg)', background: 'var(--color-bg-white)',
            cursor: 'pointer', textAlign: 'left', transition: 'box-shadow 0.15s, border-color 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--color-primary)'; e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,108,224,0.1)'; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--color-border)'; e.currentTarget.style.boxShadow = 'none'; }}
        >
          <div style={{
            width: 44, height: 44, borderRadius: 'var(--border-radius-md)', flexShrink: 0,
            background: 'var(--color-primary-light)', color: 'var(--color-primary)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <IconInfo />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 'var(--font-size-base)', fontWeight: 700, color: 'var(--color-text-main)', marginBottom: 2 }}>
              {ja ? '無限ノックについて' : 'About Mugenknock'}
            </div>
            <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)' }}>
              {ja ? 'サービス紹介ページを見る' : 'View the service intro page'}
            </div>
          </div>
          <span style={{ color: 'var(--color-text-light)', fontSize: 'var(--font-size-lg)', flexShrink: 0 }}>›</span>
        </button>

        {/* Webサイトの構成図 */}
        <button
          onClick={() => navigate('/architecture')}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', gap: 16,
            padding: '16px var(--spacing-md)', border: '1px solid var(--color-border)',
            borderRadius: 'var(--border-radius-lg)', background: 'var(--color-bg-white)',
            cursor: 'pointer', textAlign: 'left', transition: 'box-shadow 0.15s, border-color 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--color-primary)'; e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,108,224,0.1)'; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--color-border)'; e.currentTarget.style.boxShadow = 'none'; }}
        >
          <div style={{
            width: 44, height: 44, borderRadius: 'var(--border-radius-md)', flexShrink: 0,
            background: 'var(--color-primary-light)', color: 'var(--color-primary)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <IconNetwork size={22} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 'var(--font-size-base)', fontWeight: 700, color: 'var(--color-text-main)', marginBottom: 2 }}>
              {ja ? 'Webサイトの構成図' : 'Site Architecture'}
            </div>
            <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)' }}>
              {ja ? 'このサイトの技術構成を図で見る' : 'See how this site is built'}
            </div>
          </div>
          <span style={{ color: 'var(--color-text-light)', fontSize: 'var(--font-size-lg)', flexShrink: 0 }}>›</span>
        </button>

        {/* おひねり（一番下） */}
        {showOhineri && (
          <button
            onClick={() => navigate('/aws/ohineri')}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 16,
              padding: '16px var(--spacing-md)', border: '1px solid var(--color-border)',
              borderRadius: 'var(--border-radius-lg)', background: 'var(--color-bg-white)',
              cursor: 'pointer', textAlign: 'left', transition: 'box-shadow 0.15s, border-color 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--color-primary)'; e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,108,224,0.1)'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--color-border)'; e.currentTarget.style.boxShadow = 'none'; }}
          >
            <div style={{
              width: 44, height: 44, borderRadius: 'var(--border-radius-md)', flexShrink: 0,
              background: 'var(--color-primary-light)', color: 'var(--color-primary)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--font-size-xl)',
            }}>
              ¥
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 'var(--font-size-base)', fontWeight: 700, color: 'var(--color-text-main)', marginBottom: 2 }}>
                {ja ? 'おひねり' : 'Tip jar'}
              </div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)' }}>
                {ja ? '1日の演習上限をなくす（任意・1回のみ）' : 'Remove the daily limit (optional, one-time)'}
              </div>
            </div>
            <span style={{ color: 'var(--color-text-light)', fontSize: 'var(--font-size-lg)', flexShrink: 0 }}>›</span>
          </button>
        )}

      </div>

      {/* お問い合わせモーダル */}
      {showContact && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--spacing-md)' }}
          onClick={e => { if (e.target === e.currentTarget) setShowContact(false); }}
        >
          <div style={{ background: 'var(--color-bg-white)', borderRadius: 'var(--border-radius-lg)', padding: '24px 24px 20px', width: '100%', maxWidth: 'var(--modal-width-md)', boxShadow: 'var(--box-shadow-md)', maxHeight: window.innerWidth < 768 ? '66vh' : '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-lg)' }}>
              <h3 style={{ margin: 0, fontSize: 'var(--font-size-h3)', fontWeight: 700, color: 'var(--color-text-main)' }}>{t('contact.title')}</h3>
              <button onClick={() => setShowContact(false)} style={{ border: 'none', background: 'none', fontSize: 'var(--font-size-xl)', cursor: 'pointer', color: 'var(--color-text-sub)', padding: '4px 8px' }}><IconX size={20} /></button>
            </div>
            {contactDone ? (
              <div style={{ textAlign: 'center', padding: '24px 0' }}>
                <div style={{ display: 'flex', justifyContent: 'center', color: 'var(--color-success)', marginBottom: 'var(--spacing-md)' }}><IconCircleCheck size={40} /></div>
                <p style={{ color: 'var(--color-success)', fontWeight: 700, fontSize: 'var(--font-size-md)', margin: '0 0 var(--spacing-sm)' }}>{t('contact.sent')}</p>
                <p style={{ color: 'var(--color-text-sub)', fontSize: 'var(--font-size-sm)', margin: '0 0 var(--spacing-lg)' }}>{t('contact.thankYou')}</p>
                <Button onClick={() => setShowContact(false)} size="md">{t('contact.close')}</Button>
              </div>
            ) : (
              <>
                <p style={{ margin: '0 0 var(--spacing-md)', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-light)', background: 'var(--color-bg-main)', borderRadius: 'var(--border-radius-md)', padding: 'var(--spacing-sm) var(--spacing-md)', lineHeight: 1.6 }}>
                  {t('contact.anonymous')}
                </p>
                <div style={{ marginBottom: 'var(--spacing-md)' }}>
                  <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', fontWeight: 700, marginBottom: 'var(--spacing-xs)' }}>{t('contact.subject')}</div>
                  <input
                    value={contactSubject}
                    onChange={e => setContactSubject(e.target.value)}
                    placeholder={t('contact.subjectPlaceholder')}
                    style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--color-border)', borderRadius: 'var(--border-radius-md)', fontSize: 'var(--font-size-base)', boxSizing: 'border-box', outline: 'none' }}
                    onFocus={e => e.currentTarget.style.borderColor = 'var(--color-primary)'}
                    onBlur={e => e.currentTarget.style.borderColor = 'var(--color-border)'}
                  />
                </div>
                <div style={{ marginBottom: 'var(--spacing-lg)' }}>
                  <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', fontWeight: 700, marginBottom: 'var(--spacing-xs)' }}>{t('contact.message')} <span style={{ color: 'var(--color-danger)' }}>*</span></div>
                  <textarea
                    value={contactMessage}
                    onChange={e => setContactMessage(e.target.value)}
                    placeholder={t('contact.messagePlaceholder')}
                    rows={5}
                    style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--color-border)', borderRadius: 'var(--border-radius-md)', fontSize: 'var(--font-size-base)', resize: 'vertical', boxSizing: 'border-box', outline: 'none', lineHeight: 1.6 }}
                    onFocus={e => e.currentTarget.style.borderColor = 'var(--color-primary)'}
                    onBlur={e => e.currentTarget.style.borderColor = 'var(--color-border)'}
                  />
                </div>
                {contactError && (
                  <p style={{ margin: '0 0 var(--spacing-sm)', fontSize: 'var(--font-size-sm)', color: 'var(--color-danger)' }}>
                    {ja ? '送信に失敗しました。しばらく経ってから再試行してください。' : 'Failed to send. Please try again later.'}
                  </p>
                )}
                <div style={{ display: 'flex', gap: 'var(--spacing-sm)' }}>
                  <Button onClick={handleContactSend} disabled={contactSending || !contactMessage.trim()} variant="primary" style={{ flex: 1 }}>
                    {contactSending ? t('contact.sending') : t('contact.send')}
                  </Button>
                  <Button onClick={() => setShowContact(false)} variant="outline">{t('contact.cancel')}</Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </PageLayout>
  );
}
