/** 职责：在真实浏览器通过 App 的搜索、radio 与刷新入口验证 UI，只控制外部目录快照。 */
import { expect, test, type Page } from '@playwright/test';
import type { CatalogSnapshot, Selection } from '../../src/catalog';

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
    preview: { selection: { version: null, target: { os: 'macos', arch: 'x64' } }, status: 'unselected', source: null, required: [], error: null },
    ...changes,
  };
}

/** 替换隔离页的外部IPC；page 为浏览器，respond 接收原始query与selection，返回安装完成承诺，路由失败时拒绝。 */
async function serveCatalog(page: Page, respond: (query: string, selection: Selection) => CatalogSnapshot | Promise<CatalogSnapshot>) {
  await page.route('**/tests/browser/ipc/prepare', (route) => route.fulfill({ status: 204 }));
  await page.route('**/tests/browser/ipc/snapshot?*', async (route) => {
    const params = new URL(route.request().url()).searchParams;
    const query = params.get('query') ?? '';
    const selection: Selection = JSON.parse(params.get('selection') ?? 'null');
    const result = await respond(query, selection);
    await route.fulfill({ json: { ...result, preview: { ...result.preview, selection } } });
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
    const params = new URL(route.request().url()).searchParams;
    const query = params.get('query') ?? '';
    const selection: Selection = JSON.parse(params.get('selection') ?? 'null');
    const result = catalog(query, { revision: 2 });
    await route.fulfill({ json: { ...result, preview: { ...result.preview, selection } } });
  });
  await page.goto('/tests/browser/index.html');
  await expect(page.getByRole('alert')).toHaveText('测试目录 IPC 读取失败：HTTP 503');
  await expect(page.getByText('没有匹配的发行版本', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('radio')).toHaveCount(0);
  recovered = true;
  await page.getByRole('button', { name: '刷新目录' }).click();
  await expect(page.locator('#catalog-status')).toContainText('目录就绪');
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
    await expect(page.locator('#catalog-status')).toContainText('正在加载查询结果');
    await expect(page.getByRole('radio')).toHaveCount(0);
    await expect(page.getByText('没有匹配的发行版本', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '刷新目录' })).toBeDisabled();
  } finally {
    // 即使断言失败也结束边界等待，避免未完成路由拖住浏览器清理。
    resume();
  }
  await expect(page.locator('#catalog-status')).toHaveText('目录就绪，3 个发行版本。');
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
  await page.locator('#target-os').selectOption('linux');
  await page.locator('#target-arch').selectOption('arm64');
  await expect(page.locator('#catalog-status')).toContainText('目录就绪');
  await page.getByRole('radio', { name: 'v22.10.0', exact: true }).check();
  await page.getByRole('searchbox', { name: '搜索发行版本' }).fill('24.10');
  try {
    await expect(page.locator('#catalog-status')).toContainText('正在加载查询结果');
    await expect(page.getByRole('radio', { name: 'v24.10.0', exact: true })).toBeDisabled();
    await expect(page.getByText('当前选择：v22.10.0', { exact: true })).toBeVisible();
  } finally {
    resume();
  }
  await expect(page.getByRole('radio')).toHaveCount(1);
  await expect(page.getByRole('radio', { name: 'v24.10.0', exact: true })).not.toBeChecked();
  await expect(page.getByText('尚未选择发行版本', { exact: true })).toBeVisible();
  await expect(page.getByText('当前发行版本不再符合搜索，已清除单选；不会自动改选。', { exact: true })).toBeVisible();
  await expect(page.locator('#target-os')).toHaveValue('linux');
  await expect(page.locator('#target-arch')).toHaveValue('arm64');
  await expect(page.locator('#preview-panel')).toHaveAttribute('data-preview-status', 'unselected');
  await expect(page.locator('[data-artifact-path]')).toHaveCount(0);
  await expect(page.locator('.manifest-source')).toHaveText('');
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
  await expect(page.locator('#catalog-status')).toHaveText('目录就绪，0 个发行版本。');
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
  await expect(page.locator('#catalog-status')).toContainText('目录就绪');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('当前展示旧数据，未确认最新目录；可主动刷新重试。', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('radio', { name: 'v22.10.0', exact: true })).toBeChecked();
});

