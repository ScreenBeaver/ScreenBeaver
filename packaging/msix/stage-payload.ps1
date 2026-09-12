# Stage release binaries for Visual Studio / MakeAppx MSIX packaging.
# Run after: npm run desktop:build
# Output: packaging/msix/payload/
# Optional: set SCREENBEAVER_MSIX_VS_PAYLOAD to also stage into an external VS project.

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$release = Join-Path $root "src-tauri\target\release"
$payload = Join-Path $PSScriptRoot "payload"
$assets = Join-Path $PSScriptRoot "Assets"
$vsPayload = $env:SCREENBEAVER_MSIX_VS_PAYLOAD

$exeCandidates = @(
  (Join-Path $release "screen-beaver.exe"),
  (Join-Path $release "screen-weaver.exe")
)
$exe = $exeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) {
  Write-Error "Missing release EXE (screen-beaver.exe / screen-weaver.exe) - run npm run desktop:build first."
}

function Stage-To([string]$dest) {
  if (Test-Path $dest) {
    Remove-Item $dest -Recurse -Force
  }
  New-Item -ItemType Directory -Path $dest | Out-Null
  Copy-Item $exe (Join-Path $dest "ScreenWeaver.exe")

  Get-ChildItem $release -File | Where-Object {
    $_.Extension -eq ".dll" -and (
      $_.Name -like "screen_weaver*" -or
      $_.Name -like "WebView2*" -or
      $_.Name -eq "tauri.dll"
    )
  } | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $dest $_.Name)
  }
}

Stage-To $payload

# Store / package icons (optional; VS packaging project can override)
$iconSrc = Join-Path $root "src-tauri\icons"
if (Test-Path $iconSrc) {
  New-Item -ItemType Directory -Path $assets -Force | Out-Null
  foreach ($name in @("32x32.png", "128x128.png", "icon.ico", "StoreLogo.png")) {
    $src = Join-Path $iconSrc $name
    if (Test-Path $src) { Copy-Item $src (Join-Path $assets $name) -Force }
  }
}

if ($vsPayload -and (Test-Path (Split-Path $vsPayload -Parent))) {
  Stage-To $vsPayload
  Write-Host "Also staged into VS project: $vsPayload"
}

Write-Host "Staged MSIX payload:"
Get-ChildItem $payload | Format-Table Name, Length -AutoSize
Write-Host "Next: package with MakeAppx or your Visual Studio MSIX project (Release | x64)."
