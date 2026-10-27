'use client';
import React, { useState, useEffect } from 'react';
import { API_ENDPOINT } from '../constants';
import Button from './ui/Button';
import { lockBodyScroll } from '../utils/bodyScrollLock';

type Category = 'question_error' | 'choice_error' | 'explanation_error' | 'other';

const CATEGORIES: { value: Category; label: string; labelEn: string }[] = [
  { value: 'question_error',   label: '問題文の誤り',      labelEn: 'Error in question text' },
  { value: 'choice_error',     label: '選択肢・正解の誤り', labelEn: 'Error in choices or answer' },
  { value: 'explanation_error',label: '解説の誤り',         labelEn: 'Error in explanation' },
  { value: 'other',            label: 'その他',             labelEn: 'Other' },
];

type Props = {
  questionId: string;
  userId?: string;
  lang: string;
  onClose: () => void;
};

export default function ReportModal({ questionId, userId, lang, onClose }: Props) {
  const [category, setCategory] = useState<Category>('question_error');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    return lockBodyScroll();
  }, []);

  const handleSubmit = async () => {
    setSending(true);
    setError(false);
    try {
      const res = await fetch(`${API_ENDPOINT}/questions/${questionId}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: userId || 'anonymous', category, message }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      setDone(true);
    } catch (err) {
      console.error(err);
      setError(true);
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      data-kbscope="1" role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--spacing-md)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: 'var(--color-bg-white)', borderRadius: 'var(--border-radius-lg)', width: '100%', maxWidth: 460, boxShadow: 'var(--box-shadow-md)', maxHeight: window.innerWidth < 768 ? '66vh' : '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* ヘッダー */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 28px 16px', flexShrink: 0, borderBottom: '1px solid var(--color-border)' }}>
          <h3 style={{ margin: 0, fontSize: 'var(--font-size-h3)', fontWeight: 700, color: 'var(--color-text-main)' }}>
            {lang === 'ja' ? '問題を通報' : 'Report an issue'}
          </h3>
          <button onClick={onClose} style={{ border: 'none', background: 'none', fontSize: 'var(--font-size-xl)', cursor: 'pointer', color: 'var(--color-text-sub)', padding: '4px 8px' }}>✕</button>
        </div>

        {done ? (
          <div style={{ textAlign: 'center', padding: '24px 28px', flex: 1 }}>
            <div style={{ fontSize: 40, marginBottom: 'var(--spacing-md)' }}>✓</div>
            <p style={{ color: 'var(--color-success)', fontWeight: 700, fontSize: 'var(--font-size-md)', margin: '0 0 var(--spacing-sm)' }}>
              {lang === 'ja' ? '通報を受け付けました' : 'Report submitted'}
            </p>
            <p style={{ color: 'var(--color-text-sub)', fontSize: 'var(--font-size-sm)', margin: '0 0 var(--spacing-lg)', lineHeight: 1.6 }}>
              {lang === 'ja' ? 'ご協力ありがとうございます。確認後、対応いたします。' : 'Thank you. We will review your report.'}
            </p>
            <Button onClick={onClose} size="md">{lang === 'ja' ? '閉じる' : 'Close'}</Button>
          </div>
        ) : (
          <>
            {/* スクロール可能なコンテンツ */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '16px 28px' }}>
              <div style={{ fontSize: 'var(--font-size-xs)', fontFamily: 'monospace', color: 'var(--color-text-light)', marginBottom: 'var(--spacing-lg)', background: 'var(--color-bg-main)', padding: '3px 8px', borderRadius: 'var(--border-radius-sm)', display: 'inline-block' }}>
                {questionId}
              </div>

              <div style={{ marginBottom: 'var(--spacing-lg)' }}>
                <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 700, color: 'var(--color-text-sub)', marginBottom: 'var(--spacing-sm)' }}>
                  {lang === 'ja' ? '通報の種類' : 'Category'} <span style={{ color: 'var(--color-danger)' }}>*</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)' }}>
                  {CATEGORIES.map(cat => (
                    <label key={cat.value} style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)', cursor: 'pointer', fontSize: 'var(--font-size-base)', padding: '8px 12px', borderRadius: 'var(--border-radius-md)', border: `1px solid ${category === cat.value ? 'var(--color-primary)' : 'var(--color-border)'}`, background: category === cat.value ? 'var(--color-primary-light)' : 'var(--color-bg-white)', transition: 'all 0.15s' }}>
                      <input
                        type="radio"
                        name="report-category"
                        value={cat.value}
                        checked={category === cat.value}
                        onChange={() => setCategory(cat.value)}
                        style={{ width: 16, height: 16, accentColor: 'var(--color-primary)' }}
                      />
                      <span style={{ fontWeight: category === cat.value ? 700 : 400 }}>
                        {lang === 'ja' ? cat.label : cat.labelEn}
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 700, color: 'var(--color-text-sub)', marginBottom: 'var(--spacing-xs)' }}>
                  {lang === 'ja' ? '詳細（任意）' : 'Details (optional)'}
                </div>
                <textarea
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  placeholder={lang === 'ja' ? '具体的な内容を記入してください' : 'Describe the issue in detail'}
                  rows={3}
                  style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--color-border)', borderRadius: 'var(--border-radius-md)', fontSize: 'var(--font-size-base)', resize: 'vertical', boxSizing: 'border-box', outline: 'none', lineHeight: 1.6 }}
                  onFocus={e => e.currentTarget.style.borderColor = 'var(--color-primary)'}
                  onBlur={e => e.currentTarget.style.borderColor = 'var(--color-border)'}
                />
              </div>
            </div>

            {/* 固定フッター：送信ボタン */}
            <div style={{ flexShrink: 0, padding: '12px 28px 20px', borderTop: '1px solid var(--color-border)', background: 'var(--color-bg-white)' }}>
              {error && (
                <p style={{ margin: '0 0 var(--spacing-sm)', fontSize: 'var(--font-size-sm)', color: 'var(--color-danger)' }}>
                  {lang === 'ja' ? '送信に失敗しました。しばらく経ってから再試行してください。' : 'Failed to submit. Please try again later.'}
                </p>
              )}
              <div style={{ display: 'flex', gap: 'var(--spacing-sm)' }}>
                <Button variant="primary" onClick={handleSubmit} disabled={sending} style={{ flex: 1 }}>
                  {sending ? (lang === 'ja' ? '送信中...' : 'Sending…') : (lang === 'ja' ? '通報する' : 'Submit report')}
                </Button>
                <Button variant="outline" onClick={onClose}>{lang === 'ja' ? 'キャンセル' : 'Cancel'}</Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
