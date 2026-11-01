@echo off
REM ---------------------------------------------------------------------------
REM Relay console launcher (Windows).
REM
REM Double-click this file, or run it from any directory. It always switches to
REM the repository root first, so npm never looks for package.json in the wrong
REM folder (the "ENOENT: C:\Users\<you>\package.json" error).
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

REM Keep the built-in Threads auto-reply permanently off.
set "THREADS_AUTOREPLY_ENABLED=false"

where node >nul 2>nul
if errorlevel 1 (
  echo [relay] Node.js 22 or newer is required: https://nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [relay] Installing dependencies...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [relay] npm install failed.
    pause
    exit /b 1
  )
)

echo [relay] Building workspaces...
call npm run build
if errorlevel 1 (
  echo [relay] Build failed.
  pause
  exit /b 1
)

echo [relay] Starting the console on http://127.0.0.1:4317
echo [relay] Keep this window open while you use Relay. Press Ctrl+C to stop.
if not defined RELAY_LAUNCH_NO_BROWSER (
  start "" /b powershell -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 240;$i++){try{Invoke-RestMethod 'http://127.0.0.1:4317/api/health' -TimeoutSec 1 | Out-Null; Start-Process 'http://127.0.0.1:4317'; break}catch{Start-Sleep -Milliseconds 500}}"
)

call npm run start -w @relay/web
