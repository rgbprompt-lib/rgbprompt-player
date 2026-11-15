# apps/player-mac

The macOS menu-bar shell for RGBPrompt Player (PLAYER §9.1, ADR-0014). It links
the shared Rust core through a small C ABI and only owns the platform UI: the
status item, the panel, URL/file entry points and (later) Core Audio / CGEventTap
/ HID integration.

## Prerequisites

- Xcode 27.2 with the macOS SDK. Public CI selects `/Applications/Xcode_27.2.app` on the `xcode-27` runner.
- XcodeGen 2.46.0 (`brew install xcodegen`, or the 2.46.0 release zip).
- Rust 1.96 through the pinned `apps/player-core/rust-toolchain.toml`, with the
  `aarch64-apple-darwin` target.
- pnpm 9 through Corepack (`corepack pnpm …`).

The engine and safety player bundles must exist before the core can build; the
core build script creates them. No OpenRGB install is needed: the core uses an
already-running SDK server on port 6742 as an external driver, or the test stub.

## Build and test

Run from the repository root:

```bash
corepack pnpm player:core:mac   # engine + safety IIFEs, then the Rust staticlib
corepack pnpm player:mac:build  # Release app (pass --debug for Debug)
corepack pnpm player:mac:test   # PlayerKit XCTest + openrgb-stub integration
corepack pnpm player:mac:layout # regenerate the Swift ANSI-104 table
corepack pnpm player:mac:layout -- --check   # fail on drift
```

## Signed release (Developer ID + notarization)

`player:mac:build` stays ad-hoc so everyday developer builds do not need a
Developer ID certificate. To produce a downloadable package, build a Release
app and then run:

```bash
# Build first (or pass --build to combine the two steps).
corepack pnpm player:mac:build
CODESIGN_IDENTITY="Developer ID Application: lixin li (3ZEMHQZW5S)" \
  NOTARY_KEYCHAIN_PROFILE=rgbprompt \
  bash tools/player/sign-notarize-mac.sh \
    --app "apps/player-mac/build/Build/Products/Release/RGBPrompt Player.app"
```

The script copies the app (it never resigns the Xcode derived-data tree in
place), signs every nested Mach-O with the hardened runtime and a secure
timestamp, applies `apps/player-mac/RGBPromptPlayer.entitlements` only to the
app bundle, wraps a zip (the format `GET /api/player/download/mac` expects)
and a DMG, submits the DMG to Apple notary via the `notarytool` keychain
profile, and staples the ticket to both the `.app` and the DMG. Artifacts
land in `dist/player-mac/` (gitignored) as
`RGBPrompt-Player-<version>-<build>-mac-<arch>.zip` and `.dmg`, plus
`SHA256SUMS.txt` and `build-info.json`.

The only entitlement is `com.apple.security.device.audio-input`, required for
sound-reactive effects under the hardened runtime. Network, USB/HID matching
and the listen-only key tap do not need entitlements while App Sandbox is off.
QuickJS is an interpreter, so there is no JIT entitlement.

The current toolchain and `project.yml` target Apple silicon only (`arm64`).
Daily `player:mac:build` and `player:mac:test` stay ad-hoc (`CODE_SIGN_IDENTITY=-`)
and do not copy a helper. Public CI runs `player:mac:test` this way. It starts
`openrgb-stub` and does not request Input Monitoring, screen recording, or a
signing certificate.

