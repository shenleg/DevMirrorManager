# 第一版桌面交付的安装、签名与更新要求

Type: grilling
Labels: wayfinder:grilling
Status: resolved
Blocked by: 07
Assignee: collin

## Question

为了形成可交给开发执行的第一版 Tauri 桌面下载器规格，哪些面向 macOS/Windows 最终用户的交付要求必须在实现前明确：安装包格式、安装与卸载范围、macOS 签名与公证、Windows 签名、升级或自动更新及首次运行限制？请区分第一版必须确定的约束与可推迟到实际发布阶段的事项；不得仅凭桌面应用惯例默认纳入签名、安装或更新功能。

## Answer

用户于 2026-10-13 确认以下第一版桌面交付边界。本答案规定开发规格必须包含的要求，不表示已构建、安装、签名或通过兼容性验收，也不授权实际发布。

### 交付对象、运行平台与安装包

- 第一版面向本人及少量内部使用者，提供可直接安装运行的构建产物，不要求使用者搭建开发环境；不进入应用商店，不公开发布。
- 下载器支持 macOS Apple Silicon、macOS Intel 和 Windows x64；Windows ARM64 暂不纳入验收。下载器的运行平台与 Node.js 分发文件的目标平台分开，运行平台不限制已约定的下载目标范围。
- 产品支持下限为 macOS 13，以及 Windows 10 22H2 / Windows 11。不承诺更老系统；这些是需要原生构建和测试验证的产品约束，不是直接采用 Tauri 的理论最低要求。Windows 系统维护与安全更新由使用者负责，应用可运行不代表操作系统仍受完整支持，也不保证未来系统版本自动兼容。
- macOS 分别交付 Apple Silicon 和 Intel 的 DMG，用户将其中的 `.app` 拖入 Applications；第一版不做 Universal 包。
- Windows 交付 x64 NSIS `.exe`，采用当前用户安装。应用本体按无需管理员权限设计，不同时提供 MSI 或便携版；运行时依赖能否安装仍受权限和组织策略约束。
- 延续 [前端技术栈与下载引擎的职责边界](07-implementation-boundaries.md)：macOS 与 Windows 分别在原生环境验证和打包，不承诺从 macOS 可靠地产出所有 Windows 安装包。

### 签名与首次运行

- macOS 内部版采用 ad-hoc 代码签名，暂不要求 Apple Developer ID 签名或公证，不以购买 Apple Developer 会员或配置公证凭证为开发前提。ad-hoc 不等同于 Developer ID 签名或公证，不能声称系统已认可其发行者或保证无安全提示。
- Windows 内部版暂不要求发行者代码签名或签名证书，接受可能出现 SmartScreen 等提示；不保证无签名安装包能在所有设备运行，正式签名也不等于完全消除提示。
- 随交付产物提供首次打开说明。macOS 仅说明在用户确认信任且系统允许时，使用 Privacy & Security 中的逐应用允许打开流程；Windows 说明实际提示及限制。不得要求全局关闭 Gatekeeper、SmartScreen、Smart App Control 或其他系统保护。
- 系统判定恶意、凭证撤销或组织策略禁止运行时，不承诺绕过；是否允许由使用者与 IT 决定。任意受管设备均可安装运行不属于第一版验收承诺。

### Windows WebView2 与安装范围

- 安装器检测并复用已有 WebView2；缺少时使用官方 bootstrapper 联网安装。不随包携带离线安装器或固定版运行时，不承诺完全离线安装。
- 网络、权限或组织策略造成依赖安装失败时，明确报告失败并提供官方安装指引，不宣称应用已成功安装并可用。应用本体的当前用户安装不意味着依赖安装在所有环境下都无需额外授权。
- 第一版只安装应用及必要运行时，不添加开机启动、后台服务、命令行 PATH 或文件关联，不修改 nvm 配置或系统安全设置。
- 下载器不以管理员身份运行，仅在用户明确选择的输出目录准备镜像，沿用已确定的最小权限和路径校验边界。
- Windows 提供普通启动入口与卸载入口；macOS 按 `.app` 的常规方式移除。不新增自动清理镜像或“一键卸载并删除下载内容”。

### 手动更新、升级与数据保留

