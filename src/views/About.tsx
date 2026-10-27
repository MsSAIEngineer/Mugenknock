'use client';
import React, { useState, useEffect } from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import { API_ENDPOINT } from '../constants';
import PageLayout from '../components/ui/PageLayout';

type Section = 'privacy' | 'terms' | 'operator';

const SECTIONS: { key: Section; ja: string; en: string }[] = [
  { key: 'privacy',  ja: 'プライバシーポリシー', en: 'Privacy Policy' },
  { key: 'terms',    ja: '利用規約',             en: 'Terms of Service' },
  { key: 'operator', ja: '運営者情報',           en: 'About Us' },
];

type CustomSections = Partial<Record<Section, string>>;

function hashToSection(): Section {
  if (typeof window === 'undefined') return 'privacy';
  const h = window.location.hash.replace('#', '') as Section;
  return SECTIONS.some(s => s.key === h) ? h : 'privacy';
}

export default function About() {
  const { lang } = useLanguage();
  const ja = lang === 'ja';
  const [section, setSection] = useState<Section>('privacy');
  const [custom, setCustom] = useState<CustomSections>({});

  useEffect(() => {
    setSection(hashToSection());
    const onHashChange = () => setSection(hashToSection());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    fetch(`${API_ENDPOINT}/settings/about`)
      .then(r => r.ok ? r.json() : { sections: {} })
      .then(data => setCustom(data.sections ?? {}))
      .catch(() => {});
  }, []);

  return (
    <PageLayout>
      <h1 style={{ margin: '0 0 var(--spacing-md)', fontSize: 'var(--font-size-h2)', fontWeight: 700, color: 'var(--color-text-main)' }}>
        {ja ? 'このサイトについて' : 'About'}
      </h1>
      {/* タブ */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 'var(--spacing-xl)', flexWrap: 'wrap' }}>
        {SECTIONS.map(s => (
          <button
            key={s.key}
            onClick={() => setSection(s.key)}
            style={{
              padding: '6px 18px', borderRadius: 'var(--border-radius-md)', border: 'none', cursor: 'pointer',
              fontSize: 'var(--font-size-sm)', fontWeight: 600,
              background: section === s.key ? 'var(--color-primary)' : 'var(--color-bg-main)',
              color: section === s.key ? 'var(--color-on-primary)' : 'var(--color-text-sub)',
              transition: 'background 0.15s',
            }}
          >
            {ja ? s.ja : s.en}
          </button>
        ))}
      </div>

      <div style={{ lineHeight: 1.8, color: 'var(--color-text-main)', fontSize: 'var(--font-size-base)' }}>
        {custom[section]
          ? <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, fontFamily: 'inherit', fontSize: 'inherit', lineHeight: 'inherit' }}>{custom[section]}</pre>
          : section === 'privacy' ? <PrivacyPolicy />
          : section === 'terms'   ? <TermsOfService />
          : <OperatorInfo />
        }
      </div>
    </PageLayout>
  );
}

function H3({ children }: { children: React.ReactNode }) {
  return (
    <h2 style={{ fontSize: 'var(--font-size-h3)', fontWeight: 700, color: 'var(--color-text-main)', margin: '2em 0 0.5em' }}>
      {children}
    </h2>
  );
}
function P({ children }: { children: React.ReactNode }) {
  return <p style={{ margin: '0.6em 0' }}>{children}</p>;
}
function Ul({ items }: { items: string[] }) {
  return (
    <ul style={{ margin: '0.5em 0', paddingLeft: 24 }}>
      {items.map((item, i) => <li key={i} style={{ marginBottom: 4 }}>{item}</li>)}
    </ul>
  );
}

