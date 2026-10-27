import type { Metadata } from 'next';
import '@aws-amplify/ui-react/styles.css';

export const metadata: Metadata = { title: 'ログイン | 無限ノック' };

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
