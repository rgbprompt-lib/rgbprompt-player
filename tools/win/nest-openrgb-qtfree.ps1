#Requires -Version 5.1
<#
.SYNOPSIS
  Nest the Qt-free OpenRGB helper next to a built Windows Player.

.DESCRIPTION
  Copies OpenRGB-RGBPrompt\ (OpenRGB.exe plus its DLLs/modules) next to
  RGBPrompt.Player.exe so Player-core's bundled-helper lookup finds it and
  does not download a separate helper zip. Does not edit the manifest, does
  not upload, and does not change the Player UI.

.PARAMETER HelperDir
  Folder containing OpenRGB.exe (default:
  %LOCALAPPDATA%\rgbprompt-build\openrgb-qtfree\OpenRGB-RGBPrompt).

.PARAMETER PlayerExe
  Path to RGBPrompt.Player.exe. When omitted, the script searches
  %LOCALAPPDATA%\rgbprompt-build\dotnet\artifacts.
#>
[CmdletBinding()]
param(
  [string]$HelperDir = (Join-Path $env:LOCALAPPDATA "rgbprompt-build\openrgb-qtfree\OpenRGB-RGBPrompt"),
  [string]$PlayerExe = ""
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath (Join-Path $HelperDir "OpenRGB.exe"))) {
  Write-Error "missing helper: $HelperDir\OpenRGB.exe"
}

if ($PlayerExe -eq "") {
  $root = Join-Path $env:LOCALAPPDATA "rgbprompt-build\dotnet\artifacts"
  $found = Get-ChildItem -Path $root -Recurse -Filter "RGBPrompt.Player.exe" -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $found) {
    Write-Error "RGBPrompt.Player.exe not found under $root; run tools\win\build.ps1 first or pass -PlayerExe"
  }
  $PlayerExe = $found.FullName
}
if (-not (Test-Path -LiteralPath $PlayerExe)) {
  Write-Error "missing Player exe: $PlayerExe"
}

$playerDir = Split-Path -Parent (Resolve-Path -LiteralPath $PlayerExe).Path
$target = Join-Path $playerDir "OpenRGB-RGBPrompt"
if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
Copy-Item -LiteralPath $HelperDir -Destination $target -Recurse

Write-Host "Nested Qt-free OpenRGB helper:"
Write-Host "  player: $playerDir"
Write-Host "  helper: $target"
Get-ChildItem -LiteralPath $target -File | Sort-Object Name | ForEach-Object {
  $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLower()
  "  {0}  {1}" -f $hash, $_.Name
}
