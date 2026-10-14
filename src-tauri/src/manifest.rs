//! 集中定义目标选择、固定必需文件与官方清单事实；清单齐备不代表归档已校验或镜像可用。
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Arc};

/// 已校验的正式发行标识；仅应用可构造，来源不能收到任意路径。
#[derive(Clone, Debug)]
pub struct ReleaseVersion(String);

impl ReleaseVersion {
    /// 读取规范发行标识；无参数，返回 vX.Y.Z 文本，不抛异常。
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// 校验发行标识；version 为候选文本，返回不可任意构造的标识，非规范正式发行版本返回原因；目录成员关系由应用另行确认。
    pub(crate) fn validated(version: &str) -> Result<Self, String> {
        crate::catalog::validate_version(version)?;
        Ok(Self(version.into()))
    }
}

/// 用户可浏览的目标系统，与宿主系统无关。
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetOs {
    #[default]
    Macos,
    Windows,
    Linux,
}

/// 用户可浏览的 CPU 架构，与宿主架构无关。
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetArch {
    #[default]
    X64,
    Arm64,
}

/// 封闭的目标平台输入，不接收格式、变体、路径或来源。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    pub os: TargetOs,
    pub arch: TargetArch,
}

/// 前端的未提交草稿；默认仅决定可见选项，不选择发行版本。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    pub version: Option<String>,
    pub target: Target,
}

/// 固定必需的发行目录相对文件名；待确认时不推断存在性或 hash。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequiredArtifact {
    pub path: String,
    pub present: Option<bool>,
    pub sha256: Option<String>,
}

/// 清单依据的权威目标预览；ready 仅说明后续准备所需依据齐备。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub selection: Selection,
    pub status: String,
    pub source: Option<String>,
    pub required: Vec<RequiredArtifact>,
    pub error: Option<String>,
}

/// 已验证的完整清单；原始字节与用于匹配的路径/hash 分开保存，不能从匹配结果重建官方正文。
pub(crate) struct Manifest {
    pub raw: Arc<[u8]>,
    pub entries: HashMap<String, String>,
}

/// 按发行版本保存的进程内准备状态；没有实体即 idle，失败实体只能由显式重试替换。
pub(crate) enum ManifestState {
    Loading,
    Error(String),
    Ready(Manifest),
}

/// 构造固定官方清单地址；version 为已校验发行标识，返回完整 URL，不联网、不抛异常。
pub(crate) fn source_url(version: &ReleaseVersion) -> String {
    format!(
        "https://nodejs.org/dist/{}/SHASUMS256.txt",
        version.as_str()
    )
}

/// 验证完整官方清单；body 为未经改写的响应，返回共享原始字节与规范小写 hash；超限、编码/记录/hash/路径非法或重复时返回原因。
pub(crate) fn parse(body: Vec<u8>) -> Result<Manifest, String> {
    // 外部来源可能不是生产 HTTP Adapter，不能只依赖网络层的长度检查。
    if body.len() > crate::official_source::MAX_BODY_BYTES {
        return Err("官方清单超过安全大小限制（4 MiB）".into());
    }
    let text = std::str::from_utf8(&body).map_err(|_| "官方清单不是有效 UTF-8")?;
    let mut entries = HashMap::new();
    for line in text.lines() {
        let (hash, path) = line.split_once("  ").ok_or("官方清单记录格式无效")?;
        if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) || path.is_empty()
        {
            return Err("官方清单 hash 或记录格式无效".into());
        }
        // 不解码、不修复路径：百分号、URL/盘符、反斜杠及非 ASCII 别名都可能改变后续 URL 或文件系统语义。
        if !path
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-/".contains(&byte))
            || path
                .split('/')
                .any(|segment| segment.is_empty() || segment == "." || segment == "..")
        {
            return Err("官方清单含不安全的相对路径".into());
        }
        if entries
            .insert(path.into(), hash.to_ascii_lowercase())
            .is_some()
        {
            return Err(format!("官方清单含重复路径：{path}"));
        }
    }
    if entries.is_empty() {
        return Err("官方清单为空".into());
    }
    Ok(Manifest {
        raw: body.into(),
        entries,
    })
}

/// 计算目标预览；selection 的发行版本须由应用校验，state 为该发行版本的共享清单状态；返回固定要求与确认结果，不联网、不抛异常，准备错误保留在预览中。
pub(crate) fn preview(selection: Selection, state: Option<&ManifestState>) -> Preview {
    let Some(version) = &selection.version else {
        return Preview {
            selection,
            status: "unselected".into(),
            source: None,
            required: vec![],
            error: None,
        };
    };
    let os = match selection.target.os {
        TargetOs::Macos => "darwin",
        TargetOs::Windows => "win",
        TargetOs::Linux => "linux",
    };
    let arch = match selection.target.arch {
        TargetArch::X64 => "x64",
        TargetArch::Arm64 => "arm64",
    };
    let formats: &[&str] = match selection.target.os {
        TargetOs::Windows => &["7z"],
        _ => &["tar.xz", "tar.gz"],
    };
    // 这里只列出固定要求，存在性必须由完整路径匹配清单，不能用相似变体替代。
    let mut required = formats
        .iter()
        .map(|format| RequiredArtifact {
            path: format!("node-{version}-{os}-{arch}.{format}"),
            present: None,
            sha256: None,
        })
        .collect::<Vec<_>>();
    let (status, error) = match state {
        None => ("idle", None),
        Some(ManifestState::Loading) => ("loading", None),
        Some(ManifestState::Error(reason)) => ("error", Some(reason.clone())),
        Some(ManifestState::Ready(manifest)) => {
            for file in &mut required {
                file.sha256 = manifest.entries.get(&file.path).cloned();
                file.present = Some(file.sha256.is_some());
            }
            (
                if required.iter().all(|file| file.present == Some(true)) {
                    "ready"
                } else {
                    "missing"
                },
                None,
            )
        }
    };
    Preview {
        source: Some(format!("https://nodejs.org/dist/{version}/SHASUMS256.txt")),
        selection,
        status: status.into(),
        required,
        error,
    }
}
