'use client';
import React from 'react';
import { useNavigate } from '@/compat/react-router-dom';

type BreadcrumbItem = {
  label: string;
  path?: string;
};

type Props = {
  items: BreadcrumbItem[];
  style?: React.CSSProperties;
};

export default function Breadcrumb({ items, style }: Props) {
  const navigate = useNavigate();

  return (
    <nav aria-label="パンくずリスト" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-base)', color: 'var(--color-text-sub)', marginBottom: 20, flexWrap: 'wrap', fontWeight: 400, ...style }}>
      {items.map((item, index) => (
        <React.Fragment key={index}>
          {index > 0 && <span style={{ color: 'var(--color-text-light)', fontSize: 'var(--font-size-sm)' }}>❯</span>}
          {item.path ? (
            <button
              onClick={() => navigate(item.path!)}
              style={{
                background: 'none', border: 'none', padding: 0,
                color: 'var(--color-primary)', cursor: 'pointer', fontSize: 'var(--font-size-base)',
                textDecoration: 'none',
              }}
              onMouseEnter={e => e.currentTarget.style.textDecoration = 'underline'}
              onMouseLeave={e => e.currentTarget.style.textDecoration = 'none'}
            >
              {item.label}
            </button>
          ) : (
            <span style={{ color: 'var(--color-text-sub)' }}>{item.label}</span>
          )}
        </React.Fragment>
      ))}
    </nav>
  );
}
