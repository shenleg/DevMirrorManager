# Node.js 发行目录桌面应用

本项目目前实现票 14：从固定官方来源浏览、搜索并单选 Node.js 发行版本。下载、目标平台选择、受支持 LTS 筛选、镜像准备和正式安装包尚未交付。

## 开发环境

已在 macOS 27.0.1 / Apple Silicon 验证开发模式。工具链固定为 Node.js 24.18.0、npm 11.16.0、Rust 1.93.1，需安装 Xcode Command Line Tools。

Windows 开发需 MSVC C++ Build Tools（Desktop development with C++）和 WebView2。产品基线为 Windows 10 22H2 / Windows 11、macOS 13；这些基线及 Windows/macOS Intel **尚未实测**。本机结果不等于安装包验收。

```sh
npm ci --registry=https://registry.npmjs.org
npm run tauri dev
```

`npm run dev` 只启动 WebView 前端，浏览器不会伪造官方目录；请用 `npm run tauri dev` 启动正式桌面应用。

## 检查与测试

```sh
npm run typecheck
npm test
npm run build
cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

首次构建需要从 npm 官方 registry、crates.io 和 Rust 官方工具链来源下载依赖。直接依赖精确固定，传递依赖由 `package-lock.json` 和 `src-tauri/Cargo.lock` 锁定。

## 用户规则

- 来源只有 `https://nodejs.org/dist/index.json`，不支持任意 URL 或自定义镜像；网络 Adapter 禁止重定向，保持 TLS 验证，设置超时和 4 MiB 响应限制。
- 搜索去首尾空白和一次可选的 `v` / `V`，按版本文本前缀匹配；`22.1` 包含 `22.10`，不是语义版本范围。排序和候选校验由 Rust 完成。
- 初始无选择，只能单选；最新查询排除所选发行版本时清除草稿，不自动选择或恢复。查询待定期间旧列表不可选。
- 加载、有效空结果、联网/解析失败分开呈现。刷新失败可继续浏览已校验旧目录，但明确显示旧数据及失败原因。
- 日期或历史 LTS 标记缺失/异常时显示未知，不隐藏可识别发行版本；官方 `lts: false` 显示无标记。历史标记不证明今天仍受支持。

## Module Interface 与缓存

Rust 应用 Module 提供打开、刷新、`snapshot(query)` 和 revision 通知。Tauri 命令为 `open_catalog`、`catalog_snapshot`、`refresh_catalog`，Event 为 `catalog-changed`。查询无全局查询副作用，通知仅表示目录变化；重连从权威快照恢复展示。前端应用 Module 管理查询竞态及未提交单选，不解析或排序官方目录。

稳定应用标识符为 `dev.nodejs-downloader.desktop`，目录缓存存于 Tauri 用户级应用数据目录下的 `catalog/release-catalog.json`；macOS 为 `~/Library/Application Support/dev.nodejs-downloader.desktop/catalog/`，Windows 由 Tauri 的 `app_data_dir()` 决定。请勿随意修改标识符或把缓存路径当作镜像目录。

缓存有效期为 1 小时，过期在下次打开应用时刷新；没有后台定时重下载。手动刷新即使缓存新鲜也请求官方目录，并使用配套 ETag。304 仅接受有配套已校验实体的条件响应，失败不续期。损坏、不兼容或未来时间缓存保留原文件，网络结果只在内存使用并告警；缓存无法保存时也明确告警。缓存与当前选择均不证明内容已下载或本地镜像可用。

## GitHub Actions 跨平台验证

`.github/workflows/ci.yml` 使用 `macos-latest`（ARM64）、`macos-15-intel`（x64）、`windows-latest`（x64）和 `windows-11-arm`（ARM64），`fail-fast: false`；实际架构由 Node/Rust host 同时核对。

每个平台运行前端/Rust测试、Playwright浏览器测试、release打包、真实原生启动/目录就绪和目标窗口截图；Windows另用`tauri-driver`与匹配运行时版本的Microsoft Edge Driver验证完整搜索/选择/刷新。Windows ARM64必须先实际尝试，驱动或测试失败不会静默跳过。

```sh
npm run test:browser
npm run tauri -- build --ci
# 仅本机平台：测试feature构建与正式包隔离，参数为可执行文件和新的证据目录。
CARGO_TARGET_DIR=target-ci npm run tauri -- build --no-bundle --features ci-smoke
npm run test:smoke -- src-tauri/target-ci/release/nodejs-downloader artifacts/local-native
```

`ci-smoke` 默认关闭；只有独立测试构建含观察命令，正式安装包没有它。浏览器固定IPC夹具只在`tests/browser/`隔离入口，不进入生产构建，也不是原生网络证据。

构建包仅保存为Actions artifact，不创建Release。四平台同一提交全部绿且查看截图后才记录跨平台开发验证通过。安装/卸载、系统弹窗、签名公证、通知/托盘、高DPI、深色模式、输入法等仍需人工检查，不由CI成功推断。

首次版本的锁文件曾使用本机配置的`npmmirror`来源；本轮已改为官方`registry.npmjs.org`并用`npm ci`核实包完整性，没有修改全局npm配置。

## 验证记录

实际桌面步骤、截图、测试结果和未验证边界见 [票 14 验证记录](docs/verification/release-catalog-search.md)。
