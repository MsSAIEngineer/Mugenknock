'use client';
// 管理者アカウントの2段階認証（TOTP）を設定する（docs/10-ops-review.md 4.9）。
// ユーザープールの MFA は「任意・TOTP のみ」なので、一般ユーザーには影響しない。ここで設定した人だけ、
// 次回からのログインで認証アプリの6桁コードを求められる（Amplify の Authenticator がその画面を出す）。
import React, { useEffect, useState } from 'react';
import { fetchMFAPreference, setUpTOTP, verifyTOTPSetup, updateMFAPreference } from 'aws-amplify/auth';
import Button from '../ui/Button';

export default function MfaSetupCard({ email }: { email: string }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [secret, setSecret] = useState('');
  const [uri, setUri] = useState('');
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchMFAPreference()
      .then(p => setEnabled(p.enabled?.includes('TOTP') ?? false))
      .catch(() => setEnabled(false));
  }, []);

  const start = async () => {
    setBusy(true); setMsg('');
    try {
      const out = await setUpTOTP();
      setSecret(out.sharedSecret);
      setUri(out.getSetupUri('無限ノック 管理', email).toString());
    } catch (e) {
      setMsg(`設定を始められませんでした: ${(e as Error).message}`);
    }
    setBusy(false);
  };

  const verify = async () => {
    setBusy(true); setMsg('');
    try {
      await verifyTOTPSetup({ code: code.trim() });
      await updateMFAPreference({ totp: 'PREFERRED' });
      setEnabled(true); setSecret(''); setUri(''); setCode('');
      setMsg('2段階認証を有効にしました。次回のログインから認証アプリのコードを求められます。');
    } catch (e) {
      setMsg(`コードを確認できませんでした: ${(e as Error).message}`);
    }
    setBusy(false);
  };

  return (
    <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--border-radius-md)', padding: 'var(--spacing-md)', marginBottom: 'var(--spacing-lg)' }}>
      <div style={{ fontSize: 'var(--font-size-base)', fontWeight: 700, marginBottom: 'var(--spacing-xs)' }}>2段階認証（認証アプリ）</div>
      {enabled === null && <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)' }}>確認中…</div>}
      {enabled === true && <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-main)' }}>✓ 有効です（{email}）</div>}
      {enabled === false && !secret && (
        <>
          <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', lineHeight: 1.6, margin: '0 0 var(--spacing-sm)' }}>
            未設定です。管理者はパスワードだけで問題の削除などができてしまうので、設定してください。
            Google Authenticator などの認証アプリが必要です。
          </p>
          <Button size="sm" onClick={start} disabled={busy}>設定を始める</Button>
        </>
      )}
      {enabled === false && secret && (
        <div style={{ fontSize: 'var(--font-size-sm)', lineHeight: 1.6 }}>
          <p style={{ margin: '0 0 var(--spacing-sm)' }}>
            認証アプリで「セットアップキーを入力」を選び、次のキーを入れてください（種類は「時間ベース」）。
          </p>
          <code style={{ display: 'block', padding: 'var(--spacing-sm)', background: 'var(--color-bg-main)', borderRadius: 'var(--border-radius-sm)', wordBreak: 'break-all', marginBottom: 'var(--spacing-sm)' }}>{secret}</code>
          <details style={{ marginBottom: 'var(--spacing-sm)' }}>
            <summary style={{ cursor: 'pointer', color: 'var(--color-text-sub)' }}>otpauth URI（QR コードを自分で作る場合）</summary>
            <code style={{ display: 'block', wordBreak: 'break-all', marginTop: 'var(--spacing-xs)' }}>{uri}</code>
          </details>
          <div style={{ display: 'flex', gap: 'var(--spacing-sm)', alignItems: 'center', flexWrap: 'wrap' }}>
            <input value={code} onChange={e => setCode(e.target.value)} inputMode="numeric" placeholder="アプリに出た6桁"
              aria-label="認証アプリの6桁のコード"
              style={{ padding: 'var(--spacing-sm)', border: '1px solid var(--color-border)', borderRadius: 'var(--border-radius-md)', fontSize: 'var(--font-size-base)', width: 140 }} />
            <Button size="sm" onClick={verify} disabled={busy || code.trim().length !== 6}>有効にする</Button>
          </div>
        </div>
      )}
      {msg && <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', margin: 'var(--spacing-sm) 0 0' }}>{msg}</p>}
    </div>
  );
}
