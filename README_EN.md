# dsh-feiyu-zeta

[简体中文](./README.md) · [Repository](https://github.com/xiaoyaocz/dsh-feiyu-zeta)

A **personal testing and self-use experiment** combining QQ chat, an evolving whale-inspired persona, memory, shared stickers, speech, autonomous activity and optional cloud services in one DeepSeek Harness plugin. It is not an official DeepSeek, Tencent Connect or service-provider product, and it carries no production stability guarantee.

Current version: **0.4.1**. Target: **DeepSeek Harness 0.2.1-rc.3**, **Node.js >=24.9.0**. The former plugin name was `dsh-zeta`; this repository root contains the plugin itself.

## Build and install locally

This package is not published to npm. Build and install the local archive:

```powershell
npm ci
npm run check
npm test
npm run build
npm pack

.\scripts\install-local.ps1 -InspectOnly
.\scripts\install-local.ps1 -Package .\dsh-feiyu-zeta-0.4.1.tgz -WhatIf
.\scripts\install-local.ps1 -Package .\dsh-feiyu-zeta-0.4.1.tgz
```

The Windows script discovers the installed Desktop runtime and defaults to an isolated `zeta-test` profile. For the everyday Desktop profile, explicitly add `-Profile desktop`. It backs up the target profile configuration and leaves restarting the app to you. Do not enable this plugin alongside the old `dsh-zeta` package or the original `@tencent-connect/dsh-qqbot` in the same profile.

The local `install.sh` helper supports an already installed DSH CLI. It accepts a local archive through `--package` and defaults to the `web` profile; see `./install.sh --help`.

## Configure and use

1. Select a working default conversation model in DSH. Open **dsh-feiyu-zeta**, bind QQ by scanning the code, then test a private message or a group mention.
2. Review the shared name, persona and habits. The original default preset is named **小鲸鱼**. Upload a persona image and an appearance description if wanted.
3. Use `/bot-whoami` in QQ to obtain a real sender ID for the owner-only administrator list. A listed administrator must use `/admin` in the current message for sensitive operations.
4. Enable speech, Browser Run, image generation or temporary deployment individually. Configure their credentials in the authenticated DSH owner panel. Autonomous contact has its own target list and limits.

Ordinary QQ and autonomous sessions may evolve their shared name, persona and habits through `zeta_identity_get` and `zeta_identity_update`. Writes require a reason and the current `expected_revision`. This narrow capability grants no configuration, credential, plugin or shell privileges. The owner panel retains the latest 30 changes and can reset the identity. Older settings clients without an identity revision cannot overwrite a newer identity.

Memory and speech records remain conversation-scoped; stickers and the persona image are shared. Group messages are briefly collected before the model chooses to reply or stay silent. Silence sends no placeholder to QQ. Autonomous activity uses model-selected one-shot schedules rather than a fixed recurring interval.

## Optional services

| Service | Integration |
| --- | --- |
| [Cloudflare Browser Run](https://developers.cloudflare.com/browser-run/) | Playwright CDP with explicit remote deletion, short retention, hard limits and cleanup recovery |
| [ApiMart images](https://docs.apimart.ai/cn/api-reference/images/gemini-nano-banana-2.1/generation) | `gemini-nano-banana-2.1-ext`, **1K**, one image by default; asynchronous tracking, local download and optional QQ delivery |
| [Cloudflare temporary accounts](https://developers.cloudflare.com/workers/platform/claim-deployments/) | Static previews with roughly 60 minutes of temporary access; backend-only credentials and an owner-only claim URL |
| MiMo / MiniMax | Optional WAV generation, management previews and explicit QQ speech delivery |

Self portraits automatically use the uploaded persona image. Unknown paid-request or QQ-delivery outcomes are recorded without automatically repeating the charge or delivery. Provider access, usage and billing depend on the configured account.

## Backup and verification

The owner panel exports encrypted backups and a code-only plugin archive. Backups cover identity and audit history, settings, associated native sessions and attachments, memory, stickers, generated media and native task history. Restored QQ, autonomous activity and cloud services stay paused until explicitly re-enabled. Temporary deployment tokens and active browser sessions are not portable permissions.

Compatibility handling exists for backups from the former `dsh-zeta` 0.3.0 and 0.4.0 versions. Customized old identities are preserved; only an untouched old built-in identity is replaced. See [the Chinese guide](./README.md) for complete configuration and migration steps, and [VALIDATION.md](./VALIDATION.md) for actual verification scope. Old-name checks do not establish verification of the renamed archive.

## Sources and attribution

- **Directly based on** [tencent-connect/dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot), commit `ee980be2b45dc868bb7ea58babc45775e4c2a871`: QQ integration and its base UI; MIT notice retained.
- **Directly integrated** [yyh-001/dsh-meme](https://github.com/yyh-001/dsh-meme), commit `49e2a7e5a56f271b91e8f5ee71ccce9d0c9d1a2c`: collection code, SQLite index, 24 bundled stickers and ZIP-related implementation; MIT notice retained.
- **Architecture reference** [Amengclass/dsh-memory](https://github.com/Amengclass/dsh-memory), commit `138979eb0b45937b3a157b652623d0f571d519f2`: native persistent, model-editable memory. Its runtime module is not bundled.
- **Host dependency** [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): agents, sessions, tools, credentials, storage and Schedule.
- **Persona writing references** [ERUIHNIYHBKBNF/dafeiyu-persona](https://github.com/ERUIHNIYHBKBNF/dafeiyu-persona) and [YunYueSama/codex-deepseek-pet](https://github.com/YunYueSama/codex-deepseek-pet): independently rewritten default text; no copied character artwork or complete skill prompts.

See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for reuse and licensing boundaries. [LICENSE](./LICENSE) and bundled upstream copyright notices remain intact. Software licenses do not transfer third-party artwork, brand or trademark rights.
