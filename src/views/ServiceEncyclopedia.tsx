'use client';
import React, { useState, useEffect, useMemo } from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import { useAuth } from '../contexts/AuthContext';
import Button from '../components/ui/Button';
import { IconLock, IconBean, ServiceIcon, isServiceIconKey, ServiceIconImg, IconExternalLink, IconSearch } from '../components/Icons';
import { CATALOG, getDailyService, ServiceEntry } from '../data/awsServiceCatalog';
import { API_ENDPOINT } from '../constants';
import PageLayout from '../components/ui/PageLayout';

type EncyclopediaService = {
  serviceId: string;
  name: string;
  shortName?: string;
  category?: string;
  icon: string;
  description: string;
  trivia?: string;
  docUrl?: string;
  deprecationNote?: string;
  deprecationStatus?: string;
  contentCheckedAt?: string;
};


function normalizeSvcName(n: string): string {
  return n.toLowerCase().replace(/^amazon\s+/, '').replace(/^aws\s+/, '').trim();
}

function isUnlocked(svc: ServiceEntry, unlockedMap: Record<string, string>, storedServices?: Record<string, { name?: string }>): boolean {
  if (svc.serviceIds?.some(id => id in unlockedMap)) return true;
  if (svc.name in unlockedMap) return true;
  // DailyServices UUID がカタログの serviceIds と一致しない場合、
  // storedServices のサービス名とカタログ名を正規化して突合
  // （カタログは短縮名 "CloudFront"、DailyServices は "Amazon CloudFront" のため）
  if (storedServices) {
    const normCatalog = normalizeSvcName(svc.name);
    const found = Object.keys(unlockedMap).some(id => {
      const storedName = storedServices[id]?.name;
      return storedName && normalizeSvcName(storedName) === normCatalog;
    });
    if (found) return true;
  }
  return false;
}

function unlockKey(svc: ServiceEntry): string {
  return svc.serviceIds?.[0] ?? svc.name;
}


function resolveEncyclopediaIcon(icon: string, name: string): string {
  if (!icon || icon.startsWith('/') || icon.startsWith('http') || isServiceIconKey(icon)) return icon;
  const lower = name.toLowerCase();
  for (const cat of CATALOG) {
    const entry = cat.services.find(s => s.name.toLowerCase() === lower);
    if (entry?.icon) return entry.icon;
  }
  return icon;
}

function renderIcon(service: EncyclopediaService, size: number): React.ReactNode {
  const icon = resolveEncyclopediaIcon(service.icon, service.name);
  return <ServiceIconImg icon={icon} name={service.name} size={size} />;
}

