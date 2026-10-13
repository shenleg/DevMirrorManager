//! 将权威目录应用 Module 接入最小 Tauri 命令与轻量 Event，不开放任意网络或文件操作。
pub mod application;
mod cache;
mod catalog;
pub mod official_source;

use application::{Application, CatalogSnapshot};
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

/// 查询快照；query 为原始文本，state 为权威应用，返回校验后的结果；无业务异常。
#[tauri::command]
async fn catalog_snapshot(
    query: String,
    state: State<'_, Arc<Application>>,
) -> Result<CatalogSnapshot, String> {
    Ok(state.snapshot(&query).await)
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
    tauri::Builder::default()
        .setup(|app| {
            let source = official_source::OfficialSource::new().map_err(std::io::Error::other)?;
            let application = Arc::new(Application::new(
                Arc::new(source),
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
        .invoke_handler(tauri::generate_handler![
            open_catalog,
            catalog_snapshot,
            refresh_catalog
        ])
        .run(tauri::generate_context!())
        .expect("无法启动 Node.js 发行目录桌面应用");
}
