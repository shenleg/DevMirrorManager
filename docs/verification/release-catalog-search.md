# 票 14：发行目录浏览与搜索验证记录

本文记录本轮开发和实际桌面证据，不表示正式安装包、下载功能或跨平台验收通过。

## 环境

- 验证日期：2026-10-14；应用时间来自本机系统时间，不承诺独立授时。
- macOS 27.0.1（26A434）、Apple Silicon / `aarch64-apple-darwin`。
- Node.js 24.18.0、npm 11.16.0、Rust/Cargo 1.93.1，Xcode Command Line Tools。
- React 19.3.0、TypeScript 7.0.2、Vite 8.3.4、Vitest 5.0.4、Tauri Rust 2.12.3 / CLI 2.12.2 / JS 2.12.3、reqwest 0.13.5；完整依赖见锁文件。
- 从基线 `770987e` 实施；运行分支 `feat/release-catalog-search`。

## 实际桌面演示

运行 `npm run tauri dev`，通过 Orca `computer-use` 操作真实 macOS Tauri 窗口；不是 HTML 原型或浏览器模拟。

| 步骤 | 观察结果 |
| --- | --- |
| 打开空查询 | 官方目录加载成功，870 个发行版本，起始无选择；数值版本降序 |
| 输入 `  V22.1  ` | 14 个结果，包含 `v22.19.0` 到 `v22.1.0`，其中有 `v22.10.0` |
| 选 `v22.19.0`，再选 `v22.18.0` | 前者 radio 为 0、后者为 1，摘要仅显示 `v22.18.0` |
| 改搜 `24.10` | 1 个候选 `v24.10.0`，radio 未选；原选择清除并显示原因，没有自动改选 |
| 点击刷新目录 | 显示“正在刷新官方目录，当前展示已验证的旧数据”；完成后回到目录就绪，成功校验时间更新 |
| 核对历史 LTS 标记 | 官方 `false` 显示“无”，有代号显示代号，不推断当前生命周期支持 |

初次 accessibility `set-value` 没有触发 React 用户输入事件，未将其误报为搜索成功；随后聚焦窗口并使用真实输入，读取候选和选择摘要验证实际效果。自动化操作的 provider 回执不是单独通过依据，需结合后续可观察快照及截图。

最终实例重新启动后复验了上述交互，避免开发热更新保留旧会话闭包。已查看并保存实际截图：

- [空查询浏览官方目录](release-catalog-search/browse.png)
- [搜索与单选替换](release-catalog-search/search-selection.png)
- [搜索失配清除且不自动改选](release-catalog-search/selection-cleared.png)
- [主动刷新加载中](release-catalog-search/refresh-loading.png)
- [主动刷新完成](release-catalog-search/refresh-ready.png)

最终刷新完成时成功校验时间由 `01:20:56` 更新至 `01:33:05`（界面本地时间）。公网此次具体结果数量仅为观察值，不是生产常量或固定测试期望。

## 自动化测试与检查

测试通过预先确认的 Seam：Rust 应用命令/快照/通知、前端应用公开用户操作/展示快照、React 用户可见操作。受控 Adapter 只替换官方网络或外部 IPC，不 mock 内部函数；磁盘缓存使用独立临时目录。固定时间直接用于测试，不建设通用时钟框架。

已运行的切片覆盖：

- 空白/`v`/`V`、空查询、`22.1` → `22.10`、`24.10.0 > 24.9.0`；查询间不互相修改状态。
- 异常目录、无效/重复发行标识、非法 UTF-8、可选元数据未知与明确无 LTS 标记。
- 缓存跨重开、一小时边界、手动条件刷新、304 续期、孤立304、200 缺少新 ETag。
- 缓存损坏/不兼容/未来时间保护、缓存位置不可用、加载/失败旧实体保留、不续期、通知与重复刷新。
- 单选替换、失配清除、不恢复、查询乱序、通知补读、断开/重连、初始化期间输入、IPC 失败及主动恢复。
- 界面加载、结果、空结果、原因/主动刷新、缓存告警、旧数据、浏览器明确拒绝伪造目录。

### 最终检查结果

