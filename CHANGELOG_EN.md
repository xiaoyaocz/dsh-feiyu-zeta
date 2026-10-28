# dsh-feiyu-zeta changelog

[简体中文](./CHANGELOG.md) · [Repository](https://github.com/xiaoyaocz/dsh-feiyu-zeta)

This file records this personal testing and self-use experiment. The inherited dsh-qqbot changelog is no longer presented as this project's release history; source and copyright notices remain in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## 0.4.1 — current

- Rename the project and package to `dsh-feiyu-zeta`, repository `xiaoyaocz/dsh-feiyu-zeta`. Installation uses a local archive, not a published npm package.
- Introduce the independently rewritten **小鲸鱼** default persona; preserve customized older identities.
- Let ordinary QQ and autonomous sessions update their shared name, persona and habits with a reason and a matching revision.
- Persist the latest 30 identity changes; support owner refresh/reset and protect against stale forms or concurrent old revisions.
- Include identity and audit history in encrypted migration, with compatibility handling for former-name 0.3.0 and 0.4.0 backups.
- Clarify personal-use status and source categories while retaining upstream MIT notices. Renamed-package verification is recorded separately in [VALIDATION.md](./VALIDATION.md).

## 0.4.0 — formerly dsh-zeta

- Add optional Cloudflare Browser Run, temporary static deployments and ApiMart image generation, disabled by default; use the Ext image model and 1K default output.
- Add a shared persona image, automatic self-portrait reference and real-sender administrator checks.
- Share sticker collections and combine short group-message bursts before a model reply-or-silence decision.
- Replace fixed activity intervals with model-selected native one-shot schedules.

## 0.3.0 — formerly dsh-zeta

- Add encrypted backups, code-only package downloads, native session and attachment migration, paused restoration and safe continuation after interruption.
- Retain QQ chat, persistent memory, stickers, speech, autonomous activity and cross-conversation features.
