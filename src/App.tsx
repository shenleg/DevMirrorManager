/** 职责：展示官方目录、独立目标草稿与 Rust 清单事实，通过公开 Interface 操作，不生成候选或文件。 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createCatalogApplication } from './application';
import { createTauriCatalogAdapter, type CatalogAdapter, type Target } from './catalog';

/** 渲染目录与目标预览；adapter 可注入外部 IPC，返回 React 页面，IPC 错误在页面展示，不主动抛出。 */
export function App({ adapter }: { adapter?: CatalogAdapter }) {
  const [application] = useState(() => createCatalogApplication(adapter ?? createTauriCatalogAdapter()));
  const state = useSyncExternalStore(application.subscribe, application.getSnapshot);
  useEffect(() => {
    void application.connect();
    return () => { application.disconnect(); };
  }, [application]);
  const catalog = state.catalog;
  // 草稿变化后暂时隐藏旧事实；不推导新目标文件或把传输等待伪装成 Rust 的 loading。
  const preview = catalog?.query === state.query
    && catalog.preview.selection.version === state.selectedVersion
    && catalog.preview.selection.target.os === state.target.os
    && catalog.preview.selection.target.arch === state.target.arch ? catalog.preview : null;
  const previewMessages = {
    unselected: '选择发行版本后查看必需文件。',
    idle: '清单尚未准备，文件存在性待确认。',
    loading: '正在获取并校验官方清单，文件存在性待确认。',
    error: '清单获取或解析失败，文件存在性待确认；请主动重试清单。',
    missing: '清单已确认必需文件缺失，此目标尚不齐备。',
    ready: '清单已证实必需文件齐备；尚未下载或校验归档，不代表本地镜像可用。',
  };
  const error = state.error ?? catalog?.error;
  const status = state.querying ? '正在加载查询结果，暂不能选择旧列表…'
    : error ? '目录获取或查询失败，请主动刷新重试。'
    : catalog?.status === 'loading' ? (catalog.hasCatalog ? '正在刷新官方目录，当前展示已验证的旧数据。' : '正在加载官方发行目录…')
    : catalog?.hasCatalog ? `目录就绪，${catalog.releases.length} 个发行版本。`
    : '正在加载官方发行目录…';

  return (
    <main>
      <header className="page-header">
        <p className="eyebrow">NODE.JS · 官方发行目录</p>
        <h1>浏览发行版本，选择一个草稿</h1>
        <p className="intro">从官方目录搜索 Node.js 发行版本。本页只浏览与单选，不下载或准备镜像。</p>
      </header>
      <div className="workspace">
        <section id="catalog-panel" className="panel" aria-labelledby="catalog-heading">
          <div className="panel-heading">
            <h2 id="catalog-heading">搜索并选择发行版本</h2>
            <button type="button" onClick={() => { void (state.connected ? application.refresh() : application.connect()); }}
              disabled={state.querying || (catalog?.status === 'loading' && !state.error)}>刷新目录</button>
          </div>
          <label className="field" htmlFor="release-query">搜索发行版本</label>
          <input id="release-query" type="search" value={state.query}
            onChange={(event) => { void application.setQuery(event.target.value); }}
            placeholder="例如：22、v24 或 24.10" />
          <p className="muted" id="search-rules">忽略首尾空格与可选的 v / V 前缀，按版本号文本前缀匹配；22.1 也匹配 22.10。结果按语义版本从高到低排列。</p>
          <div id="catalog-status" className="message" role="status" aria-live="polite">
            {status}
          </div>
          {error && <p className="message error" role="alert">{error}</p>}
          {catalog?.stale && <p className="message warning">当前展示旧数据，未确认最新目录；可主动刷新重试。</p>}
          {catalog && catalog.warnings.length > 0 && <ul className="warnings" aria-label="目录告警">
            {catalog.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}
          </ul>}
          {!state.querying && catalog?.hasCatalog && catalog.query === state.query && catalog.releases.length === 0
            && <p className="empty">没有匹配的发行版本</p>}
          <p className="feedback" aria-live="polite">{state.feedback}</p>
          <fieldset className="release-fieldset" disabled={state.querying || !state.connected || !catalog?.hasCatalog || catalog.query !== state.query}>
            <legend className="sr-only">单选一个发行版本</legend>
            <div className="release-list">
              {catalog?.releases.map((release) => (
                <label key={release.version} className={`release${state.selectedVersion === release.version ? ' selected' : ''}`}>
                  <input type="radio" name="release" aria-label={release.version}
                    value={release.version} checked={state.selectedVersion === release.version}
                    onChange={() => { void application.select(release.version); }} />
                  <span><strong>{release.version}</strong><small>发布日期：{release.date ?? '未知'} · LTS 标记：{release.lts === false ? '无' : release.lts ?? '未知'}</small></span>
                </label>
              ))}
            </div>
          </fieldset>
        </section>
        <aside className="panel" aria-labelledby="selection-heading">
          <h2 id="selection-heading">当前单选草稿</h2>
          <p className="selection-summary">{state.selectedVersion ? `当前选择：${state.selectedVersion}` : '尚未选择发行版本'}</p>
          <p className="muted">搜索使已选发行版本失配时会清除单选，保留目标，不自动改选或恢复。</p>
          <section id="preview-panel" aria-labelledby="preview-heading" data-preview-status={preview?.status ?? (state.selectedVersion ? undefined : 'unselected')}>
            <h2 id="preview-heading">目标平台与必需文件预览</h2>
            <div className="target-fields">
              <div>
                <label className="field" htmlFor="target-os">目标系统</label>
                <select id="target-os" value={state.target.os} onChange={(event) => {
                  void application.setTarget({ ...state.target, os: event.target.value as Target['os'] });
                }}>
                  <option value="macos">macOS</option><option value="windows">Windows</option><option value="linux">Linux</option>
                </select>
              </div>
              <div>
                <label className="field" htmlFor="target-arch">目标架构</label>
                <select id="target-arch" value={state.target.arch} onChange={(event) => {
                  void application.setTarget({ ...state.target, arch: event.target.value as Target['arch'] });
                }}>
                  <option value="x64">x64</option><option value="arm64">ARM64</option>
                </select>
              </div>
            </div>
            <p className="muted">目标平台与本机无关，所有系统与架构始终可浏览。</p>
            <div id="preview-status" className="message" role="status" aria-live="polite">
              {preview ? previewMessages[preview.status] : state.selectedVersion
                ? '正在读取当前选择的权威预览，文件存在性待确认。' : previewMessages.unselected}
            </div>
            {(state.previewError ?? preview?.error) && <p className="message error" role="alert">{state.previewError ?? preview?.error}</p>}
            {(preview?.status === 'idle' || preview?.status === 'error' || state.previewError) && <button type="button" disabled={!state.connected || state.querying}
              onClick={() => { void application.retryPreview(); }}>{preview?.status === 'idle' && !state.previewError ? '准备清单' : '重试清单'}</button>}
            {preview && preview.required.length > 0 && <ul className="artifact-list" aria-label="必需分发文件">
              {preview.required.map((artifact) => <li key={artifact.path} data-artifact-path={artifact.path}
                data-present={artifact.present === null ? 'unknown' : artifact.present ? 'present' : 'missing'}
                data-sha256={artifact.sha256 ?? undefined}>
                <code>{artifact.path}</code>
                <span>{artifact.present === null ? '存在性待确认' : artifact.present ? '清单证实存在' : '清单证实缺失'}</span>
                {artifact.sha256 && <small>SHA-256：<code>{artifact.sha256}</code></small>}
              </li>)}
            </ul>}
            <h3>清单来源</h3>
            <p className="manifest-source">{preview?.source ?? ''}</p>
            {!preview?.source && <p className="muted">尚无清单来源</p>}
            <p className="muted">仅预览，下载尚未接入。</p>
          </section>
          <h2>目录来源</h2>
          <p className="source">{catalog?.source ?? '等待官方目录来源信息'}</p>
          <dl className="metadata">
            <dt>上次成功校验</dt>
            <dd>{catalog?.checkedAt != null ? new Date(catalog.checkedAt).toLocaleString('zh-CN') : '尚未成功校验'}</dd>
          </dl>
          <p className="muted">目录候选和当前选择均不代表文件已下载、通过校验或已在本地镜像可用。LTS 标记不代表当前仍受支持。</p>
        </aside>
      </div>
    </main>
  );
}