2026-10-14 本机时间 `01:34` 执行完整测试与构建：**前端 22 个、Rust 12 个测试全部通过，共 34 个**。随后修复最后两处 rustfmt 格式差异并重新执行格式及 Clippy 检查，全部通过。

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 2 个文件、22 个测试通过 |
| `npm run build` | 通过，Vite 生产资源构建成功 |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml` | 通过 |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | 12 个应用 Interface 测试通过；无额外私有单元测试 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | 修正格式后通过 |
| `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | 通过 |
| 工作区及暂存区 `git diff --check` | 通过 |
| `npm run tauri dev` | 真正桌面进程启动，并完成用户操作验证 |

### 代码审查

以 `770987e` 为基点对暂存实现进行了 Standards / Spec 双轴审查（尚未提交，因此不用空的 `770987e...HEAD` 差异冒充审查对象）。

- Standards：1 项明确注释问题已修正——公开操作不再错误承诺隔离订阅者异常；2 项低优先级建议（共享测试夹具、LTS 专用类型）暂不引入额外抽象。
- Spec：未发现可确认的业务错误或范围扩大；指出 Windows 运行证据及最终截图/测试记录尚缺。本记录已补齐后者，Windows 仍明确未验证。
- 没有因此宣布全平台或正式安装包验收完成。

中途环境/构建问题：固定 Rust 工具链初次下载超时，随后成功安装同版本；首个 Rust 测试确认缺少应用 Interface 后开始实现。正式宿主初次编译缺少必需 PNG 图标，补齐后通过；前端入口尚未写完时构建失败，入口完成后重新构建。Clippy 曾指出测试夹具类型复杂度，改为具名类型后通过。未改镜像或绕过 TLS/权限。

## GitHub Actions 四平台验证（续轮）

用户更新规则后，多平台验证改由 `.github/workflows/ci.yml` 执行，不再规划其他机器的手动开发验证。**同一提交 `b9db4de3d7dd8ca3171eaece318855abc84fe74d` 的四平台结果全部成功，artifact 已下载，环境/结果 JSON 与截图均已核对。**

