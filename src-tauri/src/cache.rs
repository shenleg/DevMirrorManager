//! 独立保存官方目录缓存；不保存单选、下载任务或镜像可用性。
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};

// 应用策略而非官方 SLA；Unix 毫秒与前端展示及测试时间一致。
pub(crate) const MAX_AGE_MS: u64 = 60 * 60 * 1000;
pub(crate) const CACHE_FILE: &str = "release-catalog.json";

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct CachedCatalog {
    pub format_version: u32,
    pub body: String,
    pub etag: Option<String>,
    pub checked_at: u64,
}

/// 读取专用缓存；directory 为应用缓存位置，返回缓存或不存在，读取/解析失败返回原因且不修改原文件。
pub(crate) fn read(directory: &Path) -> Result<Option<CachedCatalog>, String> {
    match fs::read(directory.join(CACHE_FILE)) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| format!("目录缓存解析失败，原文件保留：{e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("目录缓存读取失败，原文件保留：{e}")),
    }
}

/// 保存经校验的缓存；directory 为专用位置，cached 为新实体，成功无返回数据，目录/序列化/写入失败返回原因。
pub(crate) fn write(directory: &Path, cached: &CachedCatalog) -> Result<(), String> {
    fs::create_dir_all(directory).map_err(|e| format!("无法创建目录缓存位置：{e}"))?;
    let bytes = serde_json::to_vec(cached).map_err(|e| format!("目录缓存序列化失败：{e}"))?;
    fs::write(directory.join(CACHE_FILE), bytes).map_err(|e| format!("目录缓存写入失败：{e}"))
}