- 第一版不做应用内自动更新，也不做联网检查应用新版本；使用者自行获取新安装包并手动升级或替换应用。刷新 Node.js 上游版本目录不属于应用自身更新，仍是既定业务需求。
- 升级前先结束下载工作并退出旧版，不支持运行中热升级，不静默强杀正在运行的下载器。安装器若检测到占用，应要求退出或阻止替换。
- 升级保留用户级应用数据；卸载默认保留应用数据及用户选定输出目录中的镜像内容。通过稳定的应用数据目录身份与安装、卸载行为实现并测试该承诺，不能仅凭 Tauri 的默认行为推断数据必然保留。具体应用标识符由实现阶段确定，后续升级不得无迁移地改变其数据路径语义。
- 升级后不自动启动网络任务；此前异常退出的任务仍按 [下载任务的恢复、失败与完成语义](06-download-lifecycle.md) 标为中断，用户手动重试从头下载。

### 状态兼容与异常处理

- 同一持久化状态格式正常读取；第一版不承诺任意旧版状态都能自动迁移，也不保证回退旧版能读取新版状态。
- 状态格式无法识别、不兼容或损坏时，保护原状态文件并明确提示，不静默清空、覆盖或自动执行旧任务。
- 经用户确认后，可以使用新的空任务状态；原文件保护方式由实现决定，但不得在确认前破坏它，也不得因重置任务状态删除镜像文件。
- 已有镜像内容仍依据本地文件与官方校验结果重新核验，状态文件不能作为镜像可用性的证明。具体异常提示呈现留给交互原型，规则不依赖原型另行决定。

### 安装包验收与未验证边界

- 第一版交付前使用实际安装包，在原生环境验证 macOS Apple Silicon、macOS Intel 和 Windows x64 三种运行组合，并覆盖 macOS 13、Windows 10 22H2 和 Windows 11 的支持基线；不能只证明开发模式可运行。
- 验证安装、首次打开及主界面可用，记录实际出现的安全提示；不以绕过系统或组织安全策略为测试目标。
- Windows 分别验证已有与缺少 WebView2 的情况，以及依赖安装失败时的报告和指引。
- 验证退出旧版后的手动升级、应用数据保留，以及卸载后应用数据和镜像内容保留。
- 验证不兼容或损坏状态的原文件保护、明确提示与用户确认后启用空任务状态的流程。
- 缺少测试环境的组合必须记为未验证，不得声称已验收；不要求穷举所有系统补丁版本。测试环境、实施方法及证据安排由开发验收执行，不在本轮搭建。

### 可推迟到后续发布阶段的事项

- Apple Developer ID 签名、公证、Windows 发行者代码签名及相关账号、证书和凭证准备，在正式对外分发前重新决策；本轮不配置密钥、证书或 CI/CD。
- 公开发布、应用商店、自动更新与更新服务不属于第一版交付要求；将来需要时另行决策，不提前实现。
- Universal、MSI、便携版、Windows ARM64、离线运行时及更广泛的状态迁移兼容，不属于当前承诺，不为它们新增第一阶段实现任务。

### 事实依据

以下一手来源于 2026-10-13 经 Context7 及官方页面核查，用于辨明技术可行性与默认行为边界；并未实测安装包。详细产品选择仅由本议题记录，已有技术调研见 [Tauri 下载器技术约束调研](../research/tauri-constraints.md)。

- [Tauri macOS application bundle](https://v2.tauri.app/distribute/macos-application-bundle/) 与 [DMG](https://v2.tauri.app/distribute/dmg/)：区分 `.app` 与 DMG 分发形式。
- [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/) 与 [Apple 打开来自未知开发者的应用说明](https://support.apple.com/en-us/102445)：ad-hoc、Developer ID、公证及逐应用允许打开的边界，不保证组织策略可绕过。
- [Tauri Windows Installer](https://v2.tauri.app/distribute/windows-installer/)：NSIS 安装范围、WebView2 安装选项与安装/卸载定制接缝；用户数据保留是本项目需实现并验证的要求。
- [Microsoft SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)：签名、信誉提示、Smart App Control 与组织策略限制。
- [Microsoft WebView2 distribution](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution) 与 [WebView2 支持平台](https://learn.microsoft.com/en-us/microsoft-edge/webview2/)：运行时检测、分发与权限条件；预装不等于所有设备均已具备运行时。
- [Tauri path API](https://v2.tauri.app/reference/javascript/api/namespacepath/) 与 [Tauri configuration](https://v2.tauri.app/reference/config/)：应用数据目录与 identifier 的关系，不等于任意升级、卸载逻辑自动保留数据。

## Comments

- 2026-10-13 resolution：用户逐轮确认 Q1–Q13 的推荐方案，并确认完整汇总后授权写入；安装、签名、首次运行、运行时依赖、更新、数据保护与安装包验收边界详见 `## Answer`。本轮只记录规划，不实现应用、不构建或安装、不配置凭证或 CI/CD、不提交、推送或发布。
