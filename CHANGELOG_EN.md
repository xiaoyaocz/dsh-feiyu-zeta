# dsh-feiyu-zeta changelog

[简体中文](./CHANGELOG.md) · [Repository](https://github.com/xiaoyaocz/dsh-feiyu-zeta)

This file records this personal testing and self-use experiment. The inherited dsh-qqbot changelog is no longer presented as this project's release history; source and copyright notices remain in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## 0.4.4 — current

- Accept `github:xiaoyaocz/dsh-feiyu-zeta` or the full GitHub HTTPS URL in DSH's plugin source field, without a local clone.
- Commit complete prebuilt `dist/` and `lib/` files on `main` instead of compiling during installation. Retain development builds and check source/artifact consistency in CI.
- Add `-Source` to the Windows helper while keeping the Desktop carrier's official entry point for the reserved `desktop` profile, local `-Package` archives and `-WhatIf` plan previews.
- Keep the exact DSH `0.2.1-rc.3` requirement. Git and network access for runtime dependencies are still needed; no `node_modules`, npm publication, marketplace entry or GitHub Release is provided.
- Preserve backup compatibility with 0.4.3 and earlier supported versions. Actual verification scope is recorded in [VALIDATION.md](./VALIDATION.md).

## 0.4.3

- Remove the management-space selector and share memory, speech, generated images and temporary webpage records in one library.
- Merge older partitions without overwriting conflicts or repeating paid submissions or QQ deliveries; retain original files and task identifiers.
- Preserve real QQ routes, administrator checks and per-task browser cleanup.
- Include shared-library migration receipts and deployment records in backups, with compatibility for 0.4.2 and earlier supported versions.

## 0.4.2

- Select administrators from observed QQ users in a dropdown, with display names and sources; no manual ID entry. Previously saved users not yet re-observed remain marked and preserved.
- Accept natural-language administrator requests and verify the real sender and current administrator list when each sensitive tool executes, without a command prefix.
- Separate group turns by sender authority so ordinary members cannot inherit administrator rights through message batching; mixed-source requests remain denied.
- Persist the observed-user directory and include it in encrypted migration, with compatibility for older backups lacking that table.

## 0.4.1

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
