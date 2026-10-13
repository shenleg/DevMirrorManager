# 官方版本目录、分发文件与当前受支持 LTS 调研

本文件记录版本目录和官方维护周期的数据契约、实测样本与限制，供后续筛选、文件选择和缓存策略决策使用；不锁定页面交互或下载实现。

调查日期：2026-10-13（会话日期）。仅请求官方 JSON、文本、目录页面和源码，未下载或执行分发包，未安装依赖。

## 结论

1. `dist/index.json` 适合版本搜索、语义版本排序与发行版本元数据；**`lts` 标记并不表示当前仍受支持**。必须结合 Node.js Release 官方 `schedule.json` 对发布线的维护周期判断。[索引](https://nodejs.org/dist/index.json)、[时间表](https://raw.githubusercontent.com/nodejs/Release/main/schedule.json)、[维护定义](https://github.com/nodejs/Release#release-phases)
2. `files` 是经过转换的文件类别标识，**不是完整文件列表，也不足以确定所有压缩格式或所有可执行文件是否存在**。具体选择应补查该版本的 `SHASUMS256.txt`；HTML 目录提供交叉验证和文件大小信息。[生成器](https://github.com/nodejs/nodejs-dist-indexer/blob/main/src/dist-indexer.js)、[映射](https://github.com/nodejs/nodejs-dist-indexer/blob/main/src/transform-filename.js)、[实测清单](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt)
3. 按会话日期与取得的官方时间表计算，当前受支持 LTS 发布线是 **v22（Maintenance LTS）与 v24（Active LTS）**；v20 已 EOL，v26 尚为 Current。这是调查快照，不是应写入应用的固定列表。[时间表](https://raw.githubusercontent.com/nodejs/Release/main/schedule.json)、[官方状态页](https://nodejs.org/en/about/previous-releases)
4. 已观察到同一操作系统、CPU 架构和格式仍有不同 Linux libc 变体；`linux-x64` 与 `linux-x64-musl` 不能当成同一个目标。这需要后续明确第一版的变体范围，不应静默合并。[v24 清单](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt)

## 1. 版本索引契约

### 官方入口和字段

- JSON：`https://nodejs.org/dist/index.json`。
- TSV：`https://nodejs.org/dist/index.tab`。
- 官方生成器 README 还列出 `/download/release/index.json` 与 `/download/release/index.tab`；本项目已指定 `/dist/`，不需要因此改换上游。[官方生成器说明](https://github.com/nodejs/nodejs-dist-indexer)

本次直接解析 JSON 得到 870 条记录。首条为 `v26.11.1`，发行日期 `2026-10-07`；观察字段为：

```text
version, date, files, npm, v8, uv, zlib, openssl, modules, lts, security
```

`version` 是含 `v` 的完整发行版本；`date` 是发行日期字符串；`files` 是类别标识数组；组件版本和 `modules` 是字符串；`lts` 在样本中为 `false` 或代号字符串；`security` 为布尔值。TSV 使用同序列列名，文件类别用逗号连接，非 LTS 的 `lts` 和非安全更新的 `security` 表示为 `-`。[JSON 实测](https://nodejs.org/dist/index.json)、[TSV 实测](https://nodejs.org/dist/index.tab)

生成器最终按 `semver.compare` 对发行版本降序排序，而非按日期或字符串排序。应用可依据完整版本号进行主版本匹配、精确匹配和搜索；若支持 LTS 代号搜索，代号直接来自 `lts`，不需要用户录入。搜索的具体匹配语义仍属交互决策。[生成器源码](https://github.com/nodejs/nodejs-dist-indexer/blob/main/src/dist-indexer.js)

### LTS 标记的来源与边界

生成器为对应 Git ref 读取 `src/node_version.h`：检查 `NODE_VERSION_IS_LTS 1`，并取 `NODE_VERSION_LTS_CODENAME`。因此标记属于**这次发行版本**，不是对今天支持状态的实时查询。[生成器 `fetchLtsVersion`](https://github.com/nodejs/nodejs-dist-indexer/blob/main/src/dist-indexer.js)

实测反例：

| 发行版本 | 索引 `lts` | 2026-10-13 的筛选结论 |
| --- | --- | --- |
| `v20.20.2` | `"Iron"` | 排除：发布线已 EOL |
| `v22.23.3` | `"Jod"` | 包含：Maintenance LTS |
| `v24.21.0` | `"Krypton"` | 包含：Active LTS |
| `v24.10.0` | `false` | 排除：同为 v24，但这次发行尚未进入 LTS |
| `v26.11.1` | `false` | 排除：Current，不是 LTS |

来源：[索引](https://nodejs.org/dist/index.json)、[时间表](https://raw.githubusercontent.com/nodejs/Release/main/schedule.json)。

生成器存在单项元数据拉取失败后继续输出记录的代码路径，缺失值可能被 JSON 序列化省略；LTS 代号解析失败也可能产生 `null`。不能把“任何 truthy 值”当成健全的 LTS 记录，也不能假设官方给出了永不变化的严格 JSON Schema。应用应验证所需字段并将异常记为未知，而不是猜测支持状态。[生成器源码](https://github.com/nodejs/nodejs-dist-indexer/blob/main/src/dist-indexer.js)

## 2. 当前受支持 LTS 的时间依据

官方 Release Working Group 定义：Current 接收主分支的适当非破坏性变化，Active LTS 接收经审查的稳定更新，Maintenance 以重要修复和安全更新为主；“supported release lines”指尚未 EOL 的发布线。用户的筛选比这一总集合窄：它还要求进入 LTS。[官方维护定义](https://github.com/nodejs/Release#release-phases)

本次取得的时间表：

| 发布线 | LTS 开始 | Maintenance 开始 | EOL 日期 | 会话日期对应阶段 |
| --- | --- | --- | --- | --- |
| v20 | 2023-10-24 | 2024-10-22 | 2026-04-30 | EOL |
| v22 | 2024-10-29 | 2025-10-21 | 2027-04-30 | Maintenance LTS |
| v24 | 2025-10-28 | 2026-10-20 | 2028-04-30 | Active LTS |
| v26 | 2026-10-28 | 2027-10-20 | 2029-04-30 | Current |

来源：[官方 `schedule.json`](https://raw.githubusercontent.com/nodejs/Release/main/schedule.json)。官方状态页也显示 v20 EOL、v22/v24 LTS、v26 Current，与本次计算一致。[状态页](https://nodejs.org/en/about/previous-releases)

### 可以据此制定的判定规则

以下为基于来源的**建议算法**，不是官方承诺的应用 API：

1. 以查询时钟的当前日期为基准，解析每个发行版本所属主版本发布线。
2. 该发行版本必须具有有效、非空的 LTS 代号；仅有发布线 LTS 日期不够。
3. 其发布线须具备有效 `lts`、`end` 日期，且处于两者之间；Maintenance LTS 仍在支持范围内。
4. 使用 `maintenance` 区分 Active 与 Maintenance；不存在或格式异常的字段不能靠偶数主版本或固定支持年数补全。
5. 日期到达转换点时重新计算，不仅在刷新 JSON 时计算；否则缓存内容不变也会造成 EOL 后仍显示受支持。

**未由来源解决的边界**：时间表只提供 `YYYY-MM-DD`，没有规定精确转换时刻、时区或结束日是否含当日。可建议采用 UTC 日期与半开区间 `[lts, end)`，但必须在实现/验收决策中明确，不能声称这是已验证的官方时间语义。[时间表](https://raw.githubusercontent.com/nodejs/Release/main/schedule.json)

支持周期属于发布线，并不保证该发布线每个旧补丁版本均包含最新安全修复。用户已要求支持线内带 LTS 标记的发行版本；是否另外突出“该线最新补丁”属于展示或安全提示策略，不应把“受支持发布线”文案扩大为“每个旧补丁均安全”。[维护定义](https://github.com/nodejs/Release#release-phases)、[索引中的安全更新样本](https://nodejs.org/dist/index.json)

### 不能硬编码偶数主版本规则

官方状态页及新发布计划公告说明，从 Node.js 27 起改为年度周期，并使每个主版本最终进入 LTS；此前偶数 LTS 的规则不能作为长期算法。[官方状态页](https://nodejs.org/en/about/previous-releases)、[发布计划变更公告](https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule)

本次取得的 `v27` 时间表含 `alpha: 2026-10-28`、`start: 2027-04-22`、`maintenance: 2027-10-20`、`end: 2030-04-30`，**尚无 `lts` 字段**。这表示当前数据不足以给它计算未来 LTS 起点，不应推断它永远没有 LTS，也不应自行填充日期。Release README 的旧奇偶叙述与新的官网公告并未完全同步；实际筛选依赖时间表字段与发行标记，遇到缺失应呈现未知或按另行确定的降级规则处理。[时间表](https://raw.githubusercontent.com/nodejs/Release/main/schedule.json)、[Release README](https://github.com/nodejs/Release#release-plan)、[变更公告](https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule)

## 3. 从类别到实际分发文件

### 为什么 `files` 不能直接生成所有 URL

官方索引生成器的 `dirFiles` 从每个版本的 `SHASUMS256.txt` 取得文件名，交给 `transformFilename` 映射并过滤未识别项，最后排序。映射将 `.tar.gz` 去后缀得到类别，却没有相同的 `.tar.xz` 归一化；所以一个 `linux-x64` 标识并不能逐一列出格式。[生成器](https://github.com/nodejs/nodejs-dist-indexer/blob/main/src/dist-indexer.js)、[映射](https://github.com/nodejs/nodejs-dist-indexer/blob/main/src/transform-filename.js)

已验证的映射例子：

- `darwin-arm64` 对应 `osx-arm64-tar`，索引与文件名的操作系统词汇不同。
- `win-x64.zip` 对应 `win-x64-zip`；`win-x64/node.exe` 对应 `win-x64-exe`。
- 当前映射缺少 `win-arm64/node.exe`，但 v22/v24/v26 的校验清单实际包含该文件；**类别中没有某 token 不等于对应分发文件不存在**。

来源：[映射源码](https://github.com/nodejs/nodejs-dist-indexer/blob/main/src/transform-filename.js)、[v24 清单](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt)、[v22 清单](https://nodejs.org/dist/v22.23.3/SHASUMS256.txt)、[v26 清单](https://nodejs.org/dist/v26.11.1/SHASUMS256.txt)。

### 实测 v24.21.0 文件样本

```text
node-v24.21.0-linux-x64.tar.gz
node-v24.21.0-linux-x64.tar.xz
node-v24.21.0-linux-x64-musl.tar.gz
node-v24.21.0-linux-x64-musl.tar.xz
node-v24.21.0-darwin-arm64.tar.gz
node-v24.21.0-darwin-arm64.tar.xz
node-v24.21.0-win-arm64.zip
node-v24.21.0-win-arm64.7z
node-v24.21.0-win-x64.zip
node-v24.21.0-win-x64.7z
win-arm64/node.exe
win-x64/node.exe
```

其清单共有 34 条文件及 SHA-256 记录，包含嵌套相对路径。目录页还列出 `SHASUMS256.txt`、`.asc`、`.sig`，普通文件有大小和时间戳，`win-*` 目录本身无可用大小。保留官方相对路径时不能将 `win-x64/node.exe` 扁平化到版本目录。[清单](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt)、[目录](https://nodejs.org/dist/v24.21.0/)

版本之间不具有相同目标集合：v22.23.3 清单含 Windows x86 ZIP/7z 与 `win-x86/node.exe`，索引还含 `linux-armv7l`；v24.21.0 没有这些组合。只能使用所选发行版本自己的实际文件证据，不能生成操作系统×架构×格式的全组合。[v22 清单](https://nodejs.org/dist/v22.23.3/SHASUMS256.txt)、[v24 清单](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt)、[索引](https://nodejs.org/dist/index.json)

**建议数据流程**：用索引发现版本、显示发行元数据；对待选或待提交的发行版本取得原始校验清单，将允许的实际相对路径解析成分发文件，再从这些文件派生可选平台/格式。HTML 目录用于大小展示与异常交叉验证，不把 HTML 布局当作有正式稳定性承诺的 API。源码和所有未知 token 的展示范围，以及 nvm 所需最小格式，应由后续议题决定。

SHA-256 清单有助于得到准确文件名和校验值，但仅取得文本并不等于验证其独立签名；签名真实性和部分镜像是否原样保留清单属于其他议题。将上游路径落盘时仍须验证相对路径安全，不能无条件信任远程文本。[清单及签名入口](https://nodejs.org/dist/v24.21.0/)

## 4. 更新、缓存与观察时间限制

直接网络读取本次观察到：

| 来源 | `Date` 响应头 | `Last-Modified` | `Cache-Control` |
| --- | --- | --- | --- |
| `dist/index.json` | 2026-10-12 16:38:47 GMT | 2026-10-07 23:52:50 GMT | `public, max-age=3600, s-maxage=14400` |
| `Release/main/schedule.json` | 2026-10-12 16:38:50 GMT | 无 | `max-age=300` |
| v24.21.0 校验清单 | 2026-10-12 16:38:51 GMT | 2026-09-08 21:48:15 GMT | `public, max-age=3600, s-maxage=14400` |

以上三个响应均含 `ETag`。这些是**本次观察到的 HTTP 行为**，不是永不变化的更新周期或 SLA；客户端可以考虑条件请求，但应用自己的过期和失败策略仍待决定。[索引入口](https://nodejs.org/dist/index.json)、[时间表入口](https://raw.githubusercontent.com/nodejs/Release/main/schedule.json)、[清单入口](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt)

重要限制：响应头日期为 2026-10-12，而会话日期为 2026-10-13。现有官方版本日期与文件修改日期也不同，例如 `v24.21.0` 索引发行日期是 2026-09-07，目录/清单修改日期是 2026-09-08。报告如实记录这些差异，不把网络响应日期、发行日期和查询日期混为一谈，也不据此改写版本支持结论。

官方时间表明确声明日期可能改变。因此，版本索引与支持周期应分开缓存、分别显示更新时间，不能仅更新发行列表却永远不更新生命周期数据。网络失败时不能将旧生命周期数据伪装为当前确定状态；继续使用旧缓存、提示过期、禁用 LTS 筛选等选择需用户确认。[Release 时间表说明](https://github.com/nodejs/Release#release-schedule)

## 5. 仍待决策的问题

- 时区、支持截止日和时钟异常的精确判定边界；建议 UTC 与 `[lts, end)`，但须明确它是产品规则。
- 生命周期数据缺失、过期或获取失败时的降级行为，以及 `v27` 这类未来记录缺字段的呈现。
- Linux libc/ABI 变体是否纳入第一版选择；现有“操作系统×CPU 架构×格式”不能唯一识别全部实际文件。
- 支持线中是否显示全部 LTS 历史补丁，以及如何突出最新安全更新；不能把支持线状态当成每个补丁的安全保证。
- 版本校验清单的获取时机、缓存、大小信息来源，以及真实文件集合加载失败时是否禁止提交。

以上均可作为现有交互、技术边界或验收议题的输入，本调研不代替用户作取舍。

## Sources

- [Node.js 官方 JSON 版本索引](https://nodejs.org/dist/index.json)
- [Node.js 官方 TSV 版本索引](https://nodejs.org/dist/index.tab)
- [Node.js Release 官方时间表](https://raw.githubusercontent.com/nodejs/Release/main/schedule.json)
- [Node.js Release 维护周期与时间表说明](https://github.com/nodejs/Release)
- [Node.js 官方支持状态页面](https://nodejs.org/en/about/previous-releases)
- [Node.js 官方年度发布计划变更公告](https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule)
- [Node.js 官方分发索引生成器](https://github.com/nodejs/nodejs-dist-indexer)
- [索引字段与清单读取源码](https://github.com/nodejs/nodejs-dist-indexer/blob/main/src/dist-indexer.js)
- [文件类别映射源码](https://github.com/nodejs/nodejs-dist-indexer/blob/main/src/transform-filename.js)
- [v24.21.0 官方文件目录](https://nodejs.org/dist/v24.21.0/)
- [v24.21.0 官方校验清单](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt)
- [v22.23.3 官方校验清单](https://nodejs.org/dist/v22.23.3/SHASUMS256.txt)
- [v26.11.1 官方校验清单](https://nodejs.org/dist/v26.11.1/SHASUMS256.txt)
