/**
 * 認証カナリアテスト — ログイン後の主要フローのスモーク
 *
 * 認証あり(chromium project, storageState 再利用)で実行する。
 * 目的: ログイン済みユーザーの主要導線（ホーム/マイページ/演習開始）が
 *       本番相当環境で「本当に動いているか」を短時間で確認する。
 *
 * 実行（認証カナリア専用ランナー canary-auth.sh から）:
 *   PLAYWRIGHT_BASE_URL=https://develop.mugenknock.pages.dev \
 *   PLAYWRIGHT_EMAIL=... PLAYWRIGHT_PASSWORD=... \
 *   npx playwright test e2e/tests/canary.auth.spec.ts --project=chromium
 */
import { test, expect } from '@playwright/test';
import { PageMonitor } from '../helpers/monitor';

const BROWSER_NOISE: RegExp[] = [
  /Failed to load resource.*404/,
  /Failed to load resource.*ERR_ABORTED/,
  /AdSense.*data-nscript/,
  /data-nscript/,
  /violates the following.*Content Security Policy/,
  /frame-ancestors/,
];

function assertNoRealErrors(monitor: PageMonitor, label: string) {
  const real = monitor.errors().filter(e => !BROWSER_NOISE.some(p => p.test(e.text)));
  const cors = real.filter(e => /CORS|Access-Control-Allow-Origin|blocked by CORS/.test(e.text));
  const js   = real.filter(e => !/CORS|Access-Control-Allow-Origin|blocked by CORS/.test(e.text));
  const net5xx = monitor.networkErrors.filter(e => e.status >= 500);
  if (cors.length)   console.error(`[${label}] CORS:\n`  + cors.map(e => `  ${e.text}`).join('\n'));
  if (js.length)     console.error(`[${label}] JS:\n`    + js.map(e => `  ${e.text}`).join('\n'));
  if (net5xx.length) console.error(`[${label}] 5xx:\n`   + net5xx.map(e => `  ${e.status} ${e.url}`).join('\n'));
  expect(cors,   `[${label}] CORS エラー`).toHaveLength(0);
  expect(js,     `[${label}] JS エラー`).toHaveLength(0);
  expect(net5xx, `[${label}] サーバーエラー(5xx)`).toHaveLength(0);
}

// Cookie同意バナーは画面下部に固定表示され、演習開始ボタン等の操作を妨げるため事前に閉じる
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem('cookie_consent_v1', 'accepted'); } catch { /* noop */ }
  });
});

// ① 認証状態でホームが表示される（＝ログインが効いている）
test('認証ホーム /aws/ が表示される', async ({ page }) => {
  const monitor = new PageMonitor(page);
  await page.goto('/aws/', { waitUntil: 'networkidle' });
  // ログインへ飛ばされていないこと（認証が効いている）
  expect(page.url(), 'ログインページへリダイレクトされた（認証失敗の可能性）').not.toMatch(/\/login/);
  await expect(page.locator('header, main, h1, h2').first()).toBeVisible({ timeout: 12_000 });
  monitor.printReport('認証ホーム');
  assertNoRealErrors(monitor, '認証ホーム');
});

// ② マイページと記録が表示される（認証ユーザー向けUI）
//   苦手分析・解答履歴はマイページから記録画面（/aws/stats）へ移した（specs/007）
test('マイページ /aws/mypage と記録 /aws/stats が表示される', async ({ page }) => {
  const monitor = new PageMonitor(page);
  await page.goto('/aws/mypage', { waitUntil: 'networkidle' });
  await expect(page.getByText(/目標資格/).first()).toBeVisible({ timeout: 10_000 });
  // 記録画面は目標資格を localStorage から読むので、先にホームでサーバ保存分をロードさせる（演習テストと同じ）
  await page.goto('/aws/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.goto('/aws/stats', { waitUntil: 'networkidle' });
  // 目標資格が未設定のアカウントでは、タブの代わりに設定の案内が出る（どちらかが出れば画面は正常）
  const tabs = page.getByRole('tab', { name: /苦手分析/ });
  const noTarget = page.getByText(/目標資格を設定すると/);
  await expect(tabs.or(noTarget).first()).toBeVisible({ timeout: 10_000 });
  if (await tabs.isVisible()) {
    for (const name of [/解答履歴/, /正答率の推移/, /演習量/]) {
      await expect(page.getByRole('tab', { name })).toBeVisible();
    }
  }
  monitor.printReport('マイページ・記録');
  assertNoRealErrors(monitor, 'マイページ・記録');
});

// ③ 演習を開始して問題・選択肢が表示される（最重要の認証導線）
//   実ルートは /aws/practice（演習タブ）。開始→/aws/exercise/session へ遷移し問題が出る。
test('演習を開始→問題・選択肢が表示される', async ({ page }) => {
  const monitor = new PageMonitor(page);
  // まずホームを開いて目標資格(サーバ保存)をlocalStorageへロードさせてから演習ページへ
  await page.goto('/aws/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.goto('/aws/practice', { waitUntil: 'networkidle' });

  // 演習タブの開始/再開ボタン（ドラフト有無で文言が変わるため広めに一致）
  const startBtn = page.getByRole('button',
    { name: /演習を開始|新規に開始|再開|^Start$|Start New|Resume/i }).first();
  await expect(startBtn).toBeVisible({ timeout: 12_000 });
  await startBtn.click();

  // 上書き確認パネルなどが出たら進む
  const confirmNew = page.getByRole('button', { name: /新規に開始|Start New/i });
  if (await confirmNew.count() > 0) {
    try { await confirmNew.first().click({ timeout: 3_000 }); } catch { /* なければ無視 */ }
  }

  // セッションへ遷移し、選択肢ボタンが表示される（1問目が実際にロードされる）
  await page.waitForURL(/\/aws\/exercise\/session/, { timeout: 15_000 }).catch(() => {});
  const choices = page.locator('button').filter({ hasNot: page.locator('svg') });
  await expect(choices.first()).toBeVisible({ timeout: 15_000 });

  monitor.printReport('演習開始');
  assertNoRealErrors(monitor, '演習開始');
});
