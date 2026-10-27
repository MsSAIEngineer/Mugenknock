/**
 * 全ページナビゲーション + コンソールエラー一括チェック
 * 「ユーザー視点でおかしなことが起こっていないか」を網羅的に検査する
 */
import { test, expect } from '@playwright/test';
import { PageMonitor } from '../helpers/monitor';

const PAGES = [
  { path: '/aws/',                label: 'ホーム' },
  { path: '/aws/practice',        label: 'トレーニング' },
  { path: '/aws/stats',           label: '記録' },
  { path: '/aws/mypage',          label: 'マイページ' },
  { path: '/aws/exercise/setup',  label: '演習設定' },
  { path: '/aws/exam/setup',      label: '模試設定' },
  { path: '/aws/release-notes',   label: 'リリースノート' },
  { path: '/aws/growth',          label: '成長記録' },
  { path: '/aws/exam-dashboard',  label: '資格ダッシュボード' },
  { path: '/aws/encyclopedia',    label: 'サービス図鑑' },
  { path: '/about',               label: 'このサイトについて' },
];

test.describe('全ページ ナビゲーション + エラー監視', () => {
  for (const { path, label } of PAGES) {
    test(`${label} (${path}) — エラーなし`, async ({ page }) => {
      const monitor = new PageMonitor(page);

      await page.goto(path, { waitUntil: 'networkidle' });

      // ページが認証リダイレクトされた場合はスキップ
      const currentUrl = page.url();
      if (currentUrl.includes('/login')) {
        test.skip(true, '認証リダイレクト — ログイン情報が必要');
        return;
      }

      // 基本的なレンダリングの確認
      await expect(page.locator('body')).not.toBeEmpty();
      // スピナーが消えるまで待つ（最大5秒）
      await page.waitForFunction(
        () => !document.querySelector('.sherpa-spinner'),
        { timeout: 5_000 }
      ).catch(() => {}); // タイムアウトしても継続

      monitor.printReport(label);

      // コンソールエラーがないこと
      const errors = monitor.errors();
      if (errors.length > 0) {
        const msg = errors.map(e => `  [${e.url}]\n  → ${e.text}`).join('\n');
        expect.soft(errors, `コンソールエラーあり:\n${msg}`).toHaveLength(0);
      }

      // 5xx サーバーエラーがないこと
      const serverErrors = monitor.networkErrors.filter(e => e.status >= 500);
      if (serverErrors.length > 0) {
        const msg = serverErrors.map(e => `  ${e.status} ${e.method} ${e.url}`).join('\n');
        expect.soft(serverErrors, `サーバーエラーあり:\n${msg}`).toHaveLength(0);
      }
    });
  }
});

test.describe('ページ遷移シーケンス', () => {
  test('ホーム → マイページ → ホーム の遷移でエラーが起きない', async ({ page }) => {
    const monitor = new PageMonitor(page);

    await page.goto('/aws/', { waitUntil: 'networkidle' });
    await page.goto('/aws/mypage', { waitUntil: 'networkidle' });
    await page.goto('/aws/', { waitUntil: 'networkidle' });

    monitor.printReport('遷移シーケンス');
    const errors = monitor.errors();
    expect(errors, `遷移中にエラー: ${monitor.summary()}`).toHaveLength(0);
  });
});
