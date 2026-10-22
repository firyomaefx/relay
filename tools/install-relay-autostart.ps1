#!/usr/bin/env pwsh
# install-relay-autostart — run the Relay supervisor automatically at login.
#
# Creates a shortcut in the current user's Startup folder. No admin required.

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$startup = [Environment]::GetFolderPath("Startup")
$pwsh = Join-Path $PSHOME "pwsh.exe"
$script = Join-Path $root "tools\relay-supervisor.ps1"
$shortcutPath = Join-Path $startup "Relay Supervisor.lnk"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $pwsh
$shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$shortcut.WorkingDirectory = $root
$shortcut.WindowStyle = 7
$shortcut.Description = "Keeps Relay console, HTTP MCP and tunnels running"
$shortcut.Save()

Write-Host "Installed: $shortcutPath"
Write-Host "The supervisor will start at your next login."
Write-Host "Start it now with:"
Write-Host "  & `"$pwsh`" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
