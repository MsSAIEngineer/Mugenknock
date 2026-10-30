'use client';
import React, { useState, useEffect, useCallback } from 'react';
import { IconChevronDown, IconChevronUp } from './Icons';
import { createPortal } from 'react-dom';

// 初回オンボーディング用スポットライト。
// targetSelector で指定した要素（＝演習開始ボタン）だけを切り抜いて周囲を暗くし、
// 矢印アニメーション＋一言で「開始」へ誘導する。
// スポットライトは box-shadow で暗転を描くだけ（pointer-events:none）なので、
// 強調中もボタンはそのまま押せる。
interface Props {
  targetSelector: string;
  message: string;
  skipLabel: string;
  onClose: () => void;
}

export default function StartTutorialSpotlight({ targetSelector, message, skipLabel, onClose }: Props) {
  const [rect, setRect] = useState<DOMRect | null>(null);

  const measure = useCallback(() => {
    const el = document.querySelector<HTMLElement>(targetSelector);
    // 実寸のある（表示中の）要素のみ対象にする
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) { setRect(r); return; }
    }
    setRect(null);
  }, [targetSelector]);

  useEffect(() => {
    measure();
    // レイアウト変化（フォント読込・パネル開閉・スクロール）に追従
    const id = window.setInterval(measure, 400);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [measure]);

  if (!rect) return null;

  const pad = 8;
  const hole = {
    left: rect.left - pad,
    top: rect.top - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  };
  // ボタンの上に十分な余白があれば上に、なければ下に吹き出しを出す
  const above = rect.top > 150;
  const bubbleLeft = Math.max(12, Math.min(window.innerWidth - 12 - 260, hole.left + hole.width / 2 - 130));

  const bubble = (
    <div style={{ display: 'inline-block', maxWidth: 260, background: 'var(--color-accent)', color: '#16191f', fontWeight: 700, fontSize: 'var(--font-size-sm)', padding: '8px 14px', borderRadius: 'var(--border-radius-full)', boxShadow: 'var(--box-shadow-lg)', lineHeight: 1.5 }}>
      {message}
    </div>
  );
  const arrow = (
    <div style={{ animation: 'mkTutArrow 0.9s ease-in-out infinite', color: 'var(--color-accent)', display: 'flex' }}>
      {above ? <IconChevronDown size={28} /> : <IconChevronUp size={28} />}
    </div>
  );

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 9500, pointerEvents: 'none' }}>
      <style>{`
        @keyframes mkTutArrow { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(7px); } }
        @keyframes mkTutRing {
          0%   { box-shadow: 0 0 0 0 rgba(255,153,0,0.6), 0 0 0 9999px rgba(0,0,0,0.55); }
          70%  { box-shadow: 0 0 0 12px rgba(255,153,0,0), 0 0 0 9999px rgba(0,0,0,0.55); }
          100% { box-shadow: 0 0 0 0 rgba(255,153,0,0), 0 0 0 9999px rgba(0,0,0,0.55); }
        }
        @keyframes mkTutFade { from { opacity: 0; } to { opacity: 1; } }
      `}</style>

      {/* スポットライト（穴＝開始ボタン。周囲は box-shadow で暗転） */}
      <div style={{
        position: 'fixed', left: hole.left, top: hole.top, width: hole.width, height: hole.height,
        borderRadius: 26,
        animation: 'mkTutRing 1.6s ease-out infinite',
        pointerEvents: 'none',
        transition: 'left 0.2s ease, top 0.2s ease, width 0.2s ease, height 0.2s ease',
      }} />

      {/* 吹き出し＋矢印 */}
      <div style={{
        position: 'fixed',
        left: bubbleLeft,
        width: 260,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
        textAlign: 'center',
        animation: 'mkTutFade 0.3s ease both',
        ...(above
          ? { bottom: window.innerHeight - hole.top + 8 }
          : { top: hole.top + hole.height + 8 }),
      }}>
        {above ? (<>{bubble}{arrow}</>) : (<>{arrow}{bubble}</>)}
      </div>

      {/* スキップ */}
      <button
        onClick={onClose}
        style={{ position: 'fixed', top: 12, right: 12, pointerEvents: 'auto', background: 'rgba(0,0,0,0.55)', color: '#fff', border: 'none', borderRadius: 'var(--border-radius-md)', padding: '6px 14px', fontSize: 'var(--font-size-xs)', cursor: 'pointer' }}
      >{skipLabel}</button>
    </div>,
    document.body,
  );
}
