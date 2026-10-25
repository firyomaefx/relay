#!/usr/bin/env pwsh
# start-mcp-https — run Relay's token-protected HTTP MCP and a dedicated HTTPS tunnel.
#
# Usage:
#   .\tools\start-mcp-https.ps1 -ConsoleUrl https://<console-tunnel>
#
# Output: the public MCP URL and the local bearer-token file.
# Keep this window open; closing it stops the tunnel.

param(
  [int]$Port = 4320,
  [string]$ConsoleUrl = $env:RELAY_CONSOLE_URL
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
if (-not $ConsoleUrl) { $ConsoleUrl = "http://127.0.0.1:4317" }
$env:RELAY_CONSOLE_URL = $ConsoleUrl
$env:RELAY_PUBLIC_MEDIA_BASE_URL = $ConsoleUrl

$healthUrl = "http://127.0.0.1:$Port/health"
$healthy = $false
try { Invoke-RestMethod $healthUrl -TimeoutSec 2 | Out-Null; $healthy = $true } catch { }

if (-not $healthy) {
  $out = Join-Path $root ".data\mcp-http.out.log"
  $err = Join-Path $root ".data\mcp-http.err.log"
  Start-Process -FilePath "C:\Program Files\nodejs\node.exe" `
    -ArgumentList @("apps\mcp\dist\index.js", "--http", "--port", "$Port", "--data-dir", ".data", "--console-url", $ConsoleUrl) `
    -WorkingDirectory $root -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden | Out-Null
  Start-Sleep -Seconds 3
}

$tunnelOut = Join-Path $root "tools\mcp-tunnel.out.log"
$tunnelErr = Join-Path $root "tools\mcp-tunnel.err.log"
Remove-Item $tunnelOut, $tunnelErr -Force -ErrorAction SilentlyContinue
$cloudflared = Join-Path $root "tools\cloudflared.exe"
Start-Process -FilePath $cloudflared `
  -ArgumentList @("tunnel", "--url", "http://127.0.0.1:$Port", "--no-autoupdate") `
  -WorkingDirectory $root -RedirectStandardOutput $tunnelOut -RedirectStandardError $tunnelErr -WindowStyle Hidden | Out-Null

$url = $null
for ($i = 0; $i -lt 20 -and -not $url; $i++) {
  Start-Sleep -Seconds 1
  $text = (Get-Content $tunnelOut -Raw -ErrorAction SilentlyContinue) + (Get-Content $tunnelErr -Raw -ErrorAction SilentlyContinue)
  $match = [regex]::Match($text, 'https://[a-z0-9-]+\.trycloudflare\.com')
  if ($match.Success) { $url = $match.Value }
}
if (-not $url) { throw "Cloudflare tunnel did not return a URL; see tools\mcp-tunnel.err.log" }

$tokenFile = Join-Path $root ".data\mcp-http-token"
$info = @{ url = "$url/mcp"; tokenFile = $tokenFile; startedAt = (Get-Date).ToString("o") }
$info | ConvertTo-Json | Set-Content (Join-Path $root ".data\mcp-https.json") -Encoding UTF8

Write-Host ""
Write-Host "Relay MCP HTTPS endpoint: $url/mcp"
Write-Host "Bearer token file:       $tokenFile"
Write-Host "Grok Bot: add a remote MCP with the URL above and header 'Authorization: Bearer <token>'."
Write-Host "Keep this terminal open; closing it stops the tunnel (the node server may keep running)."
