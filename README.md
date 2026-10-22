# Relay

**Self-hosted publishing for X, Threads and TikTok — with an MCP server and a local console.**

Relay is a small, local-first alternative to tools like Metricool, focused on one job: **posting**.
It gives you a browser console for composing and scheduling, plus an MCP server so an AI agent
(Claude, Codex, DeepSeek Harness, …) can sign in accounts and publish across all three networks.

No accounts, no cloud, no database server. State lives in `.data/`, tokens are encrypted at rest,
and everything runs in **simulated mode** until you add developer credentials for a platform —
so you can try the whole product immediately.

![Relay console — compose](docs/console-compose.png)

![Relay console — one-click sign-in](docs/console-accounts.png)

```text
┌──────────────┐   MCP (stdio)   ┌────────────────────────────┐   OAuth + REST   ┌─────────┐
│ MCP client   │ ───────────────▶│  Relay MCP server          │ ───────────────▶ │ X       │
│ (agent)      │                 │  apps/mcp                  │                  ├─────────┤
└──────────────┘                 │            └── core service│ ───────────────▶ │ Threads │
┌──────────────┐   HTTP          │  Relay console             │                  ├─────────┤
│ Browser      │ ───────────────▶│  apps/web                  │ ───────────────▶ │ TikTok  │
└──────────────┘                 └────────────────────────────┘                  └─────────┘
                                        shared encrypted state in .data/
```

## What you get

- **Full posting, not just text** — images, video, multi-part threads/chains, quote posts,
  TikTok photo carousels, per-platform options, character-limit validation before anything is sent.
- **One-click sign-in** — connect X, Threads and TikTok from the console; Relay runs the OAuth
  flow locally and stores the tokens encrypted. The MCP server can start the same flow with `relay_connect`.
- **Scheduling and a queue** — pick a date/time and Relay publishes it. A PID lock guarantees only
  one running Relay process fires scheduled posts, even if the console and MCP server share `.data/`.
- **Simulated mode by default** — no credentials required. Every account is connected and every
  post is simulated (`mode: "mock"`), so the UI, MCP tools and scheduler can be tested end to end.
- **MCP-native** — 10 tools for account management, validation, posting, scheduling, history and limits.
- **Local and private** — binds `127.0.0.1`, optional console password, AES-256-GCM token storage,
  no telemetry.
- **Posting only, by design** — no analytics or inbox. Just the composer, queue and history.

## Requirements