function PrivacyPolicy() {
  return (
    <div>
      <P>制定日：2025年1月1日　最終更新日：2026年10月6日</P>
      <P>
        無限ノック（以下「本サービス」）は、ユーザーのプライバシーを尊重し、個人情報の保護に努めます。
        本プライバシーポリシーは、本サービスにおける個人情報の取り扱い方針を定めるものです。
      </P>

      <H3>1. 収集する情報と利用目的</H3>
      <P>本サービスは以下の情報を収集します。</P>
      <Ul items={[
        'アカウント情報（メールアドレス）：ログイン認証および運営からのお知らせ送付のため',
        '学習履歴・スコア：演習結果の保存・分析および学習進捗の表示のため',
        '1日の演習回数（1日あたりの演習の上限を設けている場合）：上限の判定のため。日本時間の翌日0時を過ぎてから数日で自動的に削除されます',
        'おひねり（任意のお支払い）をいただいた場合の購入記録（ユーザーID・金額・購入日時・決済ID）：購入状態の反映・お問い合わせ対応・不正利用の確認のため。クレジットカード情報は本サービスでは取得・保存しません',
        'お問い合わせ内容：ユーザーサポート対応のため',
        'アクセスログ（IPアドレス、ブラウザ種別等）：サービスの改善・不正利用防止のため',
      ]} />

      <H3>2. 広告について</H3>
      <P>
        本サービスは、現在、広告を配信していません。
      </P>

      <H3>3. アクセス解析（Google Analytics）</H3>
      <P>
        本サービスは、サービス改善を目的としてアクセス解析ツール「Google Analytics」を利用する場合があります。
        Google Analytics はトラフィックデータ収集のために Cookie または類似技術を使用します。
        収集されるデータは匿名であり、個人を特定するものではありません。
        Google Analytics のデータ収集については
        <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-primary)' }}>Google プライバシーポリシー</a>
        をご確認ください。
      </P>

      <H3>4. Cookie について</H3>
      <P>
        本サービスは、以下の目的で Cookie を使用します。
      </P>
      <Ul items={[
        'ログイン状態の維持・設定の保存',
        'アクセス解析',
      ]} />
      <P>
        ブラウザの設定から Cookie を無効にできます（一部機能が利用不可になる場合があります）。
      </P>

      <H3>5. 第三者への提供</H3>
      <P>
        本サービスは、法令に基づく場合を除き、収集した個人情報を第三者に提供・開示しません。
        ただし、AWS（Amazon Web Services）等のインフラサービスを利用するにあたり、
        サービスの運営上必要な範囲でデータが処理される場合があります。
      </P>
      <P>
        おひねり（任意のお支払い）の決済は、決済代行サービス「Stripe」（Stripe, Inc. および Stripe Payments Japan 株式会社）に委託しています。
        決済に必要な情報（メールアドレス・クレジットカード情報等）は Stripe が取得・処理し、本サービスはカード情報を受け取りません。
        Stripe における情報の取り扱いについては、
        <a href="https://stripe.com/jp/privacy" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-primary)' }}>Stripe のプライバシーポリシー</a>
        をご確認ください。
      </P>

      <H3>6. 情報の管理・セキュリティ</H3>
      <P>
        収集した個人情報は、不正アクセス・紛失・改ざん・漏洩等を防止するため、
        適切な安全管理措置を講じます。
      </P>

      <H3>7. ポリシーの変更</H3>
      <P>
        本プライバシーポリシーは、法令の改正やサービス内容の変更に伴い、予告なく改訂する場合があります。
        変更後のポリシーは本ページに掲載した時点で効力を生じます。
      </P>

      <H3>8. お問い合わせ</H3>
      <P>個人情報の取り扱いに関するお問い合わせは、本ページ内の「運営者情報」に記載の連絡先までご連絡ください。</P>

      <p style={{ marginTop: '2em', fontSize: 'var(--font-size-sm2)', color: 'var(--color-text-light)' }}>
        このポリシーの固定URLは{' '}
        <a href="/privacy-policy" style={{ color: 'var(--color-primary)' }}>/privacy-policy</a>{' '}
        です。
      </p>
    </div>
  );
}

