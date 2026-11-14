#Requires -Version 5.1
<#
.SYNOPSIS
  Draft Velopack pack for RGBPrompt Player (M6-W5). Does NOT upload or sign.
#>
[CmdletBinding()]
param(
  [string]$Configuration = "Release",
  [string]$Version = "0.6.0"
)

$ErrorActionPreference = "Stop"
$LocalBuild = Join-Path $env:LOCALAPPDATA "rgbprompt-build"
$Artifacts = Join-Path $LocalBuild "dotnet\artifacts"
$PackOut = Join-Path $LocalBuild "pack\$Version"
New-Item -ItemType Directory -Force -Path $PackOut | Out-Null

$exe = Get-ChildItem -Path $Artifacts -Recurse -Filter "RGBPrompt.Player.exe" -ErrorAction SilentlyContinue |
  Select-Object -First 1
if (-not $exe) {
  Write-Error "RGBPrompt.Player.exe not found under $Artifacts. Run tools\win\build.ps1 first."
}

Write-Host "Pack source: $($exe.DirectoryName)"
Write-Host "Pack output: $PackOut"
Write-Host ""
Write-Host "Velopack CLI is not auto-installed here yet."
Write-Host "When ready (M6-W5):"
Write-Host "  dotnet tool install -g vpk"
Write-Host "  vpk pack -u RGBPromptPlayer -v $Version -p `"$($exe.DirectoryName)`" -o `"$PackOut`""
Write-Host ""
Write-Host "Then sign with the EV cert (Q28) via signtool - do not upload from this script."
exit 0
