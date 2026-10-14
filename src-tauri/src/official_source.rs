//! 固定官方目录与发行清单的生产网络 Adapter，统一限制重定向、等待时间与响应大小。
use crate::manifest::ReleaseVersion;
use async_trait::async_trait;
use reqwest::{
    header::{ETAG, IF_NONE_MATCH},
    redirect::Policy,
    Client, StatusCode,
};
use std::time::Duration;

/// 唯一允许访问的发行目录；调用者不能指定来源或镜像地址。
pub const OFFICIAL_CATALOG: &str = "https://nodejs.org/dist/index.json";
// 当前官方目录约 325 KiB；留出增长空间，同时限制不可信响应的内存占用。
pub(crate) const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

/// 官方网络响应；304 不携带新目录实体。
pub enum CatalogResponse {
    Modified { body: Vec<u8>, etag: Option<String> },
    NotModified,
}

/// 官方目录的窄内部 Seam，不接受任意网络地址。
#[async_trait]
pub trait CatalogSource: Send + Sync {
    /// 获取目录；etag 为已校验实体的条件标记，返回响应，联网或协议错误返回原因。
    async fn fetch(&self, etag: Option<&str>) -> Result<CatalogResponse, String>;
}

/// 官方清单的窄外部 Seam；只能请求经过应用校验的发行版本。
#[async_trait]
pub trait ManifestSource: Send + Sync {
    /// 获取完整清单；version 为目录成员的规范发行标识，返回原始字节，网络或协议异常返回原因。
    async fn fetch(&self, version: &ReleaseVersion) -> Result<Vec<u8>, String>;
}

/// 只访问 Node.js 官方目录与清单的生产 Adapter，使用系统信任与代理配置。
pub struct OfficialSource {
    client: Client,
}

impl OfficialSource {
    /// 创建官方客户端；无参数，返回 Adapter，TLS/客户端初始化失败返回原因；不绕过系统证书验证。
    pub fn new() -> Result<Self, String> {
        let client = Client::builder()
            .redirect(Policy::none())
            // 有界等待让网络失败可反馈；这不是用户网络 SLA，不提供自动重试。
            .timeout(Duration::from_secs(30))
            .user_agent("nodejs-downloader/0.1.0")
            .build()
            .map_err(|e| format!("官方网络客户端初始化失败：{e}"))?;
        Ok(Self { client })
    }
}

#[async_trait]
impl CatalogSource for OfficialSource {
    /// 请求固定官方来源；etag 控制条件请求，返回有界响应，非200/304、超时或正文异常返回原因。
    async fn fetch(&self, etag: Option<&str>) -> Result<CatalogResponse, String> {
        let mut request = self.client.get(OFFICIAL_CATALOG);
        if let Some(tag) = etag {
            request = request.header(IF_NONE_MATCH, tag);
        }
        let response = request
            .send()
            .await
            .map_err(|e| format!("无法连接官方版本目录：{e}"))?;
        match response.status() {
            StatusCode::NOT_MODIFIED => return Ok(CatalogResponse::NotModified),
            StatusCode::OK => {}
            status => {
                return Err(format!(
                    "官方目录返回 HTTP {status}；不跟随重定向，请主动刷新"
                ))
            }
        }
        let etag = response
            .headers()
            .get(ETAG)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let body = bounded_body(response).await?;
        Ok(CatalogResponse::Modified { body, etag })
    }
}

#[async_trait]
impl ManifestSource for OfficialSource {
    /// 获取固定官方清单；version 为规范目录成员，返回原始字节；非 200、重定向、超时或超出安全上限时返回原因，不自动重试。
    async fn fetch(&self, version: &ReleaseVersion) -> Result<Vec<u8>, String> {
        let response = self
            .client
            .get(crate::manifest::source_url(version))
            .send()
            .await
            .map_err(|error| format!("无法连接官方清单：{error}"))?;
        if response.status() != StatusCode::OK {
            return Err(format!(
                "官方清单返回 HTTP {}；不跟随重定向，请主动重试",
                response.status()
            ));
        }
        bounded_body(response).await
    }
}

async fn bounded_body(mut response: reqwest::Response) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|size| size > MAX_BODY_BYTES as u64)
    {
        return Err("官方响应超过安全大小限制（4 MiB）".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("官方正文读取失败：{error}"))?
    {
        // 声明长度不可信；分块响应也必须在追加前检查实际累计大小。
        if body.len().saturating_add(chunk.len()) > MAX_BODY_BYTES {
            return Err("官方响应超过安全大小限制（4 MiB）".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}
