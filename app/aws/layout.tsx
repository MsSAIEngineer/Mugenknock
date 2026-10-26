import type { Metadata } from 'next';
import React from 'react';
import AwsShell from './AwsShell';

// ルートの app/layout.tsx は 'use client' で metadata を書けないため、/aws 配下のタブ名はここと
// 各ルートの layout.tsx で付ける。子ルートは title に画面名だけを書けば template が付く。
export const metadata: Metadata = {
  title: { default: 'ホーム | 無限ノック', template: '%s | 無限ノック' },
};

export default function AwsLayout({ children }: { children: React.ReactNode }) {
  return <AwsShell>{children}</AwsShell>;
}
