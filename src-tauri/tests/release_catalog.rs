//! 通过应用的公开命令和快照验证官方目录，不绑定内部函数或线程顺序。
use async_trait::async_trait;
use nodejs_downloader::{
    application::Application,
    official_source::{CatalogResponse, CatalogSource},
};
use std::sync::Arc;

type ExpectedResponse = (Option<String>, Result<CatalogResponse, String>);

/// 受控网络 Adapter；按协议夹具返回结果，条件标记不匹配时报告网络错误。
struct ScriptedSource(std::sync::Mutex<std::collections::VecDeque<ExpectedResponse>>);

impl ScriptedSource {
    /// 创建一次 200 响应；body 为独立夹具，返回 Adapter，无异常。
    fn modified(body: &str) -> Arc<Self> {
        Arc::new(Self(std::sync::Mutex::new(
            std::collections::VecDeque::from([(
                None,
                Ok(CatalogResponse::Modified {
                    body: body.as_bytes().to_vec(),
                    etag: Some("\"catalog-a\"".into()),
                }),
            )]),
        )))
    }
}

#[async_trait]
impl CatalogSource for ScriptedSource {
    /// 验证条件请求与夹具契约；etag 为实体标记，返回受控响应或原因，不执行公网访问。
    async fn fetch(&self, etag: Option<&str>) -> Result<CatalogResponse, String> {
        let (expected, response) = self
            .0
            .lock()
            .unwrap()
            .pop_front()
            .ok_or("没有配置该请求的响应")?;
        if expected.as_deref() != etag {
            return Err(format!(
                "条件请求标记错误：预期 {expected:?}，得到 {etag:?}"
            ));
        }
        response
    }
}

struct FixedSource;

#[async_trait]
impl CatalogSource for FixedSource {
    /// 返回固定官方响应；etag 为条件标记，返回夹具，不产生网络异常。
    async fn fetch(&self, _etag: Option<&str>) -> Result<CatalogResponse, String> {
        Ok(CatalogResponse::Modified {
            body: br#"[{"version":"v24.9.0","date":"2026-01-01"},{"version":"v24.10.0","date":"2025-01-01"}]"#.to_vec(),
            etag: Some("\"catalog-a\"".into()),
        })
    }
}

