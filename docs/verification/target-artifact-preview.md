# 票15：目标平台与真实必需文件预览验证

## 范围与状态

本票实现 macOS / Windows / Linux × x64 / ARM64 的目标预览。文件存在性与提交所需的文件依据由 Rust 根据成功解析的官方 `SHASUMS256.txt` 判定，不代表归档已下载、通过 SHA-256 校验或镜像可用。

本机全量检查、macOS ARM64 正式打包与真实原生六目标复验已通过。四平台 CI 尚未运行，不据此标记验收完成；票 15 保持 `claimed`，等待授权推送及跨平台证据。

## 已确认的测试范围

- Rust 应用公开 Interface：命令、快照、通知及原始字节读取；仅在外部清单来源注入受控原始字节，验证真实解析与领域规则。
- 前端应用 Interface、正式 React 界面及浏览器：仅替换外部 IPC，验证草稿协调与展示，不将其称为 Rust 或官方清单证据。
- 原生：真实 WebView、正式 IPC 与官方清单，核对六目标的页面事实。Windows 使用真实 WebDriver 操作；macOS 使用独立 `ci-smoke` 构建的界面观察协议。
- 不新增原生清单夹具服务器、不改变正式来源。确定性网络／解析失败与主动重试由前两层验证，原生官方请求失败必须报告失败，不能转为“目标缺文件”。
- 固定清单样例仅为测试数据，不冒充官方某个发行版本的事实。

## TDD 记录

### 原生验收首次失败

在实现预览前，为原生冒烟入口增加六目标、改选目标保留发行版本、搜索失配保留目标的验收要求，再启动原有 `ci-smoke` 二进制。

```bash
node scripts/ci/native-smoke.mjs src-tauri/target-ci/release/nodejs-downloader .local-validation/issue15-red-native
```

实际退出码为 `1`，原因：`原生报告未验证六目标、目标保留与发行版本保留`。旧应用已有的目录就绪不能满足新验收，不会被沿用为本票通过证据。

### Rust 与前端的实际 red → green

- Rust 逐条先观察失败，再增加固定六目标规则、hash／记录验证、不安全路径拒绝、重复路径拒绝及解析入口大小上限。其他由前序实现自然满足的回归只记录实际通过，不虚构 red。
- 前端先观察无目标／准备入口、旧目标响应覆盖、失配未补读、清单错误误入目录区域及长 hash 横向溢出，再逐条修复。
- 收尾新增回归实际先失败：重连仍显示旧 IPC 原因；同发行版本准备期间切目标导致漏读成功／吞掉错误；准备失败后切目标丢失重试入口；已有成功权威事实仍显示旧传输错误；A→B→A 后旧 A 的失败污染新准备。修复后前端应用 Interface 的 26 项全部通过。

