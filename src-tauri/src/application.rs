//! 官方目录与清单的应用命令、权威快照和统一通知；网络及清单解析不持有查询状态锁。
use crate::{
    cache::{self, CachedCatalog},
    catalog::{self, Release},
    manifest::{self, ManifestState, Preview, ReleaseVersion, Selection},
    official_source::{CatalogResponse, CatalogSource, ManifestSource},
};
use serde::Serialize;
use std::{collections::HashMap, path::PathBuf, sync::Arc};
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
    pub preview: Preview,
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
    manifests: HashMap<String, ManifestState>,
}

/// 集中持有目录与清单事实；前端草稿不属于权威状态，查询没有全局选择副作用。
pub struct Application {
    source: Arc<dyn CatalogSource>,
    manifest_source: Option<Arc<dyn ManifestSource>>,
    cache_dir: PathBuf,
    now: Arc<dyn Fn() -> u64 + Send + Sync>,
    state: Mutex<State>,
    notifications: watch::Sender<u64>,
}

impl Application {
    /// 创建仅目录应用；source 为官方目录 Adapter，cache_dir 为专用缓存位置，now 返回 Unix 毫秒；返回空应用，不联网、不抛异常，清单命令会报告未配置来源。
    pub fn new(
        source: Arc<dyn CatalogSource>,
        cache_dir: PathBuf,
        now: Arc<dyn Fn() -> u64 + Send + Sync>,
    ) -> Self {
        Self::build(source, None, cache_dir, now)
    }

    /// 创建完整预览应用；source/manifest_source 为外部目录/清单来源，cache_dir 仅缓存目录，now 返回 Unix 毫秒；返回空应用，不联网、不抛异常。
    pub fn new_with_manifest_source(
        source: Arc<dyn CatalogSource>,
        manifest_source: Arc<dyn ManifestSource>,
        cache_dir: PathBuf,
        now: Arc<dyn Fn() -> u64 + Send + Sync>,
    ) -> Self {
        Self::build(source, Some(manifest_source), cache_dir, now)
    }

    fn build(
        source: Arc<dyn CatalogSource>,
        manifest_source: Option<Arc<dyn ManifestSource>>,
        cache_dir: PathBuf,
        now: Arc<dyn Fn() -> u64 + Send + Sync>,
    ) -> Self {
        Self {
            source,
            manifest_source,
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
                manifests: HashMap::new(),
            }),
            notifications: watch::channel(0).0,
        }
    }

    /// 订阅目录与清单共用的 revision；无参数，返回轻量通知接收端，不抛异常。通知可以合并，调用者必须通过快照取得事实。
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
        // 空选择不会校验失败；旧目录入口与目标预览共用同一权威快照。
        self.snapshot_with_selection(query, Selection::default())
            .await
            .expect("默认空选择始终有效")
    }

    fn validate_selection(
        state: &State,
        selection: &Selection,
    ) -> Result<Option<ReleaseVersion>, String> {
        let Some(version) = &selection.version else {
            return Ok(None);
        };
        let validated = ReleaseVersion::validated(version)?;
        if !state
            .releases
            .as_ref()
            .is_some_and(|releases| releases.iter().any(|release| release.version == *version))
        {
            return Err("所选发行版本不属于已校验官方目录".into());
        }
        Ok(Some(validated))
    }

    /// 查询包含目标预览的完整快照；query 为原始搜索，selection 为草稿；返回同一 revision 下的目录与预览，非法或目录外版本返回原因，不联网。
    pub async fn snapshot_with_selection(
        &self,
        query: &str,
        selection: Selection,
    ) -> Result<CatalogSnapshot, String> {
        let state = self.state.lock().await;
        Self::validate_selection(&state, &selection)?;
        let preview = manifest::preview(
            selection.clone(),
            selection
                .version
                .as_ref()
                .and_then(|version| state.manifests.get(version)),
        );
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
        Ok(CatalogSnapshot {
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
            preview,
        })
    }

    /// 准备清单；selection 为草稿，retry 仅表示用户主动重试失败；返回前完成输入校验与调度，非法/未选版本或未配置来源返回原因，联网/解析错误由快照报告。
    pub async fn prepare_preview(
        self: &Arc<Self>,
        selection: Selection,
        retry: bool,
    ) -> Result<(), String> {
        let mut state = self.state.lock().await;
        let version = Self::validate_selection(&state, &selection)?.ok_or("请先选择发行版本")?;
        let source = self.manifest_source.clone().ok_or("未配置官方清单来源")?;
        match state.manifests.get(version.as_str()) {
            Some(ManifestState::Loading | ManifestState::Ready(_)) => return Ok(()),
            Some(ManifestState::Error(_)) if !retry => return Ok(()),
            _ => {}
        }
        state
            .manifests
            .insert(version.as_str().into(), ManifestState::Loading);
        self.publish(&mut state);
        let application = self.clone();
        tokio::spawn(async move {
            // 外部等待与解析都在锁外，查询其他发行版本不会被网络阻塞。
            let result = source.fetch(&version).await.and_then(manifest::parse);
            let mut state = application.state.lock().await;
            state.manifests.insert(
                version.as_str().into(),
                match result {
                    Ok(manifest) => ManifestState::Ready(manifest),
                    Err(reason) => ManifestState::Error(format!("官方清单准备失败：{reason}")),
                },
            );
            application.publish(&mut state);
        });
        Ok(())
    }

    /// 读取已成功解析清单的原始字节；version 必须规范且属于目录，返回共享只读字节或尚未成功的 None；非法/目录外版本返回原因，不联网。
    pub async fn raw_manifest(&self, version: &str) -> Result<Option<Arc<[u8]>>, String> {
        let state = self.state.lock().await;
        let selection = Selection {
            version: Some(version.into()),
            ..Selection::default()
        };
        Self::validate_selection(&state, &selection)?;
        Ok(match state.manifests.get(version) {
            Some(ManifestState::Ready(manifest)) => Some(manifest.raw.clone()),
            _ => None,
        })
    }
}
