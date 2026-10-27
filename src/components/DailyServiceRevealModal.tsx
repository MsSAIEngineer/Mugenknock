'use client';
import { useState, useEffect, useMemo } from 'react';
import { lockBodyScroll } from '../utils/bodyScrollLock';
import { createPortal } from 'react-dom';
import { ServiceIconImg, IconSparkles, IconPointer, IconMousePointerClick, IconBean } from './Icons';
import Button from './ui/Button';

type DailyService = {
  serviceId: string;
  name: string;
  shortName?: string;
  category?: string;
  icon: string;
  description: string;
  trivia?: string;
  docUrl?: string;
  contentCheckedAt?: string;
};

type Phase = 'waiting' | 'revealing' | 'revealed';

const PARTICLE_COUNT = 28;
const COLORS = ['#FF9900', '#FFD700', '#FF6B35', '#FFFFFF', '#5CA3E6', '#FFCC44', '#44DD88'];

export default function DailyServiceRevealModal({
  service, lang, onClose, onNavigateEncyclopedia, onStartExercise,
}: {
  service: DailyService;
  lang: string;
  onClose: () => void;
  onNavigateEncyclopedia: () => void;
  onStartExercise: () => void;
}) {
  const ja = lang === 'ja';
  const [phase, setPhase] = useState<Phase>('waiting');

  const particles = useMemo(() => Array.from({ length: PARTICLE_COUNT }, (_, i) => {
    const angle = (360 / PARTICLE_COUNT) * i + (Math.random() * 14 - 7);
    const dist = 90 + Math.random() * 130;
    const rad = (angle * Math.PI) / 180;
    return {
      id: i,
      x: Math.cos(rad) * dist,
      y: Math.sin(rad) * dist,
      size: 7 + Math.random() * 7,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      delay: Math.random() * 0.13,
      dur: 0.55 + Math.random() * 0.3,
      round: Math.random() > 0.38,
    };
  }), []);

  const particleCSS = useMemo(() => particles.map(p => `
    @keyframes dp-particle-${p.id} {
      0%   { transform: translate(0,0) scale(1); opacity: 1; }
      100% { transform: translate(${p.x}px,${p.y}px) scale(0.05); opacity: 0; }
    }
  `).join(''), [particles]);

  const handleTap = () => {
    if (phase !== 'waiting') return;
    setPhase('revealing');
    setTimeout(() => setPhase('revealed'), 680);
  };

  useEffect(() => {
    return lockBodyScroll();
  }, []);

  const isMobile = window.innerWidth < 768;
  const cardSize = Math.min(276, window.innerWidth - 56);
  const isWaiting  = phase === 'waiting';
  const isRevealing = phase === 'revealing';
  const isRevealed  = phase === 'revealed';

  return createPortal(
    <>
      <style>{`
        @keyframes dp-pulse {
          0%,100% { box-shadow: 0 0 18px 3px rgba(82,130,255,.35), 0 0 50px 8px rgba(82,130,255,.12); }
          50%      { box-shadow: 0 0 32px 8px rgba(82,130,255,.65), 0 0 72px 18px rgba(82,130,255,.28); }
        }
        @keyframes dp-float {
          0%,100% { transform: translateY(0); }
          50%      { transform: translateY(-10px); }
        }
        @keyframes dp-tap-hint {
          0%,100% { opacity: 1; transform: translateY(0); }
          50%      { opacity: .65; transform: translateY(-6px); }
        }
        @keyframes dp-shimmer {
          0%   { transform: translateX(-130%) skewX(-18deg); }
          100% { transform: translateX(230%) skewX(-18deg); }
        }
        @keyframes dp-shake {
          0%  { transform: translate(0,0) rotate(0deg); }
          15% { transform: translate(-8px,3px) rotate(-4deg); }
          30% { transform: translate(8px,-3px) rotate(4deg); }
          50% { transform: translate(-5px,2px) rotate(-2deg); }
          70% { transform: translate(4px,-1px) rotate(2deg); }
          90% { transform: translate(-2px,1px) rotate(-1deg); }
          100%{ transform: translate(0,0) rotate(0deg); }
        }
        @keyframes dp-flash {
          0%   { opacity: 0; }
          22%  { opacity: .92; }
          100% { opacity: 0; }
        }
        @keyframes dp-icon-pop {
          0%   { transform: scale(0) rotate(-10deg); opacity: 0; }
          58%  { transform: scale(1.22) rotate(4deg); opacity: 1; }
          80%  { transform: scale(.93) rotate(-2deg); }
          100% { transform: scale(1) rotate(0deg); opacity: 1; }
        }
        @keyframes dp-badge {
          0%   { transform: scale(0) rotate(-20deg); opacity: 0; }
          65%  { transform: scale(1.28) rotate(6deg); opacity: 1; }
          100% { transform: scale(1) rotate(0deg); opacity: 1; }
        }
        @keyframes dp-text-up {
          from { transform: translateY(14px); opacity: 0; }
          to   { transform: translateY(0);    opacity: 1; }
        }
        ${particleCSS}
      `}</style>

      {/* ── close backdrop ── */}
      <div
        data-kbscope="1" role="dialog" aria-modal="true"
        onClick={phase === 'waiting' ? handleTap : phase === 'revealed' ? onClose : undefined}
        style={{
          position: 'fixed', inset: 0, zIndex: 9990,
          background: 'rgba(4,6,18,.9)',
          backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
          cursor: phase !== 'revealing' ? 'pointer' : 'default',
        }}
      />

      {/* flash */}
      {isRevealing && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9991,
          background: 'white',
          animation: 'dp-flash .5s ease-out forwards',
          pointerEvents: 'none',
        }} />
      )}

      {/* particles */}
      {(isRevealing || isRevealed) && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9992,
          pointerEvents: 'none',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {particles.map(p => (
            <div key={p.id} style={{
              position: 'absolute',
              width: p.size, height: p.round ? p.size : p.size * .52,
              borderRadius: p.round ? '50%' : '2px',
              background: p.color,
              boxShadow: `0 0 ${p.size}px ${p.color}88`,
              animation: `dp-particle-${p.id} ${p.dur}s ease-out ${p.delay}s both`,
            }} />
          ))}
        </div>
      )}

      {/* ── scrollable content layer (pointer-events: none so clicks pass through to backdrop) ── */}
      <div style={{
        position: 'fixed', inset: 0, zIndex: 9993,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center',
        padding: '20px 16px',
        overflowY: 'auto', overflowX: 'hidden',
        pointerEvents: 'none',
      }}>
        <div
          onClick={phase !== 'revealing' ? () => { if (isWaiting) handleTap(); else if (isRevealed) onClose(); } : undefined}
          style={{
            position: 'relative',
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            width: '100%', margin: 'auto 0',
            pointerEvents: 'auto',
            cursor: phase !== 'revealing' ? 'pointer' : 'default',
          }}>

          {/* label */}
          <div style={{
            color: 'rgba(255,255,255,.9)',
            fontSize: 'var(--font-size-xs)', fontWeight: 700, letterSpacing: '.12em',
            textTransform: 'uppercase', marginBottom: 18,
            textShadow: '0 1px 8px rgba(0,0,0,.4)',
            animation: 'dp-text-up .4s ease both',
            display: 'flex', alignItems: 'center', gap: 6,
            cursor: phase !== 'revealing' ? 'pointer' : 'default',
          }}
            onClick={isWaiting ? e => { e.stopPropagation(); handleTap(); } : isRevealed ? e => { e.stopPropagation(); onClose(); } : undefined}
          >
            <IconSparkles size={14} />
            {ja ? '今日の日めくりAWSサービス' : 'Daily AWS Service'}
            <IconSparkles size={14} />
          </div>

          {/* card */}
          <div
            onClick={e => { e.stopPropagation(); if (isWaiting) handleTap(); else if (isRevealed) onClose(); }}
            style={{
              position: 'relative',
              width: cardSize, height: cardSize,
              background: 'linear-gradient(140deg,#1a1a2e 0%,#16213e 55%,#0f3460 100%)',
              borderRadius: 22,
              border: `2px solid rgba(82,130,255,${isRevealed ? '.45' : '.75'})`,
              cursor: isWaiting ? 'pointer' : isRevealed ? 'pointer' : 'default',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              overflow: 'hidden',
              animation: isWaiting ? 'dp-pulse 2.2s ease-in-out infinite'
                        : isRevealing ? 'dp-shake .4s ease both'
                        : 'none',
              transition: 'border-color .4s',
              userSelect: 'none', WebkitUserSelect: 'none',
              flexShrink: 0,
            }}
          >
            {/* shimmer sweep */}
            {isWaiting && (
              <div style={{
                position: 'absolute', inset: 0,
                background: 'linear-gradient(90deg,transparent 0%,rgba(255,255,255,.08) 50%,transparent 100%)',
                width: '55%',
                animation: 'dp-shimmer 2.8s ease-in-out infinite',
                pointerEvents: 'none',
              }} />
            )}

            {/* ? mark */}
            {!isRevealed && (
              <div style={{
                fontSize: 108, fontWeight: 900, lineHeight: 1,
                color: 'white',
                textShadow: '0 4px 24px rgba(255,255,255,.25)',
                filter: 'drop-shadow(0 0 14px rgba(255,255,255,.2))',
                animation: isWaiting ? 'dp-float 3.2s ease-in-out infinite' : 'none',
                opacity: isRevealing ? 0 : 1,
                transition: 'opacity .12s',
              }}>?</div>
            )}

            {/* icon */}
            {isRevealed && (
              <div style={{ animation: 'dp-icon-pop .52s cubic-bezier(.175,.885,.32,1.275) .15s both' }}>
                <ServiceIconImg icon={service.icon} name={service.name} size={Math.round(cardSize / 2)} />
              </div>
            )}

            {/* NEW! badge */}
            {isRevealed && (
              <div style={{
                position: 'absolute', top: 14, right: 14,
                background: 'linear-gradient(135deg,#FF9900,#FF4400)',
                color: 'white', fontWeight: 900, fontSize: 'var(--font-size-xs)',
                padding: '3px 10px', borderRadius: 20,
                letterSpacing: '.04em',
                boxShadow: '0 2px 10px rgba(255,100,0,.55)',
                animation: 'dp-badge .4s cubic-bezier(.175,.885,.32,1.275) .38s both',
              }}>NEW!</div>
            )}
          </div>

          {/* tap hint */}
          {isWaiting && (
            <div
              onClick={e => { e.stopPropagation(); handleTap(); }}
              style={{
                marginTop: 24,
                color: 'rgba(255,255,255,.85)',
                fontSize: 'var(--font-size-md)', fontWeight: 600,
                animation: 'dp-tap-hint 1.5s ease-in-out infinite',
                textShadow: '0 2px 8px rgba(0,0,0,.5)',
                cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 8,
              }}
            >
              {isMobile ? <IconPointer size={18} /> : <IconMousePointerClick size={18} />}
              {ja ? 'タップして解放' : 'Tap to reveal'}
            </div>
          )}

          {/* service info */}
          {isRevealed && (
            <div
              onClick={e => { e.stopPropagation(); onClose(); }}
              style={{
                marginTop: 20, textAlign: 'center',
                animation: 'dp-text-up .4s ease .28s both',
                maxWidth: Math.min(isMobile ? 360 : 432, window.innerWidth - 40),
                width: '100%',
                paddingBottom: isMobile ? 0 : 80,
                cursor: 'pointer',
              }}
            >
              <div style={{
                fontSize: 21, fontWeight: 800, color: 'white',
                textShadow: '0 2px 8px rgba(0,0,0,.6)',
                marginBottom: 8, lineHeight: 1.3,
              }}>
                {service.name}
              </div>

              {service.category && (
                <div style={{
                  display: 'inline-block',
                  background: 'rgba(255,153,0,.16)',
                  border: '1px solid rgba(255,153,0,.4)',
                  color: 'white', fontSize: 'var(--font-size-sm)', fontWeight: 700,
                  padding: '2px 12px', borderRadius: 20, marginBottom: 12,
                }}>
                  {service.category}
                </div>
              )}

              <div style={{
                fontSize: 'var(--font-size-sm2)', color: 'rgba(255,255,255,.75)',
                lineHeight: 1.7, marginBottom: service.trivia ? 12 : 22,
                textAlign: 'left', overflowWrap: 'break-word', wordBreak: 'break-word',
              }}>
                {service.description}
              </div>

              {service.trivia && (
                <div style={{
                  background: 'rgba(255,153,0,.1)',
                  border: '1px solid rgba(255,153,0,.28)',
                  borderRadius: 10,
                  padding: '10px 14px',
                  marginBottom: 22,
                  textAlign: 'left',
                }}>
                  <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'white', marginBottom: 4, letterSpacing: '.06em', display: 'flex', alignItems: 'center', gap: 5 }}>
                    <IconBean size={12} /> {ja ? '豆知識' : 'Trivia'}
                  </div>
                  <div style={{ fontSize: 'var(--font-size-sm)', color: 'rgba(255,255,255,.7)', lineHeight: 1.7, overflowWrap: 'break-word', wordBreak: 'break-word' }}>
                    {service.trivia.replace(/^🌱\s*/, '')}
                  </div>
                </div>
              )}

              <div style={{ fontSize: 'var(--font-size-xs)', color: 'rgba(255,255,255,.4)', marginBottom: 16, textAlign: 'left' }}>
                {ja ? 'AI確認' : 'AI review'}:{' '}
                {service.contentCheckedAt
                  ? <span style={{ color: 'rgba(100,230,140,.75)', fontWeight: 700 }}>✓ {new Date(service.contentCheckedAt).toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' })}</span>
                  : <span>{ja ? '未確認' : 'not reviewed'}</span>
                }
              </div>

              {isMobile && (
                <div onClick={e => e.stopPropagation()} style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
                  <Button variant="primary" onClick={onStartExercise}>
                    {ja ? '今日の演習を始める' : "Start Today's Exercise"}
                  </Button>
                  <Button variant="outline" onClick={onNavigateEncyclopedia}
                    style={{ borderColor: 'rgba(255,255,255,.35)', color: 'white' }}>
                    {ja ? 'サービス図鑑' : 'Encyclopedia'}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* デスクトップ: ボタンを画面下に固定 */}
      {!isMobile && isRevealed && (
        <div
          onClick={e => e.stopPropagation()}
          style={{
            position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 9994,
            padding: '16px 24px',
            background: 'rgba(4,6,18,.92)',
            borderTop: '1px solid rgba(82,130,255,.2)',
            backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
            display: 'flex', gap: 12, justifyContent: 'center',
          }}
        >
          <Button variant="primary" size="lg" onClick={onStartExercise}>
            {ja ? '今日の演習を始める' : "Start Today's Exercise"}
          </Button>
          <Button variant="outline" size="lg" onClick={onNavigateEncyclopedia}
            style={{ borderColor: 'rgba(255,255,255,.35)', color: 'white' }}>
            {ja ? 'サービス図鑑' : 'Encyclopedia'}
          </Button>
        </div>
      )}
    </>,
    document.body,
  );
}
