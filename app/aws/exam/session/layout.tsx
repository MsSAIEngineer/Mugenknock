import type { Metadata } from 'next';

export const metadata: Metadata = { title: '模試中' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
