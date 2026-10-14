# Node.js 发行目录桌面应用

本项目提供 Node.js 官方发行版本浏览、搜索与单选，以及票 15 的六目标必需文件预览。清单文件依据与目标规则由 Rust 判定，本机验证已通过，四平台复验尚待完成；下载、受支持 LTS 筛选、镜像准备和正式安装包交付验收仍未完成。本票当前验证状态见下方记录。

## 开发环境

已在 macOS 27.0.1 / Apple Silicon 验证开发模式。工具链固定为 Node.js 24.18.0、npm 11.16.0、Rust 1.93.1，需安装 Xcode Command Line Tools。

Windows 开发需 MSVC C++ Build Tools（Desktop development with C++）和 WebView2。票 14 的目录功能已经通过 macOS ARM64/x64、Windows x64/ARM64 同一提交的 GitHub Actions 测试、打包、原生冒烟与截图核验，Windows 两架构完整 E2E 通过；这些历史结果不自动成为票 15 的通过证据。具体状态见下方验证记录。

产品基线为 Windows 10 22H2 / Windows 11、macOS 13；最新runner通过不等于每个最低系统版本都已验收，也不证明安装/升级/卸载通过。Windows ARM64目前是验证产物，不自动扩大正式发行支持。

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

- 来源固定为 `https://nodejs.org/dist/`：目录为 `index.json`，清单为对应发行版本的 `SHASUMS256.txt`。不支持任意 URL 或自定义镜像；网络 Adapter 禁止重定向，保持 TLS 验证，设置超时和 4 MiB 响应限制。
- 系统与架构分别选择，六目标始终可浏览，不受宿主限制。macOS/Linux 固定需要 `.tar.xz` 与 `.tar.gz`，Windows 固定需要 `.7z`；只采用标准 Linux 文件，musl、ZIP、安装器和源码不能替代。
- 只有成功取得并解析清单才判断文件存在或缺失。清单加载、获取／解析失败和真实缺文件分开显示；失败有独立主动重试，切换目标不改发行版本，搜索失配保留目标。预览就绪仍不代表下载、归档校验或镜像可用，不创建假下载任务。
- 搜索去首尾空白和一次可选的 `v` / `V`，按版本文本前缀匹配；`22.1` 包含 `22.10`，不是语义版本范围。排序和候选校验由 Rust 完成。
- 初始无选择，只能单选；最新查询排除所选发行版本时清除草稿，不自动选择或恢复。查询待定期间旧列表不可选。
- 加载、有效空结果、联网/解析失败分开呈现。刷新失败可继续浏览已校验旧目录，但明确显示旧数据及失败原因。
- 日期或历史 LTS 标记缺失/异常时显示未知，不隐藏可识别发行版本；官方 `lts: false` 显示无标记。历史标记不证明今天仍受支持。

## Module Interface 与缓存

Rust 应用 Module 提供目录打开／刷新、结构化选择的快照、清单准备和 revision 通知。Tauri 命令为 `open_catalog`、`catalog_snapshot`、`refresh_catalog`、`prepare_preview`，Event 沿用 `catalog-changed`，现在同时通知目录与清单事实变化。查询不启动网络、不修改全局选择；重连从权威快照恢复展示。前端应用 Module 管理查询与目标竞态及未提交草稿，不解析官方目录或清单，不推导文件存在性。

清单按发行版本在进程内保存，成功时分别保留完整原始字节和解析后的路径/hash；不沿用目录文本缓存、不裁剪清单为可用文件列表。正在获取的同发行版本请求合并，成功实体复用；失败只由用户主动重试，其他发行版本不受影响。Rust 验证规范发行版本、目录归属、封闭目标及清单路径，不接受任意格式、URL 或相对路径来绕过规则。

稳定应用标识符为 `dev.nodejs-downloader.desktop`，目录缓存存于 Tauri 用户级应用数据目录下的 `catalog/release-catalog.json`；macOS 为 `~/Library/Application Support/dev.nodejs-downloader.desktop/catalog/`，Windows 由 Tauri 的 `app_data_dir()` 决定。请勿随意修改标识符或把缓存路径当作镜像目录。

缓存有效期为 1 小时，过期在下次打开应用时刷新；没有后台定时重下载。手动刷新即使缓存新鲜也请求官方目录，并使用配套 ETag。304 仅接受有配套已校验实体的条件响应，失败不续期。损坏、不兼容或未来时间缓存保留原文件，网络结果只在内存使用并告警；缓存无法保存时也明确告警。缓存与当前选择均不证明内容已下载或本地镜像可用。

## GitHub Actions 跨平台验证

`.github/workflows/ci.yml` 使用 `macos-latest`（ARM64）、`macos-15-intel`（x64）、`windows-latest`（x64）和 `windows-11-arm`（ARM64），`fail-fast: false`；实际架构由 Node/Rust host 同时核对。

每个平台运行前端/Rust 测试、Playwright 浏览器测试、release 打包、真实原生启动、目录与六目标清单观察及目标窗口截图；Windows 另用 `tauri-driver` 与匹配运行时版本的 Microsoft Edge Driver 操作搜索、选择、六目标预览和刷新。Windows ARM64 驱动或测试失败不会静默跳过。原生官方清单结果与受控异常样例分开记录，不用前端 mock 冒充 Rust 验证。

```sh
npm run test:browser
npm run tauri -- build --ci
# 仅本机平台：测试feature构建与正式包隔离，参数为可执行文件和新的证据目录。
CARGO_TARGET_DIR="$PWD/src-tauri/target-ci" npm run tauri -- build --no-bundle --features ci-smoke
npm run test:smoke -- src-tauri/target-ci/release/nodejs-downloader artifacts/local-native
```

`ci-smoke` 默认关闭；只有独立测试构建含观察命令，正式安装包没有它。浏览器固定IPC夹具只在`tests/browser/`隔离入口，不进入生产构建，也不是原生网络证据。

构建包仅保存为Actions artifact，不创建Release。[运行38518510776](https://github.com/shenleg/DevMirrorManager/actions/runs/38518510776)的四平台同一提交全部绿，截图与架构已核验。后续复跑曾发生macOS x64截图超时；分离Swift编译与捕获计时后，[运行38528925495](https://github.com/shenleg/DevMirrorManager/actions/runs/38528925495)的同一修复提交四平台再次全部通过，本轮新截图已核验，票14恢复关闭。失败和复验过程仍保留在验证记录中。

Windows E2E先记录权限级别，必要时用固定官方`gsudo`降到普通权限，避免新版WebView2在高完整性宿主下忽略驱动配置；不修改ACL、注册表或系统保护。

安装/卸载、系统弹窗、签名公证、通知/托盘、高DPI、深色模式、输入法等仍需人工检查，不由CI成功推断。

首次版本的锁文件曾使用本机配置的`npmmirror`来源；本轮已改为官方`registry.npmjs.org`并用`npm ci`核实包完整性，没有修改全局npm配置。

## 验证记录

实际桌面步骤、截图、测试结果和未验证边界见 [票 14 验证记录](docs/verification/release-catalog-search.md) 与 [票 15 验证记录](docs/verification/target-artifact-preview.md)。票 15 未取得四平台通过证据前，不沿用历史运行宣称本轮验收成功。
