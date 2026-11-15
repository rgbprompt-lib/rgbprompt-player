# apps/player-win

Windows tray shell for RGBPrompt Player (PLAYER §9.2, ADR-0014). It loads the
shared Rust core (`rgbprompt_player.dll`) through a thin C ABI and only owns the
platform UI: tray icon, 340-wide panel, settings, WASAPI loopback / low-level
keyboard hook / HID hot-plug (M6-W3), protocol registration and Velopack
packaging (M6-W5).

**No WebView.** The engine and safety output stage run inside the Rust core (QuickJS),
same as macOS.

## Visibility rule (push / play)

Opening a play URL or a `.lep` file **must not** reveal the panel. If the panel
was hidden, it stays hidden while the effect starts. Only:

- an explicit tray click / "Open panel", or
- `rgbprompt://open`

may show the panel. See `EntryPoint.RevealsPanel` and `Tray/AppController.Open`.

## Layout

| Path                                | Role                                                             |
| ----------------------------------- | ---------------------------------------------------------------- |
| `src/RGBPrompt.Player.Core`         | net8.0 models, EntryPoint, KeyNameMap, LibraryImport ABI, bridge |
| `src/RGBPrompt.Player`              | WinUI 3 unpackaged + self-contained app (tray, panel, settings)  |
| `tests/RGBPrompt.Player.Core.Tests` | xUnit for Core (no WinUI, no native DLL)                         |

## Prerequisites (Windows)

Public CI runs `tools/win/build.ps1 -Configuration Debug` on `windows-2022` after
`tools/win/prepare-mac.sh` builds the bundles in that same clone. Debug avoids
the Release `lto = fat` link, which can exhaust a 16 GB machine. The job does
not sign, install, or attach a keyboard. A local Windows build uses the same
scripts in this repository.

- rustup + `x86_64-pc-windows-msvc`
- Visual Studio 2022 Build Tools — "Desktop development with C++" (x64 tools; on ARM64 also the ARM64-hosted MSVC tools)
- .NET SDK matching `global.json` (8.0.305, `latestFeature` roll-forward inside the 8.0 band)
- Bundles and fixtures from this repository: `bash tools/win/prepare-mac.sh` (or `pnpm player:prepare:win`)

`build.ps1` does not run `pnpm install`. Produce the Node artifacts first, in this clone.

## Build

From this repository root:

```powershell
powershell -ExecutionPolicy Bypass -File tools\win\build.ps1
```

Outputs land under `%LOCALAPPDATA%\rgbprompt-build`. A local VM may pass `-Configuration Debug`
on a 16 GB machine. Public CI does that on `windows-2022`. Neither path signs the app.

## Cross-check without Windows

```bash
corepack pnpm player:prepare:win   # engine + safety IIFEs + fixtures
corepack pnpm player:check:win     # cargo build --target x86_64-pc-windows-gnu
```

WinUI itself cannot be compiled on macOS.

## Input and devices (M6-W3)

- `WasapiAudioCapture` loopbacks the default render device, converts to
  interleaved f32 and resamples to 48 kHz (the v15 analyser contract).
- `LowLevelKeyCapture` installs `WH_KEYBOARD_LL` only while a key-reactive
  effect is Playing. The hook procedure enqueues; names go through
  `KeyNameMap` and are never logged.
- `DeviceNotificationService` registers `GUID_DEVINTERFACE_HID`, coalesces
  `WM_DEVICECHANGE` for 300 ms, then calls `rgbp_notify_devices_changed`.
- The driver manifest `apps/player-core/crates/core/data/manifests/openrgb-windows.json`
  points at our patched OpenRGB (K552 / EVision Direct) release
  `f81fd32-evision.1` on github.com/rgbprompt-lib/openrgb-rgbprompt (source,
  patch and build script are in that repository), with the measured size and
  SHA-256. There is no CDN mirror yet. Downloads are chunked HTTP `Range`
  requests with retry and resume (see PLAYER §4).
- Debug builds read `RGBP_DEV_DRIVER_MANIFEST` (a JSON manifest path) at
  launch, same as macOS, e.g. to point at a loopback-served patched zip.

`RGBP_DISABLE_INPUT_CAPTURE=1` disables both captures (same as macOS).

## Packaging (M6-W5 draft)

See `tools/win/pack.ps1` (Velopack scaffold; does **not** upload or sign).
EV code signing waits on Q28.
