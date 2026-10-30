'use client';
import React from 'react';
import { IconTriangleAlert } from './Icons';

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}
interface State {
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return this.props.fallback ?? (
        <div style={{
          padding: '40px 24px',
          textAlign: 'center',
          color: 'var(--color-text-main)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12, color: 'var(--color-caution)' }}><IconTriangleAlert size={32} /></div>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>画面の表示中にエラーが発生しました</div>
          <div style={{ fontSize: 'var(--font-size-sm2)', color: 'var(--color-text-sub)', marginBottom: 20 }}>
            {this.state.error.message}
          </div>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '8px 20px',
              borderRadius: 'var(--border-radius-full)',
              border: '1.5px solid var(--color-border)',
              background: 'transparent',
              cursor: 'pointer',
              fontSize: 'var(--font-size-base)',
              color: 'var(--color-text-main)',
            }}
          >
            ページを再読み込み
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
