# Tauri 跨平台下载与输出目录的技术约束

Type: research
Labels: wayfinder:research
Status: resolved
Blocked by: none
Assignee: collin

本议题调查 Tauri 实现本需求的约束和可选技术路线，不选择最终前端栈或搭建项目。

## Question

在 macOS 与 Windows 上，当前稳定 Tauri 的哪些能力与限制决定了目录选择、流式大文件下载、进度事件、取消/恢复、完整性校验和本地任务持久化的实现边界？

使用最新官方文档与 Context7，比较前端插件驱动和 Rust 后端驱动的能力，至少明确：

- Tauri 稳定主版本、所需插件、Rust/系统构建前提及跨平台构建限制；不要把 macOS 上构建 Windows 安装包视为默认可行。
- 任意用户选择目录与 capability/permission 的关系；限制插件权限与后端命令路径校验的边界。
- 网络请求、流式写盘、HTTP Range/恢复、取消、事件订阅、跨窗口/重启任务生命周期有哪些官方支持或需要自建的部分。
- 临时文件与原子完成、校验、已有文件保护和 Windows 文件占用的限制。
- 前端框架是否由 Tauri 限定，以及小型桌面应用可考虑的选项；只列权衡，不替用户锁定技术栈。
- 若举出 crate、插件或 API，核实当前文档，不虚构 Tauri 自带的下载管理器。

证据保存在 [Tauri 下载器技术约束调研](../research/tauri-constraints.md)。不安装依赖、不创建应用、不修改 CI 或系统配置。

## Answer

事实调研已完成，详见 [Tauri 下载器技术约束调研](../research/tauri-constraints.md)。核心约束如下：

- 当前稳定路线为 Tauri 2；调查时 core 为 `2.12.3`、CLI 为 `2.12.2`，不是同一版本号。当前 HTTP/fs 插件指南要求 Rust `1.90`。
- 官方 HTTP 插件响应支持 `ReadableStream`/`AbortSignal`，fs 插件支持增量写入；Rust 网络流与文件操作也可实现大文件下载。Tauri 提供构件，而非完整通用下载管理器。
- Dialog 可动态授权所选目录；前端 fs 写多级子目录需明确递归 scope。动态 scope 默认不跨重启保留，persisted-scope 可恢复插件 scope，但不等于 OS 目录可用性或持久授权。
- Capability 不会替自定义 Rust 命令完成业务路径/URL 校验；应用命令默认访问边界与插件权限必须分别处理。
- Channel 适合有序高频进度，events 适合轻量通知；后端 managed state 不自动落盘。取消、任务快照重连、退出与重启恢复须自行设计。
- Range、文件完成、SHA-256 验证及元数据提交均需应用级规则；`200` 响应不能追加到断点文件。rename 不跨文件系统，可能覆盖目标，不能写成跨环境无条件原子且无覆盖的保证。
- Windows MSI 需 Windows 构建；NSIS 有附加工具支持的交叉构建路线，但不能当作默认可靠路线。macOS 官方构建路线在 Mac 上执行。
- 前端不由 Tauri 限定；React/Vue/Svelte 或 vanilla TypeScript 均可。建议优先评估 Rust 后端持有任务与写盘，但未锁定技术栈或架构。

仍需用户决定的事项：第一版恢复/取消范围、已有文件保护与完成保障、前端和后端职责边界、持久化方案、最低 OS/CPU 架构及 Windows 验收环境。未实测应用、上游 Range、磁盘行为、吞吐或 App Sandbox 授权，报告明确列出这些边界；它们不阻止本议题回答技术约束，但不能宣称已通过验收。

## Comments

- 2026-10-13 resolution：依据官方文档、插件源码及底层 API 完成调研，资产已链接。未安装依赖、实现应用、修改 CI、提交或推送。地图索引由主会话统一更新。
