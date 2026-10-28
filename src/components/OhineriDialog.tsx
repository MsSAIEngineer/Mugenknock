'use client';
import { useState } from 'react';
import Button from './ui/Button';
import { createCheckoutUrl, type Limits } from '../utils/dailyLimit';

/**
 * 1日の演習上限に達した（または残りが少ない）ときの案内。押し付けず、必ず閉じられる。
 * remaining > 0 のときは「残りの問題数で始める」を選べる。
 */
export default function OhineriDialog({
  ja, limits, requested, onStartCapped, onClose,
}: {
  ja: boolean;
  limits: Limits;
  requested: number;
  onStartCapped: (n: number) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const remaining = limits.remaining ?? 0;

  const pay = async () => {
    setBusy(true); setFailed(false);
    const url = await createCheckoutUrl();
    if (url) { window.location.href = url; return; }
    setBusy(false); setFailed(true);
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--spacing-lg)' }}
      onClick={onClose}>
      <div style={{ background: 'var(--color-bg-white)', borderRadius: 'var(--border-radius-lg)', padding: 'var(--spacing-lg)', width: '100%', maxWidth: 'var(--modal-width-sm)', boxShadow: 'var(--box-shadow-lg)' }}
        onClick={e => e.stopPropagation()}>
        <p style={{ margin: '0 0 var(--spacing-sm)', fontSize: 'var(--font-size-md)', fontWeight: 700, color: 'var(--color-text-main)' }}>
          {remaining > 0
            ? (ja ? `今日の無料分は、あと${remaining}問です` : `${remaining} free questions left today`)
            : (ja ? '今日の無料分（' + limits.limit + '問）を使い切りました' : `You've used today's ${limits.limit} free questions`)}
        </p>
        <p style={{ margin: '0 0 var(--spacing-md)', fontSize: 'var(--font-size-sm2)', color: 'var(--color-text-sub)', lineHeight: 1.7 }}>
          {ja
            ? `無料の演習は1日${limits.limit}問までです（日本時間の0時にリセット）。模擬試験は対象外です。${limits.priceYen}円のおひねりで、この上限がなくなります（1回のみ）。`
            : `Free practice is limited to ${limits.limit} questions per day (resets at midnight JST). Mock exams are not limited. A one-time ¥${limits.priceYen} tip removes the limit.`}
        </p>
        {failed && (
          <p style={{ margin: '0 0 var(--spacing-sm)', fontSize: 'var(--font-size-sm)', color: 'var(--color-error, #d13212)' }}>
            {ja ? '決済ページを開けませんでした。時間をおいてお試しください。' : 'Could not open the payment page. Please try again later.'}
          </p>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)' }}>
          {limits.purchaseEnabled && (
            <Button variant="primary" fullWidth disabled={busy} onClick={pay}>
              {busy ? (ja ? '移動中...' : 'Redirecting...') : (ja ? `おひねりで上限をなくす（${limits.priceYen}円）` : `Remove the limit (¥${limits.priceYen})`)}
            </Button>
          )}
          {remaining > 0 && (
            <Button variant="outline" fullWidth onClick={() => onStartCapped(Math.min(requested, remaining))}>
              {ja ? `残りの${Math.min(requested, remaining)}問で始める` : `Start with ${Math.min(requested, remaining)} questions`}
            </Button>
          )}
          <Button variant="outline" fullWidth onClick={onClose}>{ja ? '閉じる' : 'Close'}</Button>
        </div>
      </div>
    </div>
  );
}