function TermsOfService() {
  return (
    <div>
      <P>制定日：2025年1月1日　最終更新日：2026年10月6日</P>
      <P>
        本利用規約（以下「本規約」）は、無限ノック（以下「本サービス」）の利用条件を定めるものです。
        本サービスをご利用いただくことで、本規約に同意いただいたものとみなします。
      </P>

      <H3>第1条（サービスの概要）</H3>
      <P>
        本サービスは、AWS資格試験の学習を支援することを目的としたWebアプリケーションです。
        演習問題の提供、学習履歴の管理、スコアの記録などの機能を提供します。
      </P>

      <H3>第2条（利用登録）</H3>
      <P>
        本サービスの一部機能はアカウント登録なしで利用できますが、学習履歴の保存・スコア管理等の機能はログインが必要です。
        登録にあたっては、正確な情報を入力してください。
      </P>

      <H3>第3条（禁止事項）</H3>
      <P>ユーザーは以下の行為を行ってはなりません。</P>
      <Ul items={[
        '本サービスの問題文・解説・その他コンテンツの無断転載・複製・配布',
        '自動化ツール（クローラー、スクレイピングツール等）による大量アクセス・データ取得',
        'サービスの正常な運営を妨害する行為',
        '他のユーザーへの迷惑行為・なりすまし',
        '法令または公序良俗に反する行為',
        '本サービスを商業目的で無断利用する行為',
      ]} />

      <H3>第4条（著作権）</H3>
      <P>
        本サービスに掲載されている問題文・解説・図表・デザイン等のコンテンツは、
        運営者またはコンテンツ提供者に帰属し、著作権法によって保護されています。
        ユーザーによる無断転載・無断複製・スクレイピングを固く禁じます。
        学習目的での個人使用の範囲内での参照のみ許可します。
      </P>

      <H3>第5条（免責事項）</H3>
      <P>
        本サービスはAWS資格試験の合格を保証するものではありません。
        本サービスを利用したことによる試験結果について、運営者は一切の責任を負いません。
      </P>
      <P>
        本サービスの利用に関連して生じた損害（機会損失・データ損失・その他の損失を含む）について、
        運営者の故意または重大な過失による場合を除き、一切の責任を負いません。
      </P>
      <P>
        本サービスに掲載している問題・解説は可能な限り正確性を期しておりますが、
        内容の正確性・完全性・最新性を保証するものではありません。
      </P>

      <H3>第6条（サービスの変更・停止）</H3>
      <P>
        運営者は、ユーザーへの事前の通知なく、本サービスの内容の変更・追加・削除、
        または本サービスの一時停止・終了を行う場合があります。
        これらによってユーザーに生じた損害について、運営者は責任を負いません。
      </P>
      <P>
        将来的に、本サービスの一部機能について有料の機能やプランを導入する可能性があります。
        その際は、利用規約・料金体系を改めてご案内します。
      </P>

      <H3>第7条（おひねり）</H3>
      <P>
        運営者は、本サービスの通常の演習について、1日あたりの回数に上限を設けることがあります（模擬試験は対象外）。
        上限を設けている場合の回数・リセット時刻は、本サービス内の表示（「おひねり」のページ等）のとおりです。
        上限の数値は、運営者の判断により変更する場合があります。
      </P>
      <P>
        運営者が任意のお支払い「おひねり」を提供している場合、ユーザーは、その料金（本ページ作成時点：100円（税込）・1回限り）を
        お支払いいただくことで、本サービスが提供されている間、ご自身のアカウントについて上記の上限が適用されなくなります。
        おひねりは応援のしるしとしての任意のお支払いであり、問題や機能が追加されるなどの特典はありません。
      </P>
      <P>
        お支払いはクレジットカードによる決済代行サービス「Stripe」を通じて行い、お支払いの完了後、直ちに反映されます。
        反映はお支払い時にログインしていたアカウントに対して行われます。
        退会（データの削除）した場合や、別のアカウントとして再登録した場合には、おひねりの効果は引き継がれません。
      </P>
      <P>
        おひねりはデジタルな権利の提供であり、お支払いの完了後のキャンセル・返金はお受けしません。
        ただし、二重のお支払い、決済の不具合、または運営者側の不具合によりおひねりが反映されない場合は、
        本ページ内の「運営者情報」に記載の連絡先までご連絡ください。確認のうえ、全額を返金します。
      </P>
      <P>
        未成年の方は、保護者の同意を得たうえでお支払いください。
      </P>

      <H3>第8条（個人情報の取り扱い）</H3>
      <P>
        個人情報の取り扱いについては、本サービスのプライバシーポリシーに定めるとおりとします。
      </P>

      <H3>第9条（規約の変更）</H3>
      <P>
        運営者は、必要に応じて本規約を予告なく変更することがあります。
        変更後の規約は本ページに掲載した時点で効力を生じるものとし、
        変更後も本サービスを継続してご利用いただいた場合は、変更後の規約に同意したものとみなします。
      </P>

      <H3>第10条（準拠法・管轄）</H3>
      <P>
        本規約は日本法を準拠法とし、本サービスに関する紛争については、
        運営者の所在地を管轄する裁判所を専属合意管轄裁判所とします。
      </P>
    </div>
  );
}

