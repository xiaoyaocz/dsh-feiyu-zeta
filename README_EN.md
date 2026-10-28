# dsh-feiyu-zeta

[简体中文](./README.md) · [Repository](https://github.com/xiaoyaocz/dsh-feiyu-zeta)

A **personal testing and self-use experiment** combining QQ chat, an evolving whale-inspired persona, memory, shared stickers, speech, autonomous activity and optional cloud services in one DeepSeek Harness plugin. It is not an official DeepSeek, Tencent Connect or service-provider product, and it carries no production stability guarantee.

Current version: **0.4.5**. Target: **DeepSeek Harness 0.2.1-rc.3 exactly**, **Node.js >=24.9.0**. The former plugin name was `dsh-zeta`; this repository root contains the plugin itself.

## Install from GitHub

In DSH's plugin installation page, enter either source below, install, then reload or restart as prompted:

```text
github:xiaoyaocz/dsh-feiyu-zeta
https://github.com/xiaoyaocz/dsh-feiyu-zeta
```

Use the `github:` prefix or full HTTPS URL; the UI rejects the shorthand without a prefix. No local clone is required. With an existing DSH CLI, install into the `web` profile using:

```sh
dsh plugin --profile web add github:xiaoyaocz/dsh-feiyu-zeta
```

The default source follows the repository's default branch. Append `#main` to name the branch explicitly, or use `github:xiaoyaocz/dsh-feiyu-zeta#<full-40-character-commit-SHA>` to pin a build. Replace that placeholder with a real commit before use.

`main` includes the complete prebuilt `dist/` and `lib/` files. Installation loads them directly and does not compile through `prepare`, `install` or `postinstall`. **Git and network access** are still required to fetch the repository and runtime dependencies; `node_modules` is not included. This package is not published to npm and has no marketplace entry or GitHub Release. On first use, configure a conversation model and bind QQ; existing bindings or environment credentials retain their connection behavior. Paid features are disabled by default and must be enabled separately.

## fnOS installation and older 404 responses

When using DSH through the [FNOSP/fnos-dsh](https://github.com/FNOSP/fnos-dsh) NAS app, install from the same GitHub source above. **Since 0.4.5**, binding, settings and companion HTTP endpoints share the `/plugins/dsh-feiyu-zeta/` prefix. The FNOS gateway already rewrites `/plugins` requests, so the new version does not require the two old proxy rules below.

For **0.4.4**, if binding reports that the plugin is disabled or unsupported and configuration or companion requests return **404**, open **Plugins → fnOS details → “三方插件 proxy” (Third-party plugin proxy)** at the bottom. Keep existing rules and append:

```text
/qqbot/im-qqbot
/zeta/api
```

Save and refresh the DSH page. This workaround is for the older absolute-path endpoints; retain other plugins' rules. See the pinned FNOS [gateway source](https://github.com/FNOSP/fnos-dsh/blob/5e6c64bd0137f2b658441bbb86eba8b8c42f8402/packages/fnos-gateway/src/client/bridge.ts#L26-L53) and [configuration guide](https://github.com/FNOSP/fnos-dsh/blob/5e6c64bd0137f2b658441bbb86eba8b8c42f8402/docs/plugins/dsh-fnos.md#L44-L51). This project has not completed validation on a physical fnOS NAS; see [VALIDATION.md](./VALIDATION.md) for the checks actually performed.

## Windows Desktop helper

If you already have a local copy of this repository, its PowerShell 7 helper can discover the installed Desktop runtime, back up the target profile configuration and use the Desktop carrier's official installation entry point:

```powershell
.\scripts\install-local.ps1 -InspectOnly
.\scripts\install-local.ps1 -Source 'github:xiaoyaocz/dsh-feiyu-zeta' -Profile desktop -WhatIf
.\scripts\install-local.ps1 -Source 'github:xiaoyaocz/dsh-feiyu-zeta' -Profile desktop
```

`-WhatIf` only shows the plan and does not modify the daily profile. Without `-Profile`, the helper defaults to the isolated `zeta-test` profile. DSH rc.3 reserves the `desktop` profile: use the DSH UI or this helper rather than a normal CLI installation targeting it. The helper leaves restarting the app to you. Use `-DesktopExe 'full path to DeepSeek Harness.exe'` for a nonstandard installation location.

Do not enable this plugin alongside the old `dsh-zeta` package or the original `@tencent-connect/dsh-qqbot` in the same profile.

## Local development and archive installation

For source changes or a local archive, run from this repository root:

```powershell
npm ci
npm run check
npm test
npm run build
npm run check:distribution
npm pack

.\scripts\install-local.ps1 -Package .\dsh-feiyu-zeta-0.4.5.tgz -WhatIf
.\scripts\install-local.ps1 -Package .\dsh-feiyu-zeta-0.4.5.tgz
.\scripts\install-local.ps1 -Package .\dsh-feiyu-zeta-0.4.5.tgz -Profile desktop
```

The local `install.sh` helper supports an already installed DSH CLI. It accepts a local archive through `--package` and defaults to the `web` profile; see `./install.sh --help`.

Keep using `npm run build` during development and commit regenerated `dist/` and `lib/` files with source changes. CI rebuilds from clean output directories and checks that committed artifacts match the source, as well as validating runtime files in Git and npm archives. See [VALIDATION.md](./VALIDATION.md) for actual installation and verification results.

## Configure and use

1. Select a working default conversation model in DSH. Open **dsh-feiyu-zeta**, bind QQ by scanning the code, then test a private message or a group mention.
2. Review the shared name, persona and habits. The original default preset is named **小鲸鱼**. Upload a persona image and an appearance description if wanted.
3. Have the intended administrator send a QQ message, then select that observed user in the owner panel's administrator dropdown and save. Users are identified by display name and source; there is no need to copy or type an ID. Refresh after a new message if someone is missing.
4. Enable speech, Browser Run, image generation or temporary deployment individually. Configure their credentials in the authenticated DSH owner panel. Autonomous contact has its own target list and limits.

Ordinary QQ and autonomous sessions may evolve their shared name, persona and habits through `zeta_identity_get` and `zeta_identity_update`. Writes require a reason and the current `expected_revision`. This narrow capability grants no configuration, credential, plugin or shell privileges. The owner panel retains the latest 30 changes and can reset the identity. Older settings clients without an identity revision cannot overwrite a newer identity.

Administrators request sensitive actions in natural language, without a command prefix. At execution time, the backend checks the real QQ sender against the current administrator list. Nicknames, quoted instructions, webpages or claims of administrator status grant no authority. Group requests are processed in separate sender-authority batches: ordinary messages can be combined, while an administrator's messages form an independent ordered turn. Mixed-source requests cannot inherit administrator rights. The dropdown lists only users actually observed by this bot, not a complete friend or group roster; saved administrators not yet re-observed remain clearly marked.

Memory, speech, generated images, temporary webpage records, stickers and the persona image use one shared library. There is no management-space selector. Existing records merge automatically, retaining conflicting entries and original media without repeating paid requests or QQ deliveries. Group messages are briefly collected before the model chooses to reply or stay silent. Silence sends no placeholder to QQ. Autonomous activity uses model-selected one-shot schedules rather than a fixed recurring interval.

## Optional services

| Service | Integration |
| --- | --- |
| [Cloudflare Browser Run](https://developers.cloudflare.com/browser-run/) | Playwright CDP with explicit remote deletion, short retention, hard limits and cleanup recovery |
| [ApiMart images](https://docs.apimart.ai/cn/api-reference/images/gemini-nano-banana-2.1/generation) | `gemini-nano-banana-2.1-ext`, **1K**, one image by default; asynchronous tracking, local download and optional QQ delivery |
| [Cloudflare temporary accounts](https://developers.cloudflare.com/workers/platform/claim-deployments/) | Static previews with roughly 60 minutes of temporary access; backend-only credentials and an owner-only claim URL |
| MiMo / MiniMax | Optional WAV generation, management previews and explicit QQ speech delivery |

Self portraits automatically use the uploaded persona image. Unknown paid-request or QQ-delivery outcomes are recorded without automatically repeating the charge or delivery. Provider access, usage and billing depend on the configured account.

## Backup and verification

The owner panel exports encrypted backups and a code-only plugin archive. Backups cover identity and audit history, the observed QQ-user directory, settings, associated native sessions and attachments, memory, stickers, generated media and native task history. Older backups without a user directory start with an empty directory while retaining saved administrators. Restored QQ, autonomous activity and cloud services stay paused until explicitly re-enabled. Temporary deployment tokens and active browser sessions are not portable permissions.

Compatibility handling exists for 0.3.0, 0.4.0, 0.4.1, 0.4.2 and 0.4.3 backups, including former `dsh-zeta` packages. Customized old identities are preserved; only an untouched old built-in identity is replaced. See [the Chinese guide](./README.md) for complete configuration and migration steps, and [VALIDATION.md](./VALIDATION.md) for actual verification scope. Old-name checks do not establish verification of the renamed archive.

## Sources and attribution

- **Directly based on** [tencent-connect/dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot), commit `ee980be2b45dc868bb7ea58babc45775e4c2a871`: QQ integration and its base UI; MIT notice retained.
- **Directly integrated** [yyh-001/dsh-meme](https://github.com/yyh-001/dsh-meme), commit `49e2a7e5a56f271b91e8f5ee71ccce9d0c9d1a2c`: collection code, SQLite index, 24 bundled stickers and ZIP-related implementation; MIT notice retained.
- **Architecture reference** [Amengclass/dsh-memory](https://github.com/Amengclass/dsh-memory), commit `138979eb0b45937b3a157b652623d0f571d519f2`: native persistent, model-editable memory. Its runtime module is not bundled.
- **Host dependency** [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): agents, sessions, tools, credentials, storage and Schedule.
- **Persona writing references** [ERUIHNIYHBKBNF/dafeiyu-persona](https://github.com/ERUIHNIYHBKBNF/dafeiyu-persona) and [YunYueSama/codex-deepseek-pet](https://github.com/YunYueSama/codex-deepseek-pet): independently rewritten default text; no copied character artwork or complete skill prompts.

See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for reuse and licensing boundaries. [LICENSE](./LICENSE) and bundled upstream copyright notices remain intact. Software licenses do not transfer third-party artwork, brand or trademark rights.