#[tokio::test]
/// 官方明确的无LTS标记与未知信息不同，快照应保留false，不宣称当前支持。
async fn known_absent_lts_marker_is_not_unknown() {
    let directory = tempfile::tempdir().unwrap();
    let app = Application::new(
        ScriptedSource::modified(r#"[{"version":"v26.1.0","date":"2026-01-01","lts":false}]"#),
        directory.path().into(),
        Arc::new(|| 10000),
    );
    app.refresh().await;
    let snapshot = serde_json::to_value(app.snapshot("").await).unwrap();
    assert_eq!(snapshot["releases"][0]["lts"], serde_json::json!(false));
}

#[tokio::test]
/// 空查询可浏览官方候选，数值排序不受字典顺序或发布日期影响。
async fn empty_query_browses_validated_releases_in_semver_order() {
    let directory = tempfile::tempdir().unwrap();
    let app = Application::new(
        Arc::new(FixedSource),
        directory.path().to_path_buf(),
        Arc::new(|| 10000),
    );
    app.refresh().await;
    let snapshot = app.snapshot("").await;
    assert_eq!(snapshot.status, "ready");
    assert_eq!(
        snapshot
            .releases
            .iter()
            .map(|r| r.version.as_str())
            .collect::<Vec<_>>(),
        ["v24.10.0", "v24.9.0"]
    );
}

#[tokio::test]
/// 前缀而非范围搜索：首尾空白和大小写前导标记不能改变匹配语义。
async fn prefix_queries_are_normalized_and_do_not_mutate_other_queries() {
    let directory = tempfile::tempdir().unwrap();
    let app = Application::new(
        ScriptedSource::modified(
            r#"[{"version":"v22.10.0"},{"version":"v22.1.0"},{"version":"v24.1.0"}]"#,
        ),
        directory.path().into(),
        Arc::new(|| 10000),
    );
    app.refresh().await;
    for query in ["22.1", "  v22.1  ", "  V22.1  "] {
        let snapshot = app.snapshot(query).await;
        assert_eq!(snapshot.normalized_query, "22.1");
        assert_eq!(
            snapshot
                .releases
                .iter()
                .map(|r| r.version.as_str())
                .collect::<Vec<_>>(),
            ["v22.10.0", "v22.1.0"]
        );
    }
    assert_eq!(app.snapshot("").await.releases.len(), 3);
    let empty = app.snapshot("99.").await;
    assert_eq!(empty.status, "ready");
    assert!(empty.has_catalog && empty.releases.is_empty() && empty.error.is_none());
}

#[tokio::test]
/// 必需标识损坏必须报目录错误，不能变成“无匹配”或接受可构造路径的非正式发行标识。
async fn invalid_required_metadata_is_an_error_not_empty_results() {
    for body in [
        r#"[{"version":"v22.1.0"},{"version":"v22.1.0"}]"#,
        r#"[{"version":"v22.1.0-beta.1"}]"#,
        r#"[{"version":"v22.1.0+build"}]"#,
        r#"[{"version":"../../x"}]"#,
        r#"[{"date":"2026-01-01"}]"#,
        r#"{}"#,
        "invalid json",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let app = Application::new(
            ScriptedSource::modified(body),
            directory.path().into(),
            Arc::new(|| 10000),
        );
        app.refresh().await;
        let snapshot = app.snapshot("").await;
        assert_eq!(snapshot.status, "error", "{body}");
        assert!(!snapshot.has_catalog && snapshot.error.is_some());
    }
}

#[tokio::test]
/// 缺失可选信息不抹掉可识别发行版本，异常日期及 LTS 值标未知而非猜测。
async fn optional_metadata_is_validated_without_erasing_release_identity() {
    let directory = tempfile::tempdir().unwrap();
    let app = Application::new(
        ScriptedSource::modified(
            r#"[{"version":"v22.10.0","date":"2026-02-30","lts":" "},{"version":"v22.1.0","lts":true},{"version":"v24.1.0"}]"#,
        ),
        directory.path().into(),
        Arc::new(|| 10000),
    );
    app.refresh().await;
    let snapshot = app.snapshot("22.").await;
    assert_eq!(snapshot.status, "ready");
    assert_eq!(snapshot.releases[0].date, None);
    assert_eq!(snapshot.releases[0].lts, None);
    assert_eq!(snapshot.releases[1].lts, None);
    assert!(!snapshot.warnings.is_empty());
}

#[tokio::test]
/// 新鲜缓存跨应用实例复用，无网络响应可用时仍能打开目录。
async fn fresh_catalog_cache_survives_reopening_the_application() {
    let directory = tempfile::tempdir().unwrap();
    let app = Application::new(
        ScriptedSource::modified(r#"[{"version":"v22.10.0"}]"#),
        directory.path().into(),
        Arc::new(|| 10000),
    );
    app.open().await;
    let reopened = Application::new(
        Arc::new(ScriptedSource(std::sync::Mutex::new(Default::default()))),
        directory.path().into(),
        Arc::new(|| 10001),
    );
    reopened.open().await;
    let snapshot = reopened.snapshot("").await;
    assert_eq!(snapshot.status, "ready");
    assert_eq!(snapshot.releases[0].version, "v22.10.0");
    assert_eq!(snapshot.checked_at, Some(10000));
}

#[tokio::test]
/// 一小时边界重开须条件刷新，手动刷新即使新鲜也续期已有目录实体。
async fn expired_open_and_manual_refresh_use_etag_and_accept_304() {
    let directory = tempfile::tempdir().unwrap();
    let app = Application::new(
        ScriptedSource::modified(r#"[{"version":"v22.10.0"}]"#),
        directory.path().into(),
        Arc::new(|| 10000),
    );
    app.open().await;
    let source = Arc::new(ScriptedSource(std::sync::Mutex::new(
        std::collections::VecDeque::from([
            (
                Some("\"catalog-a\"".into()),
                Ok(CatalogResponse::NotModified),
            ),
            (
                Some("\"catalog-a\"".into()),
                Ok(CatalogResponse::NotModified),
            ),
        ]),
    )));
    let time = Arc::new(std::sync::atomic::AtomicU64::new(3610000));
    let clock = time.clone();
    let reopened = Application::new(
        source,
        directory.path().into(),
        Arc::new(move || clock.load(std::sync::atomic::Ordering::Relaxed)),
    );
    reopened.open().await;
    let snapshot = reopened.snapshot("").await;
    assert_eq!(snapshot.status, "ready");
    assert_eq!(snapshot.checked_at, Some(3610000));
    assert_eq!(snapshot.releases[0].version, "v22.10.0");
    time.store(3610001, std::sync::atomic::Ordering::Relaxed);
    reopened.refresh().await;
    assert_eq!(reopened.snapshot("").await.checked_at, Some(3610001));
}

#[tokio::test]
/// 缓存损坏、不兼容和未来时间戳均保留原文件，新网络实体仅在内存使用并告警。
async fn untrusted_cache_is_preserved_and_does_not_hide_valid_network_releases() {
    let invalid_caches = [
        "broken json".to_owned(),
        serde_json::json!({"format_version":99,"body":"[]","etag":null,"checked_at":10000}).to_string(),
        serde_json::json!({"format_version":1,"body":"[{\"version\":\"v22.1.0\"}]","etag":"\"bad\"","checked_at":20000}).to_string(),
        serde_json::json!({"format_version":1,"body":"broken entity","etag":null,"checked_at":10000}).to_string(),
    ];
    for original in invalid_caches {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("release-catalog.json");
        std::fs::write(&path, &original).unwrap();
        let app = Application::new(
            ScriptedSource::modified(r#"[{"version":"v24.10.0"}]"#),
            directory.path().into(),
            Arc::new(|| 10000),
        );
        app.open().await;
        let snapshot = app.snapshot("").await;
        assert_eq!(snapshot.status, "ready");
        assert_eq!(snapshot.releases[0].version, "v24.10.0");
        assert!(snapshot
            .warnings
            .iter()
            .any(|warning| warning.contains("缓存")));
        assert_eq!(std::fs::read_to_string(path).unwrap(), original);
    }
}

struct HeldSource {
    initial: std::sync::atomic::AtomicBool,
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
}

#[async_trait]
impl CatalogSource for HeldSource {
    /// 首次返回目录，随后等待受控故障；etag 为条件标记，返回响应或失败原因，无公网访问。
    async fn fetch(&self, _etag: Option<&str>) -> Result<CatalogResponse, String> {
        if self
            .initial
            .swap(false, std::sync::atomic::Ordering::Relaxed)
        {
            return Ok(CatalogResponse::Modified {
                body: br#"[{"version":"v22.10.0"}]"#.to_vec(),
                etag: Some("\"held\"".into()),
            });
        }
        self.entered.notify_one();
        self.release.notified().await;
        Err("网络已断开".into())
    }
}

#[tokio::test]
/// 网络等待时快照仍可查，重复刷新不会另起请求，失败保留旧实体且不续期。
async fn refresh_notifies_loading_and_error_without_blocking_queries_or_erasing_catalog() {
    let directory = tempfile::tempdir().unwrap();
    let source = Arc::new(HeldSource {
        initial: true.into(),
        entered: Default::default(),
        release: Default::default(),
    });
    let app = Arc::new(Application::new(
        source.clone(),
        directory.path().into(),
        Arc::new(|| 10000),
    ));
    app.refresh().await;
    let mut notifications = app.subscribe();
    let worker = app.clone();
    let task = tokio::spawn(async move {
        worker.refresh().await;
    });
    source.entered.notified().await;
    notifications.changed().await.unwrap();
    let loading = app.snapshot("22").await;
    assert_eq!(loading.status, "loading");
    assert!(loading.has_catalog && loading.stale);
    tokio::time::timeout(std::time::Duration::from_secs(1), app.refresh())
        .await
        .expect("重复刷新应复用正在进行的刷新");
    source.release.notify_one();
    task.await.unwrap();
    notifications.changed().await.unwrap();
    let failed = app.snapshot("22").await;
    assert_eq!(failed.status, "error");
    assert!(failed.stale && failed.has_catalog);
    assert_eq!(failed.releases[0].version, "v22.10.0");
    assert_eq!(failed.checked_at, Some(10000));
    assert!(failed.error.unwrap().contains("网络已断开"));
    assert_eq!(*notifications.borrow(), failed.revision);
}

#[tokio::test]
/// 非UTF-8目录不能悄悄替换字符后成为正式版本，即使JSON解码器可容忍输入也必须失败。
async fn non_utf8_catalog_is_rejected_instead_of_lossy_cache_persistence() {
    let directory = tempfile::tempdir().unwrap();
    let source = Arc::new(ScriptedSource(std::sync::Mutex::new(
        std::collections::VecDeque::from([(
            None,
            Ok(CatalogResponse::Modified {
                body: b"[{\"version\":\"v22.1.0\",\"date\":\"\xff\"}]".to_vec(),
                etag: None,
            }),
        )]),
    )));
    let app = Application::new(source, directory.path().into(), Arc::new(|| 10000));
    app.refresh().await;
    assert_eq!(app.snapshot("").await.status, "error");
}

#[tokio::test]
/// 孤立304及无配套ETag的304不能冒充成功；新200缺少ETag不得沿用旧标记。
async fn conditional_protocol_errors_preserve_old_entity_and_clear_obsolete_etag() {
    let directory = tempfile::tempdir().unwrap();
    let source = Arc::new(ScriptedSource(std::sync::Mutex::new(
        std::collections::VecDeque::from([
            (None, Ok(CatalogResponse::NotModified)),
            (
                None,
                Ok(CatalogResponse::Modified {
                    body: br#"[{"version":"v22.1.0"}]"#.to_vec(),
                    etag: Some("\"a\"".into()),
                }),
            ),
            (
                Some("\"a\"".into()),
                Ok(CatalogResponse::Modified {
                    body: br#"[{"version":"v22.10.0"}]"#.to_vec(),
                    etag: None,
                }),
            ),
            (None, Ok(CatalogResponse::NotModified)),
        ]),
    )));
    let app = Application::new(source, directory.path().into(), Arc::new(|| 10000));
    app.open().await;
    let failed = app.snapshot("").await;
    assert_eq!(failed.status, "error");
    assert!(!failed.has_catalog && failed.error.unwrap().contains("304"));
    app.refresh().await;
    app.refresh().await;
    app.refresh().await;
    let snapshot = app.snapshot("").await;
    assert_eq!(snapshot.status, "error");
    assert_eq!(snapshot.releases[0].version, "v22.10.0");
    assert_eq!(snapshot.checked_at, Some(10000));
}

#[tokio::test]
/// 持久化位置不可用时仍展示有效网络目录，但必须告知本次缓存无法保存。
async fn unavailable_cache_location_does_not_turn_valid_network_data_into_empty_results() {
    let directory = tempfile::tempdir().unwrap();
    let unavailable = directory.path().join("not-a-directory");
    std::fs::write(&unavailable, "original").unwrap();
    let app = Application::new(
        ScriptedSource::modified(r#"[{"version":"v24.10.0"}]"#),
        unavailable.clone(),
        Arc::new(|| 10000),
    );
    app.open().await;
    let snapshot = app.snapshot("").await;
    assert_eq!(snapshot.status, "ready");
    assert_eq!(snapshot.releases[0].version, "v24.10.0");
    assert!(snapshot
        .warnings
        .iter()
        .any(|warning| warning.contains("缓存")));
    assert_eq!(std::fs::read_to_string(unavailable).unwrap(), "original");
}
