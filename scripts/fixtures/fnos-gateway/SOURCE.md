# FNOS gateway browser bridge test snapshot

Upstream: FNOSP/fnos-dsh (Apache-2.0).

Source: https://raw.githubusercontent.com/FNOSP/fnos-dsh/5e6c64bd0137f2b658441bbb86eba8b8c42f8402/packages/fnos-gateway/src/client/bridge.ts

Commit: 5e6c64bd0137f2b658441bbb86eba8b8c42f8402

SHA-256 (bridge.js): 84adea769ffe90a3d59d71d1ec052dbf1b0bf6ddfb11a8b4186adf2378fdba49

The JavaScript-compatible bridge.ts is copied byte for byte into bridge.js. It is used only by the offline browser regression fixture, with an empty customPaths list. It is not included in the plugin runtime package. LICENSE is copied from the same commit.
