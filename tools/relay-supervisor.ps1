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
  if (-not $ConsoleUrl) { $ConsoleUrl = "https://relay.duitpoket.fun" }
}
$env:RELAY_CONSOLE_URL = $ConsoleUrl
$env:RELAY_PUBLIC_MEDIA_BASE_URL = $ConsoleUrl
# Public /media serves ONLY this folder (jpg, jpeg, png, webp, mp4, mov). Bots drop files here.
if (-not $env:RELAY_MEDIA_DIR) { $env:RELAY_MEDIA_DIR = Join-Path $env:USERPROFILE "relay-media" }
New-Item -ItemType Directory -Force -Path $env:RELAY_MEDIA_DIR | Out-Null
$env:THREADS_AUTOREPLY_ENABLED = "false"
Set-Content $consoleUrlFile $ConsoleUrl -Encoding UTF8
$tunnelConfig = Join-Path $env:USERPROFILE ".cloudflared\config.yml"

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

function Start-NamedTunnel {
  $running = @(Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Where-Object { $_.CommandLine -match "run relay" })
  if ($running.Count -gt 0) { return }
  Write-Log "starting named tunnel relay"
  Start-Process -FilePath $cloudflared -ArgumentList @("tunnel", "--config", $tunnelConfig, "run", "relay") `
    -WorkingDirectory $root `
    -RedirectStandardOutput (Join-Path $data "named-tunnel.out.log") `
    -RedirectStandardError (Join-Path $data "named-tunnel.err.log") -WindowStyle Hidden | Out-Null
}

Write-Log "supervisor started (console $ConsoleUrl)"

while ($true) {
  if (-not (Test-Http "http://127.0.0.1:4317/api/health")) { Start-Console; Start-Sleep -Seconds 5 }
  if (-not (Test-Http "http://127.0.0.1:4320/health")) { Start-HttpMcp; Start-Sleep -Seconds 3 }

  Start-NamedTunnel

  # The tray app is optional; keep the supervisor responsive if it fails to start.

  $status = [ordered]@{
    updatedAt = (Get-Date).ToString("o")
    console = Test-Http "http://127.0.0.1:4317/api/health"
    httpMcp = Test-Http "http://127.0.0.1:4320/health"
    consoleUrl = $ConsoleUrl
    mcpUrl = "https://mcp.duitpoket.fun/mcp"
    publicConsole = Test-Http "$ConsoleUrl/api/health"
    publicMcp = Test-Http "https://mcp.duitpoket.fun/health"
    supervisorPid = $PID
  }
  $status | ConvertTo-Json | Set-Content $statusFile -Encoding UTF8

  Start-Sleep -Seconds $IntervalSeconds
}