/** 验证六目标控件和权威样本逐项呈现；缺gz及仅musl场景是展示mock，不证明Rust规则或官方事实。 */
test('六目标展示权威必需文件，缺项和musl样本不被前端补齐', async ({ page }) => {
  // 路径均为明确字面样本，测试端不复制 Rust 文件名规则或解析清单。
  const cases: Array<{ selection: Selection; status: 'ready' | 'missing'; required: CatalogSnapshot['preview']['required'] }> = [
    { selection: { version: 'v24.10.0', target: { os: 'macos', arch: 'x64' } }, status: 'ready', required: [
      { path: 'node-v24.10.0-darwin-x64.tar.xz', present: true, sha256: 'a'.repeat(64) },
      { path: 'node-v24.10.0-darwin-x64.tar.gz', present: true, sha256: 'b'.repeat(64) },
    ] },
    { selection: { version: 'v24.10.0', target: { os: 'macos', arch: 'arm64' } }, status: 'ready', required: [
      { path: 'node-v24.10.0-darwin-arm64.tar.xz', present: true, sha256: 'c'.repeat(64) },
      { path: 'node-v24.10.0-darwin-arm64.tar.gz', present: true, sha256: 'd'.repeat(64) },
    ] },
    { selection: { version: 'v24.10.0', target: { os: 'windows', arch: 'x64' } }, status: 'ready', required: [
      { path: 'node-v24.10.0-win-x64.7z', present: true, sha256: 'e'.repeat(64) },
    ] },
    { selection: { version: 'v24.10.0', target: { os: 'windows', arch: 'arm64' } }, status: 'ready', required: [
      { path: 'node-v24.10.0-win-arm64.7z', present: true, sha256: 'f'.repeat(64) },
    ] },
    { selection: { version: 'v24.10.0', target: { os: 'linux', arch: 'x64' } }, status: 'missing', required: [
      { path: 'node-v24.10.0-linux-x64.tar.xz', present: true, sha256: '1'.repeat(64) },
      { path: 'node-v24.10.0-linux-x64.tar.gz', present: false, sha256: null },
    ] },
    // 外部快照以标准文件均缺失模拟仅有 musl 变体的展示场景；不代表本测试执行过 Rust 判定或清单解析。
    { selection: { version: 'v24.10.0', target: { os: 'linux', arch: 'arm64' } }, status: 'missing', required: [
      { path: 'node-v24.10.0-linux-arm64.tar.xz', present: false, sha256: null },
      { path: 'node-v24.10.0-linux-arm64.tar.gz', present: false, sha256: null },
    ] },
  ];
  await serveCatalog(page, (query, selection) => {
    const sample = cases.find((sample) => sample.selection.target.os === selection.target.os && sample.selection.target.arch === selection.target.arch)!;
    return catalog(query, { preview: selection.version ? {
      selection, status: sample.status, required: sample.required,
      source: 'https://nodejs.org/dist/v24.10.0/SHASUMS256.txt', error: null,
    } : { selection, status: 'unselected', required: [], source: null, error: null } });
  });
  const preparations: unknown[] = [];
  await page.route('**/tests/browser/ipc/prepare', async (route) => {
    preparations.push(route.request().postDataJSON());
    await route.fulfill({ status: 204 });
  });
  await page.goto('/tests/browser/index.html');
  await expect(page.locator('#target-os option')).toHaveCount(3);
  await expect(page.locator('#target-arch option')).toHaveCount(2);
  await page.getByRole('radio', { name: 'v24.10.0', exact: true }).check();
  for (const sample of cases) {
    await page.locator('#target-os').selectOption(sample.selection.target.os);
    await page.locator('#target-arch').selectOption(sample.selection.target.arch);
    await expect(page.locator('#catalog-status')).toContainText('目录就绪');
    await expect(page.locator('#preview-panel')).toHaveAttribute('data-preview-status', sample.status);
    await expect(page.locator('[data-artifact-path]')).toHaveCount(sample.required.length);
    for (const artifact of sample.required) {
      const row = page.locator(`[data-artifact-path="${artifact.path}"]`);
      await expect(row).toHaveAttribute('data-present', artifact.present ? 'present' : 'missing');
      expect(await row.getAttribute('data-sha256')).toBe(artifact.sha256);
    }
    await expect(page.locator('.manifest-source')).toHaveText('https://nodejs.org/dist/v24.10.0/SHASUMS256.txt');
    await expect(page.locator('.selection-summary')).toHaveText('当前选择：v24.10.0');
    await expect(page.locator('#target-os')).toBeEnabled();
    await expect(page.locator('#target-arch')).toBeEnabled();
  }
  expect(preparations).toEqual([{ selection: cases[0]!.selection, retry: false }]);
  await expect(page.locator('[data-artifact-path*="musl"]')).toHaveCount(0);
  await expect(page.getByRole('combobox')).toHaveCount(2);
  await expect(page.getByRole('button', { name: /下载/ })).toHaveCount(0);
});

