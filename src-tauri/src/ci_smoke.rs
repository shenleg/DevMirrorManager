//! 仅 ci-smoke feature 编译的原生观察协议；真实界面操作与权威事实共同决定通过，正式构建不含此接线。
use crate::{application::Application, manifest::Selection};
use serde::Deserialize;
use std::sync::Arc;
use tauri::State;

/// 页面只传 DOM 观察；来源、文件清单和资格必须由 Rust 重新核对。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    versions: Vec<String>,
    #[serde(default)]
    previews: Vec<serde_json::Value>,
    selection: Option<Selection>,
    cleared_selection: Option<Selection>,
    #[serde(default)]
    rejected_inputs: usize,
    reason: Option<String>,
}

/// 核对真实界面的六目标、搜索失配及官方清单；observation 为页面观察，state 为权威应用，返回保存结果，协议或文件错误返回原因。
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
    let mut reason = observation.reason;
    if reason.is_none()
        && (snapshot.status != "ready"
            || !snapshot.has_catalog
            || snapshot.stale
            || snapshot.error.is_some()
            || expected.is_empty()
            || expected != observed)
    {
        reason = Some("页面与成功的官方目录不一致".into());
    }
    let targets = [
        ("macos", "x64"),
        ("macos", "arm64"),
        ("windows", "x64"),
        ("windows", "arm64"),
        ("linux", "x64"),
        ("linux", "arm64"),
    ];
    let mut version_preserved = false;
    let mut target_preserved = false;
    if reason.is_none() {
        if observation.previews.len() != targets.len() {
            reason = Some("页面未报告六个目标预览".into());
        } else {
            let selected = observation.selection.as_ref();
            let cleared = observation.cleared_selection.as_ref();
            version_preserved = selected.is_some_and(|selection| selection.version.is_some());
            target_preserved = selected.zip(cleared).is_some_and(|(selected, cleared)| {
                cleared.version.is_none()
                    && serde_json::to_value(&selected.target).ok()
                        == serde_json::to_value(&cleared.target).ok()
                    && serde_json::to_value(&selected.target).ok()
                        == Some(serde_json::json!({ "os": "linux", "arch": "arm64" }))
            });
            for (observed, (os, arch)) in observation.previews.iter().zip(targets) {
                let selection: Selection =
                    match serde_json::from_value(observed["selection"].clone()) {
                        Ok(selection) => selection,
                        Err(error) => {
                            reason = Some(format!("页面目标观察无效：{error}"));
                            break;
                        }
                    };
                version_preserved &=
                    selected.is_some_and(|selected| selection.version == selected.version);
                if observed["selection"]["target"] != serde_json::json!({ "os": os, "arch": arch })
                {
                    reason = Some("页面目标集合不符合六目标契约".into());
                    break;
                }
                match state.snapshot_with_selection("", selection).await {
                    Ok(authoritative) => {
                        let preview = serde_json::to_value(authoritative.preview)
                            .map_err(|error| format!("无法编码权威预览：{error}"))?;
                        if !matches!(preview["status"].as_str(), Some("ready" | "missing"))
                            || preview != *observed
                        {
                            reason =
                                Some(format!("{os}/{arch} 页面预览与成功的官方清单事实不一致"));
                            break;
                        }
                    }
                    Err(error) => {
                        reason = Some(error);
                        break;
                    }
                }
            }
            if reason.is_none() && (!version_preserved || !target_preserved) {
                reason = Some("改选目标修改了发行版本，或搜索失配丢失了目标".into());
            }
            if reason.is_none() && observation.rejected_inputs != 3 {
                reason = Some("真实 IPC 未拒绝全部恶意选择输入".into());
            }
        }
    }
    let directory = std::env::var_os("CI_SMOKE_DIR").ok_or("未指定测试输出目录")?;
    let result = serde_json::json!({
        "status": if reason.is_none() { "passed" } else { "failed" },
        "reason": reason, "arch": std::env::consts::ARCH, "os": std::env::consts::OS,
        "count": snapshot.releases.len(), "source": snapshot.source,
        "revision": snapshot.revision, "checkedAt": snapshot.checked_at,
        "previews": observation.previews, "versionPreserved": version_preserved,
        "targetPreserved": target_preserved, "rejectedInputs": observation.rejected_inputs,
    });
    std::fs::write(
        std::path::PathBuf::from(directory).join("ready.json"),
        result.to_string(),
    )
    .map_err(|error| format!("无法保存就绪证据：{error}"))
}

