import type { Metadata } from 'next';

export const metadata: Metadata = { title: '模試モード' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
