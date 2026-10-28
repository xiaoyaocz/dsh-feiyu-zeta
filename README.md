# dsh-feiyu-zeta · DSH QQ 陪伴插件

这是一个**个人测试、自用的实验项目**，不是 DeepSeek、Tencent Connect 或所接入服务的官方产品，也不提供生产稳定性保证。仓库：[xiaoyaocz/dsh-feiyu-zeta](https://github.com/xiaoyaocz/dsh-feiyu-zeta)。[English](./README_EN.md)

dsh-feiyu-zeta 将 QQ 接入、人设与形象图、长期记忆、共享表情、语音、自主活动、云浏览器、临时网页和生图集成在一个 DSH 插件中。对话模型、会话、工具执行、凭据及自动任务沿用 DeepSeek Harness。

当前版本 **0.4.8**，仅适配 **DSH 0.2.1-rc.3**，Node.js 要求 **>=24.9.0**。插件原名 `dsh-zeta`；代码与数据独立于旧 ProjectZeta 主工程，不会读取旧主工程数据库。0.3.0 / 0.4.0 / 0.4.1 / 0.4.2 / 0.4.3 数据及加密备份有升级兼容处理；实际安装、迁移验证范围见 [VALIDATION.md](./VALIDATION.md)。

## 安装与升级

### 直接从 GitHub 安装

在 DSH 的插件安装页面，将以下任意一项填入**安装来源**，按页面提示安装后重新加载或重启：

```text
github:xiaoyaocz/dsh-feiyu-zeta
https://github.com/xiaoyaocz/dsh-feiyu-zeta
```

请使用带 `github:` 前缀或完整 HTTPS 地址的来源，界面不接受省略前缀的写法。正常安装无需克隆仓库。已有 DSH CLI 的 `web` profile 也可执行：

```sh
dsh plugin --profile web add github:xiaoyaocz/dsh-feiyu-zeta
```

默认安装仓库的默认分支；也可在来源末尾添加 `#main`。要固定到某次构建，使用 `github:xiaoyaocz/dsh-feiyu-zeta#<完整40位提交SHA>`，将占位符替换为真实提交，不要原样输入。

`main` 已包含完整预构建的 `dist/` 和 `lib/`，安装时直接加载，不依赖 `prepare`、`install` 或 `postinstall` 编译。安装环境仍需 **Git**，并能联网下载 GitHub 内容和运行依赖；仓库不包含 `node_modules`。本项目未发布到 npm，也未提供插件市场条目或 GitHub Release。首次使用需配置模型并绑定 QQ；已有绑定或环境变量时沿用原连接配置。收费功能默认关闭，需分别启用所需服务。

### fnOS 安装与旧版 404 排查

通过 [FNOSP/fnos-dsh](https://github.com/FNOSP/fnos-dsh) 的 NAS 应用使用 DSH 时，同样从上面的 GitHub 来源安装。**0.4.5 起**，绑定、设置与陪伴功能的 HTTP 接口统一位于 `/plugins/dsh-feiyu-zeta/` 下；FNOS 网关默认会为 `/plugins` 请求补上应用前缀，新版无需额外添加旧接口的两项代理规则。

仍使用 **0.4.4**，且绑定区显示“插件未启用，或当前版本不支持端内配置”、配置或陪伴管理请求返回 **404** 时，可在 DSH 的 **插件 → fnOS 详情页 → 底部“三方插件 proxy”** 中保留已有规则，再追加两行：

```text
/qqbot/im-qqbot
/zeta/api
```

保存后刷新 DSH 页面。此方式用于旧版的绝对路径接口；不要覆盖其他插件的规则。地址改写行为与配置入口依据 FNOS 的[固定版本网关源码](https://github.com/FNOSP/fnos-dsh/blob/5e6c64bd0137f2b658441bbb86eba8b8c42f8402/packages/fnos-gateway/src/client/bridge.ts#L26-L53)及[插件配置文档](https://github.com/FNOSP/fnos-dsh/blob/5e6c64bd0137f2b658441bbb86eba8b8c42f8402/docs/plugins/dsh-fnos.md#L44-L51)。本项目尚未完成 fnOS NAS 真机验证，实际检查范围见 [VALIDATION.md](./VALIDATION.md)。

### Windows 桌面版安装助手

已有本仓库的本地副本时，也可使用 PowerShell 7 运行安装助手。它发现桌面版自带的 DSH，先备份目标 profile 配置，再调用桌面版官方安装入口。先查看计划，再安装到日常桌面 profile：

```powershell
.\scripts\install-local.ps1 -InspectOnly
.\scripts\install-local.ps1 -Source 'github:xiaoyaocz/dsh-feiyu-zeta' -Profile desktop -WhatIf
.\scripts\install-local.ps1 -Source 'github:xiaoyaocz/dsh-feiyu-zeta' -Profile desktop
```

`-WhatIf` 只显示计划，不修改日常 profile；不传 `-Profile` 时默认使用独立测试 profile `zeta-test`。DSH rc.3 的 `desktop` 是保留 profile，普通 CLI 不能直接安装到它，请使用 DSH 界面或此助手。脚本不会替你重启桌面版。其他安装位置可用 `-DesktopExe '完整的 DeepSeek Harness.exe 路径'`。

本包已包含 QQBot 接入代码，同一 profile 不要同时启用旧名 `dsh-zeta` 或原版 `@tencent-connect/dsh-qqbot`，以免重复加载 QQ 网关。

### 本地开发与归档安装

仓库根目录就是插件目录。需要修改源码或构建本地归档时，在本目录运行：

```powershell
npm ci
npm run check
npm test
npm run build
npm run check:distribution
npm pack
```

打包得到 `dsh-feiyu-zeta-0.4.8.tgz`。安装助手仍支持本地包：

```powershell
.\scripts\install-local.ps1 -Package .\dsh-feiyu-zeta-0.4.8.tgz -WhatIf
.\scripts\install-local.ps1 -Package .\dsh-feiyu-zeta-0.4.8.tgz
.\scripts\install-local.ps1 -Package .\dsh-feiyu-zeta-0.4.8.tgz -Profile desktop
```

其他平台已有 DSH CLI 时，可使用本仓库的本地归档安装脚本，默认安装到 `web` profile：

```sh
./install.sh --package ./dsh-feiyu-zeta-0.4.8.tgz
```

可用参数见 `./install.sh --help`；脚本使用已有 DSH，不代为从 npm 安装宿主。开发时保留 `npm run build`；源码变更应连同重新生成的 `dist/`、`lib/` 一起提交。CI 会从干净目录重建并检查已提交产物与源码一致，也会核对 Git 和 npm 归档中的完整运行文件。

升级保留已定制的名称、人设、记忆、绑定及素材；只有旧内置身份完全未修改时，才替换成新的“小鲸鱼”默认预设。旧版各聊天的记忆、语音、生成图片、网页记录和截图会自动合并到公共资料库，同名不同内容分别保留，原始素材不删除；表情在首次访问图库时继续合并。旧固定周期自主任务在开启后由新的一次性计划替换。首次启用三个外部服务及管理员权限时，仍需由 DSH 所有者配置。

## 第一次使用

1. 打开 DSH 的 **dsh-feiyu-zeta** 入口，扫码绑定 QQ，在私聊或群内 @ 机器人确认连接。
2. 在 **人设** 查看当前名称、人设与习惯，按需调整，或保留“小鲸鱼”默认预设；可上传统一人设图、填写外貌描述。
3. 需要管理权限的用户先给机器人发一条 QQ 消息；DSH 所有者在 **管理员与群聊** 的下拉名单中选择机器人已见过的用户并保存。管理员随后直接用自然语言提出管理需求。
4. 在 **记忆** 管理各聊天的事实与偏好，在 **表情** 管理所有聊天共用的收藏。
5. 按需配置 **语音**、**外部服务**，再开启 **自主生活**。所有收费能力均需先自行启用。

管理页包含 **概览 / 人设 / 会话 / 记忆 / 表情 / 语音 / 自主生活 / 管理员与群聊 / 外部服务 / 备份迁移**。设置需点击保存；凭据、素材上传和删除各有操作反馈。记忆、语音、生成图片、网页记录、人设与表情统一共用，不再需要选择管理空间。刷新不会自动提交未保存的设置。

群聊与私聊共用功能配置。管理页刷新会更新未编辑的字段并保留本地草稿，保存时只提交实际修改项，避免旧页面把其他聊天刚调整的语音、服务等设置覆盖回去；人设变更仍单独检查版本冲突。

同一机器人 AppID 的群聊与私聊也共用对话模型和新会话的 Agent 预设默认值。管理员从任一聊天切换 `/model` 或 `/preset` 会更新公共默认；模型在各聊天下次请求前对齐，旧的每聊天模型、预设偏好不再覆盖公共选择。各聊天仍保留自己的历史和发送目标。已开始会话的预设遵循 DSH 锁定规则，更新默认只影响新会话；需要采用新预设时在对应聊天使用 `/new`。

管理页面及 API 使用 DSH 登录与 owner 鉴权。未绑定 QQ 时也能通过已登录的管理页管理公共记忆、人设及素材。

## 管理员与群聊

### 管理员

在 **管理员与群聊** 中，从机器人已见过的 QQ 用户下拉名单选择管理员，可按显示名称和来源辨认。想授权的人还没出现时，先让其发送一条私聊或机器人能实际收到的群消息，再刷新名单；无需复制或手填标识。名单只反映 QQ 平台实际下发给机器人的用户，不是完整好友或群成员列表。已有配置中暂未重新见过的管理员会保留，页面明确标注其状态。

管理员直接用自然语言请求调整功能配置、插件、宿主文件或执行命令，不需要特殊前缀。敏感工具执行时，后端核对当前请求的真实 QQ 发送者是否仍在管理员名单中；显示名相同或自称管理员不会获得权限，名单为空时 QQ 无法执行宿主管理操作。是否具备具体工具取决于已安装的 DSH 插件和当前预设，此授权不会凭空安装工具。

群消息按发送者权限分别处理：普通成员的连续消息可以合并；遇到管理员消息时建立独立、顺序执行的回合，同一管理员连续发言仍可合并。其他成员、引用文本或网页内容不能继承管理员权限；即使混合来源意外进入同一请求，敏感操作也会被拒绝。审批按钮同样核对实际点击者和本次请求。

插件内置 `zeta_settings_get / zeta_settings_update` 供管理员读取和局部修改功能配置；管理员名单与密钥仍由 DSH 所有者在管理页维护。名称、人设与习惯允许 AI 自主调整，使用专门的身份工具，不会因此取得功能配置或宿主管理权限。普通 QQ 聊天只开放业务清单及下面的原生探索工具，新出现的宿主管理工具默认拒绝。

宿主提供相应工具时，普通 QQ 和自主生活都可用 `web_search` 搜索、`web_fetch` 阅读网页及 `read_image` 看图，无需管理员身份。普通 QQ 看图仅限当前真实入站或引用消息明确附带的图片、人设图、公共生成图与共享收藏、共享截图及内置表情；不开放其他聊天的原始附件或任意宿主文件。图片须使用允许范围内的有效绝对路径，自主生活只可读上述公共素材。

这层限制约束本插件 QQ 与自主 Agent 的工具调用；DSH 插件本身是可信宿主代码，不能将其视为任意第三方插件的操作系统隔离。

### 群聊节奏与沉默

同一群的连续消息先合并，再由 AI 调用 `zeta_group_decide` 决定 `reply` 或 `skip`。默认收到最后一条后等待 **2 秒**，连续消息最多等待 **6 秒**；可在 **管理员与群聊** 调整。正在处理时收到的消息按群排队，不影响其他群和私聊。

`skip` 或未决定回复时，不向 QQ 发送助手正文、工具进度或“（不回复）”等占位内容。`reply` 后由发送工具明确发送文字、表情、语音或文件，群内普通助手总结不会自动再转发。私聊沿用正常回复方式。

长任务由 AI 先向当前对话简短确认准备做什么，再开始搜索、生成或部署；任务阶段有实际变化时主动更新，文案由 AI 根据本轮任务决定。同一请求中，普通正文与显式发送的相同文字只投递一次。内部工具门控的提示只用于引导 AI，不会作为固定报错消息发到 QQ；群聊 `skip` 时仍不发送。

独立发送“停停停”“取消当前任务”或 `/stop` 会立即撤销当前对话的旧回合并清空待处理队列，阻止旧任务继续调用工具、发送消息或把迟到结果当成新回复。已经进入 QQ SDK 的在途发送无法召回。之后的新明确指令作为新请求处理，不自动恢复被停止的任务。

机器人只能处理 QQ 平台实际下发的消息。关闭本地“必须 @”门控也不能取得平台未授权下发的全部群消息；群历史缓存只覆盖本机实际收到并保留的部分。

## 身份、人设图与自画像

默认名称为 **小鲸鱼**。预设采用社区蓝色鲸鱼娘的常见气质：聪明好奇、贪吃爱摸鱼、轻微傲娇，受托时认真可靠；白饭与 token 只是偶尔使用的笑话，不影响真实任务完成。默认不设主仆或恋爱关系，也不把每句话都变成讨饭或猫叫。这是本插件原创整理的文本预设，不宣称 DeepSeek 官方人格，也不搬运社区作者的立绘。参考了 [ERUIHNIYHBKBNF 的社区人设文本](https://github.com/ERUIHNIYHBKBNF/dafeiyu-persona/blob/main/dafeiyu/SKILL.md)、[YunYueSama 的角色表现规范](https://github.com/YunYueSama/codex-deepseek-pet/blob/main/docs/%E8%A7%92%E8%89%B2%E8%AE%BE%E5%AE%9A.md)及 [ZipZipPipe 的原发布说明](https://www.bilibili.com/video/BV1mwRzBdEzk/)；具体作者版本、角色图片与素材许可仍各自独立。

**名称 / 人设 / 习惯** 是所有聊天与自主活动共享的当前身份。AI 在普通 QQ 对话和自主活动中，可通过 `zeta_identity_get` 读取，再用 `zeta_identity_update` 调整这三个字段，不需要管理员命令。每次修改必须说明原因并带上刚读取的 `expected_revision`；并发修改时旧版本会被拒绝，需重新读取后再判断，避免一段旧对话覆盖其他会话的新变化。习惯是独立字段，可以随着相处与自主探索逐渐演变；这项权限不能修改管理员、密钥、工具授权或任何功能配置。

身份保留最近 **30 条**变更记录，管理页可刷新当前身份、查看近期调整，也可恢复默认。保存较早打开的表单时会检查身份版本；旧客户端未携带身份版本，只能保存其他功能设置，不会覆盖已经演变的身份。身份与变更记录会持久保存，并随加密备份迁移。

在 **人设** 上传不超过 **8 MiB** 的 PNG、JPEG 或 WebP，作为所有聊天共用的统一形象。可手动填写最多 4000 字的外貌描述。若 QQ 连接设置已启用视觉模型，上传时可自动生成描述，也可随后重试识图；识图失败不影响原图保存。没有视觉配置时，请手动描述，模型不会声称已看过未读取的图片。

模型可用 `zeta_persona_reference` 获取参考图及外貌描述。自画像通过 `zeta_image_generate` 的 `selfPortrait=true` 自动附带人设原图，常见自画像提示也会触发该检查；没有人设图会明确报错。原图按需作为参考交给 ApiMart，不会通过临时网页公开托管。

## 外部服务

云浏览器、生图、临时部署均默认关闭。服务密钥保存在 DSH 原生凭据服务，页面只显示是否配置，不回显密钥或保存浏览器草稿。

| 服务 | 配置 | 默认限制 |
| --- | --- | --- |
| Cloudflare Browser Run | Cloudflare Account ID、具有该账户 Browser Run 权限的 API Token；凭据名 `ZETA_CLOUDFLARE_API_TOKEN` | 并发 1，单次最多 120 秒，空闲 15 秒，每日累计 10 分钟 |
| ApiMart 生图 | ApiMart API Key；凭据名 `ZETA_APIMART_API_KEY` | `gemini-nano-banana-2.1-ext`、**1K**、每次 1 张，每日最多 10 次提交 |
| Cloudflare 临时网页 | 首次由 DSH 所有者接受 Cloudflare 服务条款，再开启 | 最多 3 个活跃预览，约 60 分钟临时授权；单文件 5 MiB，总计 25 MiB |

浏览器和生图的每日用量按 UTC 日期记账；自主活动及主动联系使用配置的时区。服务本身的可用额度、收费与限制以提供商账户为准。

### 云浏览器

`zeta_browser` 使用 **playwright-core 通过 CDP** 连接 Cloudflare Browser Run，支持访问、读网页、点击、填表及截图。默认每次调用结束立即关闭；只有明确请求续用才保留短期会话，仍受空闲超时、硬时限和回合结束清理约束。取消、失败及插件卸载也执行关闭，不能仅靠 AI 记得关浏览器。显式工具为 `zeta_browser_close`；管理页可关闭全部会话并重试遗留会话清理。清理未确认的记录会保留，重启后重试。

只允许公开 HTTP(S) 页面；浏览器不共享本机登录状态，也不会下载并执行站点程序。参考 [Cloudflare Browser Run 文档](https://developers.cloudflare.com/browser-run/)。

### ApiMart 生图

启用并保存密钥后，可让 AI 生图或画自画像。模型固定使用 `gemini-nano-banana-2.1-ext`，默认 1K；管理员可调整 1K / 2K / 4K。关闭官方模型自动回退，避免服务侧转用其他收费路径。

插件保存任务 ID，轮询完成状态，将原图下载到本地，再按请求发送 QQ。“已提交”“已生成”“已发送”分别记录；等待超时后通过 `zeta_image_status` 查原任务，不自动重新提交收费请求。管理页生成只生成、不发 QQ。参考 [ApiMart 图像生成接口](https://docs.apimart.ai/cn/api-reference/images/gemini-nano-banana-2.1/generation)。

### 临时网页

`zeta_deploy_page` 将明确提供的 HTML、CSS、JS 与图片部署为静态作品，必须含 `index.html`；不会读取任意本机目录或运行构建脚本。成功需通过真实访问校验，再返回预览 URL 和到期时间。可用相同部署 ID 更新，用 `zeta_deploy_status` 查询，或 `zeta_deploy_delete` 删除公共作品库中的临时作品。

临时账户及认领链接约 **60 分钟**有效。只有已登录 DSH 的 owner 管理界面能取得认领链接；模型工具和普通 QQ 回复不包含它。需要长期保留时，由 owner 在到期前通过 Cloudflare 认领；认领后按正式账户管理，本插件不能延长临时 token 有效期，也不能仅凭本地到期状态判断认领后的站点是否仍在线。账户创建或部署结果未知时保留原记录，不自动另建账户。参考 [Cloudflare 临时账户说明](https://blog.cloudflare.com/zh-cn/temporary-accounts/)。

## 会话、记忆与表情

**会话目录** 记录机器人实际见过的私聊和群，可设置别名。用 `zeta_conversation_list` 找真实目标，`zeta_conversation_read` 读取允许的近期对话，再用发送工具明确指定 `target`。目录不是 QQ 完整群列表，普通群号不能代替 `group_openid`。跨会话读与发送各有开关；自主活动另有读取和主动联系名单。读取不唤醒目标 Agent，直接发送不自动让目标续聊。

发送语音、图片、表情或文件必须明确 `target`；要求“去群里发”时使用目录中的真实群目标，不能省略后默认发回当前私聊。同一用户请求中，相同生成参数跨工具调用编号复用结果，避免重复收费；同目标的相同媒体内容也不会重复投递。生成状态与发送状态分开记录，只有真实回执才能确认实际发送目标；结果未知时不自动重试。

**记忆** 使用 DSH 原生 `project_zeta` storageDomain，所有私聊、群与自主生活共用一份公共记忆。模型通过 `zeta_memory_set/get/search/delete` 保存与关键词检索事实；管理页可编辑。默认公共记忆最多 100 条、每条 600 字，上下文注入最多 6 条 / 1200 字。升级时自动合并旧记忆，同名冲突通过带来源后缀的键分别保留；即使旧记录合计超过新增上限也不会裁剪。公共记忆适合保存可共享的事实、偏好和约定，不应写入他人的私密信息。这是本地键值记忆，不会后台扫描全部聊天构建画像，删除记忆也不删除原始 DSH 历史。

**表情** 内置 24 张只读大肥鱼图，全部私聊、群及自主活动共用同一收藏库。支持检索、发送、收藏当前会话收到的原图、管理页上传编辑删除及 ZIP 导入导出；收到原始 GIF 时原样保存。收藏仍只允许当前真实入站文件，不能借共享图库读取其他聊天的任意本地文件。

升级时扫描旧空间图库，按文件 SHA-256 合并重复图片，合并描述与关键词，并在索引保存原始元数据。旧图片和索引不删除；中断可重试，坏文件明确报错。已有收藏即使超过新库 500 张新增上限也保留，整理前仅拒绝新图片；已迁移后删除的条目不会在重启时复活。共享库位于素材目录 `memes/shared`。长期记忆、语音、生成图片与网页记录也已改为公共资料。

管理页单张上传上限 8 MiB，ZIP 上限 80 MiB、解压内容合计 64 MiB。ZIP 导入显示已导入、跳过及未完成原因，取消或部分失败不假装全部完成。不会额外调用视觉模型给表情编写描述。

## 语音

MiMo / MiniMax 分别保存 `ZETA_MIMO_API_KEY` / `ZETA_MINIMAX_API_KEY`。默认关闭；开启后保存服务、模型、声线及语速，所有对话共用语音记录，可在管理页生成 WAV 试听。试听不发 QQ，每次新试听都会发起新的生成请求。

| 服务 | 接入与默认设置 |
| --- | --- |
| MiMo | `https://api.xiaomimimo.com/v1/chat/completions`；`mimo-v2.5-tts` / `mimo_default` |
| MiniMax | `https://api.minimax.cn/v1/t2a_v2`；`speech-2.8-hd` / `male-qn-qingse` |

`zeta_speech_generate` 可只生成或生成后发送，`send:true` 缺少明确 `target` 时会在收费前拒绝。用 `zeta_speech_list` 查已有音频，再用 `zeta_speech_send({fileName,target})` 复用发送，无需重新合成或收费。回执分别列出生成状态、请求目标及平台确认的实际目标；同一请求重复调用不重发，用户下一条明确要求“再发一次”时可将同一音频再投递一次。生成、取消或 QQ 发送结果未知时保留记录，不自动重试，请先核对实际 QQ 结果。

语速范围 0.5–2，MiMo 用朗读提示近似控制语速；MiniMax 使用原生语速与支持的情绪参数。

## 自主活动

自主活动沿用一个 DSH 独立会话和原生 Schedule **一次性任务**，没有固定活动周期，也不运行插件自建的长期唤醒循环。每轮由 AI 通过 `zeta_life_plan_next` 选择下次时间、延迟或暂不安排；首次开启先安排一次规划回合。暂不安排或本轮未规划时等待再次手动唤醒，失败也不会悄悄恢复固定轮询。

自主生活的稳定内部会话可使用上文的原生搜索、网页阅读和公共素材看图能力，但不继承 QQ 管理员权限。未知插件工具、宿主文件读写、命令执行及插件配置仍需当前真实管理员发起请求；QQ 可读取名单、主动联系目标及次数等限制继续生效。

在 **自主生活** 配置兴趣、时区、安静时段、最短间隔及每日次数上限。默认最短间隔 **5 分钟**、每日 **48 次**，时区 `Asia/Shanghai`，安静时段 **23:00–08:00**；这些是资源边界，实际下次时间由 AI 决定，页面展示接受的时间与原因。保存的计划会在宿主重启后恢复，重复投递通过持久 runId 去重。

先保持“允许主动联系”关闭，按需勾选可读取聊天，再测试“现在活动一次”。需要分享时另外选择主动联系目标、允许的表情或语音。主动联系默认关闭，每日最多 3 次，同一目标冷却 180 分钟，同时受安静时段和 QQ 平台能力限制。内部总结不会自动成为 QQ 消息；只有真实发送回执才表示平台接受。

“停止当前活动”关闭自主生活、取消当前回合、撤销本插件的有效计划，并拒绝已入队的旧唤醒。DSH 未运行时不会执行；重新开启后可重新规划。自主活动可以调整自己的名称、人设和习惯，但没有管理员权限，只能使用已启用且获准的工具。

## 备份与换机迁移

在 **备份迁移** 操作，先保存设置。

1. **旧机导出**：设定并确认 8–1024 字符的密码，下载 `.zeta-backup`。可选择是否包含已配置的凭据；不包含时新机需重新填写。密码遗失无法恢复。
2. **准备新机**：下载纯代码插件包，安装 DSH 0.2.1-rc.3 和本版插件，预装原来使用的其他插件及匹配 Agent 预设。安装包仍需安装依赖。
3. **先校验再恢复**：上传文件、输入密码，检查摘要和冲突，再恢复到空插件环境。支持本版及 0.3.0 / 0.4.0 / 0.4.1 / 0.4.2 / 0.4.3 备份；不会覆盖已有聊天、素材或冲突凭据。中断后可用同一文件校验继续。
4. **重启与启用**：恢复后重启 DSH，停掉旧机 QQ 连接，再点击“启用迁移后的QQ连接”。自主活动、主动联系及三个新外部服务保持关闭，核对数据与密钥后分别手动启用。

桌面版 `desktop` 是保留 profile，请使用包内安装脚本：

```powershell
$zetaPackage = (Resolve-Path -LiteralPath .\dsh-feiyu-zeta-plugin.tgz).Path
New-Item -ItemType Directory -Path .\dsh-feiyu-zeta-installer -Force | Out-Null
tar -xzf $zetaPackage -C .\dsh-feiyu-zeta-installer
& .\dsh-feiyu-zeta-installer\package\scripts\install-local.ps1 -Profile desktop -Package $zetaPackage
```

备份包含插件设置与管理员名单、机器人已见 QQ 用户目录、当前身份及变更记录、其他业务状态、关联 DSH 会话及明确引用的原生附件、共享及旧空间表情原件与索引、语音、人设图、生成图片与任务记录、临时网页作品与部署记录、浏览器截图、公共资料迁移收据、QQ 媒体缓存、会话偏好及仍留存的群缓冲，并保留原生自动任务与投递历史。旧备份没有用户目录时从空目录开始；原有管理员配置继续保留，新的真实消息会逐渐补齐资料。任务恢复为停用状态；0.3.0 旧空间表情首次访问时继续合并。

临时部署 token、认领入口及正在运行的浏览器会话不作为可复用作品迁移；临时授权不会因备份而延期。勾选凭据时包含已配置的 Cloudflare / ApiMart 及原有 QQ、语音、相关模型凭据。

不打包整个凭据库、无关项目聊天或任意外部工作目录。新机重新建立素材与工作目录并记录旧路径映射，历史正文不改写。单文件条目上限 256 MiB，完整迁移包及解压内容上限 2 GiB；超限报错，不截断生成不完整备份。完成后的同一备份不能再次覆盖新产生的数据。

## 数据与开发验证

素材默认位于 `$DSH_HOME/zeta`，未设置时为用户目录 `.dsh/zeta`；可用插件配置 `zeta.dataDir` 更改。设置、记忆、绑定、自主状态及发送记录保存在原生存储域，密钥使用 DSH 凭据服务。离线检查可设 `zeta.connectQQ=false`，保留管理功能并关闭 QQ 网关。

```powershell
npm run check
npm test
npm run build
npm run check:distribution
```

测试覆盖协议模拟、工具权限、身份演变与版本冲突、群沉默与合并、计划恢复、图库迁移及备份等。模拟测试不会证明真实收费服务可用；真实端到端验证应使用自己的账户、短任务，并核对外部回执。真实宿主验证脚本使用桌面版自带 DSH、独立临时 home 和本地假模型，检查原生工具调用、普通 QQ 与自主活动的身份修改、权限边界及重启持久化；不会读取日常 profile：

```powershell
node scripts/verify-host.mjs --package .\dsh-feiyu-zeta-0.4.8.tgz
```

双机迁移脚本另建两个独立临时 DSH home，检查身份、审计记录与原生会话等内容的加密备份及恢复：

```powershell
node scripts/verify-backup-host.mjs --package .\dsh-feiyu-zeta-0.4.8.tgz
```

## 来源与使用范围

| 来源 | 本项目使用方式 |
| --- | --- |
| [Tencent Connect / dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot) | 直接基于其 QQ 接入、传输、会话适配、绑定及设置页面等基础代码修改；固定提交 `ee980be2b45dc868bb7ea58babc45775e4c2a871`，保留 MIT 声明 |
| [yyh-001 / dsh-meme](https://github.com/yyh-001/dsh-meme) | 直接集成图库、SQLite 索引、24 张内置表情和 ZIP 相关实现，再接入共享收藏与 QQ 发送；固定提交 `49e2a7e5a56f271b91e8f5ee71ccce9d0c9d1a2c`，保留 MIT 声明 |
| [Amengclass / dsh-memory](https://github.com/Amengclass/dsh-memory) | 参考原生存储域与模型可编辑记忆的架构，按本项目需求重新实现；参考提交 `138979eb0b45937b3a157b652623d0f571d519f2`，没有挂载其运行模块 |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | 插件宿主与运行依赖，使用其 Agent、会话、工具、凭据、存储和原生 Schedule 能力 |
| [ERUIHNIYHBKBNF / dafeiyu-persona](https://github.com/ERUIHNIYHBKBNF/dafeiyu-persona)、[YunYueSama / codex-deepseek-pet](https://github.com/YunYueSama/codex-deepseek-pet) | 公开社区人设方向与表现方式的参考；默认文字由本项目重新整理，没有复制这些项目的立绘或把整份 skill 作为系统指令加载 |
| Cloudflare / ApiMart / MiMo / MiniMax | 可选外部服务接入，使用各自接口与账户；服务接入不表示代码归属、合作或官方背书 |

详细复用范围和许可证见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)；腾讯 QQBot 与 dsh-meme 的 MIT 版权及许可原文保留于源码和分发包。第三方图片、品牌和用户上传素材的权利不因软件许可证而改变。
