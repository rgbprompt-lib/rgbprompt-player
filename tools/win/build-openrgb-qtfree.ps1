#Requires -Version 5.1
<#
.SYNOPSIS
  Build the Qt-free OpenRGB helper for Windows x64 (MSVC) and stage it as
  OpenRGB-RGBPrompt\OpenRGB.exe, matching the Player manifest layout.

.DESCRIPTION
  Run inside the Windows VM (shared repo or copied worktree). Never uploads,
  signs, commits, or calls pnpm install. All build output stays under
  %LOCALAPPDATA%\rgbprompt-build unless -BuildRoot is supplied.

  The helper reuses the official in-tree Windows dependencies (hidapi-hotplug,
  libusb 1.0.27, mbedtls 3.2.1, PawnIO) so Windows device and hotplug
  capability is not reduced. Qt is not linked or loaded.

.PARAMETER SourceRoot
  Path to the extracted OpenRGB source tree (contains qtfree-windows\).

.PARAMETER BuildRoot
  Output root. Default: $env:LOCALAPPDATA\rgbprompt-build\openrgb-qtfree

.PARAMETER QtFreeProofRoot
  Optional proof root used to copy LICENSE / NOTICE into the staged folder.

.PARAMETER Jobs
  Parallel compile jobs. Default 2.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$SourceRoot,
  [string]$BuildRoot = (Join-Path $env:LOCALAPPDATA "rgbprompt-build\openrgb-qtfree"),
  [string]$QtFreeProofRoot = "",
  [ValidateSet("Debug", "Release")]
  [string]$Configuration = "Release",
  [int]$Jobs = 2,
  [switch]$CopySource,
  [switch]$ConfigureOnly
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Fail([string]$Message) {
  Write-Host "FAIL: $Message" -ForegroundColor Red
  exit 1
}

function Require-File([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { Fail "missing $Path" }
}

$SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
New-Item -ItemType Directory -Force -Path $BuildRoot | Out-Null
# Building directly from a Parallels shared folder is slow and can hit file
# sharing locks. Copy the source to a local Windows build root when asked or
# when the path looks like the Mac share.
if ($CopySource -or $SourceRoot -like "C:\Mac\*") {
  $localSrc = Join-Path $BuildRoot "src\openrgb-f81fd32-evision.1"
  Write-Host "Copying source to local build root: $localSrc"
  if (Test-Path -LiteralPath $localSrc) { Remove-Item -LiteralPath $localSrc -Recurse -Force }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $localSrc) | Out-Null
  Copy-Item -LiteralPath $SourceRoot -Destination $localSrc -Recurse
  $SourceRoot = $localSrc
}
$QtFree = Join-Path $SourceRoot "qtfree-windows"
Require-File (Join-Path $QtFree "CMakeLists.txt")

# ---------- MSVC environment ----------
$osArch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
$hostArch = switch ($osArch) {
  "Arm64" { "arm64" }
  "X86"   { "x86" }
  default { "amd64" }
}

