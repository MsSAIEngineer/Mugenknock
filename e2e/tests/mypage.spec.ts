/**
 * マイページ・記録 E2E テスト
 * 苦手分析・解答履歴はマイページから記録画面（/aws/stats）へ移した（specs/007）
 */
import { test, expect } from '@playwright/test';
import { PageMonitor } from '../helpers/monitor';

test.describe('マイページ', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/aws/mypage', { waitUntil: 'networkidle' });
    if (page.url().includes('/login')) {
      test.skip(true, '認証が必要');
    }
  });

  test('マイページが表示され、コンソールエラーがない', async ({ page }) => {
    const monitor = new PageMonitor(page);
    await page.goto('/aws/mypage', { waitUntil: 'networkidle' });

    await expect(page.locator('body')).not.toBeEmpty();
    await expect(page.getByText(/目標資格/).first()).toBeVisible({ timeout: 5_000 });
    monitor.printReport('マイページ');
    expect(monitor.errors()).toHaveLength(0);
  });
});

test.describe('記録', () => {
  test.beforeEach(async ({ page }) => {
    // 記録画面は目標資格を localStorage から読むので、先にホームでサーバ保存分をロードさせる
    await page.goto('/aws/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    await page.goto('/aws/stats', { waitUntil: 'networkidle' });
    if (page.url().includes('/login')) {
      test.skip(true, '認証が必要');
    }
    if (await page.getByText(/目標資格を設定すると/).isVisible().catch(() => false)) {
      test.skip(true, '目標資格が未設定のアカウント（タブは出ない仕様）');
    }
  });

  for (const name of ['苦手分析', '解答履歴', '正答率の推移', '演習量']) {
    test(`${name}タブへの切り替えでエラーがない`, async ({ page }) => {
      const monitor = new PageMonitor(page);
      await page.getByRole('tab', { name }).click();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(500); // API レスポンス待ち
      monitor.printReport(`${name}タブ`);
      expect(monitor.errors()).toHaveLength(0);
    });
  }
});
