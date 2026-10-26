import type { Metadata } from 'next';

export const metadata: Metadata = { title: '資格ダッシュボード' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
