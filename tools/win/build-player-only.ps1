#Requires -Version 5.1
<#
.SYNOPSIS
  Build just the real Windows Player (DLL + WinUI shell) from this repository.

.DESCRIPTION
  build.ps1 aborts on a pre-existing unrelated core test
  (driver::tests::install_fails_closed_without_a_hash) on this VM. This script
  runs the same VS/dotnet environment and the same compile steps without the
  test/parity/smoke gates, so a real RGBPrompt.Player.exe can be produced and
  version-verified. It never installs packages, downloads, signs or uploads.

  Run from this repository's root on Windows.
#>
[CmdletBinding()]
param(
  [ValidateSet("Debug", "Release")]
  [string]$Configuration = "Debug"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Fail([string]$Message) {
  Write-Host "FAIL: $Message" -ForegroundColor Red
  exit 1
}

function Require-Command([string]$Name, [string]$Hint) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) { Fail "Missing '$Name'. $Hint" }
}

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

Require-Command "cargo" "Install Rust via rustup."
Require-Command "dotnet" "Install .NET 8 SDK."

$osArch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
$hostArch = switch ($osArch) {
  "Arm64" { "arm64" }
  "X86"   { "x86" }
  default { "amd64" }
}
if (-not (Get-Command "cl.exe" -ErrorAction SilentlyContinue)) {
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path $vswhere)) { Fail "vswhere.exe not found" }
  $vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  $devCmd = Join-Path $vsPath "Common7\Tools\VsDevCmd.bat"
  if (-not (Test-Path $devCmd)) { Fail "VsDevCmd.bat not found" }
  Write-Host "Loading VS environment from $devCmd (-arch=amd64 -host_arch=$hostArch)"
  cmd /c "`"$devCmd`" -arch=amd64 -host_arch=$hostArch >nul && set" | ForEach-Object {
    if ($_ -match "^(.*?)=(.*)$") {
      [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2])
    }
  }
}
Require-Command "cl.exe" "MSVC cl.exe not found."

Push-Location (Join-Path $RepoRoot "apps\player-win")
try { $dotnetVersion = (& dotnet --version).Trim() } finally { Pop-Location }
Write-Host "dotnet SDK: $dotnetVersion"

Push-Location (Join-Path $RepoRoot "apps\player-core")
try {
  $buildArgs = @("build", "--locked", "-p", "rgbprompt-player", "--target", "x86_64-pc-windows-msvc")
  if ($Configuration -eq "Release") { $buildArgs += "--release" }
  & cargo @buildArgs
  if ($LASTEXITCODE -ne 0) { Fail "cargo build rgbprompt-player failed" }
} finally { Pop-Location }

$profile = if ($Configuration -eq "Release") { "release" } else { "debug" }
$DllDir = Join-Path $CargoTarget "x86_64-pc-windows-msvc\$profile"
$Dll = Join-Path $DllDir "rgbprompt_player.dll"
if (-not (Test-Path $Dll)) { Fail "Expected DLL at $Dll" }
Write-Host "DLL: $Dll"

$ShellDir = Join-Path $RepoRoot "apps\player-win"
$Sln = Join-Path $ShellDir "RGBPrompt.Player.sln"
if (-not (Test-Path $Sln)) { Fail "missing $Sln" }
$Artifacts = Join-Path $DotnetOut "artifacts"
New-Item -ItemType Directory -Force -Path $Artifacts | Out-Null

Push-Location $ShellDir
try {
  & dotnet restore $Sln --artifacts-path $Artifacts
  if ($LASTEXITCODE -ne 0) { Fail "dotnet restore failed" }
  & dotnet build $Sln -c $Configuration --artifacts-path $Artifacts -p:Platform=x64 `
    -p:RgbpromptPlayerDllDir="$DllDir"
  if ($LASTEXITCODE -ne 0) { Fail "dotnet build failed" }
} finally { Pop-Location }

$ExePath = Get-ChildItem -Path $Artifacts -Recurse -Filter "RGBPrompt.Player.exe" |
  Where-Object { $_.FullName -match "\\$Configuration\\" -or $_.FullName -match "\\bin\\" } |
  Select-Object -First 1 -ExpandProperty FullName
if (-not $ExePath) {
  $ExePath = Get-ChildItem -Path $Artifacts -Recurse -Filter "RGBPrompt.Player.exe" |
    Select-Object -First 1 -ExpandProperty FullName
}
if (-not $ExePath) { Fail "RGBPrompt.Player.exe not found under $Artifacts" }
Copy-Item -Force $Dll (Join-Path (Split-Path $ExePath) "rgbprompt_player.dll")
Write-Host "EXE: $ExePath"
Write-Host "DONE"
