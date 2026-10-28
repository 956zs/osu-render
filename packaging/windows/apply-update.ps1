# osu-render update installer. start.bat runs this when osu-render exits with code 75, then starts osu-render again.
# The server has already downloaded, verified and extracted the new version to data\update\staging\<version>\osu-render
# and written data\update\pending.json. This script swaps the app files and keeps everything that belongs to the user:
# .env, data\, config\local.json, and danser's settings, database and skins.
# The previous app files are moved to data\update\backup-<old version>. On any error they are moved back.
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\apply-update.ps1 [-Root <osu-render folder>]
param([string]$Root)

$ErrorActionPreference = 'Stop'
if ($Root) { $root = (Resolve-Path -LiteralPath $Root).Path } else { $root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
$updateDir = Join-Path $root 'data\update'
$pendingFile = Join-Path $updateDir 'pending.json'
$versionPattern = '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'

# App files replaced by every update. Anything else at the top level (.env, data\, user files) is left alone,
# except new top-level items the update ships. VERSION.json goes last: it marks the update as complete.
$managed = @('dist', 'public', 'node_modules', 'runtime', 'scripts', 'docs', 'config\defaults.json', 'start.bat', 'doctor.bat', 'set-webhook.bat',
  'package.json', 'package-lock.json', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', '.env.example')
$neverReplace = @('.env', 'data', 'danser', 'config', 'VERSION.json')
# danser content that belongs to the user; kept when danser itself is replaced.
$danserKeep = @('settings', 'danser.db', 'skins')

function Read-Json([string]$file) {
  return [System.IO.File]::ReadAllText($file, (New-Object System.Text.UTF8Encoding $false)) | ConvertFrom-Json
}

if (-not (Test-Path -LiteralPath $pendingFile)) { Write-Host 'No update is waiting to be installed.'; exit 0 }
New-Item -ItemType Directory -Force -Path $updateDir | Out-Null
try { Start-Transcript -Path (Join-Path $updateDir 'apply-update.log') -Force | Out-Null } catch { }

$journal = New-Object System.Collections.ArrayList
function Move-Tracked([string]$from, [string]$to) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $to) | Out-Null
  # Antivirus scanners and the just-exited node.exe can hold files for a moment, so retry before giving up.
  for ($attempt = 1; ; $attempt++) {
    try { Move-Item -LiteralPath $from -Destination $to; break }
    catch { if ($attempt -ge 5) { throw }; Start-Sleep -Seconds 1 }
  }
  [void]$journal.Add(@($from, $to))
}

function Undo-Moves {
  for ($index = $journal.Count - 1; $index -ge 0; $index--) {
    $from = $journal[$index][0]; $to = $journal[$index][1]
    try {
      if (Test-Path -LiteralPath $from) { Remove-Item -LiteralPath $from -Recurse -Force }
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $from) | Out-Null
      Move-Item -LiteralPath $to -Destination $from
    } catch { Write-Host "Could not restore ${from}: $($_.Exception.Message)" -ForegroundColor Red }
  }
}

