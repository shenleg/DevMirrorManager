/** 职责：通过真实 React 用户操作验证目录状态与单选反馈，只替换外部 IPC Adapter。 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import type { CatalogAdapter, CatalogSnapshot, Selection } from './catalog';

afterEach(cleanup);

/** 创建权威 IPC 样本；query 原样回显，overrides 描述不同目录状态，返回快照，不抛出异常。 */
function snapshot(query = '', overrides: Partial<CatalogSnapshot> = {}): CatalogSnapshot {
  return {
    revision: 1, query, normalizedQuery: '', status: 'ready', hasCatalog: true,
    releases: [
      { version: 'v24.10.0', date: '2026-10-01', lts: 'Krypton' },
      { version: 'v24.9.0', date: null, lts: null },
    ],
    checkedAt: 1_760_000_000_000, stale: false, error: null, warnings: [],
    source: 'https://nodejs.org/dist/index.json',
    preview: { selection: { version: null, target: { os: 'macos', arch: 'x64' } }, status: 'unselected', source: null, required: [], error: null },
    ...overrides,
  };
}

/** 创建外部 IPC 控制器；autoPreparation 自动完成旧目录用例的空预览，返回请求与通知入口，不抛出异常。 */
function controlledIpc(autoPreparation = true) {
  const requests: { query: string; selection: Selection; resolve: (value: CatalogSnapshot) => void; reject: (reason: unknown) => void }[] = [];
  const preparations: { selection: Selection; retry: boolean }[] = [];
  let latest = snapshot();
  let preparationRead = false;
  const listeners = new Set<(revision: number) => void>();
  const adapter: CatalogAdapter = {
    open: async () => {}, refresh: async () => {},
    snapshot: (query, selection) => {
      if (autoPreparation && selection.version === null && latest.preview.selection.version !== null && latest.query === query) {
        latest = { ...latest, preview: { selection, status: 'unselected', source: null, required: [], error: null } };
        return Promise.resolve(latest);
      }
      if (autoPreparation && preparationRead) {
        preparationRead = false;
        return Promise.resolve({ ...latest, query, preview: { selection, status: 'idle', source: null, required: [], error: null } });
      }
      return new Promise((resolve, reject) => { requests.push({ query, selection, resolve: (value) => {
        latest = { ...value, preview: { ...value.preview, selection } };
        resolve(latest);
      }, reject }); });
    },
    preparePreview: async (selection, retry) => {
      preparations.push({ selection, retry });
      preparationRead = autoPreparation;
    },
    listen: async (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  return {
    adapter, requests, preparations,
    /** 完成第 index 个 IPC 请求；value 是权威快照，返回完成承诺，不存在时测试超时报错。 */
    respond: async (index: number, value: CatalogSnapshot) => {
      await waitFor(() => expect(requests[index]).toBeDefined());
      await act(async () => { requests[index]!.resolve(value); });
    },
    /** 拒绝第 index 个 IPC 请求；reason 为外部失败原因，返回完成承诺，不存在时测试超时报错。 */
    fail: async (index: number, reason: string) => {
      await waitFor(() => expect(requests[index]).toBeDefined());
      await act(async () => { requests[index]!.reject(new Error(reason)); });
    },
    /** 发布目录 revision 通知；无返回值，不抛出异常。 */
    notify: (revision: number) => { act(() => { for (const listener of listeners) listener(revision); }); },
  };
}

describe('正式目录界面用户操作', () => {
  /** 验证权威idle在没有旧IPC错误时仍显示主动准备入口，点击后读取真实进度。 */
  it('idle预览提供准备清单按钮而不自动重试', async () => {
    const ipc = controlledIpc(false);
    render(<App adapter={ipc.adapter} />);
    await ipc.respond(0, snapshot());
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'v24.10.0' }));
    await ipc.respond(1, snapshot('', { preview: { selection: ipc.requests[1]!.selection, status: 'idle', source: null, required: [], error: null } }));
    expect(ipc.preparations).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: '准备清单' }));
    await ipc.respond(2, snapshot('', { revision: 2, preview: { selection: ipc.requests[2]!.selection, status: 'loading', source: null, required: [], error: null } }));
    expect(ipc.preparations.at(-1)).toEqual({ selection: { version: 'v24.10.0', target: { os: 'macos', arch: 'x64' } }, retry: true });
    expect(screen.queryByRole('button', { name: '准备清单' })).toBeNull();
    expect(screen.getByRole('region', { name: '目标平台与必需文件预览' }).getAttribute('data-preview-status')).toBe('loading');
  });
  /** 验证正式页面始终提供原生独立目标控件，并逐项渲染外部权威事实和清单来源。 */
  it('Windows预览显示权威7z和hash而没有下载入口', async () => {
    const ipc = controlledIpc(false);
    render(<App adapter={ipc.adapter} />);
    await ipc.respond(0, snapshot());
    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole('combobox', { name: '目标系统' }), 'windows');
    await ipc.respond(1, snapshot());
    await user.click(screen.getByRole('radio', { name: 'v24.10.0' }));
    await ipc.respond(2, snapshot('', { revision: 2, preview: {
      selection: { version: 'v24.10.0', target: { os: 'windows', arch: 'x64' } },
      status: 'ready', source: 'https://nodejs.org/dist/v24.10.0/SHASUMS256.txt',
      required: [{ path: 'node-v24.10.0-win-x64.7z', present: true, sha256: 'a'.repeat(64) }], error: null,
    } }));
    const panel = screen.getByRole('region', { name: '目标平台与必需文件预览' });
    expect(panel.getAttribute('data-preview-status')).toBe('ready');
    const row = panel.querySelector('[data-artifact-path="node-v24.10.0-win-x64.7z"]');
    expect(row?.getAttribute('data-present')).toBe('present');
    expect(row?.getAttribute('data-sha256')).toBe('a'.repeat(64));
    expect(panel.textContent).toContain('清单证实存在');
    expect(panel.querySelector('.manifest-source')?.textContent).toBe('https://nodejs.org/dist/v24.10.0/SHASUMS256.txt');
    expect(screen.queryByRole('button', { name: /下载/ })).toBeNull();
    expect(screen.getByText('仅预览，下载尚未接入。')).toBeDefined();
  });
  /** 验证目标切换等待期间不把上一个目标的ready文件显示为当前目标事实。 */
  it('新目标响应前隐藏旧目标文件和ready状态', async () => {
    const ipc = controlledIpc(false);
    render(<App adapter={ipc.adapter} />);
    await ipc.respond(0, snapshot());
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'v24.10.0' }));
    await ipc.respond(1, snapshot('', { preview: {
      selection: ipc.requests[1]!.selection, status: 'ready', source: 'https://nodejs.org/dist/v24.10.0/SHASUMS256.txt',
      required: [{ path: 'old-target.tar.xz', present: true, sha256: 'b'.repeat(64) }], error: null,
    } }));
    await user.selectOptions(screen.getByRole('combobox', { name: '目标系统' }), 'linux');
    const panel = screen.getByRole('region', { name: '目标平台与必需文件预览' });
    expect(panel.querySelector('[data-artifact-path]')).toBeNull();
    expect(panel.getAttribute('data-preview-status')).not.toBe('ready');
    expect(panel.querySelector('.manifest-source')?.textContent).toBe('');
    expect(screen.getByText('当前选择：v24.10.0')).toBeDefined();
    await ipc.respond(2, snapshot('', { preview: { selection: ipc.requests[2]!.selection, status: 'idle', source: null, required: [], error: null } }));
    expect(panel.getAttribute('data-preview-status')).toBe('idle');
  });

  /** 验证权威清单失败优先于重试IPC回执，始终保留预览原因和重试入口而不污染目录。 */
  it('清单权威错误不会被重试IPC失败遮蔽', async () => {
    const ipc = controlledIpc(false);
    render(<App adapter={{ ...ipc.adapter, preparePreview: async (selection, retry) => {
      if (retry) throw new Error('清单重试IPC中断');
      await ipc.adapter.preparePreview(selection, retry);
    } }} />);
    await ipc.respond(0, snapshot());
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'v24.10.0' }));
    await ipc.respond(1, snapshot('', { preview: {
      selection: ipc.requests[1]!.selection, status: 'error', source: 'https://nodejs.org/dist/v24.10.0/SHASUMS256.txt',
      required: [{ path: 'node-v24.10.0-darwin-x64.tar.xz', present: null, sha256: null }], error: '清单获取超时',
    } }));
    const catalogPanel = within(screen.getByRole('region', { name: '搜索并选择发行版本' }));
    const previewPanel = within(screen.getByRole('region', { name: '目标平台与必需文件预览' }));
    expect(previewPanel.getByRole('alert').textContent).toBe('清单获取超时');
    expect(previewPanel.getByText('存在性待确认')).toBeDefined();
    await user.click(previewPanel.getByRole('button', { name: '重试清单' }));
    expect(previewPanel.getByRole('alert').textContent).toBe('清单获取超时');
    expect(previewPanel.getByRole('button', { name: '重试清单' })).toBeDefined();
    expect(catalogPanel.queryByRole('alert')).toBeNull();
    expect(catalogPanel.getByRole('status').textContent).toContain('目录就绪');
    expect(screen.queryByText(/目标不支持/)).toBeNull();
    expect(screen.getByRole('combobox', { name: '目标系统' }).hasAttribute('disabled')).toBe(false);
  });

  // 刷新命令确认只表示启动；完成后不可继续误述为等待响应，应以权威状态和校验时间为准。
  /** 验证刷新完成后的操作说明不再声称仍在等待。 */
  it('刷新完成后的操作说明不再声称仍在等待', async () => {
    const ipc = controlledIpc();
    render(<App adapter={ipc.adapter} />);
    await ipc.respond(0, snapshot());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '刷新目录' }));
    await ipc.respond(1, snapshot('', { revision: 2 }));
    expect(within(screen.getByRole('region', { name: '搜索并选择发行版本' })).getByRole('status').textContent).toContain('目录就绪');
    expect(screen.getByText('已发起手动刷新；结果以目录状态与成功校验时间为准。')).toBeDefined();
    expect(screen.queryByText(/等待权威结果/)).toBeNull();
  });

  // 旧快照仍为loading时新的IPC失败不能永久锁住刷新按钮，用户必须能主动恢复。
  /** 验证刷新进度的IPC读取失败后仍可主动重试。 */
  it('刷新进度的IPC读取失败后仍可主动重试', async () => {
    const ipc = controlledIpc();
    render(<App adapter={ipc.adapter} />);
    await ipc.respond(0, snapshot('', { status: 'loading', stale: true }));
    ipc.notify(2);
    await ipc.fail(1, '目录快照读取失败');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '刷新目录' }));
    await ipc.respond(2, snapshot('', { revision: 2 }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(within(screen.getByRole('region', { name: '搜索并选择发行版本' })).getByRole('status').textContent).toContain('目录就绪');
  });

  // 官方 false 表示已知无历史 LTS 标记，与缺失/损坏信息的未知不同，均不推断当前支持。
  /** 验证区分无LTS标记和未知标记。 */
  it('区分无LTS标记和未知标记', async () => {
    const ipc = controlledIpc();
    render(<App adapter={ipc.adapter} />);
    await ipc.respond(0, snapshot('', { releases: [
      { version: 'v24.10.0', date: null, lts: false },
      { version: 'v24.9.0', date: null, lts: null },
    ] }));
    expect(screen.getByText('发布日期：未知 · LTS 标记：无')).toBeDefined();
    expect(screen.getByText('发布日期：未知 · LTS 标记：未知')).toBeDefined();
    expect(screen.getByText(/LTS 标记不代表当前仍受支持/)).toBeDefined();
  });

  // IPC 查询失败不能把上一查询的空列表当成当前空结果，也必须保留主动重试入口。
  /** 验证旧查询为空而新查询IPC失败时不伪报无匹配。 */
  it('旧查询为空而新查询IPC失败时不伪报无匹配', async () => {
    const ipc = controlledIpc();
    render(<App adapter={ipc.adapter} />);
    await ipc.respond(0, snapshot('', { releases: [] }));
    expect(screen.getByText('没有匹配的发行版本')).toBeDefined();
    const user = userEvent.setup();
    await user.click(screen.getByRole('searchbox', { name: '搜索发行版本' }));
    await user.paste('24');
    await ipc.fail(1, '查询连接中断');
    expect(screen.getByRole('alert').textContent).toContain('查询连接中断');
    expect(screen.queryByText('没有匹配的发行版本')).toBeNull();
    await user.click(screen.getByRole('button', { name: '刷新目录' }));
    await ipc.respond(2, snapshot('24', { revision: 2 }));
    expect(await screen.findByRole('radio', { name: 'v24.10.0' })).toBeDefined();
  });

  // 浏览器不具备真实 IPC，输入不能掩盖桌面环境要求，更不能退回内置假目录。
  /** 验证浏览器预览明确报错且输入后仍不提供假候选。 */
  it('浏览器预览明确报错且输入后仍不提供假候选', async () => {
    render(<App />);
    expect((await screen.findByRole('alert')).textContent).toContain('Tauri 桌面应用');
    const user = userEvent.setup();
    await user.type(screen.getByRole('searchbox', { name: '搜索发行版本' }), '22');
    expect(screen.getByRole('alert').textContent).toContain('Tauri 桌面应用');
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.queryByText('没有匹配的发行版本')).toBeNull();
  });

  // 旧目录仍可用，但刷新失败、缓存告警和元数据未知都不能藏在“就绪”里。
  /** 验证刷新失败保留单选并明确展示旧数据和缓存告警。 */
  it('刷新失败保留单选并明确展示旧数据和缓存告警', async () => {
    const ipc = controlledIpc();
    render(<App adapter={ipc.adapter} />);
    await ipc.respond(0, snapshot());
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'v24.10.0' }));
    ipc.notify(2);
    await ipc.respond(1, snapshot('', { revision: 2, status: 'error', stale: true, error: '官方目录请求超时', warnings: ['缓存写入失败，当前结果仅保存在内存'] }));
    expect(screen.getByRole('alert').textContent).toContain('官方目录请求超时');
    expect(screen.getByText(/旧数据.*主动刷新/)).toBeDefined();
    expect(screen.getByText('缓存写入失败，当前结果仅保存在内存')).toBeDefined();
    expect(screen.getByText(/上次成功校验/)).toBeDefined();
    expect(screen.getByText(/2025/)).toBeDefined();
    expect(screen.getByText('当前选择：v24.10.0')).toBeDefined();
    expect(screen.getByText('发布日期：未知 · LTS 标记：未知')).toBeDefined();
    await user.click(screen.getByRole('radio', { name: 'v24.9.0' }));
    expect(screen.getByText('当前选择：v24.9.0')).toBeDefined();
  });

  // 搜索待定时旧候选禁选，只有权威空结果才能清草稿，回到原查询不会自动恢复。
  /** 验证搜索无匹配时清除草稿并给出空结果与提示。 */
  it('搜索无匹配时清除草稿并给出空结果与提示', async () => {
    const ipc = controlledIpc();
    render(<App adapter={ipc.adapter} />);
    await ipc.respond(0, snapshot());
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'v24.10.0' }));
    await user.click(screen.getByRole('searchbox', { name: '搜索发行版本' }));
    await user.paste('  V99  ');
    await user.click(screen.getByRole('radio', { name: 'v24.9.0' }));
    expect(screen.getByText('当前选择：v24.10.0')).toBeDefined();
    await ipc.respond(1, snapshot('  V99  ', { normalizedQuery: '99', releases: [] }));
    expect(screen.getByText('没有匹配的发行版本')).toBeDefined();
    expect(screen.getByText('尚未选择发行版本')).toBeDefined();
    expect(screen.getByText(/已清除单选/)).toBeDefined();
    await user.clear(screen.getByRole('searchbox', { name: '搜索发行版本' }));
    await ipc.respond(2, snapshot());
    expect(screen.getByText('尚未选择发行版本')).toBeDefined();
    expect((screen.getByRole('radio', { name: 'v24.10.0' }) as HTMLInputElement).checked).toBe(false);
  });

  // 验证目录获取是异步状态：失败必须显示原因与主动刷新，不能标成空结果。
  /** 验证首次加载失败后可以主动刷新并恢复目录。 */
  it('首次加载失败后可以主动刷新并恢复目录', async () => {
    const ipc = controlledIpc();
    render(<App adapter={ipc.adapter} />);
    await ipc.respond(0, snapshot('', { revision: 0, status: 'loading', hasCatalog: false, releases: [], checkedAt: null }));
    expect(within(screen.getByRole('region', { name: '搜索并选择发行版本' })).getByRole('status').textContent).toContain('加载');
    ipc.notify(1);
    await ipc.respond(1, snapshot('', { status: 'error', hasCatalog: false, releases: [], checkedAt: null, error: '官方目录解析失败：重复发行版本' }));
    expect(screen.getByRole('alert').textContent).toContain('重复发行版本');
    expect(screen.queryByText('没有匹配的发行版本')).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '刷新目录' }));
    await ipc.respond(2, snapshot('', { revision: 2, status: 'loading', hasCatalog: false, releases: [], checkedAt: null }));
    expect(within(screen.getByRole('region', { name: '搜索并选择发行版本' })).getByRole('status').textContent).toContain('加载');
    ipc.notify(3);
    await ipc.respond(3, snapshot('', { revision: 3 }));
    expect(await screen.findByRole('radio', { name: 'v24.10.0' })).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // 验证初始加载不会冒充空结果，并呈现权威版本、来源及单选草稿。
  /** 验证加载后能从原生radio单选发行版本。 */
  it('加载后能从原生radio单选发行版本', async () => {
    const ipc = controlledIpc();
    render(<App adapter={ipc.adapter} />);
    expect(within(screen.getByRole('region', { name: '搜索并选择发行版本' })).getByRole('status').textContent).toContain('加载');
    expect(screen.queryByText('没有匹配的发行版本')).toBeNull();
    await ipc.respond(0, snapshot());
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'v24.10.0' }));
    expect((screen.getByRole('radio', { name: 'v24.10.0' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('当前选择：v24.10.0')).toBeDefined();
    await user.click(screen.getByRole('radio', { name: 'v24.9.0' }));
    expect((screen.getByRole('radio', { name: 'v24.10.0' }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText('当前选择：v24.9.0')).toBeDefined();
    expect(screen.getByText('https://nodejs.org/dist/index.json')).toBeDefined();
  });
});
