import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'このサイトについて | 無限ノック' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
