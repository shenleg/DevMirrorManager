/** 职责：声明 Rust 权威目录快照与 Tauri IPC Adapter，不在前端解析、筛选或排序目录。 */
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/** Rust 校验后的完整发行版本；展示信息缺失时保持未知。 */
export interface Release {
  version: string;
  date: string | null;
  /** 历史 LTS 名称；false 为已知无标记，null 为未知，不代表当前支持状态。 */
  lts: string | false | null;
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
}

/** 外部 IPC Adapter；每个操作只表达一个目录能力，不包含前端草稿。 */
export interface CatalogAdapter {
  /** 初始化目录，返回快速完成的承诺；IPC 失败时拒绝。 */
  open(): Promise<void>;
  /** 用原始 query 读取权威结果，返回快照；IPC 失败时拒绝。 */
  snapshot(query: string): Promise<CatalogSnapshot>;
  /** 启动手动刷新，返回快速完成的承诺；IPC 失败时拒绝。 */
  refresh(): Promise<void>;
  /** 订阅 revision 通知，listener 接收目录变更；返回取消订阅入口，IPC 失败时拒绝。 */
  listen(listener: (revision: number) => void): Promise<() => void>;
}

/** 确认当前为真实桌面环境；无返回值，浏览器预览时抛出明确错误，禁止假目录回退。 */
function requireDesktop() {
  if (!isTauri()) throw new Error('请在 Tauri 桌面应用中打开；浏览器预览无法访问官方目录。');
}

/** 创建真实 Tauri IPC Adapter；无参数，返回目录命令与通知入口，调用时 IPC 失败会拒绝。 */
export function createTauriCatalogAdapter(): CatalogAdapter {
  return {
    async open() {
      requireDesktop();
      await invoke<void>('open_catalog');
    },
    async snapshot(query) {
      requireDesktop();
      return invoke<CatalogSnapshot>('catalog_snapshot', { query });
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
