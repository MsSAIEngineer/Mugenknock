'use client';

import React, { Suspense, useEffect } from 'react';
import { Amplify } from 'aws-amplify';
import outputs from '../src/amplify_outputs.json';
import { AuthProvider } from '../src/contexts/AuthContext';
import { LanguageProvider } from '../src/contexts/LanguageContext';
import { ThemeProvider } from '../src/contexts/ThemeContext';
import { installApiAuth } from '../src/utils/apiAuth';
import '../src/index.css';

Amplify.configure(outputs);
// API_ENDPOINT 宛 fetch に Cognito idToken を自動付与（/users/me の越権防止をサーバ側で成立させる）
installApiAuth();

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // エラービーコン（グローバルエラーハンドラ）
  useEffect(() => {
    const API_BASE = process.env.NEXT_PUBLIC_API_ENDPOINT;
    if (!API_BASE) return;
    const sendErrorBeacon = (payload: object) => {
      const data = JSON.stringify({ ...payload, url: window.location.href, ua: navigator.userAgent, ts: new Date().toISOString() });
      try {
        if (navigator.sendBeacon) navigator.sendBeacon(`${API_BASE}/errors`, data);
        else fetch(`${API_BASE}/errors`, { method: 'POST', body: data, keepalive: true }).catch(() => {});
      } catch {}
    };
    const onError = (e: ErrorEvent) => sendErrorBeacon({ type: 'uncaught', message: e.message, stack: e.error?.stack ?? '' });
    const onUnhandled = (e: PromiseRejectionEvent) => {
      const r = e.reason;
      sendErrorBeacon({ type: 'unhandledrejection', message: r?.message ?? String(r), stack: r?.stack ?? '' });
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandled);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onUnhandled);
    };
  }, []);

  return (
    <html lang="ja">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#232f3e" />
        <link rel="icon" type="image/png" href="/mugen-icon.png" />
        <link rel="apple-touch-icon" href="/mugen-icon.png" />
        <link rel="manifest" href="/manifest.json" />
        {/* ログイン済み(目標資格設定済み)ユーザーはトップのランディングをペイントせず即アプリへ。
            本文がSSRで静的HTMLに残るためSEOは維持。ゲスト/クローラはCognitoトークンが無いので素通り。 */}
        <script dangerouslySetInnerHTML={{ __html: `(function(){try{var p=location.pathname;if(p!=='/'&&p!=='/index.html')return;if(location.search.indexOf('view=')!==-1||location.hash==='#about')return;var sub=null;for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);if(k&&k.indexOf('CognitoIdentityServiceProvider.')===0&&/\\.idToken$/.test(k)){var t=localStorage.getItem(k);if(t){try{sub=JSON.parse(decodeURIComponent(escape(atob(t.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))))).sub;}catch(e){}}break;}}if(sub&&localStorage.getItem('targetExam_'+sub)){location.replace('/aws/');}}catch(e){}})();` }} />
        {/* テーマちらつき防止スクリプト */}
        <script dangerouslySetInnerHTML={{ __html: `(function(){var t=localStorage.getItem('theme');if(t==='dark')document.documentElement.setAttribute('data-theme','dark');})();` }} />
        {/* JSON-LD */}
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'WebApplication',
          'name': '無限ノック',
          'url': 'https://mugenknock.com/',
          'description': 'AWS認定試験（SAA・CLF・SAPなど）の無料練習問題サービス。演習・模試・サービス図鑑の3本柱でスコアアップをサポート。',
          'applicationCategory': 'EducationApplication',
          'operatingSystem': 'All',
          'inLanguage': 'ja',
          'offers': { '@type': 'Offer', 'price': '0', 'priceCurrency': 'JPY' },
        }) }} />
        {/* Organization / WebSite（ブランド認識・サイトリンク対象化） */}
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify({
          '@context': 'https://schema.org',
          '@graph': [
            {
              '@type': 'Organization',
              '@id': 'https://mugenknock.com/#org',
              'name': '無限ノック',
              'url': 'https://mugenknock.com/',
              'logo': 'https://mugenknock.com/mugen-icon.png',
            },
            {
              '@type': 'WebSite',
              '@id': 'https://mugenknock.com/#website',
              'name': '無限ノック',
              'url': 'https://mugenknock.com/',
              'inLanguage': 'ja',
              'publisher': { '@id': 'https://mugenknock.com/#org' },
            },
          ],
        }) }} />
        <style dangerouslySetInnerHTML={{ __html: `
          #initial-loader{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#f2f3f3;gap:28px;z-index:9999;}
          html[data-theme="dark"] #initial-loader{background:#0d1117;}
          #initial-loader img{width:auto;height:56px;object-fit:contain;}
          @keyframes _spin{to{transform:rotate(360deg);}}
          #initial-loader-ring{width:40px;height:40px;border:3px solid #eaeded;border-top-color:#0047A3;border-radius:50%;animation:_spin 0.8s linear infinite;}
          html[data-theme="dark"] #initial-loader-ring{border-color:#30363d;border-top-color:#42B4FF;}
        ` }} />
      </head>
      <body>
        <AuthProvider>
          <ThemeProvider>
            <LanguageProvider>
              <Suspense fallback={null}>
                {children}
              </Suspense>
            </LanguageProvider>
          </ThemeProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