/** 验证idle/loading/error/主动重试的正式用户路径；快照来自外部HTTP样本，不把失败当成目标不支持。 */
test('清单状态与目录隔离，主动重试才恢复文件事实', async ({ page }, testInfo) => {
  let mode: 'idle' | 'loading' | 'error' | 'ready' = 'idle';
  const preparations: Array<{ selection: Selection; retry: boolean }> = [];
  await serveCatalog(page, (query, selection) => catalog(query, { preview: selection.version ? {
    selection, status: mode, source: 'https://nodejs.org/dist/v24.10.0/SHASUMS256.txt',
    required: [{ path: 'display-fixture.7z', present: mode === 'ready' ? true : null, sha256: mode === 'ready' ? 'a'.repeat(64) : null }],
    error: mode === 'error' ? '清单解析失败：展示样本' : null,
  } : { selection, status: 'unselected', source: null, required: [], error: null } }));
  await page.route('**/tests/browser/ipc/prepare', async (route) => {
    const command = route.request().postDataJSON();
    preparations.push(command);
    if (command.retry) mode = 'ready';
    await route.fulfill({ status: 204 });
  });
  await page.goto('/tests/browser/index.html');
  await expect(page.locator('#preview-panel')).toHaveAttribute('data-preview-status', 'unselected');
  await page.getByRole('radio', { name: 'v24.10.0', exact: true }).check();
  await expect(page.locator('#preview-panel')).toHaveAttribute('data-preview-status', 'idle');
  await expect(page.locator('[data-artifact-path]')).toHaveAttribute('data-present', 'unknown');
  mode = 'loading';
  await page.locator('#target-os').selectOption('windows');
  await expect(page.locator('#preview-panel')).toHaveAttribute('data-preview-status', 'loading');
  await expect(page.locator('#preview-status')).toContainText('正在获取并校验官方清单');
  await expect(page.locator('[data-artifact-path]')).not.toHaveAttribute('data-sha256');
  mode = 'error';
  await page.locator('#target-arch').selectOption('arm64');
  await expect(page.locator('#preview-panel')).toHaveAttribute('data-preview-status', 'error');
  await expect(page.locator('#preview-panel').getByRole('alert')).toHaveText('清单解析失败：展示样本');
  await expect(page.locator('#catalog-panel').getByRole('alert')).toHaveCount(0);
  await expect(page.locator('#catalog-status')).toContainText('目录就绪');
  await expect(page.getByText(/目标不支持/)).toHaveCount(0);
  expect(preparations).toHaveLength(1);
  await page.setViewportSize({ width: 360, height: 480 });
  const retry = page.getByRole('button', { name: '重试清单' });
  await retry.scrollIntoViewIfNeeded();
  await expect(retry).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const path = testInfo.outputPath('browser-preview-error-minimum.png');
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await testInfo.attach('browser-preview-error-minimum', { path, contentType: 'image/png' });
  await retry.click();
  await expect(page.locator('#preview-panel')).toHaveAttribute('data-preview-status', 'ready');
  await expect(page.locator('#preview-panel').getByRole('alert')).toHaveCount(0);
  await expect(page.locator('[data-artifact-path]')).toHaveAttribute('data-present', 'present');
  expect(preparations[1]).toEqual({ selection: { version: 'v24.10.0', target: { os: 'windows', arch: 'arm64' } }, retry: true });
  await expect(page.locator('.selection-summary')).toHaveText('当前选择：v24.10.0');
});

for (const layout of [
  { name: 'wide', viewport: { width: 1050, height: 780 } },
  { name: 'narrow', viewport: { width: 390, height: 844 } },
  { name: 'minimum', viewport: { width: 360, height: 480 } },
]) {
  /** 验证双归档预览、完整hash和来源在窗口内不横向溢出，纵向滚动仍能访问控件；仅为展示样本。 */
  test(`browser-preview-${layout.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize(layout.viewport);
    await serveCatalog(page, (query, selection) => catalog(query, { preview: selection.version ? {
      selection, status: 'ready', source: 'https://nodejs.org/dist/v24.10.0/SHASUMS256.txt', error: null,
      required: [
        { path: 'node-v24.10.0-darwin-x64.tar.xz', present: true, sha256: 'a'.repeat(64) },
        { path: 'node-v24.10.0-darwin-x64.tar.gz', present: true, sha256: 'b'.repeat(64) },
      ],
    } : { selection, status: 'unselected', source: null, error: null, required: [] } }));
    await page.goto('/tests/browser/index.html');
    await page.getByRole('radio', { name: 'v24.10.0', exact: true }).check();
    await expect(page.locator('#preview-panel')).toHaveAttribute('data-preview-status', 'ready');
    await expect(page.locator('[data-artifact-path="node-v24.10.0-darwin-x64.tar.gz"]')).toHaveAttribute('data-sha256', 'b'.repeat(64));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.locator('.manifest-source').scrollIntoViewIfNeeded();
    await expect(page.locator('.manifest-source')).toBeInViewport();
    await page.locator('#target-os').scrollIntoViewIfNeeded();
    await expect(page.locator('#target-os')).toBeInViewport();
    const path = testInfo.outputPath(`browser-preview-${layout.name}.png`);
    await page.screenshot({ path, fullPage: true, animations: 'disabled' });
    await testInfo.attach(`browser-preview-${layout.name}`, { path, contentType: 'image/png' });
  });
}

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
    await expect(page.locator('#catalog-status')).toHaveText('目录就绪，3 个发行版本。');
    await expect(page.getByText('当前选择：v22.10.0', { exact: true })).toBeVisible();
    await expect(page.getByRole('searchbox', { name: '搜索发行版本' })).toBeInViewport();
    await expect(page.getByRole('button', { name: '刷新目录' })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const path = testInfo.outputPath(`browser-catalog-${layout.name}.png`);
    await page.screenshot({ path, fullPage: true, animations: 'disabled' });
    await testInfo.attach(`browser-catalog-${layout.name}`, { path, contentType: 'image/png' });
  });
}
