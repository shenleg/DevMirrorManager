//! 校验官方发行标识并生成 Rust 权威候选，目录不证明镜像文件存在。
use semver::Version;
use serde::{Deserialize, Serialize};

/// 已识别的发行版本；可选元数据不代表当前生命周期支持状态。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Release {
    pub version: String,
    pub date: Option<String>,
    pub lts: Option<serde_json::Value>,
}

/// 校验官方目录；body 为原始JSON字节，返回降序发行版本和可选元数据告警，必需元数据非法返回原因。
pub(crate) fn parse(body: &[u8]) -> Result<(Vec<Release>, Vec<String>), String> {
    let rows: Vec<serde_json::Value> =
        serde_json::from_slice(body).map_err(|e| format!("官方版本目录解析失败：{e}"))?;
    let mut releases = Vec::new();
    let mut versions = std::collections::HashSet::new();
    let mut unknown_metadata = false;
    for row in rows {
        let version = row
            .get("version")
            .and_then(|v| v.as_str())
            .ok_or("官方版本目录缺少发行版本标识")?;
        let parsed = Version::parse(version.strip_prefix('v').ok_or("发行版本缺少 v 前导标记")?)
            .map_err(|e| format!("无效的发行版本 {version}：{e}"))?;
        // 正式发行标识只接受规范的 vX.Y.Z，避免可选后缀被误当作正式发行路径。
        if !parsed.pre.is_empty() || !parsed.build.is_empty() || version != format!("v{parsed}") {
            return Err(format!("不是完整正式发行版本：{version}"));
        }
        if !versions.insert(version.to_owned()) {
            return Err(format!("官方目录含重复发行版本：{version}"));
        }
        let date = row
            .get("date")
            .and_then(|v| v.as_str())
            .filter(|value| {
                chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
                    .is_ok_and(|date| date.to_string() == *value)
            })
            .map(str::to_owned);
        let lts = match row.get("lts") {
            Some(serde_json::Value::Bool(false)) => Some(serde_json::Value::Bool(false)),
            Some(serde_json::Value::String(value)) if !value.trim().is_empty() => {
                Some(serde_json::Value::String(value.clone()))
            }
            _ => None,
        };
        // 可选元数据拉取失败是上游允许的情况，不能因此隐藏完整发行标识。
        unknown_metadata |= date.is_none()
            || (lts.is_none() && row.get("lts") != Some(&serde_json::Value::Bool(false)));
        releases.push((
            parsed,
            Release {
                version: version.into(),
                date,
                lts,
            },
        ));
    }
    releases.sort_by(|a, b| b.0.cmp(&a.0));
    let warnings = if unknown_metadata {
        vec!["部分发行版本的日期或历史 LTS 标记未知；不影响版本搜索，不代表当前受支持状态。".into()]
    } else {
        vec![]
    };
    Ok((
        releases.into_iter().map(|(_, release)| release).collect(),
        warnings,
    ))
}