export default function ServiceEncyclopedia() {
  const { lang } = useLanguage();
  const ja = lang === 'ja';
  const { user, loading: authLoading } = useAuth();
  const uid = user?.userId ?? 'guest';

  const [unlockedMap, setUnlockedMap] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem(`encyclopediaUnlocked_${uid}`) ?? '{}'); } catch { return {}; }
  });
  const [storedServices, setStoredServices] = useState<Record<string, EncyclopediaService>>(() => {
    try { return JSON.parse(localStorage.getItem('encyclopediaServices') ?? '{}'); } catch { return {}; }
  });
  const [selected, setSelected] = useState<EncyclopediaService | null>(null);
  const [selectedLoading, setSelectedLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'all' | 'unlocked'>('unlocked');
  const [search, setSearch] = useState('');
  // サービス図鑑の母数・グリッドは DailyServices 実データから動的算出する（対象変更に追従）。
  // 取得失敗時は静的 CATALOG にフォールバックして従来表示を維持。
  const [liveServices, setLiveServices] = useState<EncyclopediaService[] | null>(null);

  // 認証完了後に正しい uid で localStorage を再読み込み
  useEffect(() => {
    if (authLoading) return;
    try { setUnlockedMap(JSON.parse(localStorage.getItem(`encyclopediaUnlocked_${uid}`) ?? '{}')); } catch {}
    try { setStoredServices(JSON.parse(localStorage.getItem('encyclopediaServices') ?? '{}')); } catch {}
  }, [uid, authLoading]);

  useEffect(() => {
    const refresh = () => {
      try { setUnlockedMap(JSON.parse(localStorage.getItem(`encyclopediaUnlocked_${uid}`) ?? '{}')); } catch {}
      try { setStoredServices(JSON.parse(localStorage.getItem('encyclopediaServices') ?? '{}')); } catch {}
    };
    window.addEventListener('encyclopediaUpdated', refresh);
    return () => window.removeEventListener('encyclopediaUpdated', refresh);
  }, [uid]);

  // サーバーから解放済みデータを取得してローカルとマージ
  useEffect(() => {
    if (!user?.userId) return;
    fetch(`${API_ENDPOINT}/users/me/encyclopedia-unlocks?userId=${encodeURIComponent(user.userId)}`)
      .then(r => r.json())
      .then(data => {
        if (!data.unlocks || typeof data.unlocks !== 'object') return;
        // サーバーから返ったサービス詳細データをローカルにマージ（新デバイスでのアイコン復元）
        // サービス詳細データ：サーバー優先（キャッシュより新しい情報で上書き）
        if (data.services && typeof data.services === 'object' && Object.keys(data.services).length > 0) {
          const existingSvcs = (() => { try { return JSON.parse(localStorage.getItem('encyclopediaServices') ?? '{}'); } catch { return {}; } })();
          const mergedSvcs = { ...existingSvcs, ...data.services };
          localStorage.setItem('encyclopediaServices', JSON.stringify(mergedSvcs));
          setStoredServices(mergedSvcs);
        }
        // todayServiceId・unlockDate はサーバー値で常に上書き（サーバー優先）
        const jstDate = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
        if (data.todayServiceId && data.unlockDate === jstDate) {
          localStorage.setItem(`encyclopediaTodayServiceId_${uid}`, data.todayServiceId);
          localStorage.setItem(`encyclopediaUnlockDate_${uid}`, data.unlockDate);
        }
        const local = (() => { try { return JSON.parse(localStorage.getItem(`encyclopediaUnlocked_${uid}`) ?? '{}'); } catch { return {}; } })();
        // サーバー優先マージ（ローカルに新規解放分があれば残す）
        const merged: Record<string, string> = { ...local, ...data.unlocks };
        const changed = Object.keys(merged).some(k => !(k in local));
        if (changed) {
          localStorage.setItem(`encyclopediaUnlocked_${uid}`, JSON.stringify(merged));
          setUnlockedMap(merged);
          const unlockDate = localStorage.getItem(`encyclopediaUnlockDate_${uid}`) ?? data.unlockDate;
          const todayServiceId = localStorage.getItem(`encyclopediaTodayServiceId_${uid}`) ?? data.todayServiceId;
          const postBody = JSON.stringify({ userId: user.userId, unlocks: merged, unlockDate, todayServiceId });
          const doPost = (retriesLeft: number) => {
            fetch(`${API_ENDPOINT}/users/me/encyclopedia-unlocks`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: postBody,
            }).then(r => { if (!r.ok && retriesLeft > 0) setTimeout(() => doPost(retriesLeft - 1), 3000); })
              .catch(() => { if (retriesLeft > 0) setTimeout(() => doPost(retriesLeft - 1), 3000); });
          };
          doPost(1);
        } else {
          // unlocks に変化がない場合でも、localStorageのtodayServiceIdが復元されたならUIを再レンダリング
          const restoredId = localStorage.getItem(`encyclopediaTodayServiceId_${uid}`);
          if (restoredId) setUnlockedMap({ ...local });
        }
        // 解放済みだがstoredServicesにないサービスをCATALOGのアイコンで補完
        // APIレスポンスのservicesに含まれなかったIDでもアイコンを即時表示するため
        const latestSvcs: Record<string, EncyclopediaService> = (() => {
          try { return JSON.parse(localStorage.getItem('encyclopediaServices') ?? '{}'); } catch { return {}; }
        })();
        const allCatalogEntries = CATALOG.flatMap(c => c.services.map(s => ({ ...s, category: c.category })));
        const supplemented = { ...latestSvcs };
        let needsUpdate = false;
        for (const id of Object.keys(merged)) {
          if (!id || id === '_schedule_' || supplemented[id]) continue;
          const entry = allCatalogEntries.find(s => s.serviceIds?.includes(id));
          if (entry?.icon) {
            supplemented[id] = { serviceId: id, name: entry.name, icon: entry.icon, description: '', category: entry.category };
            needsUpdate = true;
          }
        }
        if (needsUpdate) {
          localStorage.setItem('encyclopediaServices', JSON.stringify(supplemented));
          setStoredServices(supplemented);
        }
      })
      .catch(() => {});
  }, [user?.userId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 全件一覧を取得して母数・グリッドの源にする（公開API・解放状態とは独立）
  useEffect(() => {
    fetch(`${API_ENDPOINT}/daily-service?list=1`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (Array.isArray(d?.services) && d.services.length > 0) setLiveServices(d.services); })
      .catch(() => {});
  }, []);

  // 実データをカテゴリ別の CATALOG 互換構造へ整形（母数・グリッドに使用）
  const displayCatalog = useMemo(() => {
    if (!liveServices) return CATALOG;
    const byCat = new Map<string, ServiceEntry[]>();
    for (const s of liveServices) {
      const cat = s.category || 'その他';
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat)!.push({ name: s.shortName || s.name, serviceIds: [s.serviceId], icon: s.icon });
    }
    return Array.from(byCat, ([category, services]) => ({ category, services }));
  }, [liveServices]);

  const todaySvc = getDailyService(uid);
  const todayId = localStorage.getItem(`encyclopediaTodayServiceId_${uid}`);

  // Check unlock via direct todayId (most reliable) OR via catalog-based keys
  const todayUnlocked =
    (todayId !== null && todayId in unlockedMap) ||
    (todaySvc.serviceIds?.some(id => id in unlockedMap) ?? false) ||
    (unlockKey(todaySvc) in unlockedMap);

  // Prefer data from the exact todayId saved on the home screen
  const todayStoreData: EncyclopediaService | null =
    (todayId ? storedServices[todayId] ?? null : null) ??
    (todaySvc.serviceIds?.map(id => storedServices[id]).find(Boolean) ?? null);

  const jstDate = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const todayAlreadyDone = localStorage.getItem(`encyclopediaUnlockDate_${uid}`) === jstDate;

  const allServices = displayCatalog.flatMap(c => c.services);
  const totalServices = allServices.length;
  const unlockedCount = allServices.filter(s => isUnlocked(s, unlockedMap, storedServices)).length;
  const unlockRate = totalServices > 0 ? Math.round((unlockedCount / totalServices) * 100) : 0;

  // 検索時はタブ（解放済み/一覧）を無視して全カテゴリ横断で検索する（チートシート検索と同じ方式）
  const q = search.trim().toLowerCase();
  const totalHits = useMemo(() => {
    if (!q) return 0;
    return allServices.filter(s => s.name.toLowerCase().includes(q)).length;
  }, [q, allServices]);

  const calIcon = (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--color-primary)', flexShrink: 0 }}>
      <path d="M3 20a2 2 0 0 0 2 2h10a2.4 2.4 0 0 0 1.706-.706l3.588-3.588A2.4 2.4 0 0 0 21 16V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2z"/>
      <path d="M15 22v-5a1 1 0 0 1 1-1h5"/><path d="M8 2v4"/><path d="M16 2v4"/><path d="M3 10h18"/>
    </svg>
  );

  // 認証ロード中は guest データで誤った表示が一瞬見えるのを防ぐ
  if (authLoading) return (
    <PageLayout>
      <div className="skeleton" style={{ height: 16, width: 200, borderRadius: 4, marginBottom: 'var(--spacing-md)' }} />
      <div className="skeleton" style={{ height: 80, borderRadius: 'var(--border-radius-lg)', marginBottom: 'var(--spacing-md)' }} />
    </PageLayout>
  );

  return (
    <PageLayout>
      <p style={{ margin: '0 0 var(--spacing-md)', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)' }}>
        {ja
          ? `アプリを使った日に1つ解放されます。${unlockedCount} / ${totalServices} 解放済み`
          : `1 service unlocked per day you use the app. ${unlockedCount} / ${totalServices} unlocked`}
      </p>
      <p style={{ margin: '0 0 var(--spacing-md)', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)', lineHeight: 1.6 }}>
        {ja
          ? '※ サービスの提供状態（新規受付終了・提供終了など）に応じて、対象サービスや記事は変更・削除される場合があります。'
          : '* Services and articles may change or be removed depending on each service’s availability status (e.g. closed to new customers or discontinued).'}
      </p>

      {/* 全体解放率バー（成績グラフのバー様式を踏襲・青） */}
      <div style={{ background: 'var(--color-bg-white)', border: '1px solid var(--color-border)', borderRadius: 'var(--border-radius-lg)', padding: 'var(--spacing-md)', marginBottom: 'var(--spacing-md)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
          <span style={{ fontWeight: 700, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-main)' }}>
            {ja ? '解放率' : 'Unlock Rate'}
          </span>
          <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-sub)' }}>
            <span style={{ fontWeight: 800, fontSize: 'var(--font-size-md)', color: 'var(--color-primary)' }}>{unlockRate}%</span>
            <span style={{ marginLeft: 6 }}>{unlockedCount} / {totalServices}</span>
          </span>
        </div>
        <div style={{ height: 6, borderRadius: 3, background: 'var(--color-border)', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${unlockRate}%`, minWidth: unlockRate === 0 ? undefined : 3, background: 'var(--bar-gradient-primary)', borderRadius: 3, transformOrigin: 'left center', animation: 'growWidth 0.45s cubic-bezier(0.34, 1.56, 0.64, 1) both' }} />
        </div>
      </div>

      {/* 今日の日めくりサービス */}
      <div style={{ background: 'var(--color-bg-white)', border: '1px solid var(--color-border)', borderRadius: 'var(--border-radius-lg)', padding: 'var(--spacing-md)', marginBottom: 'var(--spacing-md)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
          {calIcon}
          <span style={{ fontWeight: 700, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-main)' }}>
            {ja ? '今日の日めくりAWSサービス' : "Today's Daily AWS Service"}
          </span>
          {todayAlreadyDone && (
            <span style={{ marginLeft: 2, fontSize: 'var(--font-size-2xs)', fontWeight: 700, padding: '1px 7px', borderRadius: 'var(--border-radius-sm)', background: 'var(--color-primary-light)', color: 'var(--color-primary)' }}>
              {ja ? '解放済み' : 'Unlocked'}
            </span>
          )}
        </div>

        <div
          style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: (todayUnlocked && todayStoreData) ? 'pointer' : 'default' }}
          onClick={() => { if (todayUnlocked && todayStoreData) setSelected(todayStoreData); }}
        >
          <div style={{ width: 44, height: 44, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-bg-main)', borderRadius: 10 }}>
            {todayUnlocked && todayStoreData
              ? renderIcon(todayStoreData, 36)
              : <IconLock size={22} />}
          </div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 'var(--font-size-md)', color: 'var(--color-text-main)' }}>
              {todayUnlocked ? (todayStoreData?.name ?? todaySvc.name) : '???'}
            </div>
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-primary)', fontWeight: 600, marginTop: 2 }}>
              {todayUnlocked ? todaySvc.category : ''}
            </div>
          </div>
          {todayUnlocked && todayStoreData && (
            <span style={{ marginLeft: 'auto', color: 'var(--color-text-light)', fontSize: 'var(--font-size-base)' }}>›</span>
          )}
        </div>

        {!todayAlreadyDone && (
          <div style={{ marginTop: 8, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)' }}>
            {ja ? 'ホーム画面を開くと解放されます' : 'Open the home screen to unlock'}
          </div>
        )}
        {todayUnlocked && !todayStoreData && (
          <div style={{ marginTop: 8, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)' }}>
            {ja ? '詳細情報は近日公開予定です' : 'Details coming soon'}
          </div>
        )}
      </div>

      {/* 検索バー */}
      <div style={{ position: 'relative', marginBottom: 'var(--spacing-md)' }}>
        <div style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-text-light)', display: 'flex', pointerEvents: 'none' }}>
          <IconSearch />
        </div>
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={ja ? 'サービス名で検索' : 'Search by service name'}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            padding: '8px 12px 8px 34px',
            borderRadius: 'var(--border-radius-md)',
            border: '1.5px solid var(--color-border)',
            background: 'var(--color-bg-white)',
            color: 'var(--color-text-main)',
            fontSize: 'var(--font-size-sm)',
            outline: 'none',
          }}
        />
      </div>
      {q && (
        <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-sub)', marginBottom: 'var(--spacing-sm)' }}>
          {ja ? `「${search}」: ${totalHits} 件` : `"${search}": ${totalHits} results`}
        </p>
      )}
      {q && totalHits === 0 && (
        <p style={{ color: 'var(--color-text-light)', fontSize: 'var(--font-size-sm)', textAlign: 'center', padding: 'var(--spacing-xl)' }}>
          {ja ? '該当するサービスが見つかりませんでした' : 'No matching services found'}
        </p>
      )}

      {/* タブ */}
      <div style={{ display: 'flex', borderBottom: '2px solid color-mix(in srgb, var(--color-text-light) 40%, transparent)', margin: 'var(--spacing-md) 0' }}>
        {(['unlocked', 'all'] as const).map(t => {
          const label = t === 'all' ? (ja ? '一覧' : 'All') : (ja ? '解放済み' : 'Unlocked');
          const active = activeTab === t;
          return (
            <button
              key={t}
              data-kbnav="tab"
              onClick={() => { setActiveTab(t); setSearch(''); }}
              style={{ flex: 1, background: 'none', border: 'none', cursor: 'pointer', padding: '10px 0', fontSize: 'var(--font-size-base)', fontWeight: active ? 700 : 500, color: active ? 'var(--color-primary)' : 'var(--color-text-sub)', borderBottom: `2px solid ${active ? 'var(--color-primary)' : 'transparent'}`, transition: 'color 0.15s, border-color 0.15s' }}
            >
              {label}
              {t === 'unlocked' && <span style={{ marginLeft: 4, fontSize: 'var(--font-size-2xs)', color: active ? 'var(--color-primary)' : 'var(--color-text-light)' }}>{unlockedCount}</span>}
            </button>
          );
        })}
      </div>

      {/* 解放済みタブが空のときは、空白にせず次の行動を示す */}
      {!q && activeTab === 'unlocked' && unlockedCount === 0 && (
        <div style={{ padding: 'var(--spacing-lg)', textAlign: 'center', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--spacing-md)' }}>
          {ja ? 'まだ解放したサービスはありません。ホームを開いた日に1つずつ解放されます。' : 'No services unlocked yet. One unlocks each day you open Home.'}
          <Button variant="outline" size="sm" onClick={() => setActiveTab('all')}>{ja ? '一覧を見る' : 'Browse all'}</Button>
        </div>
      )}
      {/* カテゴリ別サービス一覧（検索時はタブを無視して全カテゴリ横断） */}
      {displayCatalog.map(cat => {
        const displayServices = q
          ? cat.services.filter(s => s.name.toLowerCase().includes(q))
          : activeTab === 'unlocked'
            ? cat.services.filter(s => isUnlocked(s, unlockedMap, storedServices))
            : cat.services;
        if (displayServices.length === 0) return null;
        const catUnlocked = cat.services.filter(s => isUnlocked(s, unlockedMap, storedServices)).length;
        return (
          <div key={cat.category} style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, paddingBottom: 4, borderBottom: '2px solid color-mix(in srgb, var(--color-text-light) 40%, transparent)' }}>
              <span style={{ fontWeight: 700, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-main)' }}>
                {cat.category}
              </span>
              {activeTab === 'all' && (
                <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)', marginLeft: 2 }}>
                  {catUnlocked}/{cat.services.length}
                </span>
              )}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
              {displayServices.map(svc => {
                const unlocked = isUnlocked(svc, unlockedMap, storedServices);
                // serviceIds で直接引く、なければ名前の正規化照合で探す
                const normCat = normalizeSvcName(svc.name);
                const serviceData = svc.serviceIds?.map(id => storedServices[id]).find(Boolean)
                  ?? Object.values(storedServices).find(s => s?.name && normalizeSvcName(s.name) === normCat);
                // serviceData がなくても CATALOG のアイコンがあればクリック可能にする
                const displayIcon = serviceData?.icon || svc.icon || '';
                const clickable = unlocked && (!!serviceData || !!displayIcon);

                const handleClick = () => {
                  if (!unlocked) return;
                  // description がある場合のみキャッシュを使用（空文字プレースホルダーはフェッチする）
                  if (serviceData?.description) { setSelected(serviceData); return; }
                  // serviceData がない or description が空: 利用可能な serviceId で on-demand フェッチ
                  const fetchId = svc.serviceIds?.[0];
                  const placeholder: EncyclopediaService = {
                    serviceId: fetchId ?? svc.name,
                    name: svc.name,
                    icon: svc.icon ?? '',
                    description: '',
                    category: svc.serviceIds ? undefined : svc.name,
                  };
                  setSelected(placeholder);
                  if (!fetchId) return;
                  setSelectedLoading(true);
                  fetch(`${API_ENDPOINT}/daily-service?serviceId=${encodeURIComponent(fetchId)}`)
                    .then(r => r.ok ? r.json() : null)
                    .then(d => {
                      if (d?.service) {
                        const s = d.service;
                        setSelected(s);
                        // ローカルに保存して次回以降即表示
                        const upd = { ...storedServices, [s.serviceId]: s };
                        localStorage.setItem('encyclopediaServices', JSON.stringify(upd));
                        setStoredServices(upd);
                      }
                    })
                    .catch(() => {})
                    .finally(() => setSelectedLoading(false));
                };

                return (
                  <div
                    key={svc.serviceIds?.[0] ?? svc.name}
                    {...(clickable ? { 'data-kbnav': '1' } : {})}
                    onClick={handleClick}
                    style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'center',
                      gap: 4, padding: '8px 4px',
                      borderRadius: 'var(--border-radius-md)',
                      cursor: clickable ? 'pointer' : 'default',
                      transition: 'background 0.1s',
                      minWidth: 0,
                    }}
                    onMouseEnter={e => { if (clickable) e.currentTarget.style.background = 'var(--color-bg-main)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <div style={{ width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: unlocked ? 1 : 0.4 }}>
                      {unlocked && displayIcon
                        ? renderIcon({ serviceId: svc.serviceIds?.[0] ?? svc.name, name: svc.name, icon: displayIcon, description: '' }, 32)
                        : unlocked
                          ? null
                          : <IconLock size={14} />}
                    </div>
                    <span style={{
                      fontSize: 'var(--font-size-2xs)',
                      color: unlocked ? 'var(--color-text-main)' : 'var(--color-text-light)',
                      fontWeight: unlocked ? 600 : 400,
                      textAlign: 'center',
                      lineHeight: 1.3,
                      wordBreak: 'break-word',
                      width: '100%',
                    }}>
                      {unlocked ? svc.name : '???'}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Detail modal */}
      {selected && (
        <div
          data-kbscope="1"
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={e => { if (e.target === e.currentTarget) setSelected(null); }}
        >
          <div style={{ background: 'var(--color-bg-white)', borderRadius: 'var(--border-radius-lg)', padding: '24px 24px 0', width: '100%', maxWidth: 420, boxShadow: 'var(--box-shadow-md)', maxHeight: window.innerWidth < 768 ? '66vh' : '85vh', overflowY: 'auto', position: 'relative' }}>
            <button
              data-kbclose="1"
              onClick={() => setSelected(null)}
              style={{ position: 'absolute', top: 12, right: 12, border: 'none', background: 'none', fontSize: 'var(--font-size-xl)', cursor: 'pointer', color: 'var(--color-text-sub)', padding: '4px 8px', lineHeight: 1 }}
            >✕</button>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
              <div style={{ width: 44, height: 44, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {renderIcon(selected, 44)}
              </div>
              <div>
                <div style={{ fontWeight: 800, fontSize: 'var(--font-size-md)', color: 'var(--color-text-main)' }}>
                  {selected.name}
                </div>
                {selected.category && (
                  <span style={{ fontSize: 'var(--font-size-2xs)', fontWeight: 700, padding: '1px 7px', borderRadius: 'var(--border-radius-sm)', background: 'var(--color-primary-light)', color: 'var(--color-primary)' }}>
                    {selected.category}
                  </span>
                )}
              </div>
            </div>

            {selected.deprecationNote && (
              <div style={{ background: '#FFF4E5', border: '1px solid #F5A623', borderRadius: 'var(--border-radius-md)', padding: '8px 12px', marginBottom: 10, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <span style={{ flexShrink: 0, fontSize: 'var(--font-size-base)', lineHeight: 1.6 }}>⚠️</span>
                <span style={{ fontSize: 'var(--font-size-xs)', color: '#8A5A00', lineHeight: 1.6, overflowWrap: 'break-word', wordBreak: 'break-word' }}>
                  {ja
                    ? selected.deprecationNote
                    : 'This service’s availability has changed (e.g. closed to new customers or discontinued). This article may be removed soon.'}
                </span>
              </div>
            )}

            {selectedLoading ? (
              <p style={{ margin: '0 0 10px', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-light)', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="sherpa-spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
                {ja ? '情報を取得中...' : 'Loading...'}
              </p>
            ) : selected.description ? (
              <p style={{ margin: '0 0 10px', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', lineHeight: 1.7, overflowWrap: 'break-word', wordBreak: 'break-word' }}>
                {selected.description}
              </p>
            ) : (
              <p style={{ margin: '0 0 10px', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-light)' }}>
                {ja ? '説明情報がありません。' : 'No description available.'}
              </p>
            )}

            {selected.trivia && (
              <div style={{ background: 'var(--color-bg-main)', borderRadius: 'var(--border-radius-md)', padding: '8px 12px', display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 10 }}>
                <span style={{ color: 'var(--color-text-sub)', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                  <IconBean size={14} />
                </span>
                <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-sub)', lineHeight: 1.6, overflowWrap: 'break-word', wordBreak: 'break-word' }}>
                  {selected.trivia.replace(/^🌱\s*/, '')}
                </span>
              </div>
            )}

            {selected.docUrl && (
              <a
                href={selected.docUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--font-size-sm)', color: 'var(--color-primary)', textDecoration: 'none', fontWeight: 600 }}
              >
                {ja ? '公式ページを見る' : 'Official page'}<IconExternalLink size={13} />
              </a>
            )}

            <div style={{ marginTop: 12, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-light)' }}>
              {ja ? 'AI確認' : 'AI review'}:{' '}
              {selected.contentCheckedAt
                ? <strong style={{ color: 'var(--color-success)' }}>✓ {new Date(selected.contentCheckedAt).toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' })}</strong>
                : <strong>{ja ? '未確認' : 'not reviewed'}</strong>
              }
            </div>
            <div style={{ height: 20 }} aria-hidden="true" />
          </div>
        </div>
      )}
    </PageLayout>
  );
}
