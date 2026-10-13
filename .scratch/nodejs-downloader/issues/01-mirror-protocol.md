# nvm 双客户端与 Nexus 路径的兼容契约

Type: research
Labels: wayfinder:research
Status: resolved
Blocked by: none
Assignee: collin

本议题调查镜像消费者的真实协议与路径需求，不决定部分镜像的元数据发布策略。

## Question

nvm-sh 与 nvm-windows 分别从镜像请求哪些索引、版本目录、分发文件与校验文件？在保留官方文件名和相对路径、仅导出所选内容的前提下，兼容契约是什么，哪些组合天然不兼容？

调查当前稳定客户端的源码和官方文档，明确客户端版本及调查日期，至少覆盖：

- 指定精确版本、主版本、最新版本或 LTS 时的发现行为；区分 nvm-sh 与 nvm-windows 各自实际支持的命令。
- macOS/Linux 压缩包，Windows ZIP、可执行文件及其他回退路径的真实用途；哪些只针对历史版本，哪些影响仍受支持版本。
- `index.json`、`index.tab`、HTML 目录列表、`SHASUMS256.txt` 与签名文件是否必要；每一项由谁消费。
- 根 URL 与版本目录的拼接规则，Nexus raw 仓库路径映射，以及目录浏览能力或认证的限制；不要假设 raw 仓库等同于一个通用静态网站。
- 部分镜像、保留原始索引和保留原始校验文件会产生哪些事实层面的约束。
- 用源代码与具体 URL 举例，不实际下载或执行 Node.js 二进制。

证据保存在 [nvm 与 Nexus 兼容调研](../research/mirror-protocol.md)。答案需区分已验证事实、受客户端版本影响的行为、仍待用户选择的策略。

## Answer

事实调研已完成，详见 [nvm 与 Nexus 兼容调研](../research/mirror-protocol.md)。已固定官方稳定 release 和 tag 对应提交，v2 主仓库与子模块的 SHA 均列在报告中，未使用分支 HEAD 推断稳定契约。

- 当前稳定 nvm-sh `v0.40.8` 用 `index.tab` 发现版本，按本机环境选择 `.tar.xz` 或 `.tar.gz`，从版本目录取 `SHASUMS256.txt`。仅保留一种格式不一定满足不同客户端环境。
- 当前稳定 nvm-windows 已为 `v2.0.1`：主仓库 commit `9fca746c26543400095e5f164625a2aecb77769f`，固定 CLI 子模块 `fe08afeed22f15b10f07f02df6fcfca0f7d5a77c` 和 common 子模块 `e92b67d855c1f697cfc695535b85cdb0e7973d96`。它用 `index.tab`，标准在线 `downloadNode` 路径固定请求 Windows `.7z` 和 `SHASUMS256.txt`，失败切换镜像，未发现 ZIP 格式回退。这是该版本该路径的结论，不是所有版本/安装方式绝对不支持 ZIP。
- 旧版 nvm-windows `1.2.2` 对照用 `index.json`；`latest` 另外读取 `latest/SHASUMS256.txt`。非追加安装且 Node.js `>=16.9.0` 请求 ZIP，其他条件可用架构子目录 `node.exe`，不能表述成 ZIP 失败的自动格式回退。
- 两种当前客户端的 LTS 别名判断都不包含官方支持周期判断；界面的“当前受支持 LTS”需独立建模。
- Nexus raw 可以保留相对路径，mirror URL 必须指向实际内容根；不能默认拥有 nodejs.org 的目录 HTML、软链接或批次原子发布能力。匿名/认证权限是额外条件，未检查用户实例。
- 保留上游全量索引会发现不存在的镜像文件；原始校验清单可含未下载条目，目标 hash 校验不要求所有条目存在。修改清单后不能再声称原始签名验证其字节。

待用户决策：明确兼容哪些客户端版本与安装环境、是否覆盖旧版元数据和 Windows ZIP、nvm-sh 的压缩格式范围、部分镜像索引与发布策略、签名真实性级别及 Nexus 下载访问前提。未执行客户端安装、上传或部署，不能将源码契约写成端到端验收已通过。

## Comments

- 2026-10-13 resolution：完成固定版本源码、官方发布信息、官方校验清单和 Sonatype 文档调查；路径与格式差异的证据保存在关联调研资产。未实现应用、下载/执行分发包、修改配置、提交或推送。地图索引由主会话统一更新。

