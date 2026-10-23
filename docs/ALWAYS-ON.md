# Relay always-on supervisor

Relay now runs like a small background app instead of a terminal process.

## What runs

| Component | Purpose |
|---|---|
| Relay console (`:4317`) | UI, OAuth callbacks, scheduler, local API |
| HTTP MCP (`:4320`) | Token-protected endpoint for Grok Bot |
| Console tunnel | `https://relay.duitpoket.fun` |
| MCP tunnel | `https://mcp.duitpoket.fun` |
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
- `consoleUrl` — `https://relay.duitpoket.fun`
- `mcpUrl` — `https://mcp.duitpoket.fun/mcp`
- `publicConsole` — stable console health
- `publicMcp` — stable MCP health
- `supervisorPid`

## Recovery behaviour

Every 30 seconds the supervisor:

- restarts the console if `/api/health` fails
- restarts the HTTP MCP if `:4320/health` fails
- restarts the named Cloudflare tunnel `relay` if it is missing
- writes status to `.data/relay-supervisor.json`

The public URLs are permanent because the tunnel is a **named Cloudflare tunnel**
(`5a1efe42-9826-4ed5-82b7-13e20295e0ac`) with DNS records in the `duitpoket.fun` zone.
Restarting the tunnel does not change the hostnames.

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
- Tunnel credentials live in `C:\Users\User\.cloudflared`; the `duitpoket.fun` zone is on Cloudflare nameservers.
