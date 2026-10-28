# osu-render first-run setup: asks for the osu! API credentials and writes .env from .env.example.
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\setup.ps1
# -ClientId/-ClientSecret skip the prompts (automation and CI only); -Force overwrites an existing .env.
param(
  [string]$ClientId,
  [string]$ClientSecret,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$example = Join-Path $root '.env.example'
$target = Join-Path $root '.env'
$utf8 = New-Object System.Text.UTF8Encoding $false

function Test-ClientId([string]$value) { return $value -match '^[0-9]{1,12}$' }
# Node's .env parser treats # as a comment and strips quotes, so keep the secret to plain printable characters.
function Test-ClientSecret([string]$value) { return $value -match '^[!$-&(-~]{1,200}$' -and $value -notmatch '[#"''`]' }

if (-not (Test-Path -LiteralPath $example)) {
  Write-Host ".env.example is missing. Extract the whole zip again." -ForegroundColor Red
  exit 1
}
if ((Test-Path -LiteralPath $target) -and -not $Force) {
  $answer = Read-Host ".env already exists. Overwrite it? [y/N]"
  if ($answer -notmatch '^[yY]') { Write-Host "Kept the existing .env."; exit 0 }
}

$interactive = -not $ClientId -and -not $ClientSecret
if ($interactive) {
  Write-Host ""
  Write-Host "osu-render needs an osu! OAuth application (free, takes a minute):" -ForegroundColor Cyan
  Write-Host "  1. Open https://osu.ppy.sh/home/account/edit and scroll to 'OAuth'."
  Write-Host "  2. Click 'New OAuth Application'. Any name works, e.g. osu-render."
  Write-Host "     Callback URL: leave empty (or http://127.0.0.1:3030/ if it is required)."
  Write-Host "  3. Copy the Client ID and Client Secret shown for the new application."
  Write-Host "The secret is stored only in the .env file in this folder. Never share it."
  Write-Host ""
}

while (-not (Test-ClientId $ClientId)) {
  if (-not $interactive) { Write-Host "Client ID must be digits only." -ForegroundColor Red; exit 1 }
  $ClientId = (Read-Host "osu! Client ID (digits)").Trim()
  if (-not (Test-ClientId $ClientId)) { Write-Host "The Client ID is a number, e.g. 12345. Try again." -ForegroundColor Yellow }
}

while (-not (Test-ClientSecret $ClientSecret)) {
  if (-not $interactive) { Write-Host "Client secret is empty or contains spaces, quotes or #." -ForegroundColor Red; exit 1 }
  $secure = Read-Host "osu! Client Secret (input hidden)" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $ClientSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim() }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  if (-not (Test-ClientSecret $ClientSecret)) { Write-Host "The secret looks wrong (empty, or has spaces, quotes or #). Paste it again." -ForegroundColor Yellow }
}

$seen = @{}
$lines = [System.IO.File]::ReadAllText($example, $utf8) -split "`r?`n" | ForEach-Object {
  if ($_ -match '^OSU_CLIENT_ID=') { $seen.id = $true; "OSU_CLIENT_ID=$ClientId" }
  elseif ($_ -match '^OSU_CLIENT_SECRET=') { $seen.secret = $true; "OSU_CLIENT_SECRET=$ClientSecret" }
  else { $_ }
}
if (-not $seen.id) { $lines += "OSU_CLIENT_ID=$ClientId" }
if (-not $seen.secret) { $lines += "OSU_CLIENT_SECRET=$ClientSecret" }
[System.IO.File]::WriteAllText($target, ($lines -join "`n"), $utf8)

Write-Host "Saved settings to .env. Edit it with Notepad to change the port, encoder or other options." -ForegroundColor Green
exit 0