function OperatorInfo() {
  return (
    <div>
      <H3>運営者情報</H3>
      <table style={{ borderCollapse: 'collapse', width: '100%', marginTop: '0.5em' }}>
        <tbody>
          {[
            { label: 'サイト名',   value: '無限ノック' },
            { label: 'URL',        value: <a href="https://www.mugenknock.com/" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-primary)' }}>https://www.mugenknock.com/</a> },
            { label: '運営者',     value: '個人運営（日本国内）' },
            { label: 'お問い合わせ', value: <a href="mailto:mugenknock@gmail.com" style={{ color: 'var(--color-primary)' }}>mugenknock@gmail.com</a> },
          ].map(({ label, value }) => (
            <tr key={label} style={{ borderBottom: '1px solid var(--color-border)' }}>
              <td style={{ padding: '12px 16px 12px 0', width: 140, color: 'var(--color-text-sub)', fontSize: 'var(--font-size-sm)', fontWeight: 600, verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                {label}
              </td>
              <td style={{ padding: '12px 0' }}>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <H3>本サービスについて</H3>
      <P>
        無限ノックは、AWS認定資格の取得を目指す方のための反復学習Webアプリです。
        CLF・SAA・SAPをはじめとする全12種の試験区分に対応し、演習モード・模試モードで
        本番に近い環境での学習をサポートします。
      </P>
      <Ul items={[
        '全試験区分対応の演習・模試機能',
        'ドメイン別正答率の可視化',
        '予想スコアの算出',
        '学習履歴・成績の長期保存',
      ]} />

      <H3>コンテンツの品質について</H3>
      <P>
        本サービスの演習問題は、AIを活用して作成しています。
        すべての問題は人の目によるレビューおよびAIによる品質チェックを経た後に公開しており、
        正確性・適切性を確保するよう努めています。
        ただし、AWSサービスの仕様変更等により内容が最新でない場合があります。
        不審な点はお問い合わせまたは問題報告機能よりご連絡ください。
      </P>

      <H3>免責・著作権</H3>
      <P>
        本サービスはAWS資格試験の合格を保証するものではありません。
        掲載コンテンツの無断転載・スクレイピングは禁止しています。
        詳細は利用規約をご確認ください。
      </P>
      <p style={{ margin: '1em 0 0', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-light)' }}>
        AWS、Amazon Web Services およびそれに関連するロゴ・サービス名は、Amazon.com, Inc. またはその関連会社の商標です。
        本サービスは Amazon.com, Inc. およびその関連会社とは一切関係のない独立した非公式サービスです。
      </p>
    </div>
  );
}
