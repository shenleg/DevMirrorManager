# nvm 与 Nexus 兼容调研

本文件记录 nvm 客户端真实请求契约、版本差异以及 Nexus raw 路径映射的事实依据，不决定部分镜像的产品策略。

调查日期：2026-10-13。仅阅读官方发布信息、固定版本源码、官方文本清单与 Sonatype 文档；未安装客户端、下载或执行 Node.js 分发包，也未部署 Nexus。本文的“兼容”指源码层面满足必要请求条件，不表示已经通过真实客户端验收。

## 1. 调查对象与稳定版本依据

| 对象 | 固定版本 / 提交 | 依据 |
| --- | --- | --- |
| nvm-sh 当前稳定版 | `v0.40.8`，commit `a885b885fef16fac4bc544188fb25e9e37ae83e8` | [官方 latest release API](https://api.github.com/repos/nvm-sh/nvm/releases/latest) 报告 `prerelease: false`，发布时间 `2026-09-21T02:26:02Z`；[release](https://github.com/nvm-sh/nvm/releases/tag/v0.40.8)、[固定提交](https://github.com/nvm-sh/nvm/commit/a885b885fef16fac4bc544188fb25e9e37ae83e8) |
| nvm-windows 当前稳定版 | `v2.0.1`，commit `9fca746c26543400095e5f164625a2aecb77769f` | [官方 latest release API](https://api.github.com/repos/nvm-windows/nvm/releases/latest) 报告 `prerelease: false`、`draft: false`，发布时间 `2026-10-02T20:34:06Z`；[release](https://github.com/nvm-windows/nvm/releases/tag/v2.0.1)、[固定提交](https://github.com/nvm-windows/nvm/commit/9fca746c26543400095e5f164625a2aecb77769f) |
| nvm-windows 旧版对照 | `1.2.2`，commit `c05902234e6e7dcdcad8a3f3b99ad48d2c89fa94` | [固定提交](https://github.com/nvm-windows/nvm/commit/c05902234e6e7dcdcad8a3f3b99ad48d2c89fa94)；它不是此次调查的当前稳定版本，仅用于旧版契约对照 |

`coreybutler/nvm-windows` 的官方 API/链接已经转向 `nvm-windows/nvm`。v2 主仓库包含子模块，不能只检查主仓库 README 或使用子模块分支 HEAD。本文依据 [v2.0.1 的子模块 URL](https://github.com/nvm-windows/nvm/blob/v2.0.1/.gitmodules) 和 [该 tag 的 git tree](https://api.github.com/repos/nvm-windows/nvm/git/trees/v2.0.1) 固定：

- `cli`：`fe08afeed22f15b10f07f02df6fcfca0f7d5a77c`。
- `common`：`e92b67d855c1f697cfc695535b85cdb0e7973d96`。
- `sync`：`16b9292364204b2669d9e13236f4505a436ff666`，仅记录版本关联，本报告的 Node.js 请求契约来自前两个子模块。

## 2. 请求契约摘要

`M` 表示用户配置的镜像根 URL，`V` 表示不含前缀 `v` 的完整版本号；路径中的 `vV` 代表例如 `v22.16.0`。

| 消费者 | 版本发现 | 普通在线二进制安装请求 | 校验与限制 |
| --- | --- | --- | --- |
| nvm-sh `v0.40.8` | `M/index.tab`；版本匹配与 LTS 别名从表中产生 | `M/vV/node-vV-<os>-<arch>.tar.xz` 或 `.tar.gz`，压缩格式由客户端环境决定 | `M/vV/SHASUMS256.txt`；缺少对应文件的清单条目不能满足正常校验路径 |
| nvm-windows `v2.0.1` | `M/index.tab`；latest、LTS、版本范围依赖该表 | 当前检查到的标准 `downloadNode` 实现固定请求 `M/vV/node-vV-win-<arch>.7z` | 先请求 `M/vV/SHASUMS256.txt`，再 SHA-256 验证；没有在该路径中发现 ZIP 格式回退 |
| nvm-windows `1.2.2` | `M/index.json`；`latest`/`node` 另外请求 `M/latest/SHASUMS256.txt` | 非追加安装且 Node.js `>=16.9.0` 请求 `.zip`；其他路径可请求 `win-<arch>/node.exe` | 不应把新版的强制 archive SHA-256 契约倒推给旧版；旧版本/追加架构还可能依赖外部 npm 来源 |

以上不是“客户端永远不支持其他格式”的结论：针对 v2.0.1 固定源码的标准网络安装路径，`.7z` 是写死的请求格式，失败时切换配置的镜像，而不是切换 ZIP。其他版本、离线缓存路径或未来实现不在该断言内。客户端兼容版本范围、是否额外保留 ZIP 和旧版元数据，仍是产品决定。

## 3. nvm-sh 的发现、文件与校验

### 3.1 版本发现不是目录 HTML 抓取

固定源码中的 `nvm_get_mirror` 使用 `NVM_NODEJS_ORG_MIRROR`，默认 `https://nodejs.org/dist`；`nvm_ls_remote_index_tab` 请求 `${MIRROR}/index.tab`。`nvm_remote_version` 经远端索引解析用户输入，因此即使用户给出精确版本，也不能默认省略在线安装需要的索引。主版本范围、最新版本及 LTS 别名同样依赖索引。

`nvm_ls_remote_index_tab` 从第 10 列生成 `lts/<codename>`，并产生 `lts/*`。它没有在这里读取 Node.js 生命周期时间表，因此客户端的 LTS 含义不能等同于本项目“当前仍受支持 LTS”的过滤条件。保留历史 LTS 索引行可能继续让它们被客户端发现。

来源：[固定 nvm.sh](https://github.com/nvm-sh/nvm/blob/a885b885fef16fac4bc544188fb25e9e37ae83e8/nvm.sh)，函数 `nvm_get_mirror`、`nvm_remote_version`、`nvm_ls_remote_index_tab`；[官方 LTS 与镜像说明](https://github.com/nvm-sh/nvm/blob/v0.40.8/README.md)。在这些主要发现/安装路径中没有发现 `index.json` 或根目录 HTML 列表的必要性。

### 3.2 客户端决定格式和平台文件名

`nvm_get_download_slug` 生成 `node-vV-<os>-<arch>`；macOS 使用 `darwin`。`nvm_get_artifact_compression` 初始选择 `tar.gz`，当 `nvm_supports_xz` 成立时改为 `tar.xz`。xz 的可用性取决于 OS 和工具环境：例如 macOS 需至少 10.9；其他 OS 还可能要求 `xz` 可执行文件。当前受支持 Node.js 发布线满足版本方面的现代 xz 条件，但这不消除环境方面的条件。

因此，仅导出同一目标平台的 `.tar.gz`，不能保证具备 xz 条件的客户端会自动改用它；仅导出 `.tar.xz`，也不能保证无 xz 条件的客户端会请求它。需要在后续兼容承诺中明确覆盖哪些消费者环境，或保留两种官方文件。源码构建回退可以请求 `node-vV.tar.xz`/`.tar.gz`，但源码文件目前不是用户确认的默认下载内容，不能承诺无二进制时仍可安装。

来源：[固定 nvm.sh](https://github.com/nvm-sh/nvm/blob/a885b885fef16fac4bc544188fb25e9e37ae83e8/nvm.sh)，`nvm_get_download_slug`、`nvm_get_artifact_compression`、`nvm_supports_xz`、`nvm_download_artifact`。

### 3.3 原始校验清单与签名是不同保障

`nvm_get_checksum` 对现代版本请求 `M/vV/SHASUMS256.txt`，按清单中的文件名匹配所选 archive；历史 SHA-1 路径可能使用 `SHASUMS.txt`。`nvm_compare_checksum` 对内容校验；源码也包含本机无法计算 hash 时警告后继续的特殊路径，所以不能把“nvm 总能强制校验”当作本应用自己的完整性保证。

上述路径未调用 `SHASUMS256.txt.asc`/`.sig` 的 PGP 验证。校验和文件与分发包通过同一不可信渠道被替换时，普通 hash 对比不提供独立来源真实性；应用是否验证官方签名需要独立决策。

来源：[固定 nvm.sh](https://github.com/nvm-sh/nvm/blob/a885b885fef16fac4bc544188fb25e9e37ae83e8/nvm.sh)，`nvm_get_checksum`、`nvm_compare_checksum`、`nvm_download_artifact`。

## 4. nvm-windows v2.0.1 的契约

### 4.1 `index.tab` 与别名

`common/resolver/catalog.go` 的 `fetchIndexTab` 从配置的 Node mirrors 逐个请求 `/index.tab`；`parseIndexTab` 跳过 header 并读取版本、日期、npm、LTS、security 列。此处不基于平台文件列剔除无法下载的目标组合。它有内存/磁盘缓存和失败时使用旧缓存的路径，因此镜像索引变化并不必然立即出现在所有客户端。

`resolver.Find`、`Resolve` 支持精确/部分版本、别名及 semver 范围；`latest` 取 catalog 首个记录，`lts` 取首个有 LTS 名称的记录，`lts/<name>` 匹配名称。它同样不读取官方生命周期时间表。源码还包含无法匹配 minor/patch 时回退同一 major 首个记录的行为，不应在本应用中照搬为安全的精确选择规则。

来源：[固定 catalog.go](https://github.com/nvm-windows/common/blob/e92b67d855c1f697cfc695535b85cdb0e7973d96/resolver/catalog.go)、[固定 resolver.go](https://github.com/nvm-windows/common/blob/e92b67d855c1f697cfc695535b85cdb0e7973d96/resolver/resolver.go)。

### 4.2 标准安装 `.7z`，失败切换镜像而非格式

`cli/src/installer/installer.go` 的 `downloadNode`：

- 以 `runtime.GOARCH` 选架构，将 `amd64` 映射为 `x64`。
- 固定 `archiveName = node-vV-win-<arch>.7z`。
- 对 `settings.Global().NodeMirror` 中每个 URL，请求 `M/vV/SHASUMS256.txt`，再请求 `M/vV/node-vV-win-<arch>.7z`。
- 下载/校验文件获取失败等条件切换后续 mirror；某些权限/访问失败会直接停止。该标准路径没有构造 `.zip` URL，也没有 ZIP 格式回退。
- 下载后调用 `verifyNodeSHASUM`。

来源：[固定 installer.go](https://github.com/nvm-windows/cli/blob/fe08afeed22f15b10f07f02df6fcfca0f7d5a77c/src/installer/installer.go#L343-L539)、[固定缓存路径构造](https://github.com/nvm-windows/cli/blob/fe08afeed22f15b10f07f02df6fcfca0f7d5a77c/src/installer/cache.go)。

故对于“v2.0.1 标准在线安装”这一具体承诺，Windows `.7z` 是所需文件，仅提供 ZIP 不够；这不等同于对所有 nvm-windows 版本或所有安装方式宣称“绝对不支持 ZIP”。该版本 Community release 提供 amd64/arm64 builds；文件名映射基于运行架构，不应假定它沿用旧版 `32/64/all` 参数和多架构安装模型。[官方 release](https://github.com/nvm-windows/nvm/releases/tag/v2.0.1)

### 4.3 校验及其他安全行为

`verifyNodeSHASUM` 计算 SHA-256，扫描清单并按 basename 找条目；匹配到后比较 hash，没有条目返回错误。PGP detached signature 不是该函数的输入。客户端另外存在 Windows publisher/Authenticode 验证，这是与 archive hash 不同的机制，不能用重新签名本地清单替代。

来源：[固定 verification.go](https://github.com/nvm-windows/cli/blob/fe08afeed22f15b10f07f02df6fcfca0f7d5a77c/src/installer/verification.go)、[固定 cache_integrity.go](https://github.com/nvm-windows/cli/blob/fe08afeed22f15b10f07f02df6fcfca0f7d5a77c/src/installer/cache_integrity.go)。

`node_mirror` 的默认值仍为 `https://nodejs.org/dist`，配置类型为 mirror 列表。Community 源码的 `mirrorauth.HeadersForURL` 为 no-op；Certified build 的 Author-hosted mirror 身份处理是另一机制，不能视为已证实可向任意 Nexus 发自定义 Authorization header。[settings/options.go](https://github.com/nvm-windows/common/blob/e92b67d855c1f697cfc695535b85cdb0e7973d96/settings/options.go)、[mirrorauth.go](https://github.com/nvm-windows/common/blob/e92b67d855c1f697cfc695535b85cdb0e7973d96/mirrorauth/mirrorauth.go)

此次没有实测客户端的许可、证书撤销、离线策略、组织代理或其他外围联网行为，因此 `.7z`、索引与清单齐备不能被扩大为“客户端完全离线可用”的结论。

## 5. nvm-windows 1.2.2 的版本差异

旧版 `node.GetAvailable` 请求 `index.json`，将字符串形式的 `lts` 视为 LTS；同样没有官方 EOL 时间表判断。`getVersion` 经 `findLatestSubVersion` 处理主/次版本，`getLTS` 使用 JSON 中的 LTS 列表。`getLatest` 特殊请求 `latest/SHASUMS256.txt`，从 MSI 文件名提取版本号，并不使用 v2 的 `index.tab` 首行逻辑。

来源：[固定 node.go](https://github.com/nvm-windows/nvm/blob/c05902234e6e7dcdcad8a3f3b99ad48d2c89fa94/src/node/node.go)、[固定 nvm.go](https://github.com/nvm-windows/nvm/blob/c05902234e6e7dcdcad8a3f3b99ad48d2c89fa94/src/nvm.go)，`getVersion`、`getLatest`、`getLTS`。

`web.getNodeUrl` 在 `append == false` 且版本 `>=16.9.0` 时请求 `vV/node-vV-win-<arch>.zip`；其他路径使用 `vV/<architecture-prefix>node.exe`，现代正主版本的 prefix 为 `win-x86/`、`win-x64/` 或 `win-arm64/`。ZIP 包包含 node 和 npm；旧版单可执行文件路径、追加架构路径可能再获取 npm，不能因为 Node.js 镜像齐备就承诺全部历史用例不再访问外部 npm 源。

这是条件分支，不应描述成“ZIP 失败自动回退 node.exe”。`getNodeUrl` 的代码按条件选 URL 并 HEAD 检查；它不是 v2.0.1 的格式选择逻辑。

来源：[固定 web.go](https://github.com/nvm-windows/nvm/blob/c05902234e6e7dcdcad8a3f3b99ad48d2c89fa94/src/web/web.go)，`SetMirrors`、`GetNodeJS`、`getNodeUrl`；[旧版安装逻辑](https://github.com/nvm-windows/nvm/blob/c05902234e6e7dcdcad8a3f3b99ad48d2c89fa94/src/nvm.go)。旧版 Node download helper 没有新版标准 archive 安装的 `verifyNodeSHASUM` 调用，不把它视作提供同样校验承诺。

若以后要求兼容旧版 `latest`，仅生成 `index.json` 还不够；必须单独处理 `latest/SHASUMS256.txt`。它靠 MSI 名称发现版本，即便不下载 MSI，也需要保持这类名称在 discovery 文件中的语义。如何把 latest 指向实际选中可用版本属于产品策略，不在本次调研中决定。

## 6. 真实文件与 URL 示例

已读取 [官方 v22.16.0 原始 SHASUMS256.txt](https://nodejs.org/dist/v22.16.0/SHASUMS256.txt)，确认同一发行版本包含以下相对路径；没有下载这些分发文件：

```text
v22.16.0/SHASUMS256.txt
v22.16.0/node-v22.16.0-linux-x64.tar.xz
v22.16.0/node-v22.16.0-linux-x64.tar.gz
v22.16.0/node-v22.16.0-darwin-arm64.tar.xz
v22.16.0/node-v22.16.0-darwin-arm64.tar.gz
v22.16.0/node-v22.16.0-win-x64.7z
v22.16.0/node-v22.16.0-win-x64.zip
v22.16.0/win-x64/node.exe
v22.16.0/node-v22.16.0.tar.xz
```

其中 Windows `.7z`、`.zip`、`node.exe` 并不是可任意互换的同名文件；最后一项为源码包，并非默认二进制镜像内容。具体消费者仍由前述固定版本源码决定。

## 7. Nexus raw 路径映射与访问条件

Sonatype raw hosted repository 保存普通文件，官方上传示例使用 HTTP PUT 到 `/repository/<name>/<relative-path>`。因此可以将本地 `nodejs/` 内的相对路径原样上传到一个 raw hosted 仓库，例如：

```text
本地：<output-root>/nodejs/index.tab
远端：https://nexus.example.com/repository/nodejs/index.tab

本地：<output-root>/nodejs/v22.16.0/node-v22.16.0-win-x64.7z
远端：https://nexus.example.com/repository/nodejs/v22.16.0/node-v22.16.0-win-x64.7z

镜像根 URL：https://nexus.example.com/repository/nodejs
```

若上传操作额外保留顶层 `nodejs/`，mirror URL 也必须包含额外这一层；不能让镜像根仍指向仓库根而文件全部多了一层。以上只是地址映射示例，未执行上传，也未验证用户 Nexus 的部署配置。

来源：[Sonatype Raw Repositories](https://help.sonatype.com/en/raw-repositories.html)，`Creating a Hosted Raw Repository`、`Uploading Files to Hosted Raw Repositories`、`Publishing a Maven Site`。官方文档支持直接访问文件与静态内容，但不能从“browsable”推导出 Nexus 自动产生与 nodejs.org 完全同形的目录 HTML、软链接和全部 upstream 行为。所查核心客户端路径主要需要显式索引/文件，而非 HTML 抓取，所以是否具备自动目录列表不是这些路径的首要必要条件。

无认证客户端下载依赖匿名 read 权限；Sonatype 文档说明启用 anonymous access 后使用匿名角色权限，默认 `nx-anonymous` 含 read/browse，不代表用户实例已启用或未收紧权限。[Sonatype Anonymous Access](https://help.sonatype.com/en/anonymous-access.html)

nvm-sh 官方支持 `NVM_AUTH_HEADER`，由 `nvm_download` 加入 Authorization header；另外两个 Windows 版本的任意 Nexus 认证方案并未在此次调查中得到端到端确认。不能把 Nexus UI 登录或上传凭据当成客户端自动获得的下载权限。[nvm-sh 官方 README](https://github.com/nvm-sh/nvm/blob/v0.40.8/README.md)、[固定 nvm_download](https://github.com/nvm-sh/nvm/blob/a885b885fef16fac4bc544188fb25e9e37ae83e8/nvm.sh)

## 8. 部分镜像带来的事实约束

1. 保留官方全量 `index.tab`/`index.json` 会向客户端展示尚未镜像的版本；客户端的 latest/LTS/范围选择可能挑中缺失文件，然后下载失败。只删除或过滤 `files` 列不能解决全部消费者问题，nvm-sh 与 v2 catalog 主要依赖版本与 LTS 行信息。[nvm.sh](https://github.com/nvm-sh/nvm/blob/a885b885fef16fac4bc544188fb25e9e37ae83e8/nvm.sh)、[v2 catalog](https://github.com/nvm-windows/common/blob/e92b67d855c1f697cfc695535b85cdb0e7973d96/resolver/catalog.go)
2. 按本地子集生成索引能够限制发现范围，但单个共享行仍不表示所有操作系统、架构、压缩格式齐全；需要明确镜像承诺的目标组合与消费者。catalog 不能替文件级清单完成这一承诺。
3. 原始 `SHASUMS256.txt` 可以含未镜像文件的 hash；所查校验实现查找目标 basename，不要求清单每一行都在镜像存在。保留原始清单不会自动使未镜像文件可下载，但保留了原始清单字节与独立验证条件。[nvm_get_checksum](https://github.com/nvm-sh/nvm/blob/a885b885fef16fac4bc544188fb25e9e37ae83e8/nvm.sh)、[v2 verification](https://github.com/nvm-windows/cli/blob/fe08afeed22f15b10f07f02df6fcfca0f7d5a77c/src/installer/verification.go)
4. 若过滤或重写官方校验清单，原始 detached signature 就不能作为修改后字节的真实性证明。即使客户端只对 hash，也不能将其宣传为保留官方签名；是否保存 `.asc`/`.sig`、由应用验证还是提供给外部工具，仍待决定。
5. nvm 客户端自己的 `lts` 选择不等同于本项目“当前仍受支持 LTS”。界面过滤、镜像索引覆盖、已保存内容的保留与删除是不同业务行为。
6. 文件上传次序、批次失败和索引发布时间会影响消费者可用性；Nexus URL 结构并不提供跨一批文件与索引的天然事务。本次没有验证具体 Nexus 版本的部署策略，不预设可以原子切换整个仓库。

## 9. 已查清与尚未证明的边界

已查清：固定稳定客户端的关键发现路径、分发文件格式与校验路径；旧版 Windows 的契约差异；官方实际文件存在性；Nexus raw 相对路径映射和匿名访问的一般必要条件。

尚未证明：用户 Nexus 的具体版本、权限、反向代理、证书和 URL 配置；实际客户端在该 Nexus 上的安装结果；所有历史客户端/历史发布版本；v2 Community/Certified 的全部商业/离线行为；是否需要兼容旧版客户端；需要何种级别的官方签名真实性；哪些 partial mirror 发现/安装命令应被承诺成功。这些限制不妨碍把本议题按“源码与文档事实调研”解决，但必须保留为下游决定与验收边界。
