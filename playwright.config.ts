/** 职责：配置隔离浏览器 UI 验证；Windows 使用 Edge，其他宿主使用 Chromium，不冒充原生桌面验收。 */
import process from 'node:process';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  // 浏览器和开发服务器必须有界退出；留出 CI 首次启动余量，但不靠重试掩盖失败。
  timeout: 30_000,
  expect: { timeout: 5_000 },
  outputDir: 'artifacts/browser/test-results',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:1420',
    browserName: 'chromium',
    ...(process.platform === 'win32' ? { channel: 'msedge' } : {}),
    locale: 'zh-CN',
    timezoneId: 'UTC',
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:1420',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
