import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'その他' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
