//! 通过 Application 公开命令、快照、通知和原始字节验证目标预览；清单均为独立测试夹具，不代表官方发行事实。
use async_trait::async_trait;
use nodejs_downloader::{
    application::Application,
    manifest::{ReleaseVersion, Selection},
    official_source::{ManifestSource, OfficialSource},
};
use std::{collections::VecDeque, sync::Arc, time::Duration};

type ManifestResponse = (String, Result<Vec<u8>, String>);

/// 受控的外部清单来源；只接受夹具声明的发行版本，不访问公网。
struct ManifestFixture(std::sync::Mutex<VecDeque<ManifestResponse>>);

impl ManifestFixture {
    /// 为指定发行版本配置一次响应；body 是完整原始清单，返回来源，无异常。
    fn once(version: &str, body: &[u8]) -> Arc<Self> {
        Arc::new(Self(std::sync::Mutex::new(VecDeque::from([(
            version.into(),
            Ok(body.to_vec()),
        )]))))
    }
}

#[async_trait]
impl ManifestSource for ManifestFixture {
    /// 返回该发行版本的外部响应；version 已由应用校验，返回原始字节，未配置或版本不符时返回原因。
    async fn fetch(&self, version: &ReleaseVersion) -> Result<Vec<u8>, String> {
        let (expected, response) = self.0.lock().unwrap().pop_front().ok_or("未配置清单响应")?;
        if expected != version.as_str() {
            return Err("清单发行版本不匹配".into());
        }
        response
    }
}

/// 打开具有新鲜目录缓存的应用；source 仅替换外部清单，返回应用及保持缓存存活的目录；夹具或客户端初始化异常时测试失败。
async fn application(source: Arc<dyn ManifestSource>) -> (Arc<Application>, tempfile::TempDir) {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(
        directory.path().join("release-catalog.json"),
        serde_json::json!({
            "format_version": 1,
            "body": "[{\"version\":\"v24.1.0\"},{\"version\":\"v22.1.0\"}]",
            "etag": null,
            "checked_at": 10000
        })
        .to_string(),
    )
    .unwrap();
    let app = Arc::new(Application::new_with_manifest_source(
        Arc::new(OfficialSource::new().unwrap()),
        source,
        directory.path().into(),
        Arc::new(|| 10001),
    ));
    app.open().await;
    (app, directory)
}

/// 从 IPC 形状创建选择；version/os/arch 为测试输入，返回结构化草稿，非法夹具使测试失败。
fn selection(version: Option<&str>, os: &str, arch: &str) -> Selection {
    serde_json::from_value(serde_json::json!({"version":version,"target":{"os":os,"arch":arch}}))
        .unwrap()
}

/// 等待指定预览状态；app/selection 为公开查询输入，返回 JSON 快照，超时或查询失败使测试失败。
async fn wait_for(app: &Application, selection: Selection, status: &str) -> serde_json::Value {
    let mut changes = app.subscribe();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let snapshot = serde_json::to_value(
                app.snapshot_with_selection("", selection.clone())
                    .await
                    .unwrap(),
            )
            .unwrap();
            if snapshot["preview"]["status"] == status {
                return snapshot;
            }
            changes.changed().await.unwrap();
        }
    })
    .await
    .expect("预览应通过通知推进至期望状态")
}

/// 首次指定发行版本的清单等待故障，后续返回成功，其他发行版本独立成功。
struct HeldManifest {
    first: std::sync::atomic::AtomicBool,
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
}

#[async_trait]
impl ManifestSource for HeldManifest {
    /// 为 version 返回确定的完整清单；首次 v24.1.0 在 gate 放行后返回断网原因，其他情况立即成功，不访问公网。
    async fn fetch(&self, version: &ReleaseVersion) -> Result<Vec<u8>, String> {
        if version.as_str() == "v24.1.0"
            && self.first.swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            self.entered.notify_one();
            self.release.notified().await;
            return Err("网络已断开".into());
        }
        match version.as_str() {
            "v24.1.0" => Ok(b"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd  node-v24.1.0-win-x64.7z\n".to_vec()),
            "v22.1.0" => Ok(b"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee  node-v22.1.0-win-x64.7z\n".to_vec()),
            _ => Err("未配置发行版本".into()),
        }
    }
}

