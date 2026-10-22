# Relay always-on supervisor

Relay now runs like a small background app instead of a terminal process.

## What runs

| Component | Purpose |
|---|---|
| Relay console (`:4317`) | UI, OAuth callbacks, scheduler, local API |
| HTTP MCP (`:4320`) | Token-protected endpoint for Grok Bot |
| Console tunnel | Public HTTPS for OAuth/media |
| MCP tunnel | Public HTTPS for Grok Bot |
| Relay tray app | Desktop presence |
| Supervisor | Checks and restarts all of the above |

## Install / enable

```powershell
.\tools\install-relay-autostart.ps1
```

This creates:

```
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Relay Supervisor.lnk
```

The supervisor starts at login with a hidden window. To start it now:

```powershell
Start-Process pwsh -ArgumentList '-NoProfile','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',"$PWD\tools\relay-supervisor.ps1" -WindowStyle Hidden
```

## Status

```powershell
Get-Content .data\relay-supervisor.json
Get-Content .data\relay-supervisor.log -Tail 30
```

Status fields:

- `console` — `:4317` health
- `httpMcp` — `:4320` health
- `consoleUrl` — public console URL
- `mcpTunnel` — public MCP URL
- `supervisorPid`

## Recovery behaviour

Every 30 seconds the supervisor:

- restarts the console if `/api/health` fails
- restarts the HTTP MCP if `:4320/health` fails
- restarts a missing cloudflared tunnel
- restarts the Relay tray app if it disappeared
- writes status to `.data/relay-supervisor.json`

If the **MCP tunnel** is recreated, its URL changes. Update the Grok Bot connector URL to the new value from `.data/mcp-https.json`.

If the **console tunnel** is recreated, its URL changes and Meta/Threads/Instagram redirect URIs must be updated before OAuth will work again. The supervisor logs this as a warning.

## Stop

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match 'relay-supervisor\.ps1' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

Remove autostart by deleting `Relay Supervisor.lnk` from the Startup folder.

## Notes

- One instance only: a global mutex prevents duplicate supervisors.
- Logs rotate at 2 MB (`.data/relay-supervisor.log.old`).
- The supervisor never deletes tokens or data.
- For a permanent Grok Bot URL, replace the quick tunnel with a named Cloudflare tunnel and update `.data/mcp-https.json`.
