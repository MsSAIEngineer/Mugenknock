import type { Metadata } from 'next';

export const metadata: Metadata = { title: '演習中' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
