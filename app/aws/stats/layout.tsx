import type { Metadata } from 'next';

export const metadata: Metadata = { title: '統計・分析' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
