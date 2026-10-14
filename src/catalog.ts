/** 职责：声明 Rust 目录/清单快照与 Tauri IPC Adapter，不在前端解析、筛选目录或推导文件事实。 */
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/** Rust 校验后的完整发行版本；展示信息缺失时保持未知。 */
export interface Release {
  version: string;
  date: string | null;
  /** 历史 LTS 名称；false 为已知无标记，null 为未知，不代表当前支持状态。 */
  lts: string | false | null;
}

/** 与宿主无关的目标平台草稿；系统与架构独立选择。 */
export interface Target {
  os: 'macos' | 'windows' | 'linux';
  arch: 'x64' | 'arm64';
}

/** 未提交选择；空发行版本仍保留用户正在浏览的目标。 */
export interface Selection {
  version: string | null;
  target: Target;
}

/** Rust 返回的清单事实；path 为发行目录相对路径，未知存在性和 hash 保持 null。 */
export interface Preview {
  selection: Selection;
  status: 'unselected' | 'idle' | 'loading' | 'error' | 'missing' | 'ready';
  source: string | null;
  required: Array<{ path: string; present: boolean | null; sha256: string | null }>;
  error: string | null;
}

/** Rust 返回的权威查询结果；query 为原始输入，checkedAt 为 Unix 毫秒。 */
export interface CatalogSnapshot {
  revision: number;
  query: string;
  normalizedQuery: string;
  status: 'loading' | 'ready' | 'error';
  releases: Release[];
  hasCatalog: boolean;
  checkedAt: number | null;
  stale: boolean;
  error: string | null;
  warnings: string[];
  source: string;
  preview: Preview;
}

/** 外部 IPC Adapter；Rust 读取草稿并返回事实，不持有前端的全局选择。 */
export interface CatalogAdapter {
  /** 初始化目录，返回快速完成的承诺；IPC 失败时拒绝。 */
  open(): Promise<void>;
  /** 用原始 query 和未提交 selection 读取权威结果，返回快照；不触发获取，IPC 失败时拒绝。 */
  snapshot(query: string, selection: Selection): Promise<CatalogSnapshot>;
  /** 快速调度 selection 的清单准备；retry 表示用户主动重试，返回命令完成承诺，IPC 失败时拒绝。 */
  preparePreview(selection: Selection, retry: boolean): Promise<void>;
  /** 启动手动刷新，返回快速完成的承诺；IPC 失败时拒绝。 */
  refresh(): Promise<void>;
  /** 订阅 revision 通知，listener 接收目录或清单变更；返回取消订阅入口，IPC 失败时拒绝。 */
  listen(listener: (revision: number) => void): Promise<() => void>;
}

/** 确认当前为真实桌面环境；无返回值，浏览器预览时抛出明确错误，禁止假目录回退。 */
function requireDesktop() {
  if (!isTauri()) throw new Error('请在 Tauri 桌面应用中打开；浏览器预览无法访问官方目录。');
}

/** 创建真实 Tauri IPC Adapter；无参数，返回目录/清单命令与统一通知入口，调用时 IPC 失败会拒绝。 */
export function createTauriCatalogAdapter(): CatalogAdapter {
  return {
    async open() {
      requireDesktop();
      await invoke<void>('open_catalog');
    },
    async snapshot(query, selection) {
      requireDesktop();
      return invoke<CatalogSnapshot>('catalog_snapshot', { query, selection });
    },
    async preparePreview(selection, retry) {
      requireDesktop();
      await invoke<void>('prepare_preview', { selection, retry });
    },
    async refresh() {
      requireDesktop();
      await invoke<void>('refresh_catalog');
    },
    async listen(listener) {
      requireDesktop();
      return listen<{ revision: number }>('catalog-changed', (event) => listener(event.payload.revision));
    },
  };
}
