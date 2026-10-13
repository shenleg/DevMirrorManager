# Tauri 下载器技术约束调研

本文件记录 macOS/Windows Node.js 下载器所需的 Tauri、网络与文件系统能力，以及仍需用户选择的实现取舍；不构成已批准的应用架构。

调查日期：2026-10-13。范围：官方文档、官方插件源码和底层 API 文档；未安装依赖、未运行应用、未下载 Node.js 分发包，未验证目标设备上的实际行为。

## 结论

1. 当前稳定路线为 **Tauri 2**。调查时官方发布列表中的 core 为 `tauri-v2.12.3`，CLI 为 `tauri-cli-v2.12.2`，均于 2026-10-10 发布；core、CLI 与各插件版本不是同一个数字，实施时应分别锁定。[官方 core 发布](https://github.com/tauri-apps/tauri/releases/tag/tauri-v2.12.3)、[官方 CLI 发布](https://github.com/tauri-apps/tauri/releases/tag/tauri-cli-v2.12.2)
2. 官方提供目录对话框、HTTP、文件系统、简单持久化、后台状态与前后端通信等构件，**没有据此提供完整的通用下载管理器**。官方文档中的 `download` Channel 示例是应用自定义命令示例，不能当作现成插件 API。[调用前端](https://v2.tauri.app/develop/calling-frontend/)
3. 大文件下载既可走前端插件，也可走 Rust 后端；两者都有流式能力。对于多文件、恢复、校验及跨页面生命周期，**优先考虑 Rust 后端持有任务与写盘状态**，前端负责展示和命令。这是基于约束的建议，尚非用户决策。[HTTP 插件源码](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/http/guest-js/index.ts)、[状态管理](https://v2.tauri.app/develop/state-management/)、[reqwest Response](https://docs.rs/reqwest/latest/reqwest/struct.Response.html)
4. 插件 capability 不等于通用操作系统沙箱：前端插件调用受命令权限和 scope 约束；应用自定义 Rust 命令、Rust 文件操作与网络访问必须自行实现业务授权、路径和 URL 校验。[capabilities](https://v2.tauri.app/security/capabilities/)、[文件系统插件](https://v2.tauri.app/plugin/file-system/)
5. 断点恢复、完成状态、SHA-256 校验、重复任务处理和重启恢复都需要应用自己的契约与记录；仅提供 `Range`、持久化路径或进度事件不足以兑现这些承诺。

## 1. 稳定版本与开发前提

- core `2.12.3` 和 CLI `2.12.2` 来自官方 monorepo 最近发布记录；不能将 `/releases/latest` 返回的 CLI 版本误当作 core 版本。[官方发布列表](https://github.com/tauri-apps/tauri/releases)
- 当前 HTTP 和文件系统插件指南均注明最低 Rust `1.90`。这是当前文档对应插件的要求，不意味着未来插件版本永远维持此最低版本；最终 Rust 工具链需覆盖所锁定全部依赖的要求。[HTTP 插件](https://v2.tauri.app/plugin/http-client/)、[文件系统插件](https://v2.tauri.app/plugin/file-system/)
- macOS 桌面开发需要 Xcode 或 Xcode Command Line Tools；Windows 需要 Microsoft C++ Build Tools 的 `Desktop development with C++` 与 WebView2。官方推荐 Windows 使用 MSVC 工具链。[Prerequisites](https://v2.tauri.app/start/prerequisites/)
- 使用 JavaScript/TypeScript 前端时，开发环境仍需 Node.js 与包管理器。下载器会下载 Node.js，不代表它可在无构建环境时自行完成应用开发。[Prerequisites](https://v2.tauri.app/start/prerequisites/)
- 以上为官方依赖要求；没有检查本机是否已具备这些工具，也没有替用户安装。

## 2. 输出目录、scope 与授权边界

### 官方提供什么

- `@tauri-apps/plugin-dialog` 的 `open({ directory: true, multiple: false })` 可请求用户选择目录；取消返回 `null`。选择目录后需在该目录内建立业务约定的 `nodejs/`，而不是把应用安装目录当成输出目录。[Dialog](https://v2.tauri.app/plugin/dialog/)、[Dialog JavaScript API](https://v2.tauri.app/reference/javascript/dialog/)
- JavaScript 对话框的 `recursive` 表示后续是否允许访问所选目录的子目录。插件 Rust 命令源码中，该字段使用 `#[serde(default)]`，省略时为 `false`；如果采用前端文件系统插件并要写入 `nodejs/vX.Y.Z/` 等子目录，必须明确考虑递归 scope，不能只授权顶层目录。[Dialog JavaScript API](https://v2.tauri.app/reference/javascript/dialog/)、[dialog commands.rs](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/dialog/src/commands.rs)
- `open` 的官方实现会把所选文件或目录加入 filesystem scope（存在 fs 插件 scope 时）与 asset scope。文件系统 scope 的目录更新使用 `allow_directory(&path, options.recursive)`，不能据“asset scope 已允许目录”推断 filesystem scope 也自动允许所有后代。[dialog commands.rs](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/dialog/src/commands.rs)
- 对话框 API 明确说明这些动态 scope 在应用重启后清除。`tauri-plugin-persisted-scope` 可保存并恢复 filesystem 和 asset scopes，且要求先初始化 `tauri-plugin-fs`，再初始化 persisted-scope。[Dialog JavaScript API](https://v2.tauri.app/reference/javascript/dialog/)、[Persisted Scope](https://v2.tauri.app/plugin/persisted-scope/)
- scope 只回答插件是否允许调用；它不保证目录仍存在、磁盘可用、OS ACL 可写，也不证明 macOS App Sandbox 的系统授权已被持久化。后者未在本次资料中核实，若之后决定启用 App Sandbox，需独立核实授权持久化。[Persisted Scope](https://v2.tauri.app/plugin/persisted-scope/)

### 应用必须负责什么

- 前端插件操作需要**命令权限与路径 scope**同时允许。文件系统插件默认权限主要面向应用专属目录，不能当作任意用户目录的写权限。[文件系统插件](https://v2.tauri.app/plugin/file-system/)
- filesystem 插件防止带 `..` 的路径访问；其 `stat` 会跟随符号链接并检查目标 scope，`lstat` 则查询链接本身。使用应用自己的 `std::fs`/`tokio::fs` 时不能把这些插件检查当成自动生效的保障。[文件系统插件](https://v2.tauri.app/plugin/file-system/)
- `invoke_handler` 注册的应用命令默认可被应用内所有窗口和 webview 使用；限制自定义命令还需配置 `AppManifest::commands` 等应用权限规则。重叠 capabilities 的权限会合并，配置越多不等于边界越窄。[Capabilities](https://v2.tauri.app/security/capabilities/)
- **建议的业务边界**：后端记录已授权输出根目录；命令接收任务标识与经过验证的发行文件描述，而不是允许前端提交任意 URL 和任意绝对写入路径。上游文本与文件名仍需校验，尤其防止绝对路径、父目录、Windows 驱动器/UNC 路径及符号链接越界。这是应用设计建议，不是 Tauri 默认保护。

## 3. 网络下载与流式写盘

### 路线 A：前端插件组合

可用构件：`@tauri-apps/plugin-http`、`@tauri-apps/plugin-fs`、`@tauri-apps/plugin-dialog`，按需求增加 persisted-scope 和 store。[HTTP 插件](https://v2.tauri.app/plugin/http-client/)、[文件系统插件](https://v2.tauri.app/plugin/file-system/)

- HTTP 插件提供 Fetch 风格 `fetch`，接受 `RequestInit` 及 `ClientOptions`。`connectTimeout` 是连接超时，不是整次下载的总超时。允许的 URL 需要配置 scope；`http:default` 开放相关命令，不自动授权任何远程 origin。禁用请求头的处理及 `unsafe-headers` feature 也需遵守插件文档，不能把原生 HTTP 请求与浏览器 Fetch 完全等同。[HTTP 插件](https://v2.tauri.app/plugin/http-client/)、[HTTP JavaScript API](https://v2.tauri.app/reference/javascript/http/)
- 官方 JavaScript 源码把 Rust 响应体包装为 `ReadableStream<Uint8Array>`，可使用 `response.body?.getReader()` 逐块消费。响应块通过 IPC 到前端；取消 stream 会释放 Rust 响应体，`AbortSignal` 会取消请求或使响应流报错。这些是所查官方源码的行为；并非“取消成功”与“磁盘上没有任何新增字节”的完整业务承诺。[HTTP 插件源码](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/http/guest-js/index.ts)
- fs 插件 `open()` 返回文件句柄，可进行增量 `write()` 并最终 `close()`。是否追加、截断和从何处写入必须显式选择适当的打开参数。[文件系统插件](https://v2.tauri.app/plugin/file-system/)
- 因此可以构造不整包读入内存的“读网络块→写文件块”循环；但每个响应块会穿过 Rust→前端及前端→fs 的 IPC。若选该路线，需自行实现串行写入、背压、取消清理、任务状态和恢复；官方资料没有保证该组合具有下载管理器级别的吞吐、崩溃恢复或一致性。
- 网络与文件循环若由 webview 持有，重载、关闭页面及订阅销毁等会影响其生命周期；不能因此承诺独立于前端继续下载。

### 路线 B：Rust 后端引擎

可用构件：Tauri async command、`tauri::async_runtime::spawn`、应用 managed state、HTTP 客户端、异步文件操作及 Channel。HTTP 插件也 re-export `reqwest`；后端是否依赖插件还是直接选择网络 crate，留给架构决策。[HTTP 插件](https://v2.tauri.app/plugin/http-client/)、[Calling Rust](https://v2.tauri.app/develop/calling-rust/)、[状态管理](https://v2.tauri.app/develop/state-management/)

- `reqwest::Response::chunk()` 可逐块获取响应体；`bytes_stream()` 提供字节流但需启用 `stream` feature。`bytes()` 返回完整响应体，不能将其当作大文件增量下载方式。[reqwest Response](https://docs.rs/reqwest/latest/reqwest/struct.Response.html)
- 下载和校验可在 Rust 内逐块处理，避免把完整二进制送入 webview；UI 只接收进度与状态。这是基于 API 能力的架构建议，未做吞吐基准测试。
- `tokio::fs` 当前使用 blocking pool 执行底层文件系统操作。写入返回后不一定所有底层写入已结束，`flush()` 用于等待待完成的文件写操作；取消或 drop 不能被视为“所有待写磁盘操作立即停止”。[Tokio filesystem](https://docs.rs/tokio/latest/tokio/fs/index.html)
- 应用必须自己持有任务标识、并发限制、取消标记和恢复记录，明确在请求阻塞、正在写盘和完成提交各阶段如何取消。Tauri 没有在上述构件里定义这些业务规则。
- 自定义 Rust 网络访问不能假定会被 JavaScript HTTP 插件的 URL scope 自动约束；应显式限定官方来源、路径、重定向策略与 TLS 行为。官方 HTTP 插件文档只明确描述插件接口的 scope，没有承诺通用 Rust 客户端受其检查。

## 4. HTTP Range 不等于安全恢复

HTTP 能表达 Range/If-Range，但续传是否成功由服务器响应决定：服务器可以忽略 Range 并返回 `200`；成功单区间响应为 `206`，须核对 `Content-Range`；`416` 应据当前实体长度判断；If-Range 校验器不匹配时返回完整内容。日期校验器不能随意替代强 ETag。[RFC 9110 §§13.1.5、14.2、14.4、15.3.7、15.5.17](https://www.rfc-editor.org/rfc/rfc9110.html)

**建议的恢复规则，待任务生命周期议题决定：**

- 保存部分文件长度、文件身份、所用校验依据和可用的 HTTP 验证器；重新读取本地文件实际长度，不只相信 UI 数字。
- 仅在 `206` 与起始偏移正确时继续追加；`200` 必须作为完整实体另行处理，不能追加到旧部分文件。
- `416` 不自动表示下载完成；须结合真实长度和完整校验结果判断。
- 自动解压的传输编码可能改变响应体长度，`reqwest` 的 `content_length()` 并不保证等于原始 `Content-Length`。续传应明确请求与存盘表示的关系，不把解码后的长度用作上游实体偏移。[reqwest Response](https://docs.rs/reqwest/latest/reqwest/struct.Response.html)
- 本次未对 `nodejs.org` 的 Range、ETag、重定向、代理环境行为作实测；不能写成“官方一定支持断点续传”的已验证事实。

## 5. 进度、窗口与任务生命周期

- 官方建议用 Channel 做高频、有序的流式数据通信；events 更适合轻量、多对多通知，非高吞吐流。Channel 的官方下载示例支持 started/progress/finished，但其任务和错误语义仍由应用实现。[调用前端](https://v2.tauri.app/develop/calling-frontend/)
- 若使用 events，前端须处理 `listen()` 返回的解除订阅函数。events 不具备 capability 级的细粒度事件访问控制，不应广播敏感本地路径或把收到事件当成业务授权。[调用前端](https://v2.tauri.app/develop/calling-frontend/)
- managed state 是应用进程里的状态，不是落盘记录。后端持有任务可使 webview 重载不直接销毁下载逻辑，但 UI 重新连接后的“查询当前任务快照→重新订阅”需要自己定义。[状态管理](https://v2.tauri.app/develop/state-management/)
- `RunEvent::ExitRequested` 的 `ExitRequestApi::prevent_exit()` 可阻止退出请求，但不阻止 `AppHandle::restart`。这只控制应用生命周期，不自动持久化或恢复下载，也不让下载在进程终止后继续。[ExitRequestApi](https://docs.rs/tauri/latest/tauri/struct.ExitRequestApi.html)
- 用户关闭窗口时是退出、后台继续还是询问，重启后是自动恢复还是等待确认，都尚未批准。

## 6. 完整性、临时文件与已有文件保护

Tauri filesystem API 不把“文件写成功”自动转换成“Node.js 分发文件通过 SHA-256 验证”。应用需要从已确认可信来源读取校验值，逐块或读回计算摘要，并明确何时可以完成镜像元数据提交。

**建议而非既定实现：**先写同版本目录内的独立临时文件，完成所有写入与预期校验后再进入最终路径；保持网络/任务记录与镜像内容的职责分离。

- 不要用同名最终文件边下边覆盖，否则取消或崩溃可能损坏已有镜像文件。
- `std::fs::rename` 不支持跨 mount point，允许时可以替换已存在的目标；不同平台/文件系统规则有差异，文档不提供覆盖所有环境的统一原子性保证。因此“先 exists 再 rename”不是可靠的无覆盖承诺，临时文件也应位于目标相同文件系统。[Rust rename](https://doc.rust-lang.org/std/fs/fn.rename.html)
- `File::create_new` 的 create-if-absent 操作可原子地避免创建时覆盖已有文件，但这不等于完整的无覆盖 rename/镜像事务设计。[Rust File](https://doc.rust-lang.org/std/fs/struct.File.html)
- `flush` 与 `sync_all` 不应混用语义：等待写操作完成与请求文件内容/元数据同步是不同要求；关闭时的错误可能被忽略，重要提交要显式处理同步错误。[Tokio filesystem](https://docs.rs/tokio/latest/tokio/fs/index.html)、[Rust File](https://doc.rust-lang.org/std/fs/struct.File.html)
- Windows 的文件占用、病毒扫描与目标文件替换行为未在真实环境验证；最终规格须留出可恢复错误与 Windows 验收，而不是假设 rename 总成功。
- 校验文件是否原样保留、镜像索引何时更新及签名验证的范围属于其他决策议题，不在这里锁定。

## 7. 持久化选项

- `tauri-plugin-store` 是异步、文件支撑的键值存储，Rust 与 JavaScript 可复用同一路径的 store。`autoSave` 默认以 100 ms 防抖保存，可关闭并显式 `save()`；文档也说明正常退出时保存。[Store](https://v2.tauri.app/plugin/store/)
- 该指南没有保证数据库事务、文件系统与任务记录间的原子提交，或崩溃后零数据丢失。正常退出保存不能代替异常终止恢复设计。
- store 可作为简单配置/任务记录候选；自管文件或数据库也可评估。需要何种持久化粒度，取决于任务生命周期与镜像完成承诺，不在本次事实调研中选择。
- persisted-scope 解决的是插件路径 scope 的恢复，store 解决的是数据记录；两者都不是下载续传引擎。[Persisted Scope](https://v2.tauri.app/plugin/persisted-scope/)、[Store](https://v2.tauri.app/plugin/store/)

## 8. 前端框架与构建发布

### 前端

Tauri 官方称其 frontend agnostic，静态资源可来自 SPA、SSG 或 MPA；不原生支持依赖运行时服务端的 SSR。React、Vue、Svelte、Solid、vanilla JavaScript/TypeScript 都有可行路线，Vite 为 SPA 官方推荐选项。[Frontend Configuration](https://v2.tauri.app/start/frontend/)

本项目没有已有前端代码，因此无需迁移约束。技术栈仍待用户决策：

- vanilla TypeScript 的构建和依赖较少，但复杂的筛选、列表及多任务状态需自行组织。
- React/Vue/Svelte 等可提供组件化与成熟界面生态，但引入相应工具、依赖与状态组织选择。
- 本次未基准测试框架性能、比较组件库或选定 UI 样式；不能把任一框架写成 Tauri 的必要条件。

### 构建

- macOS `.app` 官方构建路线在 Mac 上执行；默认 minimum system version 文档为 `10.13`，但最终下限还受所选依赖和前端 WebKit 能力影响，应单独验证，不直接承诺所有这些系统可用。[macOS Application Bundle](https://v2.tauri.app/distribute/macos-application-bundle/)
- Windows MSI 使用 WiX、必须在 Windows 上构建；NSIS `-setup.exe` 有 macOS/Linux 交叉构建路线，需要 NSIS、LLVM、MSVC Rust target 与 `cargo-xwin` 等。官方将交叉编译说明视为相对不成熟的备用路线；不能因为开发机是 macOS 就承诺无额外环境完成 Windows MSI 或全部 Windows 发布验收。[Windows Installer](https://v2.tauri.app/distribute/windows-installer/)
- Windows 安装器默认会在缺少 WebView2 时下载安装，因此那种安装模式需要网络。若目标机器离线，需要在后续发布范围明确后选择合适 WebView2 分发方式。[Windows Installer](https://v2.tauri.app/distribute/windows-installer/)
- 代码签名、macOS notarization、Windows 安装器选型、升级和 CI 配置均未获本轮授权，不创建相关配置。

## 9. 仍需用户决定

以下问题属于后续对话议题，不是事实调研的未完成部分：

- 是否采纳 Rust 后端持有下载任务与写盘状态，以及具体前端栈。
- 第一版的取消、暂停、失败重试、断点恢复、重启恢复各自必需范围。
- UI 与后台任务断开时的行为、关闭应用时的处理、已有文件的保护策略。
- 持久化与完成提交的保障级别，是否需要事务型存储。
- 支持的 macOS/Windows 最低系统版本、CPU 架构、原生 Windows 构建和验收环境。
- 将来发布时是否需要离线 WebView2、签名或 App Sandbox；本轮不预设。

## 10. 未验证边界

- 未编译任何 Tauri 项目；未测试 macOS/Windows 文件占用、目录权限、WebView 兼容、下载吞吐或退出行为。
- 未实测 `nodejs.org` 的 HTTP Range、验证器及网络故障恢复。
- 未验证 App Sandbox 下的安全授权/bookmark 持久化。
- 插件源码引用为官方 `v2` 分支、底层 API 引用为官方当前 `latest` 文档，可能继续变化；实施时应按锁定版本重新核对相关接口与安全语义。

## 调研方法

先经 Context7 解析到 `/tauri-apps/tauri-docs`，分别查询目录权限、HTTP/文件流和后台任务通信；再回溯官方指南、JavaScript API 与插件 Rust/TypeScript 源码。版本依据官方 GitHub 发布列表；网络与文件的边界以 RFC、Rust、Tokio 和 reqwest 的原始资料为准。所有建议均与已核实 API 事实分开，不以示例代码或功能名称推断存在完整下载器。
