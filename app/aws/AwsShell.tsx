'use client';
import dynamic from 'next/dynamic';
import React from 'react';
const Layout = dynamic(() => import('@/components/Layout'), { ssr: false });
export default function AwsShell({ children }: { children: React.ReactNode }) {
  return <Layout>{children}</Layout>;
}