The optional notarized release script can nest a pre-built, Developer ID-signed
OpenRGB.app at Contents/Helpers/OpenRGB.app. Set `OPENRGB_APP` to that local
artifact. The script's default path is a local release directory, not a source
checkout, and CI never calls the script. Settings includes a Licenses footer that
opens the bundled GPL-2.0 notice for OpenRGB
(https://github.com/rgbprompt-lib/openrgb-rgbprompt).

`player:core:mac` prints the absolute `librgbprompt_player.a` path and size.
`player:mac:build` runs XcodeGen, builds with ad-hoc signing and prints the
absolute `.app` path and its size. The Release app lands at:

```
apps/player-mac/build/Build/Products/Release/RGBPrompt Player.app
```

The generated `RGBPromptPlayer.xcodeproj` and `apps/player-mac/build/` are
gitignored; `project.yml` is the checked-in source of truth.

`player:mac:test` passes the stub and `.lep` paths to the test bundle through its
Info.plist (`RGBPStubPath` / `RGBPLepPath`, expanded from `RGBP_STUB` /
`RGBP_LEP`). It also forwards the documented `TEST_RUNNER_RGBP_*` settings.
The integration test starts only its own `openrgb-stub` child and kills it in
teardown.

## Core linking

`CoreBridge/module.modulemap` declares `RGBPromptPlayerCore` over the core header
(the header is not copied). The app links the static archive directly:

```
apps/player-core/target/aarch64-apple-darwin/release/librgbprompt_player.a
```

System libraries/frameworks: `pthread`, `m`, `Security`, `CoreFoundation`,
`CoreGraphics`, `CoreAudio`, `AudioToolbox` and `Carbon` (the last one only for
the `kVK_*` virtual key codes). Link the archive by path (not
`-lrgbprompt_player`) so the linker cannot prefer the `cdylib` next to it.

## Configuration

The bridge builds `RgbpConfig` as follows:

| Field          | Value                                                                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `data_dir`     | `~/.rgbprompt` (created if missing; the core only writes `<data_dir>/openrgb`)                                                               |
| `api_base`     | env `RGBP_API_BASE` → `UserDefaults.apiBase` → Info.plist `RGBPAPIBase` (build setting `RGBP_API_BASE`, default `https://rgbprompt.com/api`) |
| `openrgb_addr` | env `RGBP_OPENRGB_ADDR` → `UserDefaults.openrgbAddr` → core default `127.0.0.1:6742`                                                         |
| `platform`     | `mac`                                                                                                                                        |
| `language`     | `UserDefaults.language` (`en` / `zh-CN`, absent follows `Locale.preferredLanguages`); applied again with `rgbp_set_language` at launch       |
| `app_version`  | `CFBundleShortVersionString` (`0.6.0`)                                                                                                       |
| `os_version`   | `ProcessInfo.operatingSystemVersionString` normalized to `major.minor.patch`                                                                 |

The env overrides are for local testing. Against the local dev stack, point the
Player at the Vite dev server (which proxies `/api` to the Worker on 8787), so
"Open Studio" opens the site (`<origin>/app`) and not the API:

```bash
defaults write com.rgbprompt.player apiBase http://127.0.0.1:5173/api
```

`.lep` files exported by the old prototype (package versions above 3) are
rejected as `decode_failed`; export them again from the site. Logs never contain tokens, key names,
colors or diagnostics content; a `rgbprompt://` URL is logged only as
`rgbprompt://play?t=<first 6 chars>…`, and the API base is logged as its host.

## Driver install, supervision and the setup window

The core resolves the driver in this order: the OpenRGB SDK server at
`openrgb_addr`, then a managed copy under `<data_dir>/openrgb`, otherwise
`NeedsDriver`. The setup window (400 × 560, non-resizable) opens automatically
when a play request lands in `NeedsDriver` or `Blocked`, and from the panel
buttons. It closes when playback reaches `Playing` or the state returns to
`Idle`.

- **Step 1** shows the manifest (contents, size, install location, SHA-256
  verification), download progress and ETA, then installs only when the user
  clicks Install and play.
- **Step 2** is the Gatekeeper guide: Show in Finder, open
  Privacy & Security, copy the installed `.app` path, then retry.
- **Supervision** is visible in the panel. `BackendUnresponsive` splits into
  four cards from `driverInfo.supervision`: restarting (attempt n of limit),
  gave up, the user's external OpenRGB disappeared (waiting, auto-reconnect),
  and a generic stuck backend. While the external OpenRGB is lost, automatic
  rescans only probe its address and never spawn Player's own copy; only the
  explicit Retry / Restart backend buttons run full resolution.

The macOS shipped manifest is `archive: "bundle"`. When
`Contents/Helpers/OpenRGB.app` is present, the Player launches it and never
downloads a driver. If the helper is missing (a broken install or a test
host), install fails closed with `driver_error = 5` (unverified) and should
prompt the user to reinstall the Player instead of offering a download.

### Development manifest override (Debug only)

Debug builds read `RGBP_DEV_DRIVER_MANIFEST` (a JSON file path) once at launch
and call `rgbp_set_driver_manifest_json` before any effect. Release builds have
no such code path. Point it at a loopback-served zip of a patched OpenRGB:

```bash
python3 -m http.server 8788 --directory /tmp/openrgb-build   # serves openrgb.zip
RGBP_DEV_DRIVER_MANIFEST=/tmp/manifest.json \
  "apps/player-mac/build/Build/Products/Debug/RGBPrompt Player.app/Contents/MacOS/RGBPrompt Player"
```

The manifest must be the same schema as
`apps/player-core/crates/core/data/manifests/openrgb-macos.json`, with a
non-null `sha256` and an `http://127.0.0.1:<port>/…` or `https://` URL. Its
`executable` is relative to the install directory, for example
`OpenRGB.app/Contents/MacOS/OpenRGB`. The managed launcher scans eight
ports starting at the configured OpenRGB port (6742–6749 by default), so tests
that configure a private `openrgbAddr` never touch the user's OpenRGB on 6742.

## USB hot-plug (PLY-08)

`IOKitDeviceChangeWatcher` registers `IOServiceAddMatchingNotification` on
`IOHIDDevice` for keyboard usage (usage page 1, usage 6) and for USB transport
devices (some RGB keyboards expose the lighting interface as vendor-defined).
It never opens the devices, so it needs no Input Monitoring permission. Initial
iterators are drained at start without a notification; a burst of changes is
coalesced for 300 ms and then calls `rgbp_notify_devices_changed` on the main
actor. Logs contain only `hid_change added=<n> removed=<n>`.

## Entry points and default handler

In-tree `Info.plist` registers the exported UTI `com.rgbprompt.lep` and a
Viewer document type for `.lep`. It does **not** declare `CFBundleURLTypes` /
`rgbprompt://`. Daily Xcode and Release builds must stay scheme-free so Launch
Services does not register a development copy as the `rgbprompt://` handler.

The official scheme is injected only by `tools/player/sign-notarize-mac.sh`,
into the staged app after `ditto` and helper nesting and before codesign. The
script then checks that the staged package still contains both `rgbprompt://`
and the bundled OpenRGB helper. Do not add the scheme back to the source
plist, and do not edit an already-signed official app to add or remove it.

`AppDelegate` routes `rgbprompt://play` / `rgbprompt://open` and Finder-opened
`.lep` files to the core when the official package is launched. A `.lep` can
also be dropped on the panel's idle zone or the status item.
`DefaultHandlerCoordinator.makeDefault()` is user-initiated and will not claim
`rgbprompt://` unless the running bundle already declares the scheme.
Launch itself does not call `NSWorkspace.setDefaultApplication`.

When an official build is not the default handler, the panel footer offers
"Make this the app for rgbprompt:// links". Tests and scripts never do that.
For local testing, pass a `rgbprompt://…` argument or a `.lep` path on the
command line: it is handled once after launch. A development build will not
become the system `rgbprompt://` handler just by being built or opened.

## Input: system sound and keys

`InputCoordinator` owns both capture paths. It reads `rgbp_input_wanted` on each
state change and installs a capture **only while the effect is Playing and wants
that input** (bit 0 audio, bit 1 keys). Every other state, a cleared bit, stop or
Idle tears the capture down immediately; a later Playing installs it again. No
capture is installed at launch or while idle.

- **Keys (PLY-21)** — a session-level, listen-only `CGEventTap` for
  keyDown/keyUp/flagsChanged. Auto-repeat keyDowns are skipped. Mac key codes
  are mapped to ANSI-104 names, including the PC-keyboard mappings:
  Delete → `BACKSPACE`, Forward Delete → `DELETE`, Help → `INSERT`,
  F13/F14/F15 → `PRINTSCREEN`/`SCROLLLOCK`/`PAUSE`, Keypad Clear → `NUMLOCK`.
  Key names, codes and counts never appear in logs.
- **Sound (PLY-07)** — a Core Audio process tap (macOS 14.2+,
  `CATapDescription` global tap excluding this process) feeding a private
  aggregate device. The IO block converts into a preallocated scratch buffer and
  pushes interleaved `f32` through `rgbp_push_audio_pcm`. Nothing is recorded or
  uploaded.

### Permissions

- **Input Monitoring** (`System Settings › Privacy & Security › Input
Monitoring`) for the key tap. A listen-only tap does not need Accessibility.
  The first key-reactive effect shows an explanation with Continue / Not now.
  While the notice is visible the app re-checks every 2 s and when the panel
  opens; once granted, the tap is installed and the notice clears.
- **System Audio Recording Only** (`System Settings › Privacy & Security ›
Screen & System Audio Recording`) for the process tap. macOS has no API to
  ask in advance, so the first capture attempt is the prompt. If capture starts
  but every sample is exactly 0 for 3 s while another process is producing
  output, the panel offers the "Open System Settings" path. Both notices are
  non-blocking: playback continues and only that input layer stays static.

Ad-hoc signed rebuilds change the code signature, so macOS may ask again or keep
a stale entry. If permission seems granted but capture still fails, remove
RGBPrompt Player from the relevant System Settings list and add it again (or
quit and reopen Player).

Modifier remapping in System Settings changes the device-dependent bits macOS
reports, so remapped modifiers light the key they are remapped to. There is no
workaround in the shell.

For automated runs, `RGBP_DISABLE_INPUT_CAPTURE=1` disables both captures and
all permission notices.

## Settings window (PLY-15, PLY-17)

The panel footer's "Settings…" row (⌘, while the panel is key) opens one
non-resizable 400 × 560 `NSWindow` titled `RGBPrompt Player · Settings`.
`SettingsWindowController` keeps a single instance; reopening brings it to the
front. While either the setup or settings window is open the app temporarily
uses `.regular` activation policy through a shared, ref-counted
`ActivationPolicyCoordinator`: the first window acquires, the last release
restores `.accessory`, so closing one never demotes the app while the other is
still open.

- **Status** — three rows derived from `SettingsModel`/`SettingsStatusBuilder`:
  the light driver (`OpenRGB <version> · Ready`, external OpenRGB, or Not
  installed), the keyboard (last name seen while Playing/Idle, else Not found),
  and the web link (`rgbprompt:// registered`, otherwise grey plus a Make
  default button that calls the existing handler coordinator).
- **Preferences** — language, sound source (`System sound | Off`; Off sets
  `rgbp_set_audio_enabled(false)` and stops the process tap), brightness
  (10–100 in steps of 5, `rgbp_set_brightness`), launch at login, and a static
  "when you stop or quit" row. There is no restore-original-lighting toggle.
- **Footer** — version, "Check for updates" (opens
  `<site>/player` until Sparkle lands in M6-M5) and "Copy diagnostics".

`DiagnosticsCopier` is the one copy path used by the settings footer and every
panel card. It copies the core's `rgbp_diagnostics_json` verbatim, only
pretty-printed; if the core is unavailable it writes the minimal fallback with
the same allowed keys and no tokens, paths, prompts, key names or audio.

## Language (PLY-17)

`UserDefaults.language` stores `en` or `zh-CN`; absent follows the system.
`LanguageStore` is the single source of truth and `L10n` reads its static
mirror, loading strings from the matching `en` / `zh-Hans` sub-bundle of
`PlayerKitResources.bundle` and formatting numbers with that locale. Switching a
segment updates the panel, both windows and the status item live and calls
`rgbp_set_language`. To test:

```bash
defaults write com.rgbprompt.player language zh-CN
defaults delete com.rgbprompt.player language   # follow the system again
```

## Launch at login (PLY-20)

The switch is **off by default** and nothing registers automatically. It is
`SMAppService.mainApp`, wrapped by `LoginItemControlling`; only
`SMAppServiceLoginItem` (app target) calls `ServiceManagement`.
`LoginItemModel` supports `.enabled`, `.requiresApproval` (offers Open Login
Items), `.notRegistered` and `.notFound` (switch disabled). The status is
re-read every time the settings window opens. Tests use a fake controller and
never touch the real service; do not register the installed app from a script.

User defaults keys used by the shell: `apiBase`, `openrgbAddr`, `language`,
`audioEnabled` (default true), `brightness` (default 100, clamped 10–100),
`keyInputExplained`.

## Out of scope until later milestones

- Microphone capture, the tuned-driver screen (PLY-11), and Windows settings.
- There is no restore-on-stop or restore-on-quit: stop and quit turn the keys
  off (one black frame) and the panel tells the user to replug the keyboard
  (PLY-20, Q36).
- P1 / M6-M5: pause, recent effects, Sparkle updates, signing and notarization.

The panel is always dark and uses the Player App board tokens in
`Sources/RGBPromptPlayer/Theme.swift`. Every user-visible string is a
localization key with `en` and `zh-Hans` values.
