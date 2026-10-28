# osu-render first-run setup: asks for the osu! API credentials and writes .env from .env.example.
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\setup.ps1
# -ClientId/-ClientSecret skip the prompts (automation and CI only); -Force overwrites an existing .env.
# -WebhookOnly (set-webhook.bat) only sets REPORT_WEBHOOK_URL in an existing .env and keeps every other line.
# -WebhookUrl skips the webhook prompt (automation and CI only).
param(
  [string]$ClientId,
  [string]$ClientSecret,
  [string]$WebhookUrl,
  [switch]$WebhookOnly,
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
# Same rules as src/webhook-url.ts: https, a Discord host, /api[/vN]/webhooks/<digits>/<token>, and nothing else
# (no user info, port, query or fragment).
function Test-WebhookUrl([string]$value) {
  return $value -match '^https://((ptb|canary)\.)?discord(app)?\.com/api(/v[0-9]{1,2})?/webhooks/[0-9]{1,30}/[A-Za-z0-9_-]{1,200}/?$'
}

# Asks for the webhook URL with hidden input (it is a secret) and never prints it. Empty input = skip.
function Read-WebhookUrl([string]$preset, [bool]$prompt) {
  if ($preset) {
    $preset = $preset.Trim()
    if (Test-WebhookUrl $preset) { return $preset }
    Write-Host "The webhook URL is not a Discord webhook URL (https://discord.com/api/webhooks/<numbers>/<token>)." -ForegroundColor Red
    exit 1
  }
  if (-not $prompt) { return '' }
  while ($true) {
    if ([Console]::IsInputRedirected) {
      # Read-Host -AsSecureString reads the console, not redirected input, and would wait forever (piped input, CI).
      $value = [Console]::In.ReadLine()
      if ($null -eq $value) { $value = '' }
      $value = $value.Trim()
    } else {
      $secure = Read-Host "Developer report webhook URL (leave empty to skip, input hidden)" -AsSecureString
      $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
      try { $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim() }
      finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    }
    if ($value -eq '' -or (Test-WebhookUrl $value)) { return $value }
    Write-Host "That is not a Discord webhook URL. It looks like https://discord.com/api/webhooks/<numbers>/<token>. Paste it again, or press Enter to skip." -ForegroundColor Yellow
  }
}

# Replaces (or appends) the KEY=value line, keeping every other line and the file's line ending style.
function Set-EnvLine([string[]]$lines, [string]$key, [string]$value) {
  $found = $false
  $result = foreach ($line in $lines) {
    if ($line -match "^\s*$key\s*=") { if (-not $found) { $found = $true; "$key=$value" } }
    else { $line }
  }
  $result = @($result)
  if (-not $found) {
    while ($result.Count -gt 0 -and $result[-1] -eq '') { $result = @($result | Select-Object -SkipLast 1) }
    $result += "$key=$value"
    $result += ''
  }
  return ,$result
}

if ($WebhookOnly) {
  if (-not (Test-Path -LiteralPath $target)) {
    if (Test-Path -LiteralPath "$target.txt") {
      Write-Host "Found .env.txt: Windows hid the .txt extension. Rename it to .env, then run set-webhook.bat again." -ForegroundColor Red
    } else {
      Write-Host "There is no .env file yet. Run start.bat first to finish the setup, then run set-webhook.bat again." -ForegroundColor Red
    }
    exit 1
  }
  $url = Read-WebhookUrl $WebhookUrl (-not $WebhookUrl)
  if (-not $url) { Write-Host "Nothing entered, so .env was not changed."; exit 0 }
  $bytes = [System.IO.File]::ReadAllBytes($target)
  $text = $utf8.GetString($bytes)
  if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
  $newline = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
  $lines = Set-EnvLine ($text -split "`r?`n") 'REPORT_WEBHOOK_URL' $url
  [System.IO.File]::WriteAllText($target, ($lines -join $newline), $utf8)
  Write-Host "Saved the developer report webhook to .env. Close the osu-render window and run start.bat again to use it." -ForegroundColor Green
  exit 0
}

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

if ($interactive) {
  Write-Host ""
  Write-Host "Optional: if the developer gave you a Discord webhook URL for test reports, paste it now." -ForegroundColor Cyan
  Write-Host "Reports are then sent automatically after every render. You can also set it later with set-webhook.bat."
}
$url = Read-WebhookUrl $WebhookUrl $interactive

$seen = @{}
$lines = [System.IO.File]::ReadAllText($example, $utf8) -split "`r?`n" | ForEach-Object {
  if ($_ -match '^OSU_CLIENT_ID=') { $seen.id = $true; "OSU_CLIENT_ID=$ClientId" }
  elseif ($_ -match '^OSU_CLIENT_SECRET=') { $seen.secret = $true; "OSU_CLIENT_SECRET=$ClientSecret" }
  else { $_ }
}
if (-not $seen.id) { $lines += "OSU_CLIENT_ID=$ClientId" }
if (-not $seen.secret) { $lines += "OSU_CLIENT_SECRET=$ClientSecret" }
if ($url) { $lines = Set-EnvLine $lines 'REPORT_WEBHOOK_URL' $url }
[System.IO.File]::WriteAllText($target, ($lines -join "`n"), $utf8)

Write-Host "Saved settings to .env. Edit it with Notepad to change the port, encoder or other options." -ForegroundColor Green
exit 0
