#Requires -Version 5.1
<#
.SYNOPSIS
  Build a per-user Inno Setup installer for RGBPrompt Player (M6-W5 alternative
  to the Velopack stub). Does NOT sign or upload, and does not wire an updater.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$SourceTree,
  [Parameter(Mandatory = $true)]
  [string]$OutputDir,
  [string]$IssPath = "",
  [string]$OutputBase = "RGBPrompt-Player-0.6.1-10-win-x64-setup"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Fail([string]$Message) {
  Write-Host "FAIL: $Message" -ForegroundColor Red
  exit 1
}

if (-not $IssPath) {
  $IssPath = Join-Path $PSScriptRoot "setup.iss"
}
if (-not (Test-Path -LiteralPath $IssPath)) { Fail "missing $IssPath" }
$SourceTree = (Resolve-Path -LiteralPath $SourceTree).Path
$exe = Join-Path $SourceTree "RGBPrompt.Player.exe"
if (-not (Test-Path -LiteralPath $exe)) { Fail "missing $exe" }
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$OutputDir = (Resolve-Path -LiteralPath $OutputDir).Path

$iscc = $null
foreach ($candidate in @(
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles}\Inno Setup 6\ISCC.exe",
    "${env:LOCALAPPDATA}\Programs\Inno Setup 6\ISCC.exe",
    (Get-Command iscc -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
  )) {
  if ($candidate -and (Test-Path -LiteralPath $candidate)) { $iscc = $candidate; break }
}
if (-not $iscc) { Fail "ISCC.exe not found. Install Inno Setup 6 (winget install JRSoftware.InnoSetup)." }

Write-Host "ISCC: $iscc"
Write-Host "SourceTree: $SourceTree"
Write-Host "OutputDir: $OutputDir"

$issArgs = @(
  "/DSourceTree=$SourceTree",
  "/DOutputDir=$OutputDir",
  "/DOutputBase=$OutputBase",
  $IssPath
)
& $iscc @issArgs
if ($LASTEXITCODE -ne 0) { Fail "ISCC failed: $LASTEXITCODE" }

$setup = Join-Path $OutputDir ($OutputBase + ".exe")
if (-not (Test-Path -LiteralPath $setup)) { Fail "ISCC did not produce $setup" }
Write-Host ("SETUP_OK {0} bytes={1}" -f $setup, (Get-Item -LiteralPath $setup).Length)
