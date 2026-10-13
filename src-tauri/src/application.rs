//! 官方目录的应用命令、权威快照与通知；网络等待不持有查询状态锁。
use crate::{
    cache::{self, CachedCatalog},
    catalog::{self, Release},
    official_source::{CatalogResponse, CatalogSource},
};
use serde::Serialize;
use std::{path::PathBuf, sync::Arc};
use tokio::sync::{watch, Mutex};

/// 界面恢复展示所需的权威快照，query 保留原始输入，checkedAt 使用 Unix 毫秒。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSnapshot {
    pub revision: u64,
    pub query: String,
    pub normalized_query: String,
    pub status: String,
    pub releases: Vec<Release>,
    pub has_catalog: bool,
    pub checked_at: Option<u64>,
    pub stale: bool,
    pub error: Option<String>,
    pub warnings: Vec<String>,
    pub source: &'static str,
}

struct State {
    revision: u64,
    releases: Option<Vec<Release>>,
    checked_at: Option<u64>,
    error: Option<String>,
    warnings: Vec<String>,
    cached: Option<CachedCatalog>,
    opened: bool,
    loading: bool,
    cache_protection: Option<String>,
}

/// 集中持有目录事实；前端草稿不属于权威目录，查询没有全局查询副作用。
pub struct Application {
    source: Arc<dyn CatalogSource>,
    cache_dir: PathBuf,
    now: Arc<dyn Fn() -> u64 + Send + Sync>,
    state: Mutex<State>,
    notifications: watch::Sender<u64>,
}

impl Application {
    /// 创建应用；source 为官方 Adapter，cache_dir 为专用缓存位置，now 返回 Unix 毫秒；返回空应用，不访问网络、不抛异常。
    pub fn new(
        source: Arc<dyn CatalogSource>,
        cache_dir: PathBuf,
        now: Arc<dyn Fn() -> u64 + Send + Sync>,
    ) -> Self {
        Self {
            source,
            cache_dir,
            now,
            state: Mutex::new(State {
                revision: 0,
                releases: None,
                checked_at: None,
                error: None,
                warnings: vec![],
                cached: None,
                opened: false,
                loading: false,
                cache_protection: None,
            }),
            notifications: watch::channel(0).0,
        }
    }

    /// 订阅目录 revision；无参数，返回轻量通知接收端，不抛异常。通知可以合并，调用者必须通过快照取得事实。
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.notifications.subscribe()
    }

    fn publish(&self, state: &mut State) {
        // 同一锁内发布 revision 与事实，避免通知指向尚未提交的快照。
        state.revision += 1;
        self.notifications.send_replace(state.revision);
    }

    async fn load_cache(&self) -> Option<bool> {
        let mut state = self.state.lock().await;
        if state.opened {
            return None;
        }
        state.opened = true;
        let mut fresh = false;
        match cache::read(&self.cache_dir) {
            Ok(Some(cached)) => {
                let validated = if cached.format_version != 1 || cached.checked_at > (self.now)() {
                    Err("目录缓存格式不兼容或时间异常".into())
                } else {
                    catalog::parse(cached.body.as_bytes())
                };
                match validated {
                    Ok((releases, warnings)) => {
                        state.releases = Some(releases);
                        state.warnings = warnings;
                        state.checked_at = Some(cached.checked_at);
                        state.cached = Some(cached.clone());
                        fresh = (self.now)().saturating_sub(cached.checked_at) < cache::MAX_AGE_MS;
                    }
                    Err(reason) => {
                        state.cache_protection = Some(format!(
                            "目录缓存无效，原文件保留，本次仅使用内存目录：{reason}"
                        ));
                    }
                }
            }
            Ok(None) => {}
            Err(reason) => {
                state.cache_protection = Some(reason);
            }
        }
        self.publish(&mut state);
        Some(fresh)
    }

    /// 打开目录；无参数，首次打开复用一小时内缓存或获取官方目录；重复打开不自动重试，错误保存在快照。
    pub async fn open(&self) {
        if self.load_cache().await == Some(false) {
            self.refresh().await;
        }
    }

    /// 主动条件刷新；无参数，重复刷新复用进行中的操作，无返回值，网络/解析错误保存在快照，合法旧目录保留。
    pub async fn refresh(&self) {
        // 主动刷新也先检查磁盘，不能绕过损坏状态保护或丢失可用的 ETag。
        self.load_cache().await;
        let cached_entity = {
            let mut state = self.state.lock().await;
            if state.loading {
                return;
            }
            state.loading = true;
            state.error = None;
            self.publish(&mut state);
            state.cached.clone()
        };
        let result = match self
            .source
            .fetch(
                cached_entity
                    .as_ref()
                    .and_then(|cached| cached.etag.as_deref()),
            )
            .await
        {
            Ok(CatalogResponse::Modified { body, etag }) => {
                catalog::parse(&body).map(|(releases, warnings)| {
                    let cached = CachedCatalog {
                        format_version: 1,
                        body: String::from_utf8_lossy(&body).into_owned(),
                        etag,
                        checked_at: (self.now)(),
                    };
                    (releases, warnings, cached)
                })
            }
            Ok(CatalogResponse::NotModified) => match cached_entity {
                Some(mut cached) if cached.etag.is_some() => {
                    cached.checked_at = (self.now)();
                    catalog::parse(cached.body.as_bytes())
                        .map(|(releases, warnings)| (releases, warnings, cached))
                }
                _ => Err("没有配套 ETag 的有效缓存，不能接受 304 条件响应".into()),
            },
            Err(reason) => Err(format!("官方版本目录获取失败：{reason}")),
        };
        let mut state = self.state.lock().await;
        state.loading = false;
        match result {
            Ok((releases, mut warnings, cached)) => {
                if state.cache_protection.is_none() {
                    if let Err(reason) = cache::write(&self.cache_dir, &cached) {
                        warnings.push(reason);
                    }
                }
                state.releases = Some(releases);
                state.warnings = warnings;
                state.checked_at = Some(cached.checked_at);
                state.cached = Some(cached);
                state.error = None;
            }
            Err(reason) => {
                state.error = Some(reason);
            }
        }
        self.publish(&mut state);
    }

    /// 查询权威快照；query 为原始搜索输入，返回独立的语义版本降序候选，不修改目录、不抛异常。
    pub async fn snapshot(&self, query: &str) -> CatalogSnapshot {
        let state = self.state.lock().await;
        let mut warnings = state.warnings.clone();
        if let Some(warning) = &state.cache_protection {
            warnings.push(warning.clone());
        }
        let trimmed = query.trim();
        let normalized = trimmed.strip_prefix(['v', 'V']).unwrap_or(trimmed);
        let releases = state
            .releases
            .as_ref()
            .map(|items| {
                items
                    .iter()
                    .filter(|release| release.version[1..].starts_with(normalized))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        let expired = state.checked_at.is_some_and(|time| {
            time > (self.now)() || (self.now)().saturating_sub(time) >= cache::MAX_AGE_MS
        });
        CatalogSnapshot {
            revision: state.revision,
            query: query.into(),
            normalized_query: normalized.into(),
            status: if state.loading {
                "loading"
            } else if state.error.is_some() {
                "error"
            } else if state.releases.is_some() {
                "ready"
            } else {
                "loading"
            }
            .into(),
            releases,
            has_catalog: state.releases.is_some(),
            checked_at: state.checked_at,
            stale: state.releases.is_some() && (state.loading || state.error.is_some() || expired),
            error: state.error.clone(),
            warnings,
            source: "https://nodejs.org/dist/index.json",
        }
    }
}
