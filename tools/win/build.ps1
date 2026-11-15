#Requires -Version 5.1
<#
.SYNOPSIS
  Windows VM build for RGBPrompt Player (M6-W1 / PLAYER section 9.2).
  Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less files in
  the system code page (e.g. GBK), and non-ASCII characters break parsing.

.DESCRIPTION
  Run from this repository's root on Windows:
    powershell -ExecutionPolicy Bypass -File tools\win\build.ps1

  Never runs pnpm install. Expects engine / safety player IIFEs and
  player fixtures to already exist in this repository. Produce them with
  tools/win/prepare-mac.sh or: pnpm player:prepare:win.

  All Cargo / dotnet outputs go under %LOCALAPPDATA%\rgbprompt-build.

  On a 16 GB Parallels VM the workspace Release profile (lto=fat,
  codegen-units=1) can run out of memory. Use -Configuration Debug for
  bring-up. cargo test always uses the dev profile even when Configuration
  is Release; the DLL, parity and the WinUI shell still follow -Configuration.
  Builds are always x64 (x86_64-pc-windows-msvc / win-x64). On Windows
  ARM64, VsDevCmd is loaded with -host_arch=arm64 and the x64 binaries run
  under Prism emulation. Install the VS 2022 C++ x64/x86 tools AND the ARM64
  host tools (the ARM64-hosted x64 compiler).

.PARAMETER SkipShell
  Skip the WinUI shell build (core / parity / C smoke only).

.PARAMETER Configuration
  Rust + dotnet configuration. Default: Release.
#>
[CmdletBinding()]
param(
  [switch]$SkipShell,
  [ValidateSet("Debug", "Release")]
  [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Fail([string]$Message) {
  Write-Host ""
  Write-Host "FAIL: $Message" -ForegroundColor Red
  exit 1
}

function Require-Command([string]$Name, [string]$Hint) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    Fail "Missing '$Name'. $Hint"
  }
}

# Resolve repo root: this script lives at tools/win/build.ps1
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $ScriptDir "..\..")).Path
Set-Location $RepoRoot
Write-Host "Repo: $RepoRoot"

$LocalBuild = Join-Path $env:LOCALAPPDATA "rgbprompt-build"
$CargoTarget = Join-Path $LocalBuild "cargo"
$DotnetOut = Join-Path $LocalBuild "dotnet"
New-Item -ItemType Directory -Force -Path $CargoTarget | Out-Null
New-Item -ItemType Directory -Force -Path $DotnetOut | Out-Null
$env:CARGO_TARGET_DIR = $CargoTarget

# ---------- prerequisites ----------
Write-Step "Checking prerequisites"

# Per-user installs (no admin): rustup in %USERPROFILE%\.cargo\bin and the
# .NET SDK from dotnet-install.ps1 in %LOCALAPPDATA%\Microsoft\dotnet. Prefer
# them when present. apps/player-win/global.json requires SDK >= 8.0.305
# (Windows App SDK 1.6).
$CargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
if ((Test-Path (Join-Path $CargoBin "cargo.exe")) -and -not (Get-Command "cargo" -ErrorAction SilentlyContinue)) {
  $env:PATH = "$CargoBin;$env:PATH"
}
$UserDotnet = Join-Path $env:LOCALAPPDATA "Microsoft\dotnet"
if (Test-Path (Join-Path $UserDotnet "dotnet.exe")) {
  $env:DOTNET_ROOT = $UserDotnet
  $env:DOTNET_MULTILEVEL_LOOKUP = "0"
  $env:PATH = "$UserDotnet;$env:PATH"
}

Require-Command "rustup" "Install from https://rustup.rs and restart PowerShell."
Require-Command "cargo" "Install Rust via rustup, then re-run."
Require-Command "dotnet" "Install .NET 8 SDK from https://dotnet.microsoft.com/download/dotnet/8.0"

$rustTargets = & rustup target list --installed
if ($rustTargets -notcontains "x86_64-pc-windows-msvc") {
  Write-Host "Adding rustup target x86_64-pc-windows-msvc..."
  & rustup target add x86_64-pc-windows-msvc
  if ($LASTEXITCODE -ne 0) { Fail "rustup target add x86_64-pc-windows-msvc failed" }
}

