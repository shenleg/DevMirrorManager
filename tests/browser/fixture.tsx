/** 职责：在隔离测试页挂载真实 App；仅替换外部 CatalogAdapter，权威快照由浏览器测试路由提供。 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../src/App';
import type { CatalogAdapter, CatalogSnapshot } from '../../src/catalog';
import '../../src/styles.css';

// 此页面不读取官方网络、模拟 Tauri 全局或复制 Rust 筛选逻辑；没有测试路由时不会提供内置假目录。
const adapter: CatalogAdapter = {
  /** 打开受控目录边界；无参数，返回已完成承诺，不访问官方网络或抛出异常。 */
  async open() {},
  /** 读取外部测试快照；query 和 selection 原样传给边界，返回权威样本，网络、HTTP 或 JSON 失败时拒绝。 */
  async snapshot(query, selection): Promise<CatalogSnapshot> {
    const params = new URLSearchParams({ query, selection: JSON.stringify(selection) });
    const response = await fetch(`/tests/browser/ipc/snapshot?${params}`);
    // fetch 的非 2xx 不自动拒绝；需将传输失败交给 App 的正式错误恢复路径，而非当成目录样本。
    if (!response.ok) throw new Error(`测试目录 IPC 读取失败：HTTP ${response.status}`);
    return response.json();
  },
  /** 将 selection 和主动 retry 原样传给外部路由；返回完成承诺，网络或 HTTP 失败时拒绝。 */
  async preparePreview(selection, retry) {
    const response = await fetch('/tests/browser/ipc/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selection, retry }),
    });
    if (!response.ok) throw new Error(`测试清单 IPC 准备失败：HTTP ${response.status}`);
  },
  /** 确认手动刷新入口；无参数，返回已完成承诺，后续快照由测试响应控制，不抛出异常。 */
  async refresh() {},
  /** 提供无通知的外部订阅；返回取消订阅入口，不抛出异常，本套 DOM 测试只经查询/刷新读取快照。 */
  async listen() { return () => {}; },
};

const container = document.getElementById('root');
if (!container) throw new Error('浏览器测试入口缺少 root 挂载节点。');
createRoot(container).render(<StrictMode><App adapter={adapter} /></StrictMode>);