/// 在真实 WebView 操作正式控件并观察结果；不产生候选或替换 IPC，失败写入证据，就绪后保留已选目标供截图。
pub const READY_SCRIPT: &str = r#"
(async () => {
  if (window.__ciSmokeStarted) return;
  window.__ciSmokeStarted = true;
  const { invoke } = window.__TAURI_INTERNALS__;
  const deadline = Date.now() + 90000;
  const sleep = () => new Promise(resolve => setTimeout(resolve, 100));
  const selection = () => ({
    version: document.querySelector('input[name="release"]:checked')?.value ?? null,
    target: { os: document.querySelector('#target-os')?.value, arch: document.querySelector('#target-arch')?.value }
  });
  const domPreview = () => ({
    selection: selection(),
    status: document.querySelector('#preview-panel')?.dataset.previewStatus,
    source: document.querySelector('.manifest-source')?.textContent?.trim() || null,
    required: [...document.querySelectorAll('[data-artifact-path]')].map(row => ({
      path: row.dataset.artifactPath,
      present: row.dataset.present === 'unknown' ? null : row.dataset.present === 'present',
      sha256: row.dataset.sha256 || null
    })),
    error: document.querySelector('#preview-panel [role="alert"]')?.textContent?.trim() || null
  });
  const samePreview = (a, b) => a.status === b.status && a.source === b.source && a.error === b.error
    && a.selection.version === b.selection.version
    && a.selection.target.os === b.selection.target.os && a.selection.target.arch === b.selection.target.arch
    && JSON.stringify(a.required) === JSON.stringify(b.required);
  const wait = async (label, probe, accepted) => {
    let observed;
    while (Date.now() < deadline) {
      observed = await probe();
      if (accepted(observed)) return observed;
      await sleep();
    }
    throw new Error(label + '超时：' + JSON.stringify(observed));
  };
  const setTarget = (id, value) => {
    const input = document.querySelector(id);
    if (!input || input.disabled) throw new Error('目标控件不可操作：' + id);
    input.value = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const search = value => {
    const input = document.querySelector('#release-query');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  let previews = [], clearedSelection = null, rejectedInputs = 0;
  try {
    const initial = await wait('真实官方目录', () => invoke('catalog_snapshot', { query: '' }), snapshot => {
      if (snapshot.status === 'error') throw new Error(snapshot.error ?? '目录加载失败');
      const radios = [...document.querySelectorAll('input[name="release"]')];
      return snapshot.status === 'ready' && snapshot.hasCatalog && !snapshot.stale
        && snapshot.releases.length > 0 && radios.length === snapshot.releases.length
        && document.querySelector('#catalog-status')?.textContent.includes('目录就绪');
    });
    const options = id => [...document.querySelector(id).options].map(option => option.value);
    if (JSON.stringify(options('#target-os')) !== JSON.stringify(['macos', 'windows', 'linux'])
        || JSON.stringify(options('#target-arch')) !== JSON.stringify(['x64', 'arm64'])) {
      throw new Error('系统与架构选项未完整提供');
    }
    const version = initial.releases[0].version;
    const select = () => {
      const radio = [...document.querySelectorAll('input[name="release"]')].find(radio => radio.value === version);
      if (!radio || radio.matches(':disabled')) throw new Error('发行版本不可选择');
      radio.click();
    };
    select();
    for (const [os, arch] of [['macos','x64'], ['macos','arm64'], ['windows','x64'], ['windows','arm64'], ['linux','x64'], ['linux','arm64']]) {
      setTarget('#target-os', os);
      setTarget('#target-arch', arch);
      await wait('真实清单 ' + os + '/' + arch,
        () => invoke('catalog_snapshot', { query: '', selection: { version, target: { os, arch } } }), snapshot => {
          if (snapshot.preview.status === 'error') throw new Error(snapshot.preview.error ?? '清单失败');
          return ['ready', 'missing'].includes(snapshot.preview.status) && samePreview(domPreview(), snapshot.preview);
        });
      if (selection().version !== version) throw new Error('改选目标静默修改发行版本');
      previews.push(domPreview());
    }
    // 直接跨真实 IPC 验证反序列化与业务校验，不能仅依赖界面控件限制输入。
    for (const invalid of [
      { version: '../node', target: { os: 'windows', arch: 'x64' } },
      { version, target: { os: 'linux', arch: 'mips' } },
      { version, target: { os: 'windows', arch: 'x64' }, format: 'zip' }
    ]) {
      let rejected = false;
      try { await invoke('prepare_preview', { selection: invalid, retry: false }); }
      catch { rejected = true; rejectedInputs++; }
      if (!rejected) throw new Error('真实 IPC 接受恶意选择输入');
    }
    search('__issue15-no-match__');
    await wait('搜索失配清除', () => invoke('catalog_snapshot', { query: '__issue15-no-match__' }), snapshot =>
      snapshot.hasCatalog && snapshot.releases.length === 0 && selection().version === null
        && document.querySelector('#preview-panel')?.dataset.previewStatus === 'unselected');
    clearedSelection = selection();
    search('');
    await wait('返回目录', () => invoke('catalog_snapshot', { query: '' }), snapshot =>
      snapshot.releases.length === initial.releases.length
        && document.querySelectorAll('input[name="release"]').length === initial.releases.length
        && [...document.querySelectorAll('input[name="release"]')].every(input => !input.matches(':disabled')));
    select();
    await wait('恢复草稿展示', () => invoke('catalog_snapshot', { query: '', selection: { version, target: { os: 'linux', arch: 'arm64' } } }), snapshot =>
      ['ready', 'missing'].includes(snapshot.preview.status) && samePreview(domPreview(), snapshot.preview));
    await invoke('ci_smoke_ready', { observation: {
      versions: [...document.querySelectorAll('input[name="release"]')].map(radio => radio.value),
      previews, selection: selection(), clearedSelection, rejectedInputs, reason: null
    } });
  } catch (error) {
    await invoke('ci_smoke_ready', { observation: { versions: [], previews, selection: null, clearedSelection, rejectedInputs, reason: String(error) } });
  }
})().catch(error => console.error('原生就绪证据失败', error));
"#;
