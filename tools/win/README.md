# tools/win — Windows VM Player build

## One-time VM setup

1. Share the rgbprompt repo into the Windows VM (Parallels / UTM / VMware).
2. Install:
   - [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0) (x64; on ARM64 Windows the x64 SDK runs under Prism)
   - [rustup](https://rustup.rs) then `rustup target add x86_64-pc-windows-msvc`
   - Visual Studio 2022 Build Tools with **Desktop development with C++**, including the **MSVC v143 x64/x86** tools. On Windows ARM64 (Parallels on an M-series Mac) also install the **ARM64 host / ARM64-hosted** MSVC tools so `VsDevCmd.bat -arch=amd64 -host_arch=arm64` can find `cl.exe`. The script detects the host arch; do not force `-host_arch=amd64` on ARM.

   The Player is always built as x64 (`x86_64-pc-windows-msvc` / `win-x64`) and runs under Prism on Windows 11 ARM. `cargo test` and `openrgb-stub` use the same x64 target so you do not need a second aarch64 toolset just to test.

   On a 16 GB VM, prefer `powershell -ExecutionPolicy Bypass -File tools\win\build.ps1 -Configuration Debug`. The workspace Release profile uses `lto=fat` and can run out of memory. That profile is shared with the Mac Player and is not changed here.

3. On the Mac (host), from the repo root:

```bash
bash tools/win/prepare-mac.sh
# or: corepack pnpm player:prepare:win
```

## Build in the VM

Open PowerShell **in the shared repo root**:

```powershell
powershell -ExecutionPolicy Bypass -File tools\win\build.ps1
```

Paste the full output (especially the summary block) back for review.

### What the script does

1. Checks rustc/msvc/dotnet and Mac-built engine/safety/fixtures
2. `cargo test` + build `rgbprompt_player.dll` into `%LOCALAPPDATA%\rgbprompt-build\cargo`
3. `parity golden` + `parity limiter`
4. MSVC C ABI smoke against `openrgb-stub`
5. `dotnet restore/build/test` for `apps/player-win` (unless `-SkipShell`)

Never runs `pnpm install`.

## Manual checklist (after a green build)

### W1 — core only

- [ ] Summary prints DLL path and "C smoke : ok"
- [ ] Parity golden/limiter exit 0

### W2 — shell (no keyboard needed)

- [ ] Start `RGBPrompt.Player.exe` — tray icon appears, **panel stays hidden**
- [ ] Click tray → panel shows; Hide → hidden
- [ ] Play URL / site "Play on my keyboard" → effect starts **without** the panel popping up
- [ ] `start rgbprompt://open` → panel shows
- [ ] Double-click a `.lep` → plays, panel stays as-is
- [ ] Second exe instance exits and forwards the URL to the first

### W3 — input / device (USB keyboard passthrough to the VM)

- [ ] WASAPI loopback drives a sound-reactive preset (system output, 48 kHz into the core). Toggle **System sound** off and the effect should stop reacting.
- [ ] Key presses drive a key-reactive preset. The hook is installed only while a key-reactive effect is Playing. Toggle **Key-reactive lighting** off and keys should stop driving the effect. The Player must not log key contents.
- [ ] Unplug/replug the keyboard (K552 alone is enough) → the core is notified within a few seconds (HID `WM_DEVICECHANGE`, 300 ms debounce) and recovers via the existing rescan path. Panel must not pop up on its own.
- [ ] Fresh install without OpenRGB: NeedsDriver → consent → progress (bar updates in place, buttons do not flicker) → the patched OpenRGB zip from the manifest (or `RGBP_DEV_DRIVER_MANIFEST` in Debug) is downloaded, hashed, and the backend starts. A dropped connection resumes; pressing Install again after a failure continues from the kept part file.

### W4 — settings

- [ ] Settings window; launch-at-login toggles HKCU Run
- [ ] Stop/quit → keys go dark (no restore)
- [ ] Copy diagnostics

### W5 — packaging (needs Q28 EV cert)

- [ ] `tools\win\pack.ps1` produces a local Velopack release
- [ ] No automatic upload

## USB keyboard passthrough

Attach the Redragon K552 USB device to the VM while testing W3/W4. The Mac host
cannot control that keyboard's lights during passthrough.
