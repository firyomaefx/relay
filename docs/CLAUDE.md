# Connecting Relay to Claude

## Standing rule — Jev first, Jev last (all agents)

Every task in this workspace starts and ends with TypeSafe AI Jev:

1. **Start:** call one Jev tool to frame the task — `jev_decide`, `jev_find`, `jev_classify`, `jev_screen`, or `jev_noul`.
2. **End:** check the result before reporting — `jev_verify` (claims vs evidence), `jev_gate` (patch + completion claims), or `jev_review` (patch only).
3. If Jev is unavailable, say so plainly and continue; do not silently skip it.
4. MCP tools appear as `mcp__jev__jev_*`; the shell fallback is `C:\Users\User\bin\jev.cmd`.

This applies to small tasks too. Do not report a task complete without the Jev check.

Relay speaks the Model Context Protocol over stdio, so both **Claude Desktop** and **Claude Code**
can call it directly. Once connected, Claude can connect your X / Threads / TikTok accounts,
validate drafts, publish or schedule posts, and show queue/history — using your local Relay data
directory and encrypted tokens.

## Prerequisites

1. Build the MCP server once (from the repo root):

   ```powershell
   cd C:\Users\User\Documents\deepseek-harness\default-workspace
   npm run build
   ```

2. Keep the console available when you want **real (live) sign-in**: the OAuth callback is served by
   the console at `http://127.0.0.1:4317`. Open the **Relay** app (Start Menu → *Relay*, or the Desktop Relay icon) before asking Claude to connect an account. Simulated mode works
   without the console.

## Claude Desktop

Config file: `%APPDATA%\Claude\claude_desktop_config.json`.

```json
{
  "mcpServers": {
    "relay": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "C:\\Users\\User\\Documents\\deepseek-harness\\default-workspace\\apps\\mcp\\dist\\index.js",
        "--data-dir",
        "C:\\Users\\User\\Documents\\deepseek-harness\\default-workspace\\.data",
        "--console-url",
        "http://127.0.0.1:4317"
      ]
    }
  }
}
```

Then **fully quit Claude Desktop** (including the tray icon) and reopen it. The tools appear in the
tools/connectors menu. A backup of the config was written next to it as
`claude_desktop_config.json.backup-<timestamp>` before Relay was added.

If Claude Desktop rewrites the file, re-add the entry or restore the backup and add it again.

## Claude Code

```powershell
claude mcp add --scope user relay -- "C:\Program Files\nodejs\node.exe" "C:\Users\User\Documents\deepseek-harness\default-workspace\apps\mcp\dist\index.js" --data-dir "C:\Users\User\Documents\deepseek-harness\default-workspace\.data" --console-url "http://127.0.0.1:4317"
```

Verify:

```powershell
claude mcp list      # relay: ... √ Connected
claude mcp get relay
```

Remove it again with `claude mcp remove relay -s user`.

## Tools Claude gets

| Tool | Use |
| --- | --- |
| `relay_accounts` | Which accounts are connected (live vs simulated) |
| `relay_connect` / `relay_disconnect` | Sign in or remove an account |
| `relay_post` | Publish or schedule text/media/threads, per-platform options |
| `relay_validate` | Check limits and issues without posting |
| `relay_queue` / `relay_cancel` | Manage scheduled jobs |
| `relay_history` | What was published (real or simulated) |
| `relay_threads_comments` | Read-only Threads posts and comments |
| `relay_threads_reply` | Explicitly reply to one Threads comment (never automatic) |
| `relay_limits` | Per-platform limits and requirements |
| `relay_console` | Console URL, data dir, credential state, client config |

Example prompts:

> “Connect my X account and post: Relay is live — posting to X, Threads and TikTok.”

> “Schedule a three-part thread for tomorrow at 9am on X and Threads, then show me the queue.”

> “What are my current post limits and which accounts are still simulated?”

## Live sign-in from Claude

1. Open the Relay app (Start Menu → *Relay*) so the OAuth callback can complete.
2. Ask Claude to connect a platform.
3. `relay_connect` opens the platform’s sign-in page in your browser (live mode).
4. Approve access — the console exchanges the code and stores encrypted tokens in `.data/`.
5. Ask Claude to run `relay_accounts` to confirm the account is now **live**.

## Troubleshooting

**`npm error ENOENT ... C:\Users\User\package.json`**
You ran npm from your home folder. `npm` reads `package.json` from the current directory; `cd` into
the repo or double-click the Relay app.

**Browser says `ERR_CONNECTION_REFUSED` for 127.0.0.1:4317**
The console isn’t running. Open the Relay app (Start Menu → *Relay*) and leave it in the tray. Check with:

```powershell
Invoke-RestMethod http://127.0.0.1:4317/api/health
```

**Claude Desktop doesn’t show Relay**
Build first (`npm run build`), confirm the absolute path to `apps/mcp/dist/index.js`, make sure
`C:\Program Files\nodejs\node.exe` exists, then fully restart Claude. On Windows, Claude Desktop’s
MCP logs are under `%APPDATA%\Claude\logs\`.

**Claude Code shows the server but it fails**
Run `claude mcp get relay`; test the same command manually:

```powershell
& "C:\Program Files\nodejs\node.exe" "C:\Users\User\Documents\deepseek-harness\default-workspace\apps\mcp\dist\index.js" --data-dir "C:\Users\User\Documents\deepseek-harness\default-workspace\.data" --console-url "http://127.0.0.1:4317"
```

The process should print `[relay-mcp] ready …` to stderr and then wait for JSON-RPC on stdin.

**Port 4317 already in use**
Run only one console at a time. Find the owner with
`Get-NetTCPConnection -LocalPort 4317 -State Listen` and stop it, or set `RELAY_PORT` to another
port and update `--console-url` in both Claude configs.

**Live sign-in succeeds but the account stays simulated**
Credentials were not loaded. Add them in the console’s **Settings**, or set `.env` /
`X_CLIENT_ID`, `THREADS_CLIENT_ID`, `TIKTOK_CLIENT_KEY` (plus secrets), rebuild/restart and sign in
again. `relay_console` reports per-platform credential state.

## Security

The MCP server runs with your user permissions and reads `.data/` (encrypted tokens live there).
Only connect MCP servers you trust. The console binds to `127.0.0.1` and has no cloud component.
