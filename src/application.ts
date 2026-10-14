/** 职责：通过 IPC 获取权威候选并管理界面连接和未提交单选，不复制 Rust 查询逻辑。 */
import type { CatalogAdapter, CatalogSnapshot } from './catalog';

/** 界面展示快照；catalog 不代表本地镜像，selectedVersion 仅为本次会话草稿。 */
export interface ApplicationSnapshot {
  connected: boolean;
  query: string;
  querying: boolean;
  catalog: CatalogSnapshot | null;
  selectedVersion: string | null;
  feedback: string;
  error: string | null;
}

/** 前端应用的公开 Interface：IPC 错误反馈到快照；订阅者须自行处理异常，否则同步抛出或使操作承诺拒绝。 */
export interface CatalogApplication {
  /** 连接 IPC 并获取初始快照，返回完成承诺；IPC 异常转为展示错误，订阅者异常可能使承诺拒绝。 */
  connect(): Promise<void>;
  /** 断开连接并释放通知监听；无返回值，监听清理或展示订阅者异常向调用方传递。 */
  disconnect(): void;
  /** 请求手动刷新并读取进度，返回命令完成承诺；IPC 异常转为展示错误，订阅者异常可能使承诺拒绝。 */
  refresh(): Promise<void>;
  /** 保留原始 query 并读取权威结果；返回查询完成承诺，IPC 异常转为展示错误，订阅者异常可能使承诺拒绝。 */
  setQuery(query: string): Promise<void>;
  /** 将当前候选 version 设为唯一草稿；无效候选被忽略，无返回值，展示订阅者异常向调用方传递。 */
  select(version: string): void;
  /** 返回当前稳定展示快照；无参数，不抛出异常。 */
  getSnapshot(): ApplicationSnapshot;
  /** 订阅展示变化；listener 读取新快照，返回取消订阅入口，不抛出异常。 */
  subscribe(listener: () => void): () => void;
}

/** 创建独立前端会话；adapter 为外部 IPC，返回公开操作入口，不抛出异常。 */
export function createCatalogApplication(adapter: CatalogAdapter): CatalogApplication {
  let state: ApplicationSnapshot = {
    connected: false, query: '', querying: false, catalog: null, selectedVersion: null, feedback: '', error: null,
  };
  const subscribers = new Set<() => void>();
  let unlisten: (() => void) | undefined;
  let querySequence = 0;
  let highestRevision = 0;
  let connectionEpoch = 0;
  let initialized = false;

  /** 发布 next 展示快照并通知订阅者；无返回值，订阅者异常向调用方传递。 */
  function update(next: ApplicationSnapshot) {
    state = next;
    for (const subscriber of subscribers) subscriber();
  }

  /** 读取当前原始查询；只接受本轮序号响应，返回完成承诺，IPC 失败转为展示错误。 */
  async function readCatalog() {
    const sequence = ++querySequence;
    const epoch = connectionEpoch;
    const query = state.query;
    update({ ...state, querying: true, error: null });
    try {
      let catalog: CatalogSnapshot;
      while (true) {
        catalog = await adapter.snapshot(query);
        // 较慢的旧查询不能覆盖新输入，也不能误清除新输入下的草稿。
        if (sequence !== querySequence || epoch !== connectionEpoch || !state.connected) return;
        // 通知只提供下界；过期快照必须补读，否则会永远停留在漏通知的旧目录。
        if (catalog.revision < highestRevision || catalog.query !== query) continue;
        highestRevision = catalog.revision;
        break;
      }
      // 刷新失败不撤销已校验目录；是否失配取决于完成查询的实体，而非刷新状态。
      const mismatch = catalog.hasCatalog && state.selectedVersion
        && !catalog.releases.some((release) => release.version === state.selectedVersion);
      update({
        ...state, catalog, querying: false, error: null,
        selectedVersion: mismatch ? null : state.selectedVersion,
        feedback: mismatch ? '当前发行版本不再符合搜索，已清除单选；不会自动改选。' : state.feedback,
      });
    } catch (error) {
      if (sequence === querySequence && epoch === connectionEpoch && state.connected) {
        update({ ...state, querying: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return {
    async connect() {
      if (state.connected) return;
      const epoch = ++connectionEpoch;
      // Rust revision 不持久化；新连接不能与上一实例的数字比较。
      highestRevision = 0;
      initialized = false;
      update({ ...state, connected: true, querying: true, error: null });
      try {
        const stop = await adapter.listen((revision) => {
          if (epoch !== connectionEpoch || !state.connected || revision <= highestRevision) return;
          highestRevision = revision;
          if (!state.querying) void readCatalog();
        });
        if (epoch !== connectionEpoch || !state.connected) { stop(); return; }
        unlisten = stop;
        await adapter.open();
        if (epoch !== connectionEpoch || !state.connected) return;
        initialized = true;
        await readCatalog();
      } catch (error) {
        if (epoch !== connectionEpoch) return;
        unlisten?.();
        unlisten = undefined;
        update({ ...state, connected: false, querying: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
    disconnect() {
      ++connectionEpoch;
      ++querySequence;
      initialized = false;
      unlisten?.();
      unlisten = undefined;
      update({ ...state, connected: false, querying: false });
    },
    async refresh() {
      const epoch = connectionEpoch;
      if (!state.connected || !initialized) return;
      update({ ...state, feedback: '已发起手动刷新；结果以目录状态与成功校验时间为准。', error: null });
      try {
        await adapter.refresh();
        if (epoch !== connectionEpoch || !state.connected) return;
        await readCatalog();
      } catch (error) {
        if (epoch !== connectionEpoch || !state.connected) return;
        update({ ...state, error: error instanceof Error ? error.message : String(error) });
      }
    },
    async setQuery(query) {
      // 输入可在初始化期间变化，但必须等订阅和打开完成才向 Rust 发查询。
      update({ ...state, query, querying: state.connected, error: state.connected ? null : state.error });
      if (state.connected && initialized) await readCatalog();
    },
    select(version) {
      if (state.connected && !state.querying && state.catalog?.hasCatalog
          && state.catalog.query === state.query
          && state.catalog.releases.some((release) => release.version === version)) {
        update({ ...state, selectedVersion: version, feedback: '' });
      }
    },
    getSnapshot: () => state,
    subscribe(listener) {
      subscribers.add(listener);
      return () => { subscribers.delete(listener); };
    },
  };
}
