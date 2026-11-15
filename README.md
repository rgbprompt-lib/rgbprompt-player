# RGBPrompt Player

RGBPrompt Player is the small desktop app that plays RGBPrompt lighting effects on your
keyboard. It runs locally on macOS (menu bar) and Windows (tray), takes an effect from
[rgbprompt.com](https://rgbprompt.com) or a local `.lep` file, renders it frame by frame,
passes every frame through a safety limiter, and sends it to the keyboard through a local
[OpenRGB](https://openrgb.org) process.

The Player asks for sensitive permissions (keyboard input for key-reactive effects, system
audio for sound-reactive effects), so its source is public: you can read exactly what it does
with them and build it yourself. See [PRIVACY.md](PRIVACY.md).

## What is in this repository

| Path                          | What it is                                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/player-core/`           | Shared Rust core: QuickJS engine host, safety limiter, key mapping, OpenRGB SDK client, managed OpenRGB download, play-token client, playback loop, C ABI (`crates/ffi`). |
| `apps/player-mac/`            | macOS shell (Swift / SwiftUI, macOS 14.2+).                                                                                                                               |
| `apps/player-win/`            | Windows shell (WinUI 3 / C#, .NET 8).                                                                                                                                     |
| `packages/engine/`            | The lighting engine (TypeScript). Built into `engine.iife.js` and embedded in the core.                                                                                   |
| `packages/safety/`            | The real-time brightness / flash limiter, built into `safety.iife.js`.                                                                                                    |
| `packages/layouts/`           | Neutral ANSI-104 key geometry shared by engine and safety.                                                                                                                |
| `tools/golden/`               | Golden test corpus and parity scripts for the engine.                                                                                                                     |
| `tools/player/`, `tools/win/` | Build and test scripts.                                                                                                                                                   |
| `docs/specs/PLAYER.md`        | Player specification (Chinese).                                                                                                                                           |

Not in this repository: the website, the AI effect generator, accounts, billing and servers.
Those are separate, closed services; the Player only talks to them to redeem a play token when
you start an effect from the site.

## Architecture

```text
Shell (Swift / C#)  --C ABI-->  Rust core
                                  ├─ QuickJS: engine.iife.js -> frames
                                  ├─ QuickJS: safety.iife.js -> limited frames
                                  └─ OpenRGB SDK client (TCP 127.0.0.1:6742)
                                                     │
                                        OpenRGB (separate process) -> keyboard
```

The Player never writes HID lighting reports itself; OpenRGB does. On macOS the shell only
watches USB plug / unplug events and does not open devices.

## Permissions

| Input        | macOS                                                                       | Windows                 | Used for                                                                                          |
| ------------ | --------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------- |
| Keyboard     | Input Monitoring (listen-only event tap)                                    | Low-level keyboard hook | Key-reactive effects only; key codes map to generic key positions, nothing is logged or uploaded. |
| System audio | Screen & System Audio Recording (Core Audio process tap, no screen capture) | WASAPI loopback         | Sound-reactive effects only; analysed locally into frequency bands and discarded.                 |
| Network      | —                                                                           | —                       | Redeeming a play token, downloading OpenRGB on request. Frames are never uploaded.                |

Capture runs only while an effect that needs it is playing. Denying a permission keeps the
effect running with that input layer static.

## Building

Clone this repository and build it on its own. Player development does not check
out another project, export source from one, or share a `node_modules` tree.

Prerequisites: Node 22.18 (`.nvmrc`) with Corepack (pnpm 9.15.4), Rust 1.96.0
(`apps/player-core/rust-toolchain.toml`), and per platform:

- macOS 14.2+: Xcode 27.2 and [XcodeGen](https://github.com/yonaskolb/XcodeGen) 2.46.0.
- Windows: .NET SDK 8.0.305 (`apps/player-win/global.json`) and Visual Studio 2022
  with the Desktop development with C++ workload (see `apps/player-win/README.md`).
- A Windows GNU cross-check also needs `x86_64-w64-mingw32-gcc` (package
  `gcc-mingw-w64-x86-64` on Ubuntu).

```sh
corepack enable
corepack prepare pnpm@9.15.4 --activate
pnpm install --frozen-lockfile
pnpm check                      # format, lint, typecheck, JS tests, golden corpus, oracle pins, package tarballs
pnpm build:bundles              # engine.iife.js + safety.iife.js
pnpm player:iife                # player IIFE frame CRCs against the golden vectors
pnpm player:parity              # IIFE CRCs, then QuickJS golden + limiter parity
cd apps/player-core && cargo test --locked --workspace
cd ../..
pnpm player:mac:test            # Rust static core + PlayerKit XCTest (openrgb-stub)
pnpm player:mac:build           # RGBPrompt Player.app (ad-hoc signed, not notarized)
pnpm player:check:win           # cross-build the core for x86_64-pc-windows-gnu
```

`cargo test` leaves three opt-in tests ignored: `live_download_installs_a_real_archive`
and the two `audio_effect_probe` timing probes. Do not pass `--ignored` in CI.

Signing and notarization (`pnpm player:mac:release`) are optional local steps.
They are not part of CI and need no secret to build or test. CI does not attach
a keyboard or any other USB device.

Public CI is [`.github/workflows/ci.yml`](.github/workflows/ci.yml). It requests
only `contents: read`.

| Job               | What it runs                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `pnpm check`      | `pnpm check` on `ubuntu-24.04`                                                                           |
| `player parity`   | `pnpm player:parity` (Node IIFE CRCs + QuickJS)                                                          |
| `cargo test`      | `cargo test --locked --workspace` (three `#[ignore]` tests stay ignored)                                 |
| `windows gnu`     | `pnpm player:check:win` with mingw-w64                                                                   |
| `macOS PlayerKit` | `pnpm player:mac:test` on the `xcode-27` runner, Xcode 27.2, stub only                                   |
| `windows native`  | unsigned Debug MSVC DLL, cargo test, parity, stub C smoke, WinUI build, and Core tests on `windows-2022` |

The hosted Windows job uses Debug because the workspace Release profile
(`lto = "fat"`, `codegen-units = 1`) can exhaust a 16 GB runner. That job still
compiles the WinUI shell and the native DLL. It does not sign or install the app.

More detail: [`apps/player-core/README.md`](apps/player-core/README.md),
[`apps/player-mac/README.md`](apps/player-mac/README.md),
[`apps/player-win/README.md`](apps/player-win/README.md),
[`tools/golden/README.md`](tools/golden/README.md).

## OpenRGB

The Player downloads OpenRGB on request into `~/.rgbprompt/openrgb` (macOS) or
`%LOCALAPPDATA%\RGBPrompt\openrgb` (Windows), checking the SHA-256 and size pinned in
`apps/player-core/crates/core/data/manifests/`. OpenRGB is GPL-2.0 software that runs as its
own process; it is not linked into the Player. The Windows build with the EVision Direct-mode
patch used by the Player, together with its source and patches, is published at
[rgbprompt-lib/openrgb-rgbprompt](https://github.com/rgbprompt-lib/openrgb-rgbprompt/releases/tag/f81fd32-evision.1).

## License

- Player code: [Apache License 2.0](LICENSE).
- `packages/engine`: MIT ([packages/engine/LICENSE](packages/engine/LICENSE)).
- Third-party components: see [NOTICE](NOTICE).
- OpenRGB: GPL-2.0, separate program, not included here.
- The RGBPrompt name and logo are not covered by these licenses: see [TRADEMARKS.md](TRADEMARKS.md).

Security issues: see [SECURITY.md](SECURITY.md). Contributions: see [CONTRIBUTING.md](CONTRIBUTING.md).

## 中文简介

RGBPrompt Player 是在本机播放 RGBPrompt 键盘灯效的小程序（macOS 菜单栏 / Windows 托盘）。
它从 rgbprompt.com 或本地 `.lep` 文件取得灯效，逐帧渲染、经安全限幅后，通过本机 OpenRGB 写到键盘。
因为它需要「输入监控」和「系统音频」等敏感权限，所以源码公开，任何人都可以审查并自行编译。
网站、AI 生成、账户与支付不在本仓库。构建与 CI 只使用本仓库，不检出其它项目。
隐私说明见 [PRIVACY.md](PRIVACY.md)；许可证为 Apache-2.0（引擎为 MIT），OpenRGB 为 GPL-2.0 的独立程序。
