/** 职责：展示官方目录和本次会话单选草稿，通过应用公开 Interface 操作，不生成候选。 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createCatalogApplication } from './application';
import { createTauriCatalogAdapter, type CatalogAdapter } from './catalog';

/** 渲染目录界面；adapter 可注入外部 IPC，返回 React 页面，IPC 错误在页面展示，不主动抛出。 */
export function App({ adapter }: { adapter?: CatalogAdapter }) {
  const [application] = useState(() => createCatalogApplication(adapter ?? createTauriCatalogAdapter()));
  const state = useSyncExternalStore(application.subscribe, application.getSnapshot);
  useEffect(() => {
    void application.connect();
    return () => { application.disconnect(); };
  }, [application]);
  const catalog = state.catalog;
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
        <section className="panel" aria-labelledby="catalog-heading">
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
          <div className="message" role="status" aria-live="polite">
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
                    onChange={() => { application.select(release.version); }} />
                  <span><strong>{release.version}</strong><small>发布日期：{release.date ?? '未知'} · LTS 标记：{release.lts === false ? '无' : release.lts ?? '未知'}</small></span>
                </label>
              ))}
            </div>
          </fieldset>
        </section>
        <aside className="panel" aria-labelledby="selection-heading">
          <h2 id="selection-heading">当前单选草稿</h2>
          <p className="selection-summary">{state.selectedVersion ? `当前选择：${state.selectedVersion}` : '尚未选择发行版本'}</p>
          <p className="muted">搜索使已选发行版本失配时会清除单选，不自动改选或恢复。</p>
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