if (-not (Get-Command "cl.exe" -ErrorAction SilentlyContinue)) {
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path -LiteralPath $vswhere)) { Fail "vswhere.exe not found; install VS 2022 C++ tools" }
  $vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if (-not $vsPath) { Fail "Visual Studio with C++ tools not found" }
  $devCmd = Join-Path $vsPath "Common7\Tools\VsDevCmd.bat"
  Require-File $devCmd
  Write-Host "Loading VS environment: $devCmd (-arch=amd64 -host_arch=$hostArch)"
  cmd /c "`"$devCmd`" -arch=amd64 -host_arch=$hostArch >nul && set" | ForEach-Object {
    if ($_ -match "^(.*?)=(.*)$") {
      [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2])
    }
  }
}
if (-not (Get-Command "cl.exe" -ErrorAction SilentlyContinue)) {
  Fail "cl.exe not on PATH after VsDevCmd"
}

$cmake = (Get-Command cmake.exe -ErrorAction SilentlyContinue).Source
if (-not $cmake) {
  $vsCMake = Join-Path $vsPath "Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
  if (Test-Path -LiteralPath $vsCMake) { $cmake = $vsCMake }
}
if (-not $cmake) { Fail "cmake.exe not found" }
$ninja = (Get-Command ninja.exe -ErrorAction SilentlyContinue).Source
if (-not $ninja) {
  $vsNinja = Join-Path $vsPath "Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe"
  if (Test-Path -LiteralPath $vsNinja) { $ninja = $vsNinja }
}
if (-not $ninja) { Fail "ninja.exe not found" }
Write-Host "cmake: $cmake"
Write-Host "ninja: $ninja"

New-Item -ItemType Directory -Force -Path $BuildRoot | Out-Null
$BuildDir = Join-Path $BuildRoot "build"
$Stage = Join-Path $BuildRoot "OpenRGB-RGBPrompt"
$Zip = Join-Path $BuildRoot "OpenRGB-RGBPrompt-windows-x64.zip"

$cfgArgs = @(
  "-S", $QtFree,
  "-B", $BuildDir,
  "-G", "Ninja",
  "-DCMAKE_BUILD_TYPE=$Configuration",
  "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreadedDLL",
  "-DCMAKE_NINJA_FORCE_RESPONSE_FILE=ON",
  "-DCMAKE_MAKE_PROGRAM=$ninja"
)
Write-Host ""
Write-Host "==> cmake configure"
& $cmake @cfgArgs
if ($LASTEXITCODE -ne 0) { Fail "cmake configure failed" }
if ($ConfigureOnly) {
  Write-Host "Configure-only mode; stopping before compile."
  exit 0
}

Write-Host ""
Write-Host "==> cmake build (-j $Jobs)"
& $cmake --build $BuildDir -- -j $Jobs
if ($LASTEXITCODE -ne 0) { Fail "cmake build failed" }

$Exe = Join-Path $BuildDir "OpenRGB.exe"
Require-File $Exe

Write-Host ""
Write-Host "==> staging OpenRGB-RGBPrompt"
if (Test-Path -LiteralPath $Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Stage | Out-Null
Copy-Item -LiteralPath $Exe -Destination (Join-Path $Stage "OpenRGB.exe")

$Runtime = @(
  @{ Src = (Join-Path $SourceRoot "dependencies\libusb-1.0.27\VS2019\MS64\dll\libusb-1.0.dll"); Name = "libusb-1.0.dll" },
  @{ Src = (Join-Path $SourceRoot "dependencies\hidapi-hotplug-win\x64\hidapi-hotplug.dll"); Name = "hidapi-hotplug.dll" },
  @{ Src = (Join-Path $SourceRoot "dependencies\PawnIO\PawnIOLib.dll"); Name = "PawnIOLib.dll" }
)
foreach ($item in $Runtime) {
  Require-File $item.Src
  Copy-Item -LiteralPath $item.Src -Destination (Join-Path $Stage $item.Name)
}
Get-ChildItem -LiteralPath (Join-Path $SourceRoot "dependencies\PawnIO\modules") -Filter "*.bin" |
  Copy-Item -Destination $Stage

# VC runtime DLLs keep the helper self-contained (no VC redist installer).
if ($env:VCToolsRedistDir) {
  $crt = Get-ChildItem -Path (Join-Path $env:VCToolsRedistDir "x64\Microsoft.VC*.CRT") -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1
  if ($crt) {
    foreach ($dll in @("msvcp140.dll", "msvcp140_codecvt_ids.dll", "vcruntime140.dll", "vcruntime140_1.dll", "concrt140.dll")) {
      $src = Join-Path $crt.FullName $dll
      if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination $Stage }
    }
  }
}

if ($QtFreeProofRoot -ne "") {
  foreach ($name in @("LICENSE", "NOTICE")) {
    $src = Join-Path $QtFreeProofRoot $name
    if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination $Stage }
  }
}

Write-Host ""
Write-Host "==> hashes"
Get-ChildItem -LiteralPath $Stage -File | Sort-Object Name | ForEach-Object {
  $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLower()
  "{0}  {1}" -f $hash, $_.Name
} | Tee-Object -FilePath (Join-Path $BuildRoot "SHA256SUMS.txt")

Write-Host ""
Write-Host "==> zip"
if (Test-Path -LiteralPath $Zip) { Remove-Item -LiteralPath $Zip -Force }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::Open($Zip, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($file in (Get-ChildItem -LiteralPath $Stage -File | Sort-Object Name)) {
    $entryName = "OpenRGB-RGBPrompt/" + $file.Name
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $archive, $file.FullName, $entryName,
      [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally {
  $archive.Dispose()
}

Write-Host ""
Write-Host "OpenRGB Qt-free build complete"
Write-Host "  exe:  $(Join-Path $Stage 'OpenRGB.exe')"
Write-Host "  zip:  $Zip"
Write-Host "  size: $([math]::Round((Get-Item $Zip).Length / 1MB, 2)) MB"
