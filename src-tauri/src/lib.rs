//! 将目录与目标预览权威应用接入 Tauri 命令和统一轻量 Event，不开放任意来源、格式或文件操作。
pub mod application;
mod cache;
mod catalog;
#[cfg(feature = "ci-smoke")]
mod ci_smoke;
pub mod manifest;
pub mod official_source;

use application::{Application, CatalogSnapshot};
use manifest::Selection;
use serde::Serialize;
use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager, State};

#[derive(Clone, Serialize)]
struct CatalogChanged {
    revision: u64,
}

/// 打开目录；state 为宿主管理的应用，无返回数据、立即调度，业务错误由权威快照说明。
#[tauri::command]
async fn open_catalog(state: State<'_, Arc<Application>>) -> Result<(), String> {
    let application = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        application.open().await;
    });
    Ok(())
}

/// 查询完整快照；query 为原始文本，selection 为草稿（省略时无发行版本），state 为权威应用；返回同一 revision 的目录和预览，非法或目录外版本返回原因，不联网。
#[tauri::command]
async fn catalog_snapshot(
    query: String,
    selection: Option<Selection>,
    state: State<'_, Arc<Application>>,
) -> Result<CatalogSnapshot, String> {
    state
        .snapshot_with_selection(&query, selection.unwrap_or_default())
        .await
}

/// 准备清单；selection 为结构化草稿，retry 为用户主动重试，state 为权威应用；返回前完成输入校验和快速调度，输入错误直接返回，联网/解析错误留在预览。
#[tauri::command]
async fn prepare_preview(
    selection: Selection,
    retry: bool,
    state: State<'_, Arc<Application>>,
) -> Result<(), String> {
    state.inner().prepare_preview(selection, retry).await
}

/// 主动刷新；state 为权威应用，无返回数据、立即调度，联网错误保存在快照。
#[tauri::command]
async fn refresh_catalog(state: State<'_, Arc<Application>>) -> Result<(), String> {
    let application = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        application.refresh().await;
    });
    Ok(())
}

/// 启动真实桌面应用；无参数或返回值，宿主配置/TLS初始化失败时停止并报告，不启动下载或修改系统设置。
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(feature = "ci-smoke")]
    let builder = builder.on_page_load(|window, payload| {
        if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
            if let Err(error) = window.eval(ci_smoke::READY_SCRIPT) {
                eprintln!("原生就绪观察注入失败：{error}");
            }
        }
    });
    #[cfg(feature = "ci-smoke")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        open_catalog,
        catalog_snapshot,
        prepare_preview,
        refresh_catalog,
        ci_smoke::ci_smoke_ready
    ]);
    #[cfg(not(feature = "ci-smoke"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        open_catalog,
        catalog_snapshot,
        prepare_preview,
        refresh_catalog
    ]);
    builder
        .setup(|app| {
            let source =
                Arc::new(official_source::OfficialSource::new().map_err(std::io::Error::other)?);
            let application = Arc::new(Application::new_with_manifest_source(
                source.clone(),
                source,
                app.path().app_data_dir()?.join("catalog"),
                Arc::new(|| {
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64
                }),
            ));
            let mut changes = application.subscribe();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while changes.changed().await.is_ok() {
                    let revision = *changes.borrow_and_update();
                    // Event 可以丢失；前端在重连及每次通知后都读取权威快照。
                    if let Err(error) = handle.emit("catalog-changed", CatalogChanged { revision })
                    {
                        eprintln!("目录变更通知发送失败：{error}");
                    }
                }
            });
            app.manage(application.clone());
            tauri::async_runtime::spawn(async move {
                application.open().await;
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("无法启动 Node.js 发行目录桌面应用");
}
