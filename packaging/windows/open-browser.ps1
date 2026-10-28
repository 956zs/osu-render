# Opens the osu-render web page once /health answers (start.bat runs this in the background).
# -Now opens it immediately. Set OSU_RENDER_NO_BROWSER=1 to skip (CI).
param([switch]$Now, [int]$TimeoutSeconds = 90)

if ($env:OSU_RENDER_NO_BROWSER -eq '1') { exit 0 }
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$port = 3030
$bindHost = ''
$envFile = Join-Path $root '.env'
if (Test-Path -LiteralPath $envFile) {
  foreach ($line in [System.IO.File]::ReadAllLines($envFile)) {
    if ($line -match '^\s*PORT\s*=\s*([0-9]+)\s*$') { $port = [int]$Matches[1] }
    if ($line -match '^\s*HOST\s*=\s*([^\s#]*)') { $bindHost = $Matches[1] }
  }
}
if ($bindHost -in @('', '0.0.0.0', '::', '127.0.0.1', 'localhost')) { $bindHost = '127.0.0.1' }
elseif ($bindHost.Contains(':')) { $bindHost = "[$bindHost]" }
$url = "http://${bindHost}:$port/"

if (-not $Now) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Uri "${url}health" -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -eq 200) { break }
    } catch { }
    Start-Sleep -Milliseconds 700
  }
  if ((Get-Date) -ge $deadline) { exit 1 }
}
Start-Process $url