- Node.js **22.18+** (tested on Node 24.13, Windows 11; macOS/Linux should work)
- A browser for the console
- Optional, only for real posts: developer apps for [X](https://developer.x.com),
  [Threads](https://developers.facebook.com) and/or [TikTok](https://developers.tiktok.com)

## Quickstart

**Windows — no terminal needed (recommended):**

1. Open **Start** and type `Relay`, or double-click the **Relay** icon on your Desktop.
2. The Relay window starts the server, opens the console at <http://127.0.0.1:4317> and keeps
   running in the tray.
3. To stop everything: right-click the tray icon → **Exit**, or use **Stop Relay** in the Start
   Menu.

![Relay Windows app](docs/relay-app.png)

`Relay.exe` lives in [`tools/RelayApp/`](tools/RelayApp) and is built from
[`RelayApp.cs`](tools/RelayApp/RelayApp.cs) with [`build.ps1`](tools/RelayApp/build.ps1)
(recompiles the exe and recreates the Desktop + Start Menu shortcuts). The terminal launcher
`start-relay.cmd` still exists as a fallback.

**Any OS, from a terminal — run the commands *inside the repo folder*:**

```bash
cd C:\Users\User\Documents\deepseek-harness\default-workspace   # PowerShell
npm install
npm run start
```

> npm resolves `package.json` from the **current directory**. Running `npm install` from
> `C:\Users\User` fails with `ENOENT ... C:\Users\User\package.json` — that means you are in the
> wrong folder, not that the project is broken. Running the app from the wrong folder also leaves
> nothing listening on port 4317, so the browser shows `ERR_CONNECTION_REFUSED`.

Then open **http://127.0.0.1:4317**.

1. Go to **Accounts** and click **Sign in with X / Threads / TikTok** — in simulated mode the
   account is connected instantly (no OAuth round-trip).
2. Compose a post, pick platforms, optionally attach media or add thread parts.
3. Publish now, or choose a date/time to queue it. Watch it in **Queue** and **History**.

Generated files live in `.data/` (git-ignored):

```text
.data/
├── db.json               # accounts (encrypted secrets), queue, history
├── secret.key            # AES-256-GCM key for tokens and client secrets
├── credentials.enc.json  # client id/secret saved from the console (encrypted)
├── media/                # files uploaded from the composer
└── scheduler.lock        # PID of the process currently publishing scheduled posts
```

`npm run start` builds every workspace and runs the console (which also owns the scheduler).

### Configuration

Copy `.env.example` to `.env`. The apps read these variables automatically:

| Variable | Default | Purpose |
| --- | --- | --- |
| `RELAY_DATA_DIR` | `<repo>/.data` | State directory |
| `RELAY_HOST` / `RELAY_PORT` | `127.0.0.1` / `4317` | Console bind address |
| `RELAY_CONSOLE_URL` | `http://127.0.0.1:4317` | Public console URL used for OAuth callbacks |
| `RELAY_CONSOLE_PASSWORD` | unset | Optional password for the console |
| `RELAY_MOCK` | unset | `1` forces simulated mode for every platform |
| `RELAY_PUBLIC_MEDIA_BASE_URL` | unset | Tunnel URL that serves `.data/media` (needed for live Threads/TikTok photos) |
| `X_CLIENT_ID`, `X_CLIENT_SECRET` | unset | X OAuth 2.0 app |
| `THREADS_CLIENT_ID`, `THREADS_CLIENT_SECRET` | unset | Threads app |
| `THREADS_AUTOREPLY_ENABLED` | `true` | Local Threads auto-reply toggle (also a persisted Settings flag) |
| `DEEPSEEK_API_KEY` | unset | DeepSeek key for auto-reply; without it comments are logged and skipped |
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | unset | TikTok app |

You can also paste the same credentials in **Settings → Platform credentials**; they are saved
encrypted in `.data/credentials.enc.json`. Environment variables win only when a field is not set
in Settings.

### Local Threads auto-reply

When auto-reply is on (default), publishing a Threads post or discovering a new own post from
`/me/threads` opens a persisted 30-minute window. Every ~2 minutes Relay reads that post's
conversation and classifies each new comment. Spam and hostile comments are flagged without a
reply; genuine comments get one short, balanced reply in the commenter's language, written by
DeepSeek (`deepseek-chat`). Comment ids that were replied to or flagged are persisted, so a restart
never replies twice. The hard stop is checked immediately before every post: nothing is posted
after `publishedAt + 30 minutes`, and a missing `threads_read_replies` /
`threads_manage_replies` scope stops the window.

Read the log at `GET /api/threads/autoreply/log` (`{replies, flagged, windows}`) or with the
`relay_threads_autoreply` MCP tool. Toggle the persisted settings flag with
`POST /api/threads/autoreply` and `{"enabled": false}`. If `DEEPSEEK_API_KEY` is missing Relay logs
the skip and posts nothing — there is no fallback reply.

## MCP server

Build once with `npm run build`, then point any MCP client at the stdio server:

```json
{
  "mcpServers": {
    "relay": {
      "command": "node",
      "args": [
        "C:\\path\\to\\relay\\apps\\mcp\\dist\\index.js",
        "--console-url",
        "http://127.0.0.1:4317"
      ]
    }
  }
}
```

Use absolute paths for `args`; add `"--mock"` to force simulation, or set `RELAY_DATA_DIR`,
`RELAY_MOCK=1` and `RELAY_CONSOLE_URL` through the client's `env` block.

| Tool | What it does |
| --- | --- |
| `relay_accounts` | Connected accounts, live/simulated state, next step |
| `relay_connect` | Start sign-in for a platform (instant in simulated mode) |
| `relay_disconnect` | Remove a connected account |
| `relay_post` | Validate + publish or schedule a post (text, media, threads, options) |
| `relay_validate` | Dry run: limits and issues without publishing |
| `relay_queue` | List scheduled jobs and their status |
| `relay_cancel` | Cancel a pending scheduled job |
| `relay_history` | Published/simulated results |
| `relay_threads_comments` | Read-only recent Threads posts and their comments |
| `relay_threads_autoreply` | Read-only log of local auto-replies, flagged comments and windows |
| `relay_threads_reply` | Explicitly reply to one Threads comment (never automatic) |
| `relay_limits` | Per-platform character/media limits and requirements |
| `relay_console` | Console URL, data dir, credential state and client config |

Example prompts:

> "Connect my X account, then post 'Shipping day 🚀' and schedule the same text for Threads at 9am tomorrow."

> "Draft a three-part thread about our new feature, validate it for X and Threads, and publish it everywhere."

> "What can I post where? Show me the limits and which accounts are connected."

**Live sign-in needs the console running**: `relay_connect` returns an OAuth URL whose callback is
served by the console at `RELAY_CONSOLE_URL` (`/auth/callback/<platform>`). When the account is not
in simulated mode, the MCP server also opens that URL in your default browser. Start the console
first (open the **Relay** app), then ask Claude to connect the account.

### Connect to Claude

**Claude Desktop** — add Relay to `%APPDATA%\Claude\claude_desktop_config.json` (this machine is
already configured), then fully quit Claude from the tray and reopen it:

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

**Claude Code** — one command (user scope means it works in every project):

```powershell
claude mcp add --scope user relay -- "C:\Program Files\nodejs\node.exe" `
  "C:\Users\User\Documents\deepseek-harness\default-workspace\apps\mcp\dist\index.js" `
  --data-dir "C:\Users\User\Documents\deepseek-harness\default-workspace\.data" `
  --console-url "http://127.0.0.1:4317"
claude mcp list        # relay should show "Connected"
```

Run `npm run build` once before connecting (the config points at `apps/mcp/dist/index.js`).
Full setup, verification and troubleshooting: [`docs/CLAUDE.md`](docs/CLAUDE.md).

## Going live (real posting)

1. Start the console and click **Settings** (or copy `.env.example` → `.env`).
2. Create a developer app per platform and add the redirect URI shown in Settings.
3. Paste client id + secret into Settings, or set the env vars, then restart Relay.
4. Sign out and sign back in to each platform — the account flips from **Simulated** to **Live**.
5. Media rules for live posts:
   - **X** uploads files directly.
   - **Threads** fetches media from a **public URL**. Point a tunnel (ngrok, cloudflared) at the
     console and set `RELAY_PUBLIC_MEDIA_BASE_URL`, or pass media `url` values.
   - **TikTok** uploads videos directly; photo carousels need public URLs. Apps that have not
     passed TikTok's audit can only post privately — set the post's `tiktokPrivacy`/`selfOnly` option
     to `SELF_ONLY`.

See [`docs/CONNECT-ACCOUNTS.md`](docs/CONNECT-ACCOUNTS.md) for a click-by-click setup guide
(developer portal links, exact redirect URIs and scopes) and [`docs/GOING-LIVE.md`](docs/GOING-LIVE.md)
for provider-specific details and caveats.

## Posting capabilities and limits

| | X | Threads | TikTok |
| --- | --- | --- | --- |
| Text per part | 280 | 500 | 2,200 (caption) |
| Parts per post | 25 (thread) | 20 (chain) | 1 |
| Media per post | 4 images / 1 video | 1 item or a 2–20 item carousel | 35 photos / 1 video |
| Text-only posts | ✅ | ✅ | ❌ (media required) |
| Video upload | direct | public URL | direct |
| Image upload | direct | public URL | public URL (photo mode) |
| Replies / quote | reply chains, quote post | reply chains | — |
| Privacy / reply controls | reply settings | reply controls | `PUBLIC_TO_EVERYONE` / `MUTUAL_FOLLOW_FRIENDS` / `SELF_ONLY` |
| Thread/chain parts | 25 | 20 | — |

Threads parts can carry a single image/video or a carousel of 2–20 images and/or videos (public
URLs required). Attach media per thread part if you want several carousels across a chain.

Validation runs before publishing: over-limit text, too many parts, missing/oversized media,
unsupported types and unreachable files are reported per platform, and nothing is published unless
every target passes (a scheduled job that fails validation is marked `failed` in the queue).

## Architecture

```text
packages/core        Types, validation, encrypted JSON store, scheduler lock, RelayService
packages/platforms   Platform adapters (X, Threads, TikTok), mock mode, createRelay() factory
apps/mcp             MCP stdio server exposing posting tools
apps/web             Local HTTP console + single-page UI
tests/               Unit + end-to-end tests (node:test)
```

Both apps call the same `RelayService`, so the console and the MCP server share accounts, queue and
history. The scheduler lock makes exactly one process responsible for publishing scheduled jobs.

## Development

```bash
npm run build       # compile all workspaces
npm run typecheck   # tsc --noEmit per workspace
npm test            # node --test tests/
npm run smoke       # build + end-to-end posting smoke test
npm run mcp         # build + run the MCP server in a terminal
```

## Security notes

- The console binds to `127.0.0.1` by default. Set `RELAY_CONSOLE_PASSWORD` if you expose it.
- OAuth tokens and saved client secrets are encrypted with AES-256-GCM; the key is
  `.data/secret.key`. Lose that file and tokens must be re-connected. The data directory is
  git-ignored — back it up privately.
- OAuth state and PKCE verifiers are single-use and expire after 15 minutes.
- This is a single-user local tool. Do not run it as a multi-tenant service without adding
  proper auth, rate limiting and per-user data separation.

## Known limitations

- Simulated mode is the default; live posting requires your own developer app credentials.
- Live API calls follow each provider's current documented endpoints. Provider APIs change and
  some endpoints (notably X media upload) are tier- or version-sensitive — check your developer
  portal if a live call fails.
- Threads and TikTok photo posts need publicly reachable media; a local file path alone is not enough.
- No analytics, inbox, or approval workflows (intentionally post-only).
- TikTok public posting requires an audited app; unaudited apps are limited to private posts.

## License

MIT
