/** 职责：将正式目录页面挂载到桌面 WebView，并启用连接清理检查与响应式样式。 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('应用入口缺少 root 挂载节点。');
createRoot(container).render(<StrictMode><App /></StrictMode>);