最终运行：[GitHub Actions 38518510776](https://github.com/shenleg/DevMirrorManager/actions/runs/38518510776)。各平台均执行34个业务测试、9个Playwright场景、release打包及独立原生冒烟。Windows两个架构的真实应用E2E全部通过，没有降级或跳过。

| 平台 | runner | Rust host | 构建及原生结果 | 应用E2E |
| --- | --- | --- | --- | --- |
| macOS ARM64 | `macos-latest` | `aarch64-apple-darwin` | `.app`/ARM64 `.dmg`、原生冒烟及窗口截图通过 | 不使用macOS tauri-driver；此前本机真实操作及浏览器验证已记录 |
| macOS x64 | `macos-15-intel` | `x86_64-apple-darwin` | `.app`/x64 `.dmg`、原生冒烟及窗口截图通过 | 同上，不冒称macOS WebDriver覆盖 |
| Windows x64 | `windows-latest` | `x86_64-pc-windows-msvc` | 正式exe、NSIS、原生冒烟及窗口截图通过 | 真实搜索、单选替换、失配清除、刷新全部通过 |
| Windows ARM64 | `windows-11-arm` | `aarch64-pc-windows-msvc` | 原生ARM64 exe、NSIS验证产物、冒烟及窗口截图通过 | 同样真实通过，不宣称新增正式发行支持 |

已审阅并保存的代表截图：
- [macOS ARM64 原生窗口](release-catalog-search/ci-38518510776/macos-arm64.png)
- [macOS x64 原生窗口](release-catalog-search/ci-38518510776/macos-x64.png)
- [Windows x64 搜索与单选](release-catalog-search/ci-38518510776/windows-x64-selection.png) / [失配清除](release-catalog-search/ci-38518510776/windows-x64-cleared.png)
- [Windows ARM64 搜索与单选](release-catalog-search/ci-38518510776/windows-arm64-selection.png) / [失配清除](release-catalog-search/ci-38518510776/windows-arm64-cleared.png)

完整日志、浏览器报告、Windows刷新截图、环境与结果JSON、构建包见该运行的 `evidence-*` / `build-*` artifacts（保留14天）；不在Git仓库保存可执行文件。下载内容放入新的独立目录，仅读取证据，不在本机运行其他架构产物。

本轮新增：9个隔离浏览器用户操作测试（本机通过）、feature隔离的真实WebView就绪检查、macOS/Windows目标窗口截图，以及Windows原生WebDriver用户操作脚本。已有34个业务测试保持通过。原生本机冒烟先因缺就绪协议失败，再因旧截图接口不兼容SDK失败，改用ScreenCaptureKit且初始化WindowServer后实际通过，截图已查看。

依赖来源纠正：上轮安装沿用了本机`registry.npmmirror.com`，把来源描述为“官方registry”不准确；本轮锁文件改为`registry.npmjs.org`，显式官方来源`npm ci`成功核验完整性，未修改全局npm设置。

正式release打包本机遇到宏动态库加载错误`mis-aligned LINKEDIT string pool`；全新独立产物目录也复现，排除单纯旧缓存。保持同一目录与工具链，仅启用编译期依赖调试信息后成功生成正式`.app`与`.dmg`（13.07 MiB / 4.58 MiB）。已在`profile.release.build-override`记录该兼容性设置，未开启应用debug或更换工具链；四平台最终CI结果见上表。

### Windows E2E 失败与实际修复

- 首轮 `38508193346`：两个macOS通过；Windows驱动准备失败。修正新版`Microsoft Edge WebDriver`版本输出和官方ARM64归档名；按微软规则只接受版本号前三段一致的驱动。
- `38512110450`：Windows驱动准备通过，但两架构`POST /session`超时，业务断言尚未执行。未因超时跳过E2E或将ARM64标为不支持。
- 最终 `38518510776`：两种Windows runner均记录了原始 `High` (`S-1-16-12288`) 和内层 `Medium` (`S-1-16-8192`) 权限等级；仅改变测试链启动权限后，正式release应用的全部E2E通过。与[微软新版WebView2的高完整性限制](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security#recommended-privilege-level-for-webview2-host-applications)一致。
- CI使用用户明确授权的官方`gsudo v2.6.1`，固定SHA-256；不修改ACL、注册表、运行时、应用网络来源或系统保护，不在本机执行Windows工具。正式应用未增加常驻远程调试。
- Windows x64运行时/驱动为`153.0.4234.48`，ARM64为`154.0.4258.53`。结果JSON确认`  V22.1  `得到真实候选、单选替换、改搜`24.10`清除以及刷新时间更新。

### 收尾复跑出现截图超时（待复验）

纯文档提交`d03c48d`的[运行38524262778](https://github.com/shenleg/DevMirrorManager/actions/runs/38524262778)中，Windows两架构和macOS ARM64通过，macOS x64的权威WebView就绪成功，但目标窗口截图超时，capture.log为空。不能据此区分Swift解释器冷编译与捕获API等待，亦不将其冒称功能回归已确认。

当前修复将Swift辅助程序编译单独记录（有界120秒），窗口捕获仍保持30秒硬门槛，增加实际API阶段日志。本机ARM64原生冒烟通过，其他平台仅在CI复验。票据暂重开，等待新提交四平台结果；上述历史成功证据没有被改写。

## 未验证与范围外

- 四个最新runner平台已完成原生验证，但不能据此推断Windows 10 22H2、macOS 13等产品最低系统基线都通过；这些精确基线仍需后续交付验收。
- CI已生成`.app`、`.dmg`和NSIS构建产物；安装/升级/卸载、首次系统弹窗、WebView2安装行为、Developer ID签名/公证仍未验证。macOS仅使用ad-hoc签名，不宣称发行者认证或正式安装包交付验收。
- 托盘、通知、权限弹窗、全局快捷键、自动更新、高DPI、深色模式、输入法等不由当前CI自动证明；未新增这些功能或承诺。
- 下载、目标文件清单、镜像准备、受支持 LTS 筛选及 nvm 消费链路：未实现；目录成功不等于镜像可用。
- 网络/解析故障和条件响应由固定数据自动化验证；没有修改生产来源来制造故障，也没有宣称本机实际断网完成全部故障演示。
