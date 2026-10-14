/** 职责：用真实浏览器验证生产入口拒绝缺失的桌面 IPC，不能依赖隔离测试 Adapter 获得假候选。 */
import { expect, test } from '@playwright/test';

/** 验证生产根入口在浏览器明确报错，搜索和主动重试都不能获得内置假目录。 */
test('生产根入口在浏览器明确拒绝桌面 IPC', async ({ page }) => {
  await page.goto('/');
  const error = page.getByRole('alert');
  await expect(error).toHaveText('请在 Tauri 桌面应用中打开；浏览器预览无法访问官方目录。');
  await page.getByRole('searchbox', { name: '搜索发行版本' }).fill('V22.1');
  await expect(error).toHaveText('请在 Tauri 桌面应用中打开；浏览器预览无法访问官方目录。');
  await page.locator('#target-os').selectOption('linux');
  await page.locator('#target-arch').selectOption('arm64');
  await expect(page.locator('#target-os')).toHaveValue('linux');
  await expect(page.locator('#target-arch')).toHaveValue('arm64');
  await expect(page.locator('#target-os option')).toHaveCount(3);
  await expect(page.locator('#target-arch option')).toHaveCount(2);
  await expect(page.locator('#preview-panel')).toHaveAttribute('data-preview-status', 'unselected');
  await expect(page.locator('[data-artifact-path]')).toHaveCount(0);
  await page.getByRole('button', { name: '刷新目录' }).click();
  await expect(error).toHaveText('请在 Tauri 桌面应用中打开；浏览器预览无法访问官方目录。');
  await expect(page.getByRole('radio')).toHaveCount(0);
  await expect(page.getByText('没有匹配的发行版本', { exact: true })).toHaveCount(0);
});
