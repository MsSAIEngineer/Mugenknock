import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Webサイトの構成図 | 無限ノック' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
