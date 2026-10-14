/** 职责：通过前端应用公开操作和展示快照验证草稿与权威 IPC 结果的协调。 */
import { describe, expect, it, vi } from 'vitest';
import { createCatalogApplication } from './application';
import type { CatalogAdapter, CatalogSnapshot, Selection } from './catalog';

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
    source: 'https://nodejs.org/dist/index.json',
    preview: { selection: { version: null, target: { os: 'macos', arch: 'x64' } }, status: 'unselected', source: null, required: [], error: null },
    ...overrides,
  };
}

/** 控制外部 IPC；autoPreparation 为旧目录用例自动完成空预览样本，返回请求/通知控制器，不抛出异常。 */
function controlledIpc(autoPreparation = true) {
  const requests: { query: string; selection: Selection; response: ReturnType<typeof deferred<CatalogSnapshot>>; rawResolve: (value: CatalogSnapshot) => void }[] = [];
  const preparations: { selection: Selection; retry: boolean }[] = [];
  const listeners = new Set<(revision: number) => void>();
  let latest = snapshot();
  let preparationRead = false;
  const adapter: CatalogAdapter = {
    open: async () => {},
    snapshot: (query, selection) => {
      if (autoPreparation && selection.version === null && latest.preview.selection.version !== null && latest.query === query) {
        latest = { ...latest, preview: { selection, status: 'unselected', source: null, required: [], error: null } };
        return Promise.resolve(latest);
      }
      if (autoPreparation && preparationRead) {
        preparationRead = false;
        // 旧目录用例不验证清单；只回显空的 idle 样本，不生成文件或存在性事实。
        return Promise.resolve({ ...latest, query, preview: { selection, status: 'idle', source: null, required: [], error: null } });
      }
      const pending = deferred<CatalogSnapshot>();
      const response = { ...pending, resolve: (value: CatalogSnapshot) => {
        latest = { ...value, preview: { ...value.preview, selection } };
        pending.resolve(latest);
      } };
      requests.push({ query, selection, response, rawResolve: pending.resolve });
      return response.promise;
    },
    preparePreview: async (selection, retry) => {
      preparations.push({ selection, retry });
      preparationRead = autoPreparation;
    },
    refresh: async () => {},
    listen: async (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  return {
    adapter, requests, preparations,
    /** 发布外部 revision；无返回值，listener 异常向测试传递。 */
    notify: (revision: number) => { for (const listener of listeners) listener(revision); },
    /** 等待指定的外部请求出现，返回其响应控制入口；不存在时由测试等待超时报错。 */
    request: async (index: number) => {
      await vi.waitFor(() => expect(requests[index]).toBeDefined());
      return requests[index]!;
    },
  };
}

describe('前端目录应用公开 Interface', () => {
  /** 验证null-version恢复同样补读revision下界与完整身份，并隔离旧查询/旧连接，不能迟到清新草稿。 */
  it('membership恢复隔离旧查询连接并补读身份与revision', async () => {
    const ipc = controlledIpc(false);
    const app = createCatalogApplication(ipc.adapter);
    const connecting = app.connect();
    (await ipc.request(0)).response.resolve(snapshot());
    await connecting;
    const selecting = app.select('v24.10.0');
    const selected = await ipc.request(1);
    selected.response.resolve(snapshot('', { preview: { selection: selected.selection, status: 'idle', source: null, required: [], error: null } }));
    await selecting;
    const obsolete = app.setQuery('99');
    (await ipc.request(2)).response.reject(new Error('membership拒绝'));
    const obsoleteRecovery = await ipc.request(3);
    const latest = app.setQuery('24');
    const current = await ipc.request(4);
    current.response.resolve(snapshot('24', { preview: { selection: current.selection, status: 'idle', source: null, required: [], error: null } }));
    await latest;
    obsoleteRecovery.response.resolve(snapshot('99', { revision: 99, releases: [] }));
    await obsolete;
    expect(app.getSnapshot()).toMatchObject({ selectedVersion: 'v24.10.0', query: '24', catalog: { revision: 1 } });
    const disconnected = app.setQuery('98');
    (await ipc.request(5)).response.reject(new Error('membership拒绝'));
    const oldConnection = await ipc.request(6);
    app.disconnect();
    const reconnecting = app.connect();
    const reconnected = await ipc.request(7);
    reconnected.response.resolve(snapshot('98', { preview: { selection: reconnected.selection, status: 'idle', source: null, required: [], error: null } }));
    await reconnecting;
    oldConnection.response.resolve(snapshot('98', { revision: 100, releases: [] }));
    await disconnected;
    expect(app.getSnapshot().selectedVersion).toBe('v24.10.0');
    const recovering = app.setQuery('97');
    (await ipc.request(8)).response.reject(new Error('membership拒绝'));
    const stale = await ipc.request(9);
    ipc.notify(5);
    stale.response.resolve(snapshot('97', { revision: 4, releases: [] }));
    const wrongIdentity = await ipc.request(10);
    wrongIdentity.rawResolve(snapshot('97', { revision: 5, releases: [], preview: {
      selection: { version: null, target: { os: 'windows', arch: 'arm64' } }, status: 'unselected', source: null, required: [], error: null,
    } }));
    (await ipc.request(11)).response.resolve(snapshot('97', { revision: 5, releases: [] }));
    await recovering;
    expect(app.getSnapshot()).toMatchObject({ selectedVersion: null, querying: false, catalog: { revision: 5, preview: { status: 'unselected', selection: { version: null, target: { os: 'macos', arch: 'x64' } } } } });
    app.disconnect();
  });
  /** 验证命令回执晚于通知事实时，ready/missing/loading/权威error均不能被迟到传输失败遮蔽。 */
  it('通知已确认prepare或retry进度后忽略迟到失败回执', async () => {
    for (const retry of [false, true]) {
      for (const status of ['ready', 'missing', 'loading', 'error'] as const) {
        const ipc = controlledIpc(false);
        const receipt = deferred<void>();
        const app = createCatalogApplication({ ...ipc.adapter, preparePreview: (selection, requestedRetry) => {
          return requestedRetry === retry ? receipt.promise : ipc.adapter.preparePreview(selection, requestedRetry);
        } });
        const connecting = app.connect();
        (await ipc.request(0)).response.resolve(snapshot());
        await connecting;
        let pending = app.select('v24.10.0');
        let index = 1;
        if (retry) {
          const initial = await ipc.request(index++);
          initial.response.resolve(snapshot('', { preview: { selection: initial.selection, status: 'error', source: null, required: [], error: '之前的清单错误' } }));
          await pending;
          pending = app.retryPreview();
        }
        ipc.notify(2);
        const confirmed = await ipc.request(index);
        confirmed.response.resolve(snapshot('', { revision: 2, preview: {
          selection: confirmed.selection, status, source: null, required: [], error: status === 'error' ? '本次权威清单错误' : null,
        } }));
        await vi.waitFor(() => expect(app.getSnapshot().querying).toBe(false));
        receipt.reject(new Error('迟到准备回执IPC失败'));
        await pending;
        expect(app.getSnapshot()).toMatchObject({ previewError: null, catalog: { preview: { status, error: status === 'error' ? '本次权威清单错误' : null } } });
        app.disconnect();
      }
    }
  });
  /** 验证恢复读取不是随意清选择的后门：目录未知、仍包含原选择或再次失败时保留原choice与原始错误。 */
  it('恢复快照不能确认失配时保留选择及首个错误', async () => {
    for (const mode of ['contains', 'unavailable', 'reject']) {
      const ipc = controlledIpc(false);
      const app = createCatalogApplication(ipc.adapter);
      const connecting = app.connect();
      (await ipc.request(0)).response.resolve(snapshot());
      await connecting;
      const selecting = app.select('v24.10.0');
      const selected = await ipc.request(1);
      selected.response.resolve(snapshot('', { preview: { selection: selected.selection, status: 'ready', source: null, required: [], error: null } }));
      await selecting;
      const searching = app.setQuery('24');
      (await ipc.request(2)).response.reject(new Error('原始查询IPC错误'));
      const recovery = await ipc.request(3);
      if (mode === 'reject') recovery.response.reject(new Error('恢复读取IPC错误'));
      else recovery.response.resolve(snapshot('24', mode === 'unavailable' ? { hasCatalog: false, releases: [], status: 'loading' } : {}));
      await searching;
      expect(app.getSnapshot()).toMatchObject({ selectedVersion: 'v24.10.0', querying: false, error: '原始查询IPC错误', catalog: { query: '' } });
      app.disconnect();
    }
  });
  /** 验证Rust因目录移除所选发行版本而拒绝时，空version权威查询可确认失配并恢复浏览。 */
  it('membership拒绝后用无version权威结果清草稿且保留目标', async () => {
    const ipc = controlledIpc(false);
    const app = createCatalogApplication(ipc.adapter);
    await app.setTarget({ os: 'linux', arch: 'arm64' });
    const connecting = app.connect();
    (await ipc.request(0)).response.resolve(snapshot());
    await connecting;
    const selecting = app.select('v24.10.0');
    const selected = await ipc.request(1);
    selected.response.resolve(snapshot('', { preview: { selection: selected.selection, status: 'ready', source: null, required: [], error: null } }));
    await selecting;
    const searching = app.setQuery('24.9');
    (await ipc.request(2)).response.reject(new Error('发行版本已不属于已校验目录'));
    const recovery = await ipc.request(3);
    expect(recovery.selection).toEqual({ version: null, target: { os: 'linux', arch: 'arm64' } });
    recovery.response.resolve(snapshot('24.9', { revision: 2, releases: [{ version: 'v24.9.0', date: null, lts: null }] }));
    await searching;
    expect(app.getSnapshot()).toMatchObject({ querying: false, selectedVersion: null, target: { os: 'linux', arch: 'arm64' }, error: null, catalog: { query: '24.9', revision: 2, preview: { status: 'unselected', selection: { version: null } } } });
    const replacement = app.select('v24.9.0');
    const current = await ipc.request(4);
    current.response.resolve(snapshot('24.9', { revision: 2, releases: [{ version: 'v24.9.0', date: null, lts: null }], preview: { selection: current.selection, status: 'ready', source: null, required: [], error: null } }));
    await replacement;
    expect(app.getSnapshot().selectedVersion).toBe('v24.9.0');
    app.disconnect();
  });
  /** 验证准备命令未送达后重连只读取idle，用户仍能主动准备，不自动获取清单。 */
  it('准备IPC失败后重连到idle仍可主动准备', async () => {
    const ipc = controlledIpc(false);
    let rejected = true;
    const app = createCatalogApplication({ ...ipc.adapter, preparePreview: async (selection, retry) => {
      await ipc.adapter.preparePreview(selection, retry);
      if (rejected) throw new Error('prepare未送达');
    } });
    const connecting = app.connect();
    (await ipc.request(0)).response.resolve(snapshot());
    await connecting;
    await app.select('v24.10.0');
    app.disconnect();
    const reconnecting = app.connect();
    const idle = await ipc.request(1);
    idle.response.resolve(snapshot('', { preview: { selection: idle.selection, status: 'idle', source: null, required: [], error: null } }));
    await reconnecting;
    expect(ipc.preparations).toHaveLength(1);
    expect(app.getSnapshot().previewError).toBeNull();
    rejected = false;
    const preparing = app.retryPreview();
    const loading = await ipc.request(2);
    loading.response.resolve(snapshot('', { revision: 2, preview: { selection: loading.selection, status: 'loading', source: null, required: [], error: null } }));
    await preparing;
    expect(ipc.preparations.at(-1)).toEqual({ selection: { version: 'v24.10.0', target: { os: 'macos', arch: 'x64' } }, retry: true });
    expect(app.getSnapshot().catalog?.preview.status).toBe('loading');
    app.disconnect();
  });
  /** 清单准备传输失败属于发行版本，切目标仍应保留主动重试原因，不能停在无入口的 idle。 */
  it('切换目标不会清除同发行版本的准备IPC失败', async () => {
    const ipc = controlledIpc(false);
    ipc.adapter.preparePreview = async () => { throw new Error('准备IPC中断'); };
    const app = createCatalogApplication(ipc.adapter);
    const connecting = app.connect();
    (await ipc.request(0)).response.resolve(snapshot());
    await connecting;
    await app.select('v24.10.0');
    expect(app.getSnapshot().previewError).toBe('准备IPC中断');
    const changing = app.setTarget({ os: 'linux', arch: 'arm64' });
    const request = await ipc.request(1);
    request.response.resolve(snapshot('', { preview: {
      selection: request.selection, status: 'idle', source: null, required: [], error: null,
    } }));
    await changing;
    expect(app.getSnapshot().selectedVersion).toBe('v24.10.0');
    expect(app.getSnapshot().previewError).toBe('准备IPC中断');
    app.disconnect();
  });
  /** 命令回执传输失败后，后续权威事实已确认准备结果时不能继续显示过时 IPC 原因。 */
  it('成功权威清单快照清除过时的准备IPC错误', async () => {
    const ipc = controlledIpc(false);
    ipc.adapter.preparePreview = async () => { throw new Error('准备回执丢失'); };
    const app = createCatalogApplication(ipc.adapter);
    const connecting = app.connect();
    (await ipc.request(0)).response.resolve(snapshot());
    await connecting;
    await app.select('v24.10.0');
    expect(app.getSnapshot().previewError).toBe('准备回执丢失');
    ipc.notify(2);
    const request = await ipc.request(1);
    request.response.resolve(snapshot('', { revision: 2, preview: {
      selection: request.selection, status: 'ready', source: 'https://nodejs.org/dist/v24.10.0/SHASUMS256.txt',
      required: [], error: null,
    } }));
    await vi.waitFor(() => expect(app.getSnapshot().querying).toBe(false));
    expect(app.getSnapshot().previewError).toBeNull();
    expect(app.getSnapshot().catalog?.preview.status).toBe('ready');
    app.disconnect();
  });
  /** 从 A 改选 B 再返回 A 后，旧 A 命令不能把已成功的新准备污染为错误；目标浏览不等同于新命令。 */
  it('重新选择同发行版本后隔离前一次准备的迟到失败', async () => {
    const ipc = controlledIpc(false);
    const first = deferred<void>(), second = deferred<void>(), returning = deferred<void>();
    const commands = [first, second, returning];
    ipc.adapter.preparePreview = () => commands.shift()!.promise;
    const app = createCatalogApplication(ipc.adapter);
    const connecting = app.connect();
    (await ipc.request(0)).response.resolve(snapshot());
    await connecting;
    const selectingFirst = app.select('v24.10.0');
    const selectingSecond = app.select('v24.9.0');
    const returningFirst = app.select('v24.10.0');
    returning.resolve();
    const current = await ipc.request(1);
    current.response.resolve(snapshot('', { preview: {
      selection: current.selection, status: 'ready', source: null, required: [], error: null,
    } }));
    await returningFirst;
    first.reject(new Error('旧A回执失败'));
    await selectingFirst;
    expect(app.getSnapshot().selectedVersion).toBe('v24.10.0');
    expect(app.getSnapshot().previewError).toBeNull();
    second.resolve();
    await selectingSecond;
    app.disconnect();
  });
  /** 验证完整选择经快速准备命令和快照展示 Rust 文件事实，不由前端拼文件名。 */
  it('选择Windows发行版本后准备清单并展示权威7z事实', async () => {
    const ipc = controlledIpc(false);
    const app = createCatalogApplication(ipc.adapter);
    await app.setTarget({ os: 'windows', arch: 'x64' });
    const connecting = app.connect();
    (await ipc.request(0)).response.resolve(snapshot());
    await connecting;
    const selecting = app.select('v24.10.0');
    const selected = await ipc.request(1);
    expect(selected.selection).toEqual({ version: 'v24.10.0', target: { os: 'windows', arch: 'x64' } });
    selected.response.resolve(snapshot('', { revision: 2, preview: {
      selection: selected.selection, status: 'ready', source: 'https://nodejs.org/dist/v24.10.0/SHASUMS256.txt',
      required: [{ path: 'node-v24.10.0-win-x64.7z', present: true, sha256: 'a'.repeat(64) }], error: null,
    } }));
    await selecting;
    expect(ipc.preparations).toEqual([{ selection: selected.selection, retry: false }]);
    expect(app.getSnapshot().catalog?.preview).toMatchObject({ status: 'ready', required: [{ path: 'node-v24.10.0-win-x64.7z', present: true, sha256: 'a'.repeat(64) }] });
    app.disconnect();
  });
  /** 验证快速切目标只读取新事实，迟到预览不能覆盖新目标或改变发行版本。 */
  it('切换目标只读快照且隔离旧目标响应', async () => {
    const ipc = controlledIpc(false);
    const app = createCatalogApplication(ipc.adapter);
    const connecting = app.connect();
    (await ipc.request(0)).response.resolve(snapshot());
    await connecting;
    const selecting = app.select('v24.10.0');
    const old = await ipc.request(1);
    const switching = app.setTarget({ os: 'linux', arch: 'arm64' });
    const current = await ipc.request(2);
    current.response.resolve(snapshot('', { revision: 3, preview: {
      selection: current.selection, status: 'missing', source: 'https://nodejs.org/dist/v24.10.0/SHASUMS256.txt',
      required: [{ path: 'fixture-linux.tar.gz', present: false, sha256: null }], error: null,
    } }));
    await switching;
    old.response.resolve(snapshot('', { revision: 99, preview: {
      selection: old.selection, status: 'ready', source: null, required: [{ path: 'old-target', present: true, sha256: 'b'.repeat(64) }], error: null,
    } }));
    await selecting;
    expect(app.getSnapshot()).toMatchObject({ selectedVersion: 'v24.10.0', target: { os: 'linux', arch: 'arm64' }, catalog: { revision: 3, preview: { status: 'missing', required: [{ path: 'fixture-linux.tar.gz' }] } } });
    expect(ipc.preparations).toHaveLength(1);
    app.disconnect();
  });

  /** 验证失败事实浏览不重试，只有公开主动重试命令才开启新准备。 */
  it('已有清单错误不会自动重试且主动retry保持目标', async () => {
    const ipc = controlledIpc(false);
    const app = createCatalogApplication(ipc.adapter);
    const connecting = app.connect();
    (await ipc.request(0)).response.resolve(snapshot());
    await connecting;
    const selecting = app.select('v24.10.0');
    const request = await ipc.request(1);
    const errorPreview = { selection: request.selection, status: 'error' as const, source: 'https://nodejs.org/dist/v24.10.0/SHASUMS256.txt', required: [{ path: 'fixture.tar.xz', present: null, sha256: null }], error: '清单解析失败' };
    request.response.resolve(snapshot('', { revision: 2, preview: errorPreview }));
    await selecting;
    const browsing = app.setTarget({ os: 'windows', arch: 'arm64' });
    (await ipc.request(2)).response.resolve(snapshot('', { revision: 2, preview: errorPreview }));
    await browsing;
    const reselecting = app.select('v24.10.0');
    (await ipc.request(3)).response.resolve(snapshot('', { revision: 2, preview: errorPreview }));
    await reselecting;
    expect(ipc.preparations.every((request) => !request.retry)).toBe(true);
    const retrying = app.retryPreview();
    const retry = await ipc.request(4);
    retry.response.resolve(snapshot('', { revision: 3, preview: { ...errorPreview, status: 'loading', error: null } }));
    await retrying;
    expect(ipc.preparations.at(-1)).toEqual({ selection: { version: 'v24.10.0', target: { os: 'windows', arch: 'arm64' } }, retry: true });
    expect(app.getSnapshot().catalog?.preview.status).toBe('loading');
    app.disconnect();
  });

  /** 验证搜索清除只改变发行版本，并补读无选择事实，旧预览不得复活。 */
  it('搜索失配补读unselected且保留linux arm64', async () => {
    const ipc = controlledIpc(false);
    const app = createCatalogApplication(ipc.adapter);
    await app.setTarget({ os: 'linux', arch: 'arm64' });
    const connecting = app.connect();
    (await ipc.request(0)).response.resolve(snapshot());
    await connecting;
    const selecting = app.select('v24.10.0');
    (await ipc.request(1)).response.resolve(snapshot('', { revision: 2, preview: {
      selection: ipc.requests[1]!.selection, status: 'ready', source: 'https://nodejs.org/dist/v24.10.0/SHASUMS256.txt',
      required: [{ path: 'old.tar.xz', present: true, sha256: 'a'.repeat(64) }], error: null,
    } }));
    await selecting;
    const searching = app.setQuery('99');
    (await ipc.request(2)).response.resolve(snapshot('99', { revision: 3, releases: [] }));
    const cleared = await ipc.request(3);
    expect(cleared.selection).toEqual({ version: null, target: { os: 'linux', arch: 'arm64' } });
    cleared.response.resolve(snapshot('99', { revision: 3, releases: [] }));
    await searching;
    expect(app.getSnapshot()).toMatchObject({ selectedVersion: null, target: { os: 'linux', arch: 'arm64' }, catalog: { preview: { status: 'unselected', required: [], source: null } } });
    const returning = app.setQuery('');
    (await ipc.request(4)).response.resolve(snapshot('', { revision: 3 }));
    await returning;
    expect(app.getSnapshot().selectedVersion).toBeNull();
    app.disconnect();
  });

  /** 验证IPC回显的selection是响应身份的一部分；错误身份与旧revision都必须继续补读。 */
  it('通知补读同时保护query和selection身份', async () => {
    const ipc = controlledIpc(false);
    const app = createCatalogApplication(ipc.adapter);
    const connecting = app.connect();
    (await ipc.request(0)).response.resolve(snapshot());
    await connecting;
    const changing = app.setTarget({ os: 'windows', arch: 'arm64' });
    ipc.notify(5);
    (await ipc.request(1)).rawResolve(snapshot('', { revision: 5 }));
    const identityRead = await ipc.request(2);
    identityRead.response.resolve(snapshot('', { revision: 4 }));
    (await ipc.request(3)).response.resolve(snapshot('', { revision: 5 }));
    await changing;
    expect(app.getSnapshot()).toMatchObject({ querying: false, target: { os: 'windows', arch: 'arm64' }, catalog: { revision: 5, preview: { selection: { target: { os: 'windows', arch: 'arm64' } } } } });
    app.disconnect();
  });

  /** 验证旧选择准备命令的迟到失败不能污染已经清除的发行版本或新查询。 */
  it('迟到prepare失败不能覆盖失配后的当前状态', async () => {
    const ipc = controlledIpc();
    const preparation = deferred<void>();
    const app = createCatalogApplication({ ...ipc.adapter, preparePreview: () => preparation.promise });
    const connecting = app.connect();
    (await ipc.request(0)).response.resolve(snapshot());
    await connecting;
    const selecting = app.select('v24.10.0');
    const searching = app.setQuery('99');
    (await ipc.request(1)).response.resolve(snapshot('99', { releases: [] }));
    await searching;
    preparation.reject(new Error('旧选择清单IPC失败'));
    await selecting;
    expect(app.getSnapshot()).toMatchObject({ selectedVersion: null, query: '99', error: null, catalog: { preview: { status: 'unselected' } } });
    app.disconnect();
  });

  /** 验证旧连接的prepare/retry传输错误不污染重连后的权威ready预览。 */
  it('prepare或retry IPC失败后重连不残留previewError', async () => {
    for (const failedCommand of ['prepare', 'retry']) {
      const ipc = controlledIpc(false);
      const reason = `${failedCommand} IPC中断`;
      const app = createCatalogApplication({ ...ipc.adapter, preparePreview: async (selection, retry) => {
        if (retry === (failedCommand === 'retry')) throw new Error(reason);
        await ipc.adapter.preparePreview(selection, retry);
      } });
      const connecting = app.connect();
      (await ipc.request(0)).response.resolve(snapshot());
      await connecting;
      const selecting = app.select('v24.10.0');
      if (failedCommand === 'retry') {
        const selected = await ipc.request(1);
        selected.response.resolve(snapshot('', { preview: {
          selection: selected.selection, status: 'idle', source: 'https://nodejs.org/dist/v24.10.0/SHASUMS256.txt',
          required: [{ path: 'node-v24.10.0-darwin-x64.tar.xz', present: null, sha256: null }], error: null,
        } }));
        await selecting;
        await app.retryPreview();
      } else {
        await selecting;
      }
      expect(app.getSnapshot().previewError).toBe(reason);
      app.disconnect();
      const reconnecting = app.connect();
      const recovered = await ipc.request(failedCommand === 'retry' ? 2 : 1);
      recovered.response.resolve(snapshot('', { preview: {
        selection: recovered.selection, status: 'ready', source: 'https://nodejs.org/dist/v24.10.0/SHASUMS256.txt',
        required: [{ path: 'node-v24.10.0-darwin-x64.tar.xz', present: true, sha256: 'a'.repeat(64) }], error: null,
      } }));
      await reconnecting;
      expect(app.getSnapshot()).toMatchObject({ connected: true, selectedVersion: 'v24.10.0', previewError: null, catalog: { preview: { status: 'ready', error: null } } });
      app.disconnect();
    }
  });

  /** 验证同发行版本准备完成后，即使切目标且漏通知，也补读当前目标而不停在idle。 */
  it('prepare等待期间切目标后成功会补读当前选择', async () => {
    const ipc = controlledIpc(false);
    const preparation = deferred<void>();
    const app = createCatalogApplication({ ...ipc.adapter, preparePreview: () => preparation.promise });
    const connecting = app.connect();
    (await ipc.request(0)).response.resolve(snapshot());
    await connecting;
    const selecting = app.select('v24.10.0');
    const switching = app.setTarget({ os: 'windows', arch: 'arm64' });
    const idle = await ipc.request(1);
    idle.response.resolve(snapshot('', { preview: {
      selection: idle.selection, status: 'idle', source: null, required: [], error: null,
    } }));
    await switching;
    preparation.resolve();
    const ready = await ipc.request(2);
    expect(ready.selection).toEqual({ version: 'v24.10.0', target: { os: 'windows', arch: 'arm64' } });
    ready.response.resolve(snapshot('', { revision: 2, preview: {
      selection: ready.selection, status: 'ready', source: 'https://nodejs.org/dist/v24.10.0/SHASUMS256.txt',
      required: [{ path: 'node-v24.10.0-win-arm64.7z', present: true, sha256: 'b'.repeat(64) }], error: null,
    } }));
    await selecting;
    expect(app.getSnapshot()).toMatchObject({ selectedVersion: 'v24.10.0', target: { os: 'windows', arch: 'arm64' }, catalog: { preview: { status: 'ready' } } });
    app.disconnect();
  });

  /** 验证同发行版本prepare/retry切目标后仍idle时失败，必须保留无权威依据的IPC原因供用户主动重试。 */
  it('prepare或retry等待期间切目标为idle不会吞掉同版本IPC错误', async () => {
    for (const command of ['prepare', 'retry']) {
      const ipc = controlledIpc(false);
      const preparation = deferred<void>();
      const app = createCatalogApplication({ ...ipc.adapter, preparePreview: (selection, retry) => {
        if (retry === (command === 'retry')) return preparation.promise;
        return ipc.adapter.preparePreview(selection, retry);
      } });
      const connecting = app.connect();
      (await ipc.request(0)).response.resolve(snapshot());
      await connecting;
      let pending = app.select('v24.10.0');
      let requestIndex = 1;
      if (command === 'retry') {
        const failed = await ipc.request(requestIndex++);
        failed.response.resolve(snapshot('', { preview: {
          selection: failed.selection, status: 'idle', source: null, required: [], error: null,
        } }));
        await pending;
        pending = app.retryPreview();
      }
      const switching = app.setTarget({ os: 'linux', arch: 'arm64' });
      const current = await ipc.request(requestIndex);
      current.response.resolve(snapshot('', { preview: {
        selection: current.selection, status: 'idle', source: null, required: [], error: null,
      } }));
      await switching;
      preparation.reject(new Error(`${command} IPC中断`));
      await pending;
      expect(app.getSnapshot()).toMatchObject({ selectedVersion: 'v24.10.0', target: { os: 'linux', arch: 'arm64' }, previewError: `${command} IPC中断`, error: null });
      app.disconnect();
    }
  });

  /** 验证未连接桌面时仍可独立浏览目标，默认值不取决于宿主。 */
  it('无IPC时系统和架构仍可独立切换', async () => {
    const app = createCatalogApplication(controlledIpc().adapter);
    expect(app.getSnapshot().target).toEqual({ os: 'macos', arch: 'x64' });
    await app.setTarget({ os: 'windows', arch: 'x64' });
    await app.setTarget({ os: 'windows', arch: 'arm64' });
    expect(app.getSnapshot()).toMatchObject({ selectedVersion: null, target: { os: 'windows', arch: 'arm64' } });
  });
  // 清除提示描述已经发生的草稿变更；用户明确选新候选后不能仍提示当前单选被清除。
  /** 验证用户选新候选后清除过时的失配提示。 */
  it('用户选新候选后清除过时的失配提示', async () => {
    const ipc = controlledIpc();
    const app = createCatalogApplication(ipc.adapter);
    const connecting = app.connect();
    (await ipc.request(0)).response.resolve(snapshot());
    await connecting;
    await app.select('v24.10.0');
    const searching = app.setQuery('22');
    (await ipc.request(1)).response.resolve(snapshot('22', { releases: [{ version: 'v22.10.0', date: null, lts: null }] }));
    await searching;
    expect(app.getSnapshot().feedback).toContain('已清除');
    await app.select('v22.10.0');
    expect(app.getSnapshot()).toMatchObject({ selectedVersion: 'v22.10.0', feedback: '' });
    app.disconnect();
  });

  // IPC 失败后可保留旧列表用于说明，但旧查询结果不能成为新输入下的可选候选。
  /** 验证查询IPC失败后不能选择属于旧查询的列表。 */
  it('查询IPC失败后不能选择属于旧查询的列表', async () => {
    const ipc = controlledIpc();
    const app = createCatalogApplication(ipc.adapter);
    const connecting = app.connect();
    (await ipc.request(0)).response.resolve(snapshot());
    await connecting;
    await app.select('v24.10.0');
    const searching = app.setQuery('22');
    (await ipc.request(1)).response.reject(new Error('查询 IPC 失败'));
    (await ipc.request(2)).response.reject(new Error('恢复读取同样失败'));
    await searching;
    await app.select('v24.9.0');
    expect(app.getSnapshot()).toMatchObject({ querying: false, query: '22', selectedVersion: 'v24.10.0', error: '查询 IPC 失败' });
    app.disconnect();
  });

  // 订阅尚未建立时用户可改草稿，但不能提前把目录当作连接完成，避免漏启动通知。
  /** 验证连接初始化期间的输入等待订阅并用最新查询恢复。 */
  it('连接初始化期间的输入等待订阅并用最新查询恢复', async () => {
    const subscribing = deferred<() => void>();
    const adapter: CatalogAdapter = {
      open: async () => {}, refresh: async () => {}, preparePreview: async () => {},
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
  /** 验证刷新保留草稿并展示目录刷新进度。 */
  it('刷新保留草稿并展示目录刷新进度', async () => {
    const ipc = controlledIpc();
    const app = createCatalogApplication(ipc.adapter);
    const connecting = app.connect();
    (await ipc.request(0)).response.resolve(snapshot());
    await connecting;
    await app.select('v24.10.0');
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
  /** 验证连接失败变为可恢复展示错误。 */
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
  /** 验证断开隔离旧异步，重连以当前查询恢复且重置revision下界。 */
  it('断开隔离旧异步，重连以当前查询恢复且重置revision下界', async () => {
    const ipc = controlledIpc();
    const app = createCatalogApplication(ipc.adapter);
    await app.setTarget({ os: 'windows', arch: 'arm64' });
    const connecting = app.connect();
    (await ipc.request(0)).response.resolve(snapshot('', { revision: 20 }));
    await connecting;
    await app.select('v24.10.0');
    const pending = app.setQuery('22');
    app.disconnect();
    await app.setTarget({ os: 'linux', arch: 'arm64' });
    ipc.notify(99);
    (await ipc.request(1)).response.resolve(snapshot('22', { revision: 50, releases: [] }));
    await pending;
    expect(app.getSnapshot()).toMatchObject({ connected: false, selectedVersion: 'v24.10.0', catalog: { revision: 20 } });
    const reconnecting = app.connect();
    const recovering = await ipc.request(2);
    expect(recovering.query).toBe('22');
    expect(recovering.selection).toEqual({ version: 'v24.10.0', target: { os: 'linux', arch: 'arm64' } });
    recovering.response.resolve(snapshot('22', { revision: 1, releases: [
      { version: 'v22.10.0', date: null, lts: null },
    ] }));
    await reconnecting;
    expect(app.getSnapshot()).toMatchObject({ connected: true, querying: false, selectedVersion: null, target: { os: 'linux', arch: 'arm64' }, catalog: { revision: 1, query: '22', preview: { selection: { version: null, target: { os: 'linux', arch: 'arm64' } }, status: 'unselected' } } });
    app.disconnect();
  });

  // pending 中通知可连续前进；必须补读至最高 revision，不能只丢弃旧响应后卡住。
  /** 验证查询期间收到通知会持续补读直到最新目录。 */
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
  /** 验证旧但有效目录上的成功查询也清除失配且允许选择。 */
  it('旧但有效目录上的成功查询也清除失配且允许选择', async () => {
    const ipc = controlledIpc();
    const app = createCatalogApplication(ipc.adapter);
    const connecting = app.connect();
    (await ipc.request(0)).response.resolve(snapshot());
    await connecting;
    await app.select('v24.10.0');
    const searching = app.setQuery('22');
    (await ipc.request(1)).response.resolve(snapshot('22', { status: 'error', stale: true, error: '刷新超时', releases: [
      { version: 'v22.10.0', date: null, lts: null },
    ] }));
    await searching;
    expect(app.getSnapshot().selectedVersion).toBeNull();
    await app.select('v22.10.0');
    expect(app.getSnapshot().selectedVersion).toBe('v22.10.0');
    const searchingDuringRefresh = app.setQuery('24');
    (await ipc.request(2)).response.resolve(snapshot('24', { status: 'loading', stale: true }));
    await searchingDuringRefresh;
    expect(app.getSnapshot().selectedVersion).toBeNull();
    app.disconnect();
  });

  // 验证加载与获取失败不能伪装成失配，IPC 拒绝必须成为展示错误而非未处理异常。
  /** 验证加载和错误保留草稿，IPC失败提供原因。 */
  it('加载和错误保留草稿，IPC失败提供原因', async () => {
    const ipc = controlledIpc();
    const app = createCatalogApplication(ipc.adapter);
    const connecting = app.connect();
    (await ipc.request(0)).response.resolve(snapshot());
    await connecting;
    await app.select('v24.10.0');
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
    (await ipc.request(4)).response.reject(new Error('恢复读取失败'));
    await transportFailure;
    expect(app.getSnapshot()).toMatchObject({ querying: false, selectedVersion: 'v24.10.0', error: 'IPC 连接中断' });
    app.disconnect();
  });

  // 验证旧查询慢响应不能覆盖后发查询，且不能据旧结果误清除最新的草稿。
  /** 验证只接受最新查询的成功响应。 */
  it('只接受最新查询的成功响应', async () => {
    const ipc = controlledIpc();
    const app = createCatalogApplication(ipc.adapter);
    const connecting = app.connect();
    (await ipc.request(0)).response.resolve(snapshot());
    await connecting;
    await app.select('v24.10.0');
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
  /** 验证搜索期间禁选旧候选，成功失配清除草稿且不自动恢复。 */
  it('搜索期间禁选旧候选，成功失配清除草稿且不自动恢复', async () => {
    const ipc = controlledIpc();
    const app = createCatalogApplication(ipc.adapter);
    const connecting = app.connect();
    (await ipc.request(0)).response.resolve(snapshot());
    await connecting;
    await app.select('v24.10.0');
    const searching = app.setQuery('  V22.1  ');
    await app.select('v24.9.0');
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
  /** 验证单选替换且拒绝目录之外的发行版本。 */
  it('单选替换且拒绝目录之外的发行版本', async () => {
    const ipc = controlledIpc();
    const app = createCatalogApplication(ipc.adapter);
    const connecting = app.connect();
    (await ipc.request(0)).response.resolve(snapshot());
    await connecting;
    await app.select('v24.10.0');
    expect(app.getSnapshot().selectedVersion).toBe('v24.10.0');
    await app.select('v24.9.0');
    await app.select('v99.0.0');
    expect(app.getSnapshot().selectedVersion).toBe('v24.9.0');
    app.disconnect();
  });

  // 验证首次连接只展示 IPC 的权威顺序与元数据，不内置或重排候选。
  /** 验证连接后从权威快照展示发行版本和来源。 */
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
