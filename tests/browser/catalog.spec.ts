/** 职责：在真实浏览器通过 App 的搜索、radio 与刷新入口验证 UI，只控制外部目录快照。 */
import { expect, test, type Page } from '@playwright/test';
import type { CatalogSnapshot } from '../../src/catalog';

/** 创建已校验的权威样本；query 原样回显，changes 指定边界状态，返回快照，不抛出异常。 */
function catalog(query: string, changes: Partial<CatalogSnapshot> = {}): CatalogSnapshot {
  return {
    revision: 1,
    query,
    normalizedQuery: '',
    status: 'ready',
    hasCatalog: true,
    releases: [
      { version: 'v24.10.0', date: '2025-10-08', lts: false },
      { version: 'v22.10.0', date: '2024-10-16', lts: false },
      { version: 'v22.1.0', date: '2024-05-02', lts: false },
    ],
    checkedAt: 1_760_000_000_000,
    stale: false,
    error: null,
    warnings: [],
    source: 'https://nodejs.org/dist/index.json',
    ...changes,
  };
}

/** 替换隔离页的外部目录响应；page 为浏览器、respond 接收原始查询，返回安装完成承诺，路由失败时拒绝。 */
async function serveCatalog(page: Page, respond: (query: string) => CatalogSnapshot | Promise<CatalogSnapshot>) {
  await page.route('**/tests/browser/ipc/snapshot?*', async (route) => {
    const query = new URL(route.request().url()).searchParams.get('query') ?? '';
    await route.fulfill({ json: await respond(query) });
  });
}

// 前缀算法由 Rust 测试负责；本处验证输入被原样交给边界，UI 不二次筛掉 22.10 或改动权威顺序。
/** 验证带空白与 V 前缀的原始搜索、权威候选顺序和单选替换。 */
test('V22.1 搜索展示权威的 22.10 与 22.1，单选替换保持唯一草稿', async ({ page }) => {
  /** 返回已预排的查询样本；query 为原始用户输入，返回权威快照，非约定查询抛错以捕获输入被修改。 */
  function response(query: string): CatalogSnapshot {
    if (query === '') return catalog(query);
    if (query === '  V22.1  ') return catalog(query, {
      normalizedQuery: '22.1',
      releases: [
        { version: 'v22.10.0', date: '2024-10-16', lts: false },
        { version: 'v22.1.0', date: '2024-05-02', lts: false },
      ],
    });
    throw new Error(`未约定的原始查询：${query}`);
  }
  await serveCatalog(page, response);
  await page.goto('/tests/browser/index.html');
  await expect(page.getByRole('radio')).toHaveCount(3);
  await page.getByRole('searchbox', { name: '搜索发行版本' }).fill('  V22.1  ');
  await expect(page.getByRole('radio')).toHaveCount(2);
  await expect(page.getByRole('radio').nth(0)).toHaveAccessibleName('v22.10.0');
  await expect(page.getByRole('radio').nth(1)).toHaveAccessibleName('v22.1.0');
  await page.getByRole('radio', { name: 'v22.10.0', exact: true }).check();
  await expect(page.getByText('当前选择：v22.10.0', { exact: true })).toBeVisible();
  await page.getByRole('radio', { name: 'v22.1.0', exact: true }).check();
  await expect(page.getByText('当前选择：v22.1.0', { exact: true })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'v22.10.0', exact: true })).not.toBeChecked();
  await expect(page.getByRole('radio', { name: 'v22.1.0', exact: true })).toBeChecked();
});

/** 验证外部读取失败有明确原因，且用户主动刷新后恢复候选而非伪报空目录。 */
test('外部 IPC 读取失败后可主动刷新恢复', async ({ page }) => {
  let recovered = false;
  await page.route('**/tests/browser/ipc/snapshot?*', async (route) => {
    if (!recovered) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
      return;
    }
    const query = new URL(route.request().url()).searchParams.get('query') ?? '';
    await route.fulfill({ json: catalog(query, { revision: 2 }) });
  });
  await page.goto('/tests/browser/index.html');
  await expect(page.getByRole('alert')).toHaveText('测试目录 IPC 读取失败：HTTP 503');
  await expect(page.getByText('没有匹配的发行版本', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('radio')).toHaveCount(0);
  recovered = true;
  await page.getByRole('button', { name: '刷新目录' }).click();
  await expect(page.getByRole('status')).toContainText('目录就绪');
  await expect(page.getByRole('radio')).toHaveCount(3);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('已发起手动刷新；结果以目录状态与成功校验时间为准。', { exact: true })).toBeVisible();
});

/** 验证首次响应尚未完成时只能展示加载，不能伪报空结果或允许选择。 */
test('首次加载等待外部结果，不显示假空目录', async ({ page }) => {
  let resume = () => {};
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  await serveCatalog(page, async (query) => { await gate; return catalog(query); });
  await page.goto('/tests/browser/index.html');
  try {
    await expect(page.getByRole('status')).toContainText('正在加载查询结果');
    await expect(page.getByRole('radio')).toHaveCount(0);
    await expect(page.getByText('没有匹配的发行版本', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '刷新目录' })).toBeDisabled();
  } finally {
    // 即使断言失败也结束边界等待，避免未完成路由拖住浏览器清理。
    resume();
  }
  await expect(page.getByRole('status')).toHaveText('目录就绪，3 个发行版本。');
  await expect(page.getByRole('radio')).toHaveCount(3);
  await expect(page.getByText('尚未选择发行版本', { exact: true })).toBeVisible();
  await expect(page.getByText('https://nodejs.org/dist/index.json', { exact: true })).toBeVisible();
});

