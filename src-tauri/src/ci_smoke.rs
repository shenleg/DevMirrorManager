//! 仅 ci-smoke feature 编译的原生就绪协议；正式构建不含此命令或输出路径能力。
use crate::application::Application;
use serde::Deserialize;
use std::sync::Arc;
use tauri::State;

/// 页面报告只传观察结果；不能指定来源、任意文件路径或权威候选。
#[derive(Deserialize)]
pub struct Observation {
    versions: Vec<String>,
    reason: Option<String>,
}

/// 核对真实渲染与权威目录；observation为DOM观察，state为应用，返回成功或原因，文件错误返回原因。
#[tauri::command]
pub async fn ci_smoke_ready(
    observation: Observation,
    state: State<'_, Arc<Application>>,
) -> Result<(), String> {
    let snapshot = state.snapshot("").await;
    let expected: Vec<&str> = snapshot
        .releases
        .iter()
        .map(|release| release.version.as_str())
        .collect();
    let observed: Vec<&str> = observation.versions.iter().map(String::as_str).collect();
    let reason = observation.reason.or_else(|| {
        if snapshot.status != "ready"
            || !snapshot.has_catalog
            || snapshot.stale
            || snapshot.error.is_some()
            || expected.is_empty()
            || expected != observed
        {
            Some(format!(
                "页面与权威目录不一致：状态 {}，候选 {}，渲染 {}，错误 {:?}",
                snapshot.status,
                expected.len(),
                observed.len(),
                snapshot.error
            ))
        } else {
            None
        }
    });
    let directory = std::env::var_os("CI_SMOKE_DIR").ok_or("未指定测试输出目录")?;
    let result = serde_json::json!({
        "status": if reason.is_none() { "passed" } else { "failed" },
        "reason": reason, "arch": std::env::consts::ARCH, "os": std::env::consts::OS,
        "count": snapshot.releases.len(), "source": snapshot.source,
        "revision": snapshot.revision, "checkedAt": snapshot.checked_at,
    });
    std::fs::write(
        std::path::PathBuf::from(directory).join("ready.json"),
        result.to_string(),
    )
    .map_err(|error| format!("无法保存就绪证据：{error}"))
}

/// 仅在已加载的WebView注入就绪观察；不产生候选、不操作用户目录，DOM/IPC错误写入失败证据。
pub const READY_SCRIPT: &str = r#"
(async () => {
  if (window.__ciSmokeStarted) return;
  window.__ciSmokeStarted = true;
  const { invoke } = window.__TAURI_INTERNALS__;
  const deadline = Date.now() + 90000;
  let reason = '真实 WebView 在期限内未显示官方目录';
  while (Date.now() < deadline) {
    try {
      const snapshot = await invoke('catalog_snapshot', { query: '' });
      const radios = [...document.querySelectorAll('input[type="radio"][name="release"]')];
      const status = document.querySelector('[role="status"]')?.textContent ?? '';
      if (snapshot.status === 'error') { reason = snapshot.error ?? '目录加载失败'; break; }
      if (snapshot.status === 'ready' && snapshot.hasCatalog && !snapshot.stale
          && radios.length > 0 && status.includes('目录就绪')
          && radios.length === snapshot.releases.length) {
        await invoke('ci_smoke_ready', { observation: { versions: radios.map(r => r.value), reason: null } });
        return;
      }
    } catch (error) { reason = String(error); }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await invoke('ci_smoke_ready', { observation: { versions: [], reason } });
})().catch(error => console.error('原生就绪证据失败', error));
"#;
