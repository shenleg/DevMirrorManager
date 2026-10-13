/** 职责：通过前端应用公开操作和展示快照验证草稿与权威 IPC 结果的协调。 */
import { describe, expect, it, vi } from 'vitest';
import { createCatalogApplication } from './application';
import type { CatalogAdapter, CatalogSnapshot } from './catalog';

/** 创建可由测试决定完成时机的外部响应；返回承诺与完成入口，不抛出异常。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

/** 创建固定权威结果；query 原样回显，overrides 指定场景差异，返回快照，不抛出异常。 */
function snapshot(query = '', overrides: Partial<CatalogSnapshot> = {}): CatalogSnapshot {
  return {
    revision: 1, query, normalizedQuery: '', status: 'ready', hasCatalog: true,
    releases: [
      { version: 'v24.10.0', date: '2026-10-01', lts: 'Krypton' },
      { version: 'v24.9.0', date: null, lts: null },
    ],
    checkedAt: 1_760_000_000_000, stale: false, error: null, warnings: [],
    source: 'https://nodejs.org/dist/index.json', ...overrides,
  };
}

/** 控制 IPC 响应与通知；返回 Adapter 和待响应请求，不模拟任何前端内部函数，不抛出异常。 */
function controlledIpc() {
  const requests: { query: string; response: ReturnType<typeof deferred<CatalogSnapshot>> }[] = [];
  const listeners = new Set<(revision: number) => void>();
  const adapter: CatalogAdapter = {
    open: async () => {},
    snapshot: (query) => {
      const response = deferred<CatalogSnapshot>();
      requests.push({ query, response });
      return response.promise;
    },
    refresh: async () => {},
    listen: async (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  return {
    adapter, requests,
    notify: (revision: number) => { for (const listener of listeners) listener(revision); },
    /** 等待指定的外部请求出现，返回其响应控制入口；不存在时由测试等待超时报错。 */
    request: async (index: number) => {
      await vi.waitFor(() => expect(requests[index]).toBeDefined());
      return requests[index]!;
    },
  };
}

describe('前端目录应用公开 Interface', () => {
  // 清除提示描述已经发生的草稿变更；用户明确选新候选后不能仍提示当前单选被清除。
  it('用户选新候选后清除过时的失配提示', async () => {
    const ipc = controlledIpc();
    const app = createCatalogApplication(ipc.adapter);
    const connecting = app.connect();
    (await ipc.request(0)).response.resolve(snapshot());
    await connecting;
    app.select('v24.10.0');
    const searching = app.setQuery('22');
    (await ipc.request(1)).response.resolve(snapshot('22', { releases: [{ version: 'v22.10.0', date: null, lts: null }] }));
    await searching;
    expect(app.getSnapshot().feedback).toContain('已清除');
    app.select('v22.10.0');
    expect(app.getSnapshot()).toMatchObject({ selectedVersion: 'v22.10.0', feedback: '' });
    app.disconnect();
  });

  // IPC 失败后可保留旧列表用于说明，但旧查询结果不能成为新输入下的可选候选。
  it('查询IPC失败后不能选择属于旧查询的列表', async () => {
    const ipc = controlledIpc();
    const app = createCatalogApplication(ipc.adapter);
    const connecting = app.connect();
    (await ipc.request(0)).response.resolve(snapshot());
    await connecting;
    app.select('v24.10.0');
    const searching = app.setQuery('22');
    (await ipc.request(1)).response.reject(new Error('查询 IPC 失败'));
    await searching;
    app.select('v24.9.0');
    expect(app.getSnapshot()).toMatchObject({ querying: false, query: '22', selectedVersion: 'v24.10.0', error: '查询 IPC 失败' });
    app.disconnect();
  });

  // 订阅尚未建立时用户可改草稿，但不能提前把目录当作连接完成，避免漏启动通知。
  it('连接初始化期间的输入等待订阅并用最新查询恢复', async () => {
    const subscribing = deferred<() => void>();
    const adapter: CatalogAdapter = {
      open: async () => {}, refresh: async () => {},
      listen: () => subscribing.promise,
      snapshot: async (query) => snapshot(query),
    };
    const app = createCatalogApplication(adapter);
    const connecting = app.connect();
    await app.setQuery('22');
    expect(app.getSnapshot()).toMatchObject({ querying: true, query: '22', catalog: null });
    subscribing.resolve(() => {});
    await connecting;
    expect(app.getSnapshot()).toMatchObject({ querying: false, catalog: { query: '22' } });
    app.disconnect();
  });

  // 手动刷新命令快速完成不等于获取成功；界面需展示loading，随后由权威快照更新。
  it('刷新保留草稿并展示目录刷新进度', async () => {
    const ipc = controlledIpc();
    const app = createCatalogApplication(ipc.adapter);
    const connecting = app.connect();
    (await ipc.request(0)).response.resolve(snapshot());
    await connecting;
    app.select('v24.10.0');
    const refreshing = app.refresh();
    (await ipc.request(1)).response.resolve(snapshot('', { revision: 2, status: 'loading', stale: true }));
    await refreshing;
    expect(app.getSnapshot()).toMatchObject({ selectedVersion: 'v24.10.0', catalog: { status: 'loading', stale: true }, feedback: expect.stringContaining('刷新') });
    ipc.notify(3);
    (await ipc.request(2)).response.resolve(snapshot('', { revision: 3 }));
    await vi.waitFor(() => expect(app.getSnapshot().catalog?.status).toBe('ready'));
    app.disconnect();
  });

  // 未建立 IPC 时不冒充目录加载完成；连接失败给出原因，并允许用户重新连接。
  it('连接失败变为可恢复展示错误', async () => {
    const ipc = controlledIpc();
    let unavailable = true;
    const app = createCatalogApplication({ ...ipc.adapter, listen: async (listener) => {
      if (unavailable) throw new Error('只能在桌面应用中访问官方目录');
      return ipc.adapter.listen(listener);
    } });
    await app.connect();
    expect(app.getSnapshot()).toMatchObject({ connected: false, querying: false, catalog: null, error: '只能在桌面应用中访问官方目录' });
    unavailable = false;
    const reconnecting = app.connect();
    (await ipc.request(0)).response.resolve(snapshot());
    await reconnecting;
    expect(app.getSnapshot()).toMatchObject({ connected: true, error: null, catalog: { status: 'ready' } });
    app.disconnect();
  });

  // 重连可能连接新的 Rust 实例；旧事件和旧响应不得影响它，也不能沿用旧 revision 下界。
  it('断开隔离旧异步，重连以当前查询恢复且重置revision下界', async () => {
    const ipc = controlledIpc();
    const app = createCatalogApplication(ipc.adapter);
    const connecting = app.connect();
    (await ipc.request(0)).response.resolve(snapshot('', { revision: 20 }));
    await connecting;
    app.select('v24.10.0');
    const pending = app.setQuery('22');
    app.disconnect();
    ipc.notify(99);
    (await ipc.request(1)).response.resolve(snapshot('22', { revision: 50, releases: [] }));
    await pending;
    expect(app.getSnapshot()).toMatchObject({ connected: false, selectedVersion: 'v24.10.0', catalog: { revision: 20 } });
    const reconnecting = app.connect();
    const recovering = await ipc.request(2);
    expect(recovering.query).toBe('22');
    recovering.response.resolve(snapshot('22', { revision: 1, releases: [
      { version: 'v22.10.0', date: null, lts: null },
    ] }));
    await reconnecting;
    expect(app.getSnapshot()).toMatchObject({ connected: true, querying: false, selectedVersion: null, catalog: { revision: 1, query: '22' } });
    app.disconnect();
  });

  // pending 中通知可连续前进；必须补读至最高 revision，不能只丢弃旧响应后卡住。
  it('查询期间收到通知会持续补读直到最新目录', async () => {
    const ipc = controlledIpc();
    const app = createCatalogApplication(ipc.adapter);
    const connecting = app.connect();
    (await ipc.request(0)).response.resolve(snapshot());
    await connecting;
    const searching = app.setQuery('24');
    ipc.notify(3);
    (await ipc.request(1)).response.resolve(snapshot('24', { revision: 2 }));
    const followUp = await ipc.request(2);
    expect(app.getSnapshot().querying).toBe(true);
    ipc.notify(4);
    followUp.response.resolve(snapshot('24', { revision: 3 }));
    (await ipc.request(3)).response.resolve(snapshot('24', { revision: 4 }));
    await searching;
    expect(app.getSnapshot()).toMatchObject({ querying: false, catalog: { query: '24', revision: 4 } });
    ipc.notify(5);
    (await ipc.request(4)).response.resolve(snapshot('24', { revision: 5 }));
    await vi.waitFor(() => expect(app.getSnapshot().catalog?.revision).toBe(5));
    app.disconnect();
  });

  // 刷新状态不是查询失败：hasCatalog 的旧目录仍是权威候选，失配必须清草稿。
  it('旧但有效目录上的成功查询也清除失配且允许选择', async () => {
    const ipc = controlledIpc();
    const app = createCatalogApplication(ipc.adapter);
    const connecting = app.connect();
    (await ipc.request(0)).response.resolve(snapshot());
    await connecting;
    app.select('v24.10.0');
    const searching = app.setQuery('22');
    (await ipc.request(1)).response.resolve(snapshot('22', { status: 'error', stale: true, error: '刷新超时', releases: [
      { version: 'v22.10.0', date: null, lts: null },
    ] }));
    await searching;
    expect(app.getSnapshot().selectedVersion).toBeNull();
    app.select('v22.10.0');
    expect(app.getSnapshot().selectedVersion).toBe('v22.10.0');
    const searchingDuringRefresh = app.setQuery('24');
    (await ipc.request(2)).response.resolve(snapshot('24', { status: 'loading', stale: true }));
    await searchingDuringRefresh;
    expect(app.getSnapshot().selectedVersion).toBeNull();
    app.disconnect();
  });

  // 验证加载与获取失败不能伪装成失配，IPC 拒绝必须成为展示错误而非未处理异常。
  it('加载和错误保留草稿，IPC失败提供原因', async () => {
    const ipc = controlledIpc();
    const app = createCatalogApplication(ipc.adapter);
    const connecting = app.connect();
    (await ipc.request(0)).response.resolve(snapshot());
    await connecting;
    app.select('v24.10.0');
    const loading = app.setQuery('22');
    (await ipc.request(1)).response.resolve(snapshot('22', { status: 'loading', hasCatalog: false, releases: [], stale: true }));
    await loading;
    expect(app.getSnapshot().selectedVersion).toBe('v24.10.0');
    const failed = app.setQuery('23');
    (await ipc.request(2)).response.resolve(snapshot('23', { status: 'error', hasCatalog: false, releases: [], stale: true, error: '官方目录获取超时' }));
    await failed;
    expect(app.getSnapshot().selectedVersion).toBe('v24.10.0');
    const transportFailure = app.setQuery('24');
    (await ipc.request(3)).response.reject(new Error('IPC 连接中断'));
    await transportFailure;
    expect(app.getSnapshot()).toMatchObject({ querying: false, selectedVersion: 'v24.10.0', error: 'IPC 连接中断' });
    app.disconnect();
  });

  // 验证旧查询慢响应不能覆盖后发查询，且不能据旧结果误清除最新的草稿。
  it('只接受最新查询的成功响应', async () => {
    const ipc = controlledIpc();
    const app = createCatalogApplication(ipc.adapter);
    const connecting = app.connect();
    (await ipc.request(0)).response.resolve(snapshot());
    await connecting;
    app.select('v24.10.0');
    const oldQuery = app.setQuery('22');
    const latestQuery = app.setQuery('24');
    (await ipc.request(2)).response.resolve(snapshot('24'));
    await latestQuery;
    (await ipc.request(1)).response.resolve(snapshot('22', { revision: 9, releases: [] }));
    await oldQuery;
    expect(app.getSnapshot()).toMatchObject({ query: '24', selectedVersion: 'v24.10.0', catalog: { query: '24', revision: 1 } });
    app.disconnect();
  });

  // 验证仅权威搜索结果能清除失配单选，返回原查询时也不会自动恢复或改选。
  it('搜索期间禁选旧候选，成功失配清除草稿且不自动恢复', async () => {
    const ipc = controlledIpc();
    const app = createCatalogApplication(ipc.adapter);
    const connecting = app.connect();
    (await ipc.request(0)).response.resolve(snapshot());
    await connecting;
    app.select('v24.10.0');
    const searching = app.setQuery('  V22.1  ');
    app.select('v24.9.0');
    expect(app.getSnapshot()).toMatchObject({ querying: true, selectedVersion: 'v24.10.0' });
    const request = await ipc.request(1);
    expect(request.query).toBe('  V22.1  ');
    request.response.resolve(snapshot('  V22.1  ', { normalizedQuery: '22.1', releases: [
      { version: 'v22.10.0', date: null, lts: null },
    ] }));
    await searching;
    expect(app.getSnapshot()).toMatchObject({ selectedVersion: null, feedback: expect.stringContaining('已清除') });
    const returning = app.setQuery('');
    (await ipc.request(2)).response.resolve(snapshot());
    await returning;
    expect(app.getSnapshot().selectedVersion).toBeNull();
    app.disconnect();
  });

  // 验证只能单选当前候选，替换选择不会保留第二个草稿，非法候选也不能写入。
  it('单选替换且拒绝目录之外的发行版本', async () => {
    const ipc = controlledIpc();
    const app = createCatalogApplication(ipc.adapter);
    const connecting = app.connect();
    (await ipc.request(0)).response.resolve(snapshot());
    await connecting;
    app.select('v24.10.0');
    expect(app.getSnapshot().selectedVersion).toBe('v24.10.0');
    app.select('v24.9.0');
    app.select('v99.0.0');
    expect(app.getSnapshot().selectedVersion).toBe('v24.9.0');
    app.disconnect();
  });

  // 验证首次连接只展示 IPC 的权威顺序与元数据，不内置或重排候选。
  it('连接后从权威快照展示发行版本和来源', async () => {
    const ipc = controlledIpc();
    const app = createCatalogApplication(ipc.adapter);
    const connecting = app.connect();
    expect(app.getSnapshot().querying).toBe(true);
    (await ipc.request(0)).response.resolve(snapshot());
    await connecting;
    expect(app.getSnapshot()).toMatchObject({
      connected: true, querying: false, query: '', selectedVersion: null,
      catalog: { source: 'https://nodejs.org/dist/index.json', releases: [
        { version: 'v24.10.0' }, { version: 'v24.9.0' },
      ] },
    });
    app.disconnect();
  });
});