#[tokio::test]
/// Windows 选择先保持待确认，准备成功后用官方清单证实完整 .7z 路径及 hash，并发送同一 revision 通知。
async fn windows_preview_is_ready_only_after_manifest_preparation() {
    let body = b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  node-v24.1.0-win-x64.7z\n";
    let (app, _directory) = application(ManifestFixture::once("v24.1.0", body)).await;
    let selected = selection(Some("v24.1.0"), "windows", "x64");
    let idle = serde_json::to_value(
        app.snapshot_with_selection("24", selected.clone())
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        idle["preview"],
        serde_json::json!({
            "selection":{"version":"v24.1.0","target":{"os":"windows","arch":"x64"}},
            "status":"idle",
            "source":"https://nodejs.org/dist/v24.1.0/SHASUMS256.txt",
            "required":[{"path":"node-v24.1.0-win-x64.7z","present":null,"sha256":null}],
            "error":null
        })
    );
    let mut changes = app.subscribe();
    app.prepare_preview(selected.clone(), false).await.unwrap();
    let ready = wait_for(&app, selected, "ready").await;
    changes.changed().await.unwrap();
    assert_eq!(*changes.borrow(), ready["revision"].as_u64().unwrap());
    assert_eq!(
        ready["preview"]["required"],
        serde_json::json!([{
            "path":"node-v24.1.0-win-x64.7z","present":true,
            "sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        }])
    );
    assert_eq!(
        app.raw_manifest("v24.1.0").await.unwrap().unwrap().as_ref(),
        body
    );
}

#[tokio::test]
/// 六目标由固定格式与完整路径确认；目标切换只查已取得清单，不再请求清单或改变发行版本。
async fn six_targets_use_fixed_complete_file_names_and_reuse_one_manifest() {
    let names = [
        (
            "macos",
            "x64",
            vec![
                "node-v24.1.0-darwin-x64.tar.xz",
                "node-v24.1.0-darwin-x64.tar.gz",
            ],
        ),
        (
            "macos",
            "arm64",
            vec![
                "node-v24.1.0-darwin-arm64.tar.xz",
                "node-v24.1.0-darwin-arm64.tar.gz",
            ],
        ),
        ("windows", "x64", vec!["node-v24.1.0-win-x64.7z"]),
        ("windows", "arm64", vec!["node-v24.1.0-win-arm64.7z"]),
        (
            "linux",
            "x64",
            vec![
                "node-v24.1.0-linux-x64.tar.xz",
                "node-v24.1.0-linux-x64.tar.gz",
            ],
        ),
        (
            "linux",
            "arm64",
            vec![
                "node-v24.1.0-linux-arm64.tar.xz",
                "node-v24.1.0-linux-arm64.tar.gz",
            ],
        ),
    ];
    let body = names
        .iter()
        .flat_map(|(_, _, paths)| paths)
        .map(|path| {
            format!("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  {path}\n")
        })
        .collect::<String>();
    let (app, _directory) = application(ManifestFixture::once("v24.1.0", body.as_bytes())).await;
    app.prepare_preview(selection(Some("v24.1.0"), "windows", "x64"), false)
        .await
        .unwrap();
    wait_for(&app, selection(Some("v24.1.0"), "windows", "x64"), "ready").await;
    for (os, arch, expected) in names {
        let selected = selection(Some("v24.1.0"), os, arch);
        app.prepare_preview(selected.clone(), false).await.unwrap();
        app.prepare_preview(selected.clone(), true).await.unwrap();
        let snapshot =
            serde_json::to_value(app.snapshot_with_selection("", selected).await.unwrap()).unwrap();
        assert_eq!(snapshot["preview"]["status"], "ready", "{os}/{arch}");
        assert_eq!(snapshot["preview"]["selection"]["version"], "v24.1.0");
        let paths = snapshot["preview"]["required"]
            .as_array()
            .unwrap()
            .iter()
            .map(|file| file["path"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(paths, expected, "{os}/{arch}");
    }
}

#[tokio::test]
/// 成功清单缺少一种 Unix 归档时不可就绪；musl、ZIP、安装器、源码、其他目标及嵌套同名文件均不能替代。
async fn missing_one_archive_is_not_satisfied_by_similar_distribution_artifacts() {
    let body = [
        "node-v24.1.0-linux-x64.tar.xz",
        "node-v24.1.0-linux-x64-musl.tar.gz",
        "node-v24.1.0-linux-arm64.tar.gz",
        "node-v24.1.0-linux-x64.zip",
        "node-v24.1.0-win-x64.zip",
        "node-v24.1.0-x64.msi",
        "node-v24.1.0.tar.gz",
        "nested/node-v24.1.0-linux-x64.tar.gz",
    ]
    .iter()
    .map(|path| {
        format!("cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc  {path}\n")
    })
    .collect::<String>();
    let (app, _directory) = application(ManifestFixture::once("v24.1.0", body.as_bytes())).await;
    let linux = selection(Some("v24.1.0"), "linux", "x64");
    app.prepare_preview(linux.clone(), false).await.unwrap();
    let missing = wait_for(&app, linux, "missing").await;
    assert_eq!(
        missing["preview"]["required"],
        serde_json::json!([
            {"path":"node-v24.1.0-linux-x64.tar.xz","present":true,"sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},
            {"path":"node-v24.1.0-linux-x64.tar.gz","present":false,"sha256":null}
        ])
    );
    let windows = app
        .snapshot_with_selection("", selection(Some("v24.1.0"), "windows", "x64"))
        .await
        .unwrap();
    assert_eq!(windows.preview.status, "missing");
    assert_eq!(windows.preview.required[0].present, Some(false));
    assert!(windows.preview.error.is_none());
}

#[tokio::test]
/// 损坏的 hash、UTF-8 或清单记录必须报告清单错误，不能证明文件存在/缺失或暴露原始成功实体。
async fn malformed_manifest_records_cannot_become_file_facts() {
    let bad_bodies: Vec<Vec<u8>> = vec![
        b"short  node-v24.1.0-win-x64.7z\n".to_vec(),
        b"gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg  node-v24.1.0-win-x64.7z\n".to_vec(),
        b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  node-v24.1.0-win-x64.7z\n".to_vec(),
        b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa node-v24.1.0-win-x64.7z\n".to_vec(),
        b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\t node-v24.1.0-win-x64.7z\n".to_vec(),
        b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  \xff\n".to_vec(),
        b"\xef\xbb\xbfaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  node-v24.1.0-win-x64.7z\n".to_vec(),
        b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  node-v24.1.0-win-x64.7z\n\n".to_vec(),
        Vec::new(),
        b"\n".to_vec(),
    ];
    for body in bad_bodies {
        let (app, _directory) = application(ManifestFixture::once("v24.1.0", &body)).await;
        let selected = selection(Some("v24.1.0"), "windows", "x64");
        app.prepare_preview(selected.clone(), false).await.unwrap();
        let snapshot = wait_for(&app, selected, "error").await;
        assert!(snapshot["preview"]["error"]
            .as_str()
            .unwrap()
            .contains("清单"));
        assert_eq!(
            snapshot["preview"]["required"][0]["present"],
            serde_json::Value::Null
        );
        assert_eq!(
            snapshot["preview"]["required"][0]["sha256"],
            serde_json::Value::Null
        );
        assert!(app.raw_manifest("v24.1.0").await.unwrap().is_none());
    }
}

#[tokio::test]
/// 清单任一条目越界或含编码绕过都应拒绝整个实体，即使所需归档本身看似有效。
async fn unsafe_manifest_paths_are_rejected_before_any_file_is_confirmed() {
    let unsafe_paths = [
        "/node.exe",
        "//host/node.exe",
        "../node.exe",
        "./node.exe",
        "a/../node.exe",
        "a/./node.exe",
        "a//node.exe",
        "a/",
        "C:/node.exe",
        "https://evil.test/node.exe",
        "win-x64\\node.exe",
        "%2e%2e/node.exe",
        "a/%2Fnode.exe",
        "a/%252e%252e/node.exe",
        "a?b",
        "a#b",
        "a\0b",
        "a\tb",
        "a\u{7f}b",
        " node.exe",
        "node.exe ",
        "a\rb",
        "a\u{202e}exe",
        "a\u{0085}b",
    ];
    for path in unsafe_paths {
        let body = format!("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  node-v24.1.0-win-x64.7z\naaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  {path}\n");
        let (app, _directory) =
            application(ManifestFixture::once("v24.1.0", body.as_bytes())).await;
        let selected = selection(Some("v24.1.0"), "windows", "x64");
        app.prepare_preview(selected.clone(), false).await.unwrap();
        let snapshot = wait_for(&app, selected, "error").await;
        assert_eq!(
            snapshot["preview"]["required"][0]["present"],
            serde_json::Value::Null,
            "{path:?}"
        );
        assert!(
            app.raw_manifest("v24.1.0").await.unwrap().is_none(),
            "{path:?}"
        );
    }
}

#[tokio::test]
/// 重复路径不能采用最后一条覆盖，即使 hash 相同也必须拒绝，避免保真实体与后续判定发生歧义。
async fn duplicate_manifest_paths_are_errors_even_with_identical_hashes() {
    for second_hash in [
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ] {
        let body = format!("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  node-v24.1.0-win-x64.7z\n{second_hash}  node-v24.1.0-win-x64.7z\n");
        let (app, _directory) =
            application(ManifestFixture::once("v24.1.0", body.as_bytes())).await;
        let selected = selection(Some("v24.1.0"), "windows", "x64");
        app.prepare_preview(selected.clone(), false).await.unwrap();
        let snapshot = wait_for(&app, selected, "error").await;
        assert!(snapshot["preview"]["error"]
            .as_str()
            .unwrap()
            .contains("重复"));
        assert!(app.raw_manifest("v24.1.0").await.unwrap().is_none());
    }
}

#[tokio::test]
/// 即使替代网络来源返回完整大正文，解析入口仍独立执行 4 MiB 上限，不能依赖 HTTP 声明长度保护。
async fn oversized_manifest_is_rejected_at_the_application_boundary() {
    let mut body = b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  node-v24.1.0-win-x64.7z\naaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  ".to_vec();
    body.resize(4 * 1024 * 1024 + 1, b'a');
    let (app, _directory) = application(ManifestFixture::once("v24.1.0", &body)).await;
    let selected = selection(Some("v24.1.0"), "windows", "x64");
    app.prepare_preview(selected.clone(), false).await.unwrap();
    let snapshot = wait_for(&app, selected, "error").await;
    assert!(snapshot["preview"]["error"]
        .as_str()
        .unwrap()
        .contains("4 MiB"));
    assert!(app.raw_manifest("v24.1.0").await.unwrap().is_none());
}

#[tokio::test]
/// 网络挂起时命令快速返回且查询/其他发行版本仍可用；同版本 loading 合并，失败不隐式重试，用户重试后恢复。
async fn loading_and_failed_manifests_are_isolated_and_only_explicit_retry_recovers() {
    let source = Arc::new(HeldManifest {
        first: true.into(),
        entered: Default::default(),
        release: Default::default(),
    });
    let (app, _directory) = application(source.clone()).await;
    let selected = selection(Some("v24.1.0"), "windows", "x64");
    let mut changes = app.subscribe();
    tokio::time::timeout(
        Duration::from_secs(1),
        app.prepare_preview(selected.clone(), false),
    )
    .await
    .unwrap()
    .unwrap();
    source.entered.notified().await;
    changes.changed().await.unwrap();
    let loading = tokio::time::timeout(
        Duration::from_secs(1),
        app.snapshot_with_selection("24", selected.clone()),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(loading.preview.status, "loading");
    assert_eq!(loading.preview.required[0].present, None);
    assert_eq!(loading.preview.required[0].sha256, None);
    assert_eq!(*changes.borrow(), loading.revision);
    assert!(app.raw_manifest("v24.1.0").await.unwrap().is_none());
    app.prepare_preview(selected.clone(), false).await.unwrap();
    app.prepare_preview(selection(Some("v24.1.0"), "linux", "arm64"), true)
        .await
        .unwrap();
    let combined = app
        .snapshot_with_selection("", selected.clone())
        .await
        .unwrap();
    assert_eq!(combined.preview.status, "loading");
    assert_eq!(combined.revision, loading.revision);
    let other = selection(Some("v22.1.0"), "windows", "x64");
    app.prepare_preview(other.clone(), false).await.unwrap();
    wait_for(&app, other.clone(), "ready").await;
    source.release.notify_one();
    let failed = wait_for(&app, selected.clone(), "error").await;
    assert!(failed["preview"]["error"]
        .as_str()
        .unwrap()
        .contains("网络已断开"));
    assert_eq!(
        failed["preview"]["required"][0]["present"],
        serde_json::Value::Null
    );
    assert_eq!(failed["status"], "ready");
    app.prepare_preview(selected.clone(), false).await.unwrap();
    app.prepare_preview(selection(Some("v24.1.0"), "macos", "arm64"), false)
        .await
        .unwrap();
    let not_retried = app
        .snapshot_with_selection("", selected.clone())
        .await
        .unwrap();
    assert_eq!(not_retried.preview.status, "error");
    assert_eq!(not_retried.revision, failed["revision"].as_u64().unwrap());
    assert_eq!(
        app.snapshot_with_selection("", other.clone())
            .await
            .unwrap()
            .preview
            .status,
        "ready"
    );
    app.prepare_preview(selected.clone(), true).await.unwrap();
    let ready = wait_for(&app, selected.clone(), "ready").await;
    assert!(ready["revision"].as_u64().unwrap() > failed["revision"].as_u64().unwrap());
    let raw = app.raw_manifest("v22.1.0").await.unwrap().unwrap();
    assert_eq!(raw.as_ref(), b"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee  node-v22.1.0-win-x64.7z\n");
    app.prepare_preview(selected.clone(), true).await.unwrap();
    assert_eq!(
        app.snapshot_with_selection("", selected)
            .await
            .unwrap()
            .revision,
        ready["revision"].as_u64().unwrap()
    );
}

#[tokio::test]
/// 混合 LF/CRLF、无末尾换行、大小写 hash 与非必需嵌套路径均保留原始字节；重开应用不从磁盘恢复清单事实。
async fn raw_manifest_bytes_are_preserved_separately_from_parsed_hashes() {
    let body = b"ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789  node-v24.1.0-win-x64.7z\r\n0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  win-x64/node.exe\nffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff  headers/include/node.h";
    let (app, directory) = application(ManifestFixture::once("v24.1.0", body)).await;
    let selected = selection(Some("v24.1.0"), "windows", "x64");
    app.prepare_preview(selected.clone(), false).await.unwrap();
    let ready = wait_for(&app, selected.clone(), "ready").await;
    assert_eq!(
        ready["preview"]["required"][0]["sha256"],
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
    );
    assert_eq!(
        app.raw_manifest("v24.1.0").await.unwrap().unwrap().as_ref(),
        body
    );
    let other = app
        .snapshot_with_selection("no-match", selection(Some("v24.1.0"), "macos", "arm64"))
        .await
        .unwrap();
    assert_eq!(other.preview.status, "missing");
    assert_eq!(other.revision, ready["revision"].as_u64().unwrap());
    assert_eq!(
        app.raw_manifest("v24.1.0").await.unwrap().unwrap().as_ref(),
        body
    );
    let reopened = Arc::new(Application::new_with_manifest_source(
        Arc::new(OfficialSource::new().unwrap()),
        ManifestFixture::once("v24.1.0", body),
        directory.path().into(),
        Arc::new(|| 10001),
    ));
    reopened.open().await;
    assert!(reopened.raw_manifest("v24.1.0").await.unwrap().is_none());
    assert_eq!(
        reopened
            .snapshot_with_selection("", selected)
            .await
            .unwrap()
            .preview
            .status,
        "idle"
    );
}

#[tokio::test]
/// 不可信 IPC 草稿不能带任意格式/URL/路径或未知目标；非规范和目录外版本在调度前拒绝，查询也不能绕过验证。
async fn untrusted_selections_are_rejected_without_starting_manifest_work() {
    let body = b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  node-v24.1.0-win-x64.7z\n";
    let (app, _directory) = application(ManifestFixture::once("v24.1.0", body)).await;
    let initial = app.snapshot("").await.revision;
    for value in [
        serde_json::json!({"version":"v24.1.0","target":{"os":"windows","arch":"x64"},"format":"zip"}),
        serde_json::json!({"version":"v24.1.0","target":{"os":"windows","arch":"x64"},"url":"https://evil.test"}),
        serde_json::json!({"version":"v24.1.0","target":{"os":"windows","arch":"x64","path":"../x"}}),
        serde_json::json!({"version":"v24.1.0","target":{"os":"windows","arch":"x64","variant":"musl"}}),
        serde_json::json!({"version":"v24.1.0","target":{"os":"darwin","arch":"x64"}}),
        serde_json::json!({"version":"v24.1.0","target":{"os":"Windows","arch":"x64"}}),
        serde_json::json!({"version":"v24.1.0","target":{"os":"linux","arch":"ia32"}}),
        serde_json::json!({"version":"v24.1.0","target":{"os":"linux","arch":"ARM64"}}),
        serde_json::json!({"version":"v24.1.0","target":{"os":"linux"}}),
        serde_json::json!({"version":24,"target":{"os":"linux","arch":"x64"}}),
    ] {
        assert!(
            serde_json::from_value::<Selection>(value.clone()).is_err(),
            "{value}"
        );
    }
    for version in [
        "24.1.0",
        "V24.1.0",
        "v24.1",
        "v024.1.0",
        "v24.1.0-beta.1",
        "v24.1.0+build",
        " v24.1.0",
        "v24.1.0\n",
        "../v24.1.0",
        "v24.1.0/../x",
        "https://evil.test",
        "v99.1.0",
    ] {
        let selected = selection(Some(version), "windows", "x64");
        assert!(
            app.prepare_preview(selected.clone(), false).await.is_err(),
            "{version:?}"
        );
        assert!(
            app.snapshot_with_selection("", selected).await.is_err(),
            "{version:?}"
        );
        assert!(app.raw_manifest(version).await.is_err(), "{version:?}");
    }
    let unselected = selection(None, "linux", "arm64");
    let empty = serde_json::to_value(
        app.snapshot_with_selection("", unselected.clone())
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        empty["preview"],
        serde_json::json!({"selection":{"version":null,"target":{"os":"linux","arch":"arm64"}},"status":"unselected","source":null,"required":[],"error":null})
    );
    assert!(app.prepare_preview(unselected, false).await.is_err());
    assert_eq!(app.snapshot("").await.revision, initial);
    assert_eq!(
        serde_json::to_value(app.snapshot("24").await).unwrap(),
        serde_json::to_value(
            app.snapshot_with_selection("24", Selection::default())
                .await
                .unwrap()
        )
        .unwrap()
    );
    let selected = selection(Some("v24.1.0"), "windows", "x64");
    assert_eq!(
        app.snapshot_with_selection("", selected.clone())
            .await
            .unwrap()
            .preview
            .status,
        "idle"
    );
    app.prepare_preview(selected.clone(), false).await.unwrap();
    wait_for(&app, selected, "ready").await;
}