## 本机最终验证

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test --if-present` | 38 项通过（26 应用 Interface + 12 正式 React 界面） |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | 22 项通过（12 目录 + 10 清单预览） |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | 通过 |
| `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --features ci-smoke -- -D warnings` | 通过 |
| `npm run test:browser -- --output=artifacts/browser/issue15-main-final --reporter=list` | 14 项通过 |
| `npm run tauri build` | 生成 macOS ARM64 `.app` / `.dmg`，ad-hoc 签名；未公证，不代表安装验收 |
| 独立 `ci-smoke` 构建 + `native-smoke.mjs` | 最终复验通过，窗口截图已查看 |

最终原生复验从本次官方目录选取 `v26.11.1`，不是代码中固定的“最新”版本。其清单成功解析，本轮六目标全部 `ready`，页面的精确必需路径／hash 与 Rust 快照一致；这只是该次官方清单的观察，不代表所有发行版本都有全部六目标。搜索失配保留 Linux/ARM64，改选目标保留发行版本，真实 IPC 拒绝恶意发行标识、非法架构及自选格式共 3 类输入。

本轮持久证据：
- [macOS ARM64 原生窗口](target-artifact-preview/local-20261014/macos-arm64.png)
- [原生结果与六目标事实](target-artifact-preview/local-20261014/native-result.json)
- [宽窗口双归档预览](target-artifact-preview/local-20261014/browser-preview-wide.png)
- [最小窗口预览](target-artifact-preview/local-20261014/browser-preview-minimum.png)
- [最小窗口清单失败／重试](target-artifact-preview/local-20261014/browser-preview-error-minimum.png)

浏览器截图来自受控 IPC 展示样例，路径、hash、日期与清单状态不作为官方事实。1050×780、390×844、360×480 无横向溢出；窄窗口可纵向滚动访问完整文件、来源与重试控件。原生截图只捕获真实窗口可见区域，不冒充全页面截图。

## 代码评审

评审基线固定为 `64c31faba44d40121a982d7cd86c0300ad277d6f`，首轮评审提交为 `66fa7ac`。

- Standards：两项原生观察脚本文档注释问题已补齐，并说明 React 原生 setter 的 why；首次准备／重试共用 `prepareSelected`，收口重复竞态处理。局部测试夹具重复仅为非阻塞建议，因公开 seam 与 React `act` 控制不同而暂保留，不新增通用测试框架。
- Spec：三项复现均先补失败回归再修复：重连后 `idle` 提供用户主动“准备清单”入口，不自动获取；目录成员校验失败时仅由无发行版本的同查询／目标权威快照确认失配并清草稿；同发行版本已有权威加载／结果时，迟到 IPC 回执不能降级或遮盖它。Rust 输入校验未放松，恢复读取仍验证完整身份、revision 下界与连接世代。未发现范围外下载功能。
- 修复后本机重新全量验证：前端 **44 项**（31 应用 Interface + 13 正式界面）、Rust 22 项、浏览器 14 项全部通过；正式 ARM64 打包与独立原生复验通过。新增[原生窗口](target-artifact-preview/review-20261014/macos-arm64.png)、[原生结果](target-artifact-preview/review-20261014/native-result.json)、[最小窗口](target-artifact-preview/review-20261014/browser-preview-minimum.png)和[失败／重试](target-artifact-preview/review-20261014/browser-preview-error-minimum.png)均已查看，早期证据未覆盖。
- 固定提交 `983da44` 的复查确认原三项 Spec 已修复，但发现提取读取辅助函数后新微任务间隔可让旧查询清除新选择。公开回归先失败再修复：普通／恢复读取返回后、发布前重新核对读取世代、连接和 revision 下界。补充回归验证高 revision 通知落在该间隔时仍会补读；应用 Interface 34 项通过。
- 微任务修复后最终全量复验：前端 **47 项**（34 应用 Interface + 13 正式界面）、浏览器 14 项通过，macOS ARM64 正式打包与原生六目标复验通过。最终[窗口截图](target-artifact-preview/push-20261014/macos-arm64.png)已查看，[原生结果](target-artifact-preview/push-20261014/native-result.json)保留完整事实。原 Rust 22 项及包含原生 feature 的测试／Clippy 复验通过。Standards 复查无硬违规，保留一项非阻塞局部测试夹具重复；Spec 原发现及身份竞态已确认修复。
- 用户已授权评审收尾后推送功能分支跑现有四平台 CI；授权不包括推送 `main`、修改 CI 或 CI 失败后的额外重推。

## 后续下载接入约束

票 16 接入真实下载时，应通过同一 Rust `Application::snapshot_with_selection` 取得权威必需文件与清单条件，不能仅信任前端的 `ready` 或重新拼一套支持规则。`Application::raw_manifest` 提供成功实体的原始字节，后续原样保存必须复用它；预览中的预期 SHA-256 不能替代对实际归档字节的校验。本票没有创建下载请求或文件任务。

## 验证环境

- 本机 Rust host：`aarch64-apple-darwin`，只验证 macOS ARM64。
- Node.js：`v24.18.0`；npm：`11.16.0`；Rust：`1.93.1`。
- 沿用 `.github/workflows/ci.yml` 的四宿主矩阵，`fail-fast: false`。Linux 是分发目标，不因此新增 Linux 应用宿主验证承诺。
- 其他宿主只通过 GitHub Actions 验证；推送另行取得用户授权，不修改 CI 配置。

## 未验证及范围外

尚未获得本票四平台构建、原生截图与 Windows E2E 证据。安装／卸载、权限弹窗、签名公证、最低系统基线、高 DPI、深色模式和输入法不由本轮自动化推断。下载、输出目录、归档完整性校验、镜像索引与 nvm 消费属于后续票。
