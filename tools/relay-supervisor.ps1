#!/usr/bin/env pwsh
# relay-supervisor — keep Relay, its HTTP MCP endpoint and its tunnels alive.
#
# Runs hidden at login (see install-relay-autostart.ps1). Every interval it:
#   - checks the console, HTTP MCP, tray app and cloudflared tunnels
#   - restarts anything that is down
#   - writes status to .data/relay-supervisor.json and a rolling log
#
# One instance only: a global mutex prevents duplicate supervisors.

param(
  [int]$IntervalSeconds = 30,
  [string]$ConsoleUrl = $env:RELAY_CONSOLE_URL
)

$ErrorActionPreference = "SilentlyContinue"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$data = Join-Path $root ".data"
$logFile = Join-Path $data "relay-supervisor.log"
$statusFile = Join-Path $data "relay-supervisor.json"
$consoleUrlFile = Join-Path $data "relay-console-url.txt"
$node = "C:\Program Files\nodejs\node.exe"
$cloudflared = Join-Path $root "tools\cloudflared.exe"

New-Item -ItemType Directory -Force -Path $data | Out-Null
if (-not $ConsoleUrl) {
  if (Test-Path $consoleUrlFile) { $ConsoleUrl = (Get-Content $consoleUrlFile -Raw).Trim() }
  if (-not $ConsoleUrl) { $ConsoleUrl = "https://cleaners-wives-geometry-column.trycloudflare.com" }
}
$env:RELAY_CONSOLE_URL = $ConsoleUrl
$env:RELAY_PUBLIC_MEDIA_BASE_URL = $ConsoleUrl
$env:THREADS_AUTOREPLY_ENABLED = "false"

$mutex = New-Object System.Threading.Mutex($false, "Global\RelaySupervisor")
if (-not $mutex.WaitOne(0)) { exit 0 }

function Write-Log([string]$message) {
  if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 2MB)) {
    Move-Item $logFile "$logFile.old" -Force
  }
  $line = "$(Get-Date -Format o) $message"
  Add-Content $logFile $line -Encoding UTF8
}

function Test-Http([string]$url) {
  try { Invoke-RestMethod $url -TimeoutSec 3 | Out-Null; return $true } catch { return $false }
}

function Find-Process([string]$pattern) {
  @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match $pattern })
}

function Start-Console {
  Write-Log "starting Relay console"
  Start-Process -FilePath $node -ArgumentList @("apps\web\dist\index.js") -WorkingDirectory $root `
    -RedirectStandardOutput (Join-Path $data "console.out.log") `
    -RedirectStandardError (Join-Path $data "console.err.log") -WindowStyle Hidden | Out-Null
}

function Start-HttpMcp {
  Write-Log "starting Relay HTTP MCP"
  Start-Process -FilePath $node -ArgumentList @(
    "apps\mcp\dist\index.js", "--http", "--port", "4320", "--data-dir", ".data",
    "--console-url", $ConsoleUrl
  ) -WorkingDirectory $root `
    -RedirectStandardOutput (Join-Path $data "mcp-http.out.log") `
    -RedirectStandardError (Join-Path $data "mcp-http.err.log") -WindowStyle Hidden | Out-Null
}

function Start-Tunnel([int]$port, [string]$label) {
  $matches = Find-Process "--url http://127.0.0.1:$port"
  if ($matches.Count -gt 0) { return $null }
  Write-Log "starting $label tunnel on port $port"
  $out = Join-Path $root "tools\$label-tunnel.out.log"
  $err = Join-Path $root "tools\$label-tunnel.err.log"
  Remove-Item $out, $err -Force -ErrorAction SilentlyContinue
  Start-Process -FilePath $cloudflared -ArgumentList @("tunnel", "--url", "http://127.0.0.1:$port", "--no-autoupdate") `
    -WorkingDirectory $root -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden | Out-Null
  $url = $null
  for ($i = 0; $i -lt 20 -and -not $url; $i++) {
    Start-Sleep -Seconds 1
    $text = (Get-Content $out -Raw) + (Get-Content $err -Raw)
    $m = [regex]::Match($text, "https://[a-z0-9-]+\.trycloudflare\.com")
    if ($m.Success) { $url = $m.Value }
  }
  if ($url) {
    Write-Log "$label tunnel URL $url"
    Set-Content (Join-Path $data "tunnel-$port.url") $url -Encoding UTF8
    if ($port -eq 4320) {
      @{ url = "$url/mcp"; tokenFile = (Join-Path $data "mcp-http-token"); startedAt = (Get-Date).ToString("o") } |
        ConvertTo-Json | Set-Content (Join-Path $data "mcp-https.json") -Encoding UTF8
    }
  }
  return $url
}

Write-Log "supervisor started (console $ConsoleUrl)"

while ($true) {
  if (-not (Test-Http "http://127.0.0.1:4317/api/health")) { Start-Console; Start-Sleep -Seconds 5 }
  if (-not (Test-Http "http://127.0.0.1:4320/health")) { Start-HttpMcp; Start-Sleep -Seconds 3 }

  if ((Find-Process "--url http://127.0.0.1:4317").Count -eq 0) {
    $newUrl = Start-Tunnel 4317 "console"
    if ($newUrl) {
      Set-Content $consoleUrlFile $newUrl -Encoding UTF8
      Write-Log "WARNING console tunnel changed to $newUrl — update Meta/Threads/Instagram redirect URIs and restart the console"
    }
  }
  Start-Tunnel 4320 "mcp" | Out-Null

  if (-not (Get-Process Relay -ErrorAction SilentlyContinue)) {
    Write-Log "starting Relay tray"
    Start-Process (Join-Path $root "tools\RelayApp\Relay.exe") -WorkingDirectory $root | Out-Null
  }

  $status = [ordered]@{
    updatedAt = (Get-Date).ToString("o")
    console = Test-Http "http://127.0.0.1:4317/api/health"
    httpMcp = Test-Http "http://127.0.0.1:4320/health"
    consoleUrl = $ConsoleUrl
    mcpTunnel = if (Test-Path (Join-Path $data "tunnel-4320.url")) { (Get-Content (Join-Path $data "tunnel-4320.url") -Raw).Trim() } else { $null }
    supervisorPid = $PID
  }
  $status | ConvertTo-Json | Set-Content $statusFile -Encoding UTF8

  Start-Sleep -Seconds $IntervalSeconds
}
