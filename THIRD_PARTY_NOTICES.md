# 第三方来源与许可证

`dsh-feiyu-zeta`（旧名 `dsh-zeta`）是 [xiaoyaocz/dsh-feiyu-zeta](https://github.com/xiaoyaocz/dsh-feiyu-zeta) 中的个人测试、自用实验插件。本文件区分直接复用、设计参考、运行依赖及外部服务接入；不代表这些作者或服务商为本项目背书。npm 安装的其他依赖仍以各依赖包自带的许可证及声明为准。

## Tencent Connect / dsh-qqbot

- 上游：<https://github.com/tencent-connect/dsh-qqbot>
- 固定提交：`ee980be2b45dc868bb7ea58babc45775e4c2a871`
- 许可证：MIT
- 使用方式：直接复用并修改。
- 复用范围：本插件的 QQ 接入、传输、会话适配、绑定与设置页面等基础代码。dsh-feiyu-zeta 在此基础上修改并集成记忆、表情、语音、自主生活及管理界面。
- 上游许可证同时保留在本项目根目录 `LICENSE` 中。

```text
MIT License

Copyright (c) 2026 Tencent Connect

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## yyh-001 / dsh-meme

- 上游：<https://github.com/yyh-001/dsh-meme>
- 固定提交：`49e2a7e5a56f271b91e8f5ee71ccce9d0c9d1a2c`（上游版本 `0.1.65`）
- 许可证：MIT
- 使用方式：直接集成代码与包内资源。
- 包含位置：`vendor/dsh-meme/`。
- 复用范围：`memes.js`、SQLite 索引、`dafeiyu-001` 的 24 张表情资源，以及 ZIP STORE 写入相关实现。`zip.js` 对上游 ZIP 代码作适配，并增加受大小与路径限制的 STORE / DEFLATE 读取；声明文件、QQ 发送适配、共享收藏及旧空间迁移由本项目补充。
- 上游的独立插件入口、HTTP 服务、额外视觉描述流程和表情市场未作为本插件功能挂载。用户后续上传的收藏不属于本包内置资源。
- 原始许可证保留在 `vendor/dsh-meme/LICENSE`，构建时亦复制到 `dist/licenses/dsh-meme-MIT.txt`。集成说明见 `vendor/dsh-meme/README.ZETA.md`。

```text
MIT License

Copyright (c) 2026 Selfloom contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Amengclass / dsh-memory：架构参考

- 上游：<https://github.com/Amengclass/dsh-memory>
- 参考提交：`138979eb0b45937b3a157b652623d0f571d519f2`
- 上游许可证：MIT；版权声明为 `Copyright (c) 2025 A梦 (Amengclass)`。
- 参考内容：使用 DSH `storageDomain` 持久化模型可编辑的键值记忆，以工具提供保存、读取、搜索和删除能力。

dsh-feiyu-zeta 的 `src/zeta/state.ts` 与记忆工具按 QQ 会话隔离、上下文条数与长度限制、置顶和管理界面需求重新实现。本包不将上游 `dsh-memory` 源文件作为运行模块分发，也不依赖该插件。开发目录中的上游参考检出不在 npm 分发文件列表内。

## DeepSeek Harness：插件宿主与运行依赖

- 上游：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。
- 本项目适配目标：`0.2.1-rc.3`，具体依赖版本以 `package.json` 为准。
- 使用方式：调用宿主公开的 Cordis 插件、Agent、会话、工具、原生存储域、凭据与 Schedule 服务；没有为本插件另建一套模型循环。
- 宿主及 npm 依赖的版权与许可保持其各自分发声明；本项目的更名不改变这些归属。

## 大肥鱼／鲸鱼娘社区：人设写作参考

- [ERUIHNIYHBKBNF / dafeiyu-persona](https://github.com/ERUIHNIYHBKBNF/dafeiyu-persona)：公开人设文本与说话风格参考。该仓库标注 MIT；本项目没有直接加载其 skill 或照搬其整段人设与台词。
- [YunYueSama / codex-deepseek-pet](https://github.com/YunYueSama/codex-deepseek-pet)：参考[角色表现规范](https://github.com/YunYueSama/codex-deepseek-pet/blob/main/docs/%E8%A7%92%E8%89%B2%E8%AE%BE%E5%AE%9A.md)中对性格、语言和相处方式的描述。该作者对可授权新增贡献的具体要求见其 [ASSET_LICENSE.md](https://github.com/YunYueSama/codex-deepseek-pet/blob/main/ASSET_LICENSE.md)，不能据此推定第三方参考图也可自由分发。
- [ZipZipPipe 原发布说明](https://www.bilibili.com/video/BV1mwRzBdEzk/)：用于核对社区形象与上善无形原创角色的二创关系，不作为本插件额外分发图片或视频的授权依据。

“小鲸鱼”默认预设由本项目依据常见社区气质重新整理，文字为原创表达，不宣称官方人格。没有从上述人设项目添加立绘、动作图或视频素材；包内既有 24 张表情的来源单列于 dsh-meme 条目。用户后来上传的人设图和收藏不属于本包内置资源。

## 外部服务：可选接口接入

以下是服务接口接入，不是相关服务的开源代码集成或合作声明：

- [Cloudflare Browser Run](https://developers.cloudflare.com/browser-run/)：通过 Playwright CDP 连接云浏览器；[会话管理文档](https://developers.cloudflare.com/browser-run/cdp/session-management/)说明创建与关闭接口。
- [Cloudflare 临时账户部署](https://developers.cloudflare.com/workers/platform/claim-deployments/)：后台申请临时账户并部署静态作品，临时凭据及认领链接由后端保管。
- [ApiMart 图像生成接口](https://docs.apimart.ai/cn/api-reference/images/gemini-nano-banana-2.1/generation)：接入 `gemini-nano-banana-2.1-ext`，默认 1K。
- [MiMo 开放平台](https://platform.xiaomimimo.com/)与 [MiniMax 开放平台](https://platform.minimax.cn/docs/guides/models-intro)：可选语音生成服务。

服务的可用性、账户权限、费用和使用条件由对应提供商决定。相关商标、品牌、社区角色及第三方美术的权利不由本插件的软件许可证授予。