$exitCode = 0
try {
  $pending = Read-Json $pendingFile
  $version = [string]$pending.version
  if ($version -notmatch $versionPattern) { throw "pending.json has an invalid version '$version'" }
  $staging = Join-Path $updateDir "staging\$version\osu-render"
  $stagedVersionFile = Join-Path $staging 'VERSION.json'
  if (-not (Test-Path -LiteralPath $stagedVersionFile)) { throw "the staged files for $version are missing" }
  $newInfo = Read-Json $stagedVersionFile
  if ([string]$newInfo.app -ne $version) { throw "staged VERSION.json says '$($newInfo.app)', expected $version" }
  foreach ($required in 'start.bat', 'runtime\node.exe', 'dist\src\main.js') {
    if (-not (Test-Path -LiteralPath (Join-Path $staging $required))) { throw "the staged update is missing $required" }
  }

  $oldInfo = $null
  $currentVersionFile = Join-Path $root 'VERSION.json'
  if (Test-Path -LiteralPath $currentVersionFile) { $oldInfo = Read-Json $currentVersionFile }
  $oldVersion = 'unknown'
  if ($oldInfo -and ([string]$oldInfo.app -match $versionPattern)) { $oldVersion = [string]$oldInfo.app }
  Write-Host "Updating osu-render $oldVersion -> $version"

  # Keep only the newest backup so updates do not slowly fill the disk.
  Get-ChildItem -LiteralPath $updateDir -Directory -Filter 'backup-*' | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
  $backup = Join-Path $updateDir "backup-$oldVersion"

  $stagedDanser = Join-Path $staging 'danser'
  $danser = Join-Path $root 'danser'
  $sameDanser = $oldInfo -and $newInfo.danser -and ([string]$oldInfo.danser -eq [string]$newInfo.danser)
  if ((Test-Path -LiteralPath $stagedDanser) -and -not ($sameDanser -and (Test-Path -LiteralPath $danser))) {
    Write-Host "Replacing danser ($($oldInfo.danser) -> $($newInfo.danser))"
    $oldDanser = Join-Path $backup 'danser'
    if (Test-Path -LiteralPath $danser) { Move-Tracked $danser $oldDanser }
    Move-Tracked $stagedDanser $danser
    if (Test-Path -LiteralPath $oldDanser) {
      foreach ($name in $danserKeep) {
        $kept = Join-Path $oldDanser $name
        if (-not (Test-Path -LiteralPath $kept)) { continue }
        $shipped = Join-Path $danser $name
        if (Test-Path -LiteralPath $shipped) { Move-Tracked $shipped (Join-Path $backup "danser-shipped\$name") }
        Move-Tracked $kept $shipped
      }
    }
  }

  $names = New-Object System.Collections.Generic.List[string]
  foreach ($name in $managed) { if (-not $names.Contains($name)) { $names.Add($name) } }
  foreach ($folder in $root, $staging) {
    foreach ($item in Get-ChildItem -LiteralPath $folder -Force) {
      $isAppFile = $item.Name -like 'README*.md'
      $isNewInUpdate = $folder -eq $staging -and $neverReplace -notcontains $item.Name
      if (($isAppFile -or $isNewInUpdate) -and -not $names.Contains($item.Name)) { $names.Add($item.Name) }
    }
  }
  $stagedConfig = Join-Path $staging 'config'
  if (Test-Path -LiteralPath $stagedConfig) {
    foreach ($item in Get-ChildItem -LiteralPath $stagedConfig -File -Force) {
      $name = "config\$($item.Name)"
      if ($item.Name -ne 'local.json' -and -not $names.Contains($name)) { $names.Add($name) }
    }
  }
  $names.Add('VERSION.json')

  foreach ($name in $names) {
    $current = Join-Path $root $name
    $incoming = Join-Path $staging $name
    if (Test-Path -LiteralPath $current) { Move-Tracked $current (Join-Path $backup $name) }
    if (Test-Path -LiteralPath $incoming) { Move-Tracked $incoming $current }
  }

  Write-Host "osu-render $version is installed. The previous files are in $backup" -ForegroundColor Green
} catch {
  $exitCode = 1
  Write-Host "The update could not be installed: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'Restoring the previous version...'
  Undo-Moves
}

try {
  Remove-Item -LiteralPath $pendingFile -Force -ErrorAction SilentlyContinue
  $stagingRoot = Join-Path $updateDir 'staging'
  if (Test-Path -LiteralPath $stagingRoot) { Remove-Item -LiteralPath $stagingRoot -Recurse -Force }
} catch { Write-Host "Could not clean up data\update: $($_.Exception.Message)" -ForegroundColor Yellow }
try { Stop-Transcript | Out-Null } catch { }
exit $exitCode
