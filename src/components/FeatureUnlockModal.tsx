'use client';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { lockBodyScroll } from '../utils/bodyScrollLock';
import { IconLockOpen, IconTarget, IconBrain, IconSparkles } from './Icons';
import Button from './ui/Button';
import Confetti from './Confetti';

const ACCENT = 'var(--color-points)'; // 「しっかり対策」と同じティール系アクセント

/**
 * 一定数の演習を重ねて「しっかり対策」「苦手ドメイン分析」が解放されたときに
 * 一度だけ表示する祝福ポップアップ。日めくり解放モーダルと同系統の
 * ポータル + アニメーションで、既存UIのトーンに合わせている。
 */
export default function FeatureUnlockModal({
  lang, onClose, onStart,
}: {
  lang: string;
  onClose: () => void;
  onStart: () => void;
}) {
  const ja = lang === 'ja';
  const [show, setShow] = useState(false);

  useEffect(() => {
    const unlock = lockBodyScroll();
    // マウント直後に1フレーム置いてから入場アニメを走らせる
    const raf = requestAnimationFrame(() => setShow(true));
    return () => { cancelAnimationFrame(raf); unlock(); };
  }, []);

  const features = [
    {
      icon: <IconTarget size={20} />,
      title: ja ? 'しっかり対策' : 'Focused Practice',
      desc: ja ? '苦手・誤答した問題を優先して重点的に演習できます' : 'Prioritizes your weak and previously-missed questions',
    },
    {
      icon: <IconBrain size={20} />,
      title: ja ? '苦手ドメイン分析' : 'Weak Domain Analysis',
      desc: ja ? 'ドメイン別の正答率で弱点を可視化します' : 'Visualizes weak areas by domain accuracy',
    },
  ];

  return createPortal(
    <>
      <style>{`
        @keyframes fu-backdrop { from { opacity: 0; } to { opacity: 1; } }
        @keyframes fu-pop {
          0%   { opacity: 0; transform: translateY(12px) scale(.92); }
          60%  { opacity: 1; transform: translateY(0) scale(1.02); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes fu-badge {
          0%   { transform: scale(0); }
          55%  { transform: scale(1.18); }
          100% { transform: scale(1); }
        }
        @keyframes fu-ring {
          0%   { transform: scale(.8); opacity: .55; }
          100% { transform: scale(1.9); opacity: 0; }
        }
        @keyframes fu-row {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      {show && <Confetti count={90} durationMs={2600} zIndex={10002} />}

      {/* backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, zIndex: 10000,
          background: 'rgba(15,20,40,.55)',
          backdropFilter: 'blur(5px)', WebkitBackdropFilter: 'blur(5px)',
          animation: 'fu-backdrop .22s ease both',
        }}
      />

      {/* content layer */}
      <div style={{
        position: 'fixed', inset: 0, zIndex: 10001,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 'var(--spacing-md)', pointerEvents: 'none',
      }}>
        <div
          role="dialog" aria-modal="true"
          style={{
            pointerEvents: 'auto',
            width: '100%', maxWidth: 'var(--modal-width-sm)',
            background: 'var(--color-bg-white)',
            borderRadius: 'var(--border-radius-lg)',
            boxShadow: 'var(--box-shadow-lg)',
            padding: 'var(--spacing-xl) var(--spacing-lg) var(--spacing-lg)',
            textAlign: 'center',
            animation: show ? 'fu-pop .42s cubic-bezier(.2,.9,.3,1.2) both' : 'none',
          }}
        >
          {/* badge */}
          <div style={{ position: 'relative', width: 76, height: 76, margin: '0 auto var(--spacing-md)' }}>
            <span style={{
              position: 'absolute', inset: 0, borderRadius: '50%',
              border: `2px solid ${ACCENT}`,
              animation: 'fu-ring 1.8s ease-out .3s infinite',
            }} />
            <div style={{
              width: 76, height: 76, borderRadius: '50%',
              background: `linear-gradient(140deg, ${ACCENT} 0%, #00c2b8 100%)`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', boxShadow: '0 8px 22px rgba(0,158,158,.4)',
              animation: 'fu-badge .5s cubic-bezier(.2,.9,.3,1.4) both',
            }}>
              <IconLockOpen size={34} />
            </div>
          </div>

          {/* kicker */}
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            color: ACCENT, fontSize: 'var(--font-size-xs)', fontWeight: 700,
            letterSpacing: '.08em', marginBottom: 'var(--spacing-xs)',
          }}>
            <IconSparkles size={13} />
            {ja ? 'NEW FEATURE UNLOCKED' : 'NEW FEATURE UNLOCKED'}
            <IconSparkles size={13} />
          </div>

          {/* title */}
          <h2 style={{
            margin: '0 0 var(--spacing-sm)', fontSize: 'var(--font-size-xl)',
            fontWeight: 800, color: 'var(--color-text-main)',
          }}>
            {ja ? '新機能を解放しました！' : 'New features unlocked!'}
          </h2>
          <p style={{
            margin: '0 0 var(--spacing-lg)', fontSize: 'var(--font-size-sm)',
            color: 'var(--color-text-light)', lineHeight: 1.6,
          }}>
            {ja
              ? '演習の積み重ねで、次の2つが使えるようになりました。'
              : 'Your practice has unlocked these two features.'}
          </p>

          {/* feature rows */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)', marginBottom: 'var(--spacing-lg)' }}>
            {features.map((f, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 'var(--spacing-md)',
                textAlign: 'left', padding: 'var(--spacing-sm) var(--spacing-md)',
                background: 'var(--color-bg-main)',
                borderRadius: 'var(--border-radius-md)',
                animation: `fu-row .4s ease both`, animationDelay: `${0.25 + i * 0.12}s`,
              }}>
                <div style={{
                  flexShrink: 0, width: 40, height: 40, borderRadius: 'var(--border-radius-md)',
                  background: 'color-mix(in srgb, var(--color-points) 12%, transparent)', color: ACCENT,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  {f.icon}
                </div>
                <div>
                  <div style={{ fontSize: 'var(--font-size-base)', fontWeight: 700, color: 'var(--color-text-main)' }}>{f.title}</div>
                  <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)', lineHeight: 1.5 }}>{f.desc}</div>
                </div>
              </div>
            ))}
          </div>

          <Button variant="primary" fullWidth onClick={onStart}>
            {ja ? 'しっかり対策を始める' : 'Start Focused Practice'}
          </Button>
          <button
            onClick={onClose}
            style={{
              marginTop: 'var(--spacing-sm)', background: 'transparent', border: 'none',
              color: 'var(--color-text-light)', fontSize: 'var(--font-size-sm)',
              cursor: 'pointer', padding: 'var(--spacing-xs) var(--spacing-sm)',
            }}
          >
            {ja ? 'あとで' : 'Later'}
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
}