# MSVC: cl.exe must be on PATH (VS 2022 Build Tools, Desktop development with C++).
# Always target x64 (-arch=amd64). On ARM64 hosts, -host_arch=amd64 fails; use
# the ARM64-hosted x64 toolchain instead. Detect the host, never assume amd64.
$osArch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
$hostArch = switch ($osArch) {
  "Arm64" { "arm64" }
  "X86"   { "x86" }
  default { "amd64" }
}
Write-Host "Host arch: $osArch (VsDevCmd -arch=amd64 -host_arch=$hostArch)"

$hasCl = Get-Command "cl.exe" -ErrorAction SilentlyContinue
if (-not $hasCl) {
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  if (Test-Path $vswhere) {
    $vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($vsPath) {
      $devCmd = Join-Path $vsPath "Common7\Tools\VsDevCmd.bat"
      if (Test-Path $devCmd) {
        Write-Host "Loading VS environment from $devCmd"
        cmd /c "`"$devCmd`" -arch=amd64 -host_arch=$hostArch >nul && set" | ForEach-Object {
          if ($_ -match "^(.*?)=(.*)$") {
            [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2])
          }
        }
      }
    }
  }
  $hasCl = Get-Command "cl.exe" -ErrorAction SilentlyContinue
}
if (-not $hasCl) {
  Fail "MSVC cl.exe not found. Install Visual Studio 2022 Build Tools with the 'Desktop development with C++' workload. On Windows ARM64 also install the ARM64-hosted MSVC tools, then re-run (or open 'x64 Native Tools Command Prompt' with host_arch=arm64)."
}

Push-Location (Join-Path $RepoRoot "apps\player-win")
try { $dotnetVersion = (& dotnet --version).Trim() } finally { Pop-Location }
if ($LASTEXITCODE -ne 0 -or -not $dotnetVersion) {
  Fail "No .NET SDK satisfies apps/player-win/global.json (needs >= 8.0.305). Per-user install: dotnet-install.ps1 -Channel 8.0 -Quality GA -InstallDir `$env:LOCALAPPDATA\Microsoft\dotnet"
}
Write-Host "dotnet SDK: $dotnetVersion ($((Get-Command dotnet).Source))"
if (-not ($dotnetVersion.StartsWith("8."))) {
  Write-Host "Warning: expected .NET 8 SDK, found $dotnetVersion" -ForegroundColor Yellow
}

# ---------- Mac-side artifacts ----------
Write-Step "Checking engine / safety / fixtures"

$engine = Join-Path $RepoRoot "packages\engine\dist\player\engine.iife.js"
$safety = Join-Path $RepoRoot "packages\safety\dist\player\safety.iife.js"
$fixtures = Join-Path $RepoRoot "apps\player-core\fixtures\golden\manifest.json"
foreach ($f in @($engine, $safety, $fixtures)) {
  if (-not (Test-Path $f)) {
    Fail "Missing $f. From this repository root, run: bash tools/win/prepare-mac.sh   (or: corepack pnpm player:prepare:win)"
  }
  Write-Host "  ok $f"
}

$PlayerCore = Join-Path $RepoRoot "apps\player-core"
$Lep = Join-Path $PlayerCore "crates\core\tests\data\example-cyber-breath.lep"
if (-not (Test-Path $Lep)) {
  Fail "Missing test .lep at $Lep"
}

# ---------- cargo test ----------
# Always x86_64-pc-windows-msvc so ARM64 hosts do not need a second (native
# aarch64) MSVC toolset; the tests run under Prism. Always the dev profile:
# workspace lto=fat Release can OOM a 16 GB VM (the DLL is still built Release).
Write-Step "cargo test --workspace --target x86_64-pc-windows-msvc (dev profile)"
Push-Location $PlayerCore
try {
  $cargoArgs = @("test", "--locked", "--workspace", "--target", "x86_64-pc-windows-msvc")
  & cargo @cargoArgs
  if ($LASTEXITCODE -ne 0) { Fail "cargo test failed (exit $LASTEXITCODE)" }
} finally {
  Pop-Location
}

# ---------- build dll ----------
Write-Step "Building rgbprompt_player.dll"
Push-Location $PlayerCore
try {
  $buildArgs = @("build", "--locked", "-p", "rgbprompt-player", "--target", "x86_64-pc-windows-msvc")
  if ($Configuration -eq "Release") { $buildArgs += "--release" }
  & cargo @buildArgs
  if ($LASTEXITCODE -ne 0) { Fail "cargo build rgbprompt-player failed" }
} finally {
  Pop-Location
}

$profile = if ($Configuration -eq "Release") { "release" } else { "debug" }
$DllDir = Join-Path $CargoTarget "x86_64-pc-windows-msvc\$profile"
$Dll = Join-Path $DllDir "rgbprompt_player.dll"
$DllLib = Join-Path $DllDir "rgbprompt_player.dll.lib"
if (-not (Test-Path $Dll)) { Fail "Expected DLL at $Dll" }
Write-Host "  DLL: $Dll  ($([math]::Round((Get-Item $Dll).Length / 1MB, 2)) MB)"

# ---------- parity ----------
Write-Step "parity golden"
Push-Location $PlayerCore
try {
  $parityArgs = @("run", "--locked")
  if ($Configuration -eq "Release") { $parityArgs += "--release" }
  $parityArgs += @("-p", "parity", "--", "golden")
  & cargo @parityArgs
  if ($LASTEXITCODE -ne 0) { Fail "parity golden failed" }

  Write-Step "parity limiter"
  $parityArgs[-1] = "limiter"
  & cargo @parityArgs
  if ($LASTEXITCODE -ne 0) { Fail "parity limiter failed" }
} finally {
  Pop-Location
}

# ---------- C smoke (MSVC) ----------
Write-Step "MSVC C ABI smoke"

# Build + start openrgb-stub (same x64 target as the DLL, so ARM64 hosts
# do not need a native aarch64 MSVC toolset).
Push-Location $PlayerCore
try {
  $stubArgs = @("build", "--locked", "-p", "openrgb-stub", "--target", "x86_64-pc-windows-msvc")
  if ($Configuration -eq "Release") { $stubArgs += "--release" }
  & cargo @stubArgs
  if ($LASTEXITCODE -ne 0) { Fail "openrgb-stub build failed" }
} finally {
  Pop-Location
}

$StubExe = Join-Path $CargoTarget "x86_64-pc-windows-msvc\$profile\openrgb-stub.exe"
if (-not (Test-Path $StubExe)) {
  $StubExe = Join-Path $CargoTarget "$profile\openrgb-stub.exe"
}
if (-not (Test-Path $StubExe)) {
  # host build path
  $alt = Get-ChildItem -Path $CargoTarget -Recurse -Filter "openrgb-stub.exe" | Select-Object -First 1
  if ($alt) { $StubExe = $alt.FullName } else { Fail "openrgb-stub.exe not found under $CargoTarget" }
}

$SmokeDir = Join-Path $LocalBuild "smoke"
New-Item -ItemType Directory -Force -Path $SmokeDir | Out-Null
$SmokeLog = Join-Path $SmokeDir "stub.log"
$SmokeErr = Join-Path $SmokeDir "stub.err.log"
$SmokeExe = Join-Path $SmokeDir "smoke.exe"
$SmokeC = Join-Path $PlayerCore "crates\ffi\tests\c\smoke.c"
$Include = Join-Path $PlayerCore "include"

Remove-Item $SmokeLog, $SmokeErr -ErrorAction SilentlyContinue
# Start-Process refuses the same file for stdout and stderr; the port line is
# looked for in both.
$stubProc = Start-Process -FilePath $StubExe -ArgumentList @("--port", "0", "--preset", "per-key", "--protocol", "3") `
  -RedirectStandardOutput $SmokeLog -RedirectStandardError $SmokeErr -PassThru -NoNewWindow

$port = $null
for ($i = 0; $i -lt 200; $i++) {
  Start-Sleep -Milliseconds 50
  if ((Test-Path $SmokeLog) -or (Test-Path $SmokeErr)) {
    $content = "$(Get-Content $SmokeLog -Raw -ErrorAction SilentlyContinue)$(Get-Content $SmokeErr -Raw -ErrorAction SilentlyContinue)"
    if ($content -match "127\.0\.0\.1:(\d+)") {
      $port = $Matches[1]
      break
    }
  }
}
if (-not $port) {
  Stop-Process -Id $stubProc.Id -Force -ErrorAction SilentlyContinue
  Fail "openrgb-stub did not print a port. Log:`n$(Get-Content $SmokeLog -Raw -ErrorAction SilentlyContinue)$(Get-Content $SmokeErr -Raw -ErrorAction SilentlyContinue)"
}
Write-Host "  stub on 127.0.0.1:$port"

# Compile smoke.c against the import lib + dll
$env:PATH = "$DllDir;$env:PATH"
& cl.exe /nologo /W3 /O2 /Fe:$SmokeExe $SmokeC /I$Include /link /LIBPATH:$DllDir rgbprompt_player.dll.lib
if ($LASTEXITCODE -ne 0) {
  Stop-Process -Id $stubProc.Id -Force -ErrorAction SilentlyContinue
  Fail "cl.exe failed to build smoke.c"
}

try {
  & $SmokeExe $Lep $port
  if ($LASTEXITCODE -ne 0) { Fail "C smoke failed (exit $LASTEXITCODE)" }
  Write-Host "  smoke ok"
} finally {
  Stop-Process -Id $stubProc.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 200
}

# ---------- WinUI shell ----------
$ExePath = $null
$ShellDir = Join-Path $RepoRoot "apps\player-win"
$Sln = Join-Path $ShellDir "RGBPrompt.Player.sln"
if (-not $SkipShell -and (Test-Path $Sln)) {
  Write-Step "dotnet restore + build (WinUI shell)"
  # Run from apps/player-win so its global.json picks the SDK.
  Push-Location $ShellDir
  $Artifacts = Join-Path $DotnetOut "artifacts"
  New-Item -ItemType Directory -Force -Path $Artifacts | Out-Null

  # Point the app at the freshly built DLL by copying beside the output later.
  & dotnet restore $Sln --artifacts-path $Artifacts
  if ($LASTEXITCODE -ne 0) { Fail "dotnet restore failed" }

  & dotnet build $Sln -c $Configuration --artifacts-path $Artifacts -p:Platform=x64 `
    -p:RgbpromptPlayerDllDir="$DllDir"
  if ($LASTEXITCODE -ne 0) { Fail "dotnet build failed" }

  Write-Step "dotnet test (Core unit tests)"
  & dotnet test $Sln -c $Configuration --artifacts-path $Artifacts --no-build -p:Platform=x64
  if ($LASTEXITCODE -ne 0) { Fail "dotnet test failed" }

  $ExePath = Get-ChildItem -Path $Artifacts -Recurse -Filter "RGBPrompt.Player.exe" |
    Where-Object { $_.FullName -match "\\$Configuration\\" -or $_.FullName -match "\\bin\\" } |
    Select-Object -First 1 -ExpandProperty FullName
  if (-not $ExePath) {
    $ExePath = Get-ChildItem -Path $Artifacts -Recurse -Filter "RGBPrompt.Player.exe" |
      Select-Object -First 1 -ExpandProperty FullName
  }
  if ($ExePath) {
    # Ensure the native DLL sits next to the exe for LibraryImport
    Copy-Item -Force $Dll (Join-Path (Split-Path $ExePath) "rgbprompt_player.dll")
    Write-Host "  EXE: $ExePath"
  } else {
    Write-Host "  Warning: RGBPrompt.Player.exe not found under $Artifacts" -ForegroundColor Yellow
  }
  Pop-Location
} else {
  Write-Host "Skipping WinUI shell (SkipShell=$SkipShell, sln exists=$(Test-Path $Sln))"
}

# ---------- summary ----------
Write-Host ""
Write-Host "======== RGBPrompt Windows build summary ========" -ForegroundColor Green
Write-Host "Configuration : $Configuration"
Write-Host "DLL           : $Dll"
if ($ExePath) { Write-Host "EXE           : $ExePath" }
Write-Host "Cargo target  : $CargoTarget"
Write-Host "Dotnet out    : $DotnetOut"
Write-Host "Parity        : golden + limiter (see cargo output above for case counts)"
Write-Host "C smoke       : ok"
Write-Host "=================================================" -ForegroundColor Green
exit 0
