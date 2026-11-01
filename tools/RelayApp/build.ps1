$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent (Split-Path -Parent $here)
$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$ico = Join-Path $here "relay.ico"
$exe = Join-Path $here "Relay.exe"

if (-not (Test-Path $csc)) { throw "csc.exe not found at $csc" }
if (-not (Test-Path $ico)) { throw "relay.ico not found; run make-icon.py first" }

& $csc /nologo /target:winexe /out:$exe /win32icon:$ico `
    /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll `
    (Join-Path $here "RelayApp.cs")
if ($LASTEXITCODE -ne 0) { throw "Compilation failed with exit code $LASTEXITCODE" }
Write-Host "Built $exe"

$shell = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath("Desktop")
$startMenu = Join-Path ([Environment]::GetFolderPath("Programs")) "Relay"
New-Item -ItemType Directory -Force -Path $startMenu | Out-Null

function New-RelayShortcut([string]$path, [string]$arguments, [string]$description) {
    $shortcut = $shell.CreateShortcut($path)
    $shortcut.TargetPath = $exe
    $shortcut.Arguments = $arguments
    $shortcut.WorkingDirectory = $root
    $shortcut.IconLocation = "$ico,0"
    $shortcut.Description = $description
    $shortcut.Save()
    Write-Host "Shortcut: $path"
}

New-RelayShortcut (Join-Path $desktop "Relay.lnk") "" "Start Relay and open the console"
New-RelayShortcut (Join-Path $startMenu "Relay.lnk") "" "Start Relay and open the console"
New-RelayShortcut (Join-Path $startMenu "Stop Relay.lnk") "--stop" "Stop the Relay local server"

# Old terminal shortcut is superseded by the app.
Remove-Item (Join-Path $desktop "Relay Console.cmd") -Force -ErrorAction SilentlyContinue
Write-Host "Done."