/** 验证查询待定禁选旧候选，权威失配清除草稿，回到原查询也不自动恢复或改选。 */
test('搜索失配后清除单选，不自动改选或恢复', async ({ page }) => {
  let resume = () => {};
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  await serveCatalog(page, async (query) => {
    if (query === '') return catalog(query);
    if (query !== '24.10') throw new Error(`未约定的原始查询：${query}`);
    await gate;
    return catalog(query, {
      normalizedQuery: '24.10',
      releases: [{ version: 'v24.10.0', date: '2025-10-08', lts: false }],
    });
  });
  await page.goto('/tests/browser/index.html');
  await page.getByRole('radio', { name: 'v22.10.0', exact: true }).check();
  await page.getByRole('searchbox', { name: '搜索发行版本' }).fill('24.10');
  try {
    await expect(page.getByRole('status')).toContainText('正在加载查询结果');
    await expect(page.getByRole('radio', { name: 'v24.10.0', exact: true })).toBeDisabled();
    await expect(page.getByText('当前选择：v22.10.0', { exact: true })).toBeVisible();
  } finally {
    resume();
  }
  await expect(page.getByRole('radio')).toHaveCount(1);
  await expect(page.getByRole('radio', { name: 'v24.10.0', exact: true })).not.toBeChecked();
  await expect(page.getByText('尚未选择发行版本', { exact: true })).toBeVisible();
  await expect(page.getByText('当前发行版本不再符合搜索，已清除单选；不会自动改选。', { exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: '搜索发行版本' }).fill('');
  await expect(page.getByRole('radio')).toHaveCount(3);
  await expect(page.getByRole('radio', { name: 'v22.10.0', exact: true })).not.toBeChecked();
  await expect(page.getByText('尚未选择发行版本', { exact: true })).toBeVisible();
});

/** 验证权威空查询结果能显示空提示并清除单选，但不冒充加载或失败。 */
test('权威查询无匹配时显示空结果并清除草稿', async ({ page }) => {
  await serveCatalog(page, (query) => {
    if (query === '') return catalog(query);
    if (query === 'V99') return catalog(query, { normalizedQuery: '99', releases: [] });
    throw new Error(`未约定的原始查询：${query}`);
  });
  await page.goto('/tests/browser/index.html');
  await page.getByRole('radio', { name: 'v22.1.0', exact: true }).check();
  await page.getByRole('searchbox', { name: '搜索发行版本' }).fill('V99');
  await expect(page.getByText('没有匹配的发行版本', { exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('目录就绪，0 个发行版本。');
  await expect(page.getByRole('radio')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('尚未选择发行版本', { exact: true })).toBeVisible();
  await expect(page.getByText('当前发行版本不再符合搜索，已清除单选；不会自动改选。', { exact: true })).toBeVisible();
});

/** 验证目录失败保留已校验实体与单选，主动刷新成功后清除旧数据告警。 */
test('刷新错误展示旧目录与原因，主动重试保留单选', async ({ page }) => {
  let mode: 'ready' | 'error' | 'recovered' = 'ready';
  await serveCatalog(page, (query) => {
    if (mode === 'ready') return catalog(query);
    if (mode === 'error') return catalog(query, {
      revision: 2,
      status: 'error',
      stale: true,
      error: '官方目录请求超时',
      warnings: ['缓存写入失败，当前结果仅保存在内存'],
    });
    return catalog(query, { revision: 3, checkedAt: 1_760_000_060_000 });
  });
  await page.goto('/tests/browser/index.html');
  await page.getByRole('radio', { name: 'v22.10.0', exact: true }).check();
  mode = 'error';
  await page.getByRole('button', { name: '刷新目录' }).click();
  await expect(page.getByRole('alert')).toHaveText('官方目录请求超时');
  await expect(page.getByText('当前展示旧数据，未确认最新目录；可主动刷新重试。', { exact: true })).toBeVisible();
  await expect(page.getByText('缓存写入失败，当前结果仅保存在内存', { exact: true })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'v22.10.0', exact: true })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'v22.10.0', exact: true })).toBeEnabled();
  mode = 'recovered';
  await page.getByRole('button', { name: '刷新目录' }).click();
  await expect(page.getByRole('status')).toContainText('目录就绪');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('当前展示旧数据，未确认最新目录；可主动刷新重试。', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('radio', { name: 'v22.10.0', exact: true })).toBeChecked();
});

// 固定宽桌面与窄窗口尺寸，便于比较 CI artifact；这不是移动端或原生窗口适配声明。
for (const layout of [
  { name: 'wide', viewport: { width: 1280, height: 900 } },
  { name: 'narrow', viewport: { width: 390, height: 844 } },
]) {
  /** 验证真实 App 在指定窗口无横向溢出，并始终保存成功页面截图供人工查看。 */
  test(`browser-catalog-${layout.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize(layout.viewport);
    await serveCatalog(page, (query) => catalog(query));
    await page.goto('/tests/browser/index.html');
    await page.getByRole('radio', { name: 'v22.10.0', exact: true }).check();
    await expect(page.getByRole('status')).toHaveText('目录就绪，3 个发行版本。');
    await expect(page.getByText('当前选择：v22.10.0', { exact: true })).toBeVisible();
    await expect(page.getByRole('searchbox', { name: '搜索发行版本' })).toBeInViewport();
    await expect(page.getByRole('button', { name: '刷新目录' })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const path = testInfo.outputPath(`browser-catalog-${layout.name}.png`);
    await page.screenshot({ path, fullPage: true, animations: 'disabled' });
    await testInfo.attach(`browser-catalog-${layout.name}`, { path, contentType: 'image/png' });
  });
}
