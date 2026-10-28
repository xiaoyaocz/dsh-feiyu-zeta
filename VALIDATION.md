# dsh-feiyu-zeta 验证范围与记录

当前项目：[xiaoyaocz/dsh-feiyu-zeta](https://github.com/xiaoyaocz/dsh-feiyu-zeta)，版本 `0.4.4`。目标宿主为 DeepSeek Harness `0.2.1-rc.3`，Node.js `>=24.9.0`。

这是个人测试、自用实验项目。验证用于说明实际检查过的行为，不是生产稳定性承诺。更名前的旧包结果与更名后的新包结果分别记录。

## 0.4.4 GitHub 安装适配

仓库直接提交 `dist/`、`lib/` 及原有运行资源，不依赖安装时的编译钩子；保留精确宿主兼容要求。新增分发完整性检查和 GitHub CI，检查干净构建是否与提交的产物一致。

本轮类型检查、507 项单元与协议测试、12 项分发检查器测试通过；干净构建产物检查覆盖源码分发中的 130 个文件（安装包省略锁文件时为 129 个）、92 个 JavaScript 文件、156 条相对依赖和 SQLite 索引中的 24 张内置表情。实际 npm 归档解压后可在无 `node_modules` 的目录运行分发检查器。Windows 安装助手的 GitHub 来源及桌面 profile 计划已用 `-WhatIf` 检查，未修改日常配置。

官方 DSH rc.3 / pnpm 11 的两条 Git 安装路径均已完成实际验证：

- 本地 `git+file` 全离线安装初版 0.4.4 固定提交，132 项检查通过，结果位于 `output/host-git-local-0.4.4/summary.json`。
- 直接从 GitHub 安装 [`e6167c20b07cf2cc404d7f486d668f603c84dad3`](https://github.com/xiaoyaocz/dsh-feiyu-zeta/commit/e6167c20b07cf2cc404d7f486d668f603c84dad3)，132 项检查通过，结果位于 `output/host-github-0.4.4-final/summary.json`。锁文件记录了指定提交，首次运行 84 项、重启 36 项及安装产物 12 项均通过；宿主入口、设置页模块标识、语言资源、Schedule 包装入口、24 张表情均完整。

两条路径均未使用安装编译钩子或构建审批，首次运行调用本地假模型 14 次、重启零次，没有发送真实 QQ 消息或调用收费服务。日常 profile 未被修改。首次 Linux CI 发现旧 npm 锁文件混入本地 pnpm 链接，Windows 父目录依赖掩盖了缺包。已从仅含 package.json 的干净目录重新生成纯 registry 锁文件，并用 npm ci --ignore-scripts 安装的独立副本通过类型检查、507 项测试及 12 项分发检查器测试；二维码终端依赖确认位于该副本内。检查器新增锁文件回归检查。使用新锁文件重建后的页面通过 83 项浏览器检查。[Linux / Node 24 GitHub CI](https://github.com/xiaoyaocz/dsh-feiyu-zeta/actions/runs/40743445589) 已全部通过，包括 Git 归档无依赖检查、纯净依赖安装、507 项测试、12 项检查器测试、清空产物后重建、提交产物一致性和实际 npm 归档检查。

可复跑正式 GitHub 验证：

```sh
node scripts/verify-host.mjs --spec github:xiaoyaocz/dsh-feiyu-zeta#<完整40位提交SHA> --expected-version 0.4.4 --output ./output/host-github-0.4.4
```

## 0.4.3 公共资料库验证（历史）

本轮移除管理空间选择，所有聊天和自主生活共用公共记忆、语音、图片、网页与表情资料。以下针对新构建的 `dsh-feiyu-zeta-0.4.3.tgz`：

| 检查 | 可复跑命令 | 本轮结果 |
| --- | --- | --- |
| 宿主与客户端类型检查 | `npm run check` | 通过 |
| 离线单元与协议测试 | `npm test` | 41 个文件、506 项通过 |
| 构建和归档 | `npm run build`、`npm pack --ignore-scripts` | 通过 |
| 浏览器设置页 | `node scripts/verify-panel.mjs` | 83 项检查、80 次本地模拟请求通过 |
| 官方 DSH 实际升级 | `node scripts/verify-host.mjs --package ./dsh-feiyu-zeta-0.4.3.tgz --upgrade-from ./dsh-feiyu-zeta-0.4.2.tgz` | 旧版准备 19 项；新版升级 94 项、重启 36 项通过 |
| 隔离双机备份迁移 | `node scripts/verify-backup-host.mjs --package ./dsh-feiyu-zeta-0.4.3.tgz` | 4 个会话、3 个任务、公共记忆及语音等资料恢复通过 |

页面检查覆盖全部页签无空间选择、所有新管理请求不带空间参数、公共记忆数量、图片／语音／网页统一列表及全部页签 390px 布局。API 检查验证旧客户端的空间参数统一忽略，管理生成和查询不会自动投递 QQ。

实际升级先安装上一版 0.4.2，建立三个同名不同值的私聊／公共记忆和两份同 ID 不同字节的旧图片，再通过官方 CLI 安装新版。验证全部内容保留、冲突分别命名、图片原任务标识保留、媒体可读、旧图片不重发、重启不重复导入；不同 QQ 会话读取相同公共记忆。迁移专项测试另覆盖原件保留、旧调用回放、历史文件路径映射、收据与文件发布中断恢复、删除后不复活，以及保留任务身份的备份恢复。

共享资料不会合并真实 QQ 发送目标、管理员权限或活跃浏览器任务。测试确认结束一个会话不关闭另一个会话的浏览器，跨会话或管理页查询图片不触发原发送意图；不同会话的同名调用仍分别去重。

升级准备调用本地假模型 1 次，新版 14 次，重启零次。备份目标冷恢复零次，续聊一次；未发送真实 QQ 消息或调用收费外部服务。

本地结果位于 `output/host-shared-0.4.3/summary.json`、`output/backup-shared-0.4.3/summary.json` 和 `output/qa-0.4.0/result.json`，生成目录不提交。

## 0.4.2 管理员流程验证（历史）

本轮将管理员设置改为已见 QQ 用户下拉选择，敏感操作按真实发送者身份校验。以下均针对新构建的 `dsh-feiyu-zeta-0.4.2.tgz`：

| 检查 | 可复跑命令 | 本轮结果 |
| --- | --- | --- |
| 宿主与客户端类型检查 | `npm run check` | 通过 |
| 离线单元与协议测试 | `npm test` | 39 个文件、476 项通过 |
| 构建和归档 | `npm run build`、`npm pack --ignore-scripts` | 通过 |
| 浏览器设置页 | `node scripts/verify-panel.mjs` | 72 项检查、77 次本地模拟请求通过 |
| 官方 DSH 隔离宿主 | `node scripts/verify-host.mjs --package ./dsh-feiyu-zeta-0.4.2.tgz` | 82 + 36 = 118 项通过 |
| 隔离双机备份迁移 | `node scripts/verify-backup-host.mjs --package ./dsh-feiyu-zeta-0.4.2.tgz` | 4 个会话、3 个任务及已见用户目录恢复通过 |

覆盖下拉添加、保存、移除、空目录、保留旧管理员、刷新目录不覆盖草稿；群成员发现、旧私聊回填、按机器人隔离、重启持久化；管理员自然语言敏感请求、非管理员伪称身份拒绝、同回合撤权后拒绝、混合群来源拒绝。群消息拆分的停止／新会话取消和历史去重另有回归测试。加密迁移保留完整用户目录与管理员选择，0.3.0 / 0.4.0 / 0.4.1 无用户目录的旧备份兼容测试通过。

隔离宿主首次启动调用本地假模型 14 次，重启零次；迁移目标冷恢复零次，续聊一次。没有向真实 QQ 发消息或调用收费外部服务。

本地结果位于 `output/host-admin-0.4.2/summary.json`、`output/backup-admin-0.4.2/summary.json` 和 `output/qa-0.4.0/result.json`，生成目录不提交。

## 0.4.1 更名后的验证

当时已在更名后的独立插件目录重新安装依赖、构建 `dsh-feiyu-zeta-0.4.1.tgz` 并验证；以下保留该版本的实际结果。

| 检查 | 可复跑命令 | 本轮结果 |
| --- | --- | --- |
| 宿主与客户端类型检查 | `npm run check` | 通过 |
| 离线单元与协议测试 | `npm test` | 38 个文件、460 项通过 |
| 构建和归档 | `npm run build`、`npm pack` | 通过，生成新包名归档 |
| 官方 DSH 隔离宿主 | `node scripts/verify-host.mjs --package ./dsh-feiyu-zeta-0.4.1.tgz` | 69 + 34 = 103 项通过 |
| 隔离双机备份迁移 | `node scripts/verify-backup-host.mjs --package ./dsh-feiyu-zeta-0.4.1.tgz` | 4 个会话、3 个任务恢复通过 |

新名称的浏览器页面验证 `node scripts/verify-panel.mjs` 通过 62 项检查、71 次本地模拟请求，包括中英文插件卡标题、设置入口、页脚、下载包名和移动宽度布局。原生宿主验证确认实际安装的归档名称、仓库元数据与中英文 locale 标题；重启阶段零模型调用。双机隔离迁移的身份、审计记录、会话和任务保留检查通过，目标冷恢复零模型调用，后续续聊仅调用一次本地假模型。

本轮本地结果（生成目录不提交）：

- `output/host-feiyu-rename-final/summary.json`
- `output/backup-feiyu-rename-final/summary.json`
- `output/qa-0.4.0/result.json`（测试脚本沿用原输出目录名，内容已在新项目重新生成）

`verify-host --upgrade-from` 仅用于同包名历史版本；跨旧包名的迁移使用 README 的加密备份工作流。

## 更名前的历史基线

以下记录针对旧名 **`dsh-zeta 0.4.1`**，不是对更名包的验证声明：

- 官方 DSH 隔离宿主：首次启动 66 项、重启 31 项，共 97 项检查通过；前者使用 14 次本地假模型调用，重启检查零模型调用。
- 覆盖普通 QQ 原生回合自主读取和调整身份、自主活动调整习惯、敏感操作仍被拒绝、身份版本冲突、旧客户端保护，以及名称、人设、习惯和完整审计历史的重启持久化。
- 两套隔离 DSH 环境完成加密导出、下载代码包、官方 CLI 安装、恢复、受控中断续接、重启、续聊和显式 QQ 激活。
- 4 个原生会话与 3 个原生任务保留原标识、事件前缀、附件及投递历史；身份、版本和 QQ／自主活动来源的审计记录在迁移后严格一致。
- 目标冷恢复模型调用 0 次，继续聊天只调用本地假模型 1 次，QQ 发送次数 0。

历史结果位于本地开发目录：

- `output/host-0.4.1-final/summary.json`
- `output/backup-0.4.1-final/summary.json`

隔离检查没有读取日常 profile 的真实聊天或密钥，没有发送真实 QQ 消息，也没有调用收费模型、语音、生图或浏览器服务。“双机”由同一设备上的两套独立 DSH home、用户目录和工作目录模拟；没有据此声称完成跨物理设备或跨操作系统联调。

## 外部服务的验证边界

离线测试可以检查 Cloudflare 会话销毁、ApiMart 异步任务及防重复提交、静态资源上传协议和 QQ 发送状态，但不能证明真实账户权限、付费接口可用性、账单或最终音画质量。真实服务检查需要已配置的账户及实际回执，不能仅用模拟成功响应宣布已完成。

迁移后 QQ、自主活动及外部服务应保持暂停，只有管理者明确启用后才能重新活动。临时部署凭据与正在运行的浏览器会话不作为可迁移权限保存。
