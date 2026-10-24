# Relay vs Metricool vs Buffer — Product Audit

**Audit date:** 22 October 2026  
**Relay version:** 0.1.0 (local, self-hosted)  
**Origin repository:** https://origin.cursor.com/ttrg/relay  
**Benchmarks:** Metricool and Buffer public feature sets and pricing  
**Method:** Relay source/API/tool inventory, live connection tests, official benchmark pages

---

## 1. Executive summary

Relay is **not a Metricool/Buffer replacement today**. It is a focused, local, MCP-native publishing engine with unusually deep automation for five platforms. Metricool and Buffer are mature SaaS suites whose value is the **surrounding workflow**: analytics, unified inbox, approvals, content library, calendar, link-in-bio, ads and team controls.

Relay's strongest position is:

> **The publishing and automation layer for an AI-driven, single-operator social stack** — not the all-in-one social media management suite.

Where Relay wins:

- Local token ownership and encrypted credential storage
- No per-channel subscription
- Native MCP tools for Claude, Grok, Cursor and other agents
- Deep per-platform behaviour (X threads, Threads chains/carousels/replies, TikTok direct/draft, YouTube quota-aware bulk upload, Instagram posts/Reels)
- Zero-LLM batch publishing from JSON content packs
- Fully auditable, hackable TypeScript codebase

Where it loses badly against the benchmark:

- No analytics or reporting
- No unified inbox except Threads comments
- No approvals, roles or multi-user collaboration
- No content calendar, media library or idea bank
- Fewer channels (5 vs ~12)
- No link-in-bio, ads, competitor tracking, hashtag tools, mobile app or browser extension

**Verdict:** keep Relay as the **automation/publishing core** and either (a) build the missing workflow layers, or (b) pair Relay with Metricool/Buffer for analytics, inbox and team workflow.

---

## 2. Relay capability inventory (verified)

### Platforms

| Platform | Posting | Scheduling | Media | Special behaviour |
|---|---|---|---|---|
| X | ✅ text, media, threads up to 25, quotes | ✅ | images/video | OAuth 2.0, credit-based API |
| Threads | ✅ text, chains up to 20, carousels up to 20 | ✅ | URL-based | read comments, explicit replies, auto-reply feature |
| TikTok | ✅ video, photo carousels, direct/draft | ✅ | video direct / photos by URL | unaudited apps restricted to private/draft |
| YouTube | ✅ one video per post | ✅ | direct upload | quota-aware bulk mode, privacy/title/tags/category |
| Instagram | ✅ one image or Reel | ✅ | URL-based | Business/Creator account required |

### Core features

- **Compose** one draft for multiple platforms with per-platform options
- **Validate** before publishing: text limits, parts, media, platform rules
- **Publish now** or **schedule** with ISO-8601 `schedule_at`
- **Queue** and **cancel** scheduled jobs
- **History** of published and simulated posts
- **Accounts** connect/disconnect with OAuth, encrypted tokens at rest
- **Settings** for encrypted client credentials
- **Threads comments** read-only, plus explicit one-comment replies
- **Threads auto-reply** feature (currently disabled)
- **MCP server**: 13 tools over stdio, plus token-protected Streamable HTTP for cloud agents
- **Remote MCP**: `--http` mode on port 4320, bearer token in `.data/mcp-http-token`, exposed only through a dedicated HTTPS tunnel
- **Local HTTP API** used by the console, batch scripts and tests
- **Batch CLI**: JSON content pack → validate → publish/schedule, zero LLM tokens
- **YouTube max upload**: upload videos one by one until YouTube quota is exhausted
- **Scheduler lock**: one Relay process owns scheduled publishing

### Limits enforced

| Platform | Text | Parts | Media | Image | Video |
|---|---|---|---|---|---|
| X | 280 | 25 | 4 images or 1 video | 5 MB | 512 MB |
| Threads | 500 | 20 | 20 carousel | 8 MB | 500 MB |
| TikTok | 2,200 | 1 | 35 photos / 1 video | 20 MB | 4 GB |
| YouTube | 5,000 | 1 | 1 video | — | 256 MB |
| Instagram | 2,200 | 1 | 1 image or Reel | 8 MB JPEG | 1 GB |

### What Relay does **not** have

- Analytics dashboards, post metrics, audience growth, reports/PDF export
- Unified inbox for Instagram/X/TikTok/YouTube (only Threads comments)
- Team accounts, roles, approval workflows, audit logs
- Visual content calendar, media library, idea bank
- Link-in-bio / smart links / UTM builder
- Ads management, competitor tracking, hashtag tracking
- Mobile app, browser extension, Canva/Drive/Zapier/Dropbox integrations
- Built-in AI copywriter (AI comes from Claude/Grok/DeepSeek via MCP)
- Public hosted API/webhooks (only localhost API + local MCP)
- Facebook, LinkedIn, Pinterest, Bluesky, Google Business Profile, Mastodon, Substack, Twitch

---

## 3. Benchmark feature matrix

Legend: ✅ full · 🟡 partial / workaround · ❌ none

| Capability | Relay | Metricool | Buffer |
|---|---|---|---|
| Social channels | 5 (X, Threads, TikTok, YouTube, Instagram) | ~12 | ~12 |
| Multi-platform publishing | ✅ | ✅ | ✅ |
| Threads / X chains | ✅ | ✅ | ✅ |
| Scheduling | ✅ queue/API, no calendar UI | ✅ calendar | ✅ calendar |
| Bulk / batch publishing | ✅ JSON + CLI + YouTube quota loop | 🟡 CSV/bulk features | 🟡 CSV/bulk |
| Pre-publish validation | ✅ strong | 🟡 previews/warnings | 🟡 previews |
| Post analytics | ❌ | ✅ deep | ✅ |
| Reports / exports | ❌ | ✅ PDF/Data Studio | 🟡 |
| Unified inbox | 🟡 Threads only | ✅ | ✅ |
| Reply management | 🟡 Threads only | ✅ | ✅ |
| Team members / roles | ❌ single user | ✅ | ✅ Team plan |
| Approval workflows | ❌ | ✅ | ✅ Team plan |
| Content calendar | ❌ | ✅ | ✅ |
| Media library / idea bank | ❌ | ✅ | ✅ |
| AI assistant | 🟡 external agents (MCP) | ✅ built-in | ✅ built-in |
| Link-in-bio / smart links | ❌ | ✅ SmartLinks | ✅ Start Page |
| Ads management | ❌ | ✅ | ❌ |
| Competitor analysis | ❌ | ✅ | ❌ |
| Hashtag tools | ❌ | ✅ tracker | ✅ manager |
| Mobile app | ❌ | ✅ | ✅ |
| Browser extension | ❌ | ✅ | ✅ |
| Public API | 🟡 local only | ✅ | ✅ |
| MCP / agent integration | ✅ native | ✅ Metricool MCP | 🟡 API/Claude integration |
| Self-hosted / local data | ✅ | ❌ | ❌ |
| Per-channel subscription | ❌ free self-host | ✅ paid plans | ✅ paid per channel |

### Pricing snapshot (public pages, verify before buying)

- **Buffer:** Free — 3 channels, 10 scheduled posts per channel, 1 user. Essentials — **$5/channel/month** billed yearly ($60/year), unlimited posts, advanced analytics, community inbox. Team — **$10/channel/month** yearly, unlimited users, approvals and access levels. ([Buffer pricing](https://buffer.com/pricing))
- **Metricool:** Free tier; Starter around **$22/month**; Advanced around **$54/month** (third-party 2026 pricing summary; confirm on Metricool). ([Metricool pricing summary](https://costbench.com/software/social-media-management/metricool/), [official plans](https://metricool.com/premium-vs-free-metricool-plans/))
- **Relay:** no subscription; you pay platform API costs (X credits, TikTok/Meta review, YouTube quota) and your own hosting/time.

---

## 4. Gap analysis

### P0 — blocks credible parity

1. **Analytics and reporting**
   - No post impressions, engagement, follower growth, clicks, or best-time data.
   - No scheduled metric snapshots, charts, PDF/client reports.
   - *Impact:* cannot answer "what worked?" — the core reason teams pay for Metricool/Buffer.

2. **Unified engagement inbox**
   - Only Threads comments are readable. Instagram comments, X mentions/replies, TikTok comments and YouTube comments are absent.
   - *Impact:* cannot run community management from Relay.

3. **Collaboration and approvals**
   - Single user, no roles, no draft review, no audit trail.
   - *Impact:* unusable for agencies/teams; fine for a solo operator.

4. **Calendar and content library**
   - Queue is a list, not a calendar. No media library, idea bank, reusable assets or post templates.
   - *Impact:* planning is manual and file-based.

### P1 — important for daily use

5. **More channels** — LinkedIn, Facebook Pages, Pinterest, Bluesky, Google Business Profile, Mastodon, Substack.
6. **Link-in-bio / smart links / UTM builder.**
7. **Integrated AI assistant** — currently external via Claude/Grok; no built-in copy generation, repurposing or brand voice.
8. **Integrations** — Canva, Google Drive, Dropbox, Zapier, Unsplash; CSV import/export.
9. **Mobile/PWA and browser extension** — quick capture and share.
10. **First comment scheduling, hashtag manager, best-time suggestions.**

### P2 — advanced / agency

11. Ads management (Metricool strength).
12. Competitor analysis and social listening.
13. White-label reports and client workspaces.
14. Public hosted API/webhooks for third-party automation.
15. Audit logs, SSO and granular permissions.
16. Cross-platform previews and asset variants per network.

---

## 5. Where Relay genuinely wins

1. **Data ownership** — tokens are AES-256-GCM encrypted on this laptop; no SaaS holds the keys.
2. **No per-channel tax** — one local service, unlimited connected accounts (subject to platform approvals).
3. **MCP-native** — Claude, Grok, Cursor and custom agents can call the same 13 tools.
4. **Deep per-platform control** — X threads, Threads chains/replies, TikTok draft mode, YouTube quota batching, Instagram Reels.
5. **Zero-LLM batch publishing** — Claude/DeepSeek writes a JSON pack once; cron executes it with no token cost.
6. **Hackable** — TypeScript adapters, local API and tests; you can add a platform or rule in hours, not wait for a vendor roadmap.
7. **Cost profile for a solo operator** — no $22–$54/month subscription; only API usage.

---

## 6. How to use Relay

### A. Console (manual)

1. Open **Relay** from Start Menu (or `tools\RelayApp\Relay.exe`).
2. Console: `http://127.0.0.1:4317`.
3. **Accounts** → connect platforms.
4. **Compose** → select destinations → add text/media → **Validate** → **Publish now** or schedule.
5. **Queue** monitors scheduled jobs; **History** shows published results.

Keep the Relay app/server running for scheduled posts and OAuth callbacks.

### B. Claude Desktop

Relay is already configured as an MCP server in
`%APPDATA%\Claude\claude_desktop_config.json`.

Ask Claude:

```markdown
Call `relay_accounts` and list every connected platform and handle.
```

Then:

```markdown
Validate and publish this draft with Relay:
Platforms: x, threads, instagram
Text: <content>
Media: <absolute path or public URL>
```

Claude must call `relay_validate` first and `relay_post` only if validation passes.

### C. Grok CLI

Relay is configured in `~/.grok/config.toml` as `[mcp_servers.relay]`.

Verify:

```powershell
grok mcp list
grok mcp doctor relay
```

Ask Grok:

```markdown
Use the relay MCP server. Call relay_accounts, then validate and publish:
<draft>
```

### D. Grok Bot (remote HTTPS MCP)

Grok Bot cannot attach a local stdio server. Relay therefore exposes the same
13 tools over a **token-protected Streamable HTTP** endpoint:

```powershell
node apps\mcp\dist\index.js --http --port 4320 --data-dir .data `
  --console-url https://<console-tunnel>
```

The bearer token is generated once at `.data/mcp-http-token`. Publish only the
MCP port through the named Cloudflare tunnel:

```powershell
cloudflared tunnel --config C:\Users\User\.cloudflared\config.yml run relay
```

Grok Bot endpoint: `https://mcp.duitpoket.fun/mcp` with header
`Authorization: Bearer <token>`.

Ask Grok Bot:

```markdown
Add this remote MCP server to my account: name=Relay, transport=streamable HTTP,
URL=https://mcp.duitpoket.fun/mcp, Authorization header: Bearer <token>.
Then call relay_accounts.
```

Security rules for this endpoint:

- Never expose port 4320 without the bearer token.
- Use a tunnel dedicated to 4320 (do not reuse the console tunnel).
- The named tunnel keeps permanent hostnames; restarting it does not change the URL.
- Rotate `.data/mcp-http-token` and update the connector if the token leaks.

### E. Cursor

Relay is added to `~/.cursor/mcp.json`, and the audit rule lives at
`.cursor/rules/relay-audit.mdc`. Restart Cursor, then ask its agent to call
`relay_accounts`.

### F. Batch publishing (no LLM at publish time)

1. Write a content pack JSON (see `content/plans/example-week.json`).
2. Dry run:

```powershell
npm run batch -- content/plans/week.json --dry-run
```

3. Publish/schedule:

```powershell
npm run batch -- content/plans/week.json
```

Each item supports `platforms`, `text`, `thread`, `media`, `options`, `scheduleAt`.

### G. YouTube upload until quota is full

```powershell
npm run youtube-max -- --dir "C:\Users\User\Videos\DuitPoket" --privacy public
```

- Uploads one video per request, in filename order
- Stops automatically on the first `quotaExceeded`
- `--dry-run`, `--limit N`, `--title-prefix "..."` supported
- Quota resets at midnight Pacific

### H. Threads comments and replies

```markdown
Call relay_threads_comments with limit_posts=10.
For any comment that needs a reply, show me the comment and proposed reply first.
Only call relay_threads_reply after I approve.
```

Replies are **never automatic**; the scheduler never calls reply tools.

### I. Scheduling

- Pass a future ISO-8601 `schedule_at` to `relay_post`.
- Keep one Relay process running; it owns the scheduler lock.
- `relay_queue` lists jobs; `relay_cancel` cancels pending ones.

---

## 7. Connection verification (22 Oct 2026)

**Always-on supervisor:** `tools/relay-supervisor.ps1` runs at login, checks the
console, HTTP MCP, both tunnels and the tray app every 30 seconds, restarts
anything that is down, and writes `.data/relay-supervisor.json` plus a rolling
log. Autostart is installed with `tools/install-relay-autostart.ps1`.
See [docs/ALWAYS-ON.md](ALWAYS-ON.md).

| Client | Status | Evidence |
|---|---|---|
| Relay server | ✅ healthy | `/api/health` ok; 5 accounts connected |
| Claude Desktop | ✅ configured | `relay` MCP entry uses `--console-url https://relay.duitpoket.fun`; stdio handshake returned 13 tools; restart Claude to load the new argument |
| Grok CLI | ✅ connected | `~/.grok/config.toml` relay entry uses `https://relay.duitpoket.fun`; `grok mcp doctor relay` → handshake OK, 13 tools |
| Grok Bot app | ✅ updated | Remote HTTPS MCP `https://mcp.duitpoket.fun/mcp`; bearer token; 13 tools; `relay_accounts` returned 5 accounts; console/media both report `https://relay.duitpoket.fun` |
| Cursor | ✅ configured | `~/.cursor/mcp.json` relay entry uses `https://relay.duitpoket.fun`; restart Cursor to load |

If a client shows no Relay tools:

1. Fully quit and reopen the client.
2. Confirm the server is running: `Invoke-RestMethod http://127.0.0.1:4317/api/health`.
3. Run the MCP command manually to see stderr.
4. Check that the client points to `apps\mcp\dist\index.js` with the correct `--data-dir`.

---

## 8. Operational caveats

- **X** — pay-per-use credits required for writes; OAuth app must be attached to a Project.
- **Threads** — Meta app must stay in good standing; a security checkpoint blocks the entire API with `code 200 API access blocked`.
- **TikTok** — unaudited apps can only post privately or as drafts.
- **YouTube** — default quota ≈ 6 uploads/day; video-only.
- **Instagram** — Business/Creator account, public media URL, JPEG images.
- **Tunnel dependency** — Threads/Instagram OAuth and local-media publishing use the stable `relay.duitpoket.fun` named tunnel; the hostname does not change on restart.
- **Remote MCP tunnel** — Grok Bot uses the stable `mcp.duitpoket.fun/mcp` endpoint on the same named Cloudflare tunnel; no URL changes on restart.
- **Meta redirect URIs** — existing Threads/Instagram tokens keep working, but reconnect flows need the Meta app redirect URIs changed from the old quick-tunnel host to `https://relay.duitpoket.fun/auth/callback/<platform>`. The Meta app dashboard was redirecting to the Apps list at cutover time.
- **Single machine** — no cloud redundancy; if the laptop sleeps, scheduled posts wait.
- **Security** — the console binds to localhost, but a public tunnel exposes OAuth callbacks and `/media`; keep tokens encrypted and rotate if leaked.

---

## 9. Recommended roadmap

### If Relay is for personal use
Build only:
1. Analytics snapshot for the 5 platforms (post metrics + follower count) — even a daily JSON + simple chart.
2. Instagram/X/TikTok comment inbox (read + reply) — start with Instagram, since Threads is done.
3. Calendar view over the existing queue.
4. Media library backed by `.data/media`.

### If Relay is for clients/agency
Must add:
1. Multi-user auth, roles and approval workflow.
2. Client workspaces and white-label reports.
3. Hosted API/webhooks and audit logs.
4. LinkedIn/Facebook/Pinterest channels.

### Keep as-is if
You only need **AI-driven publishing + scheduling for one operator** and use Metricool/Buffer for analytics and community management.

---

## 10. Sources

- [Buffer pricing](https://buffer.com/pricing) — plans, channels, limits
- [Buffer Publish](https://buffer.com/publish) — calendar and publishing UI
- [Buffer vs Metricool comparison](https://buffer.com/resources/buffer-vs-metricool/) — category comparison (vendor-authored)
- [Metricool plans](https://metricool.com/premium-vs-free-metricool-plans/)
- [Metricool free vs paid help](https://help.metricool.com/main-differences-between-free-and-paid-plans-bl0v9)
- [Metricool pricing summary (third party)](https://costbench.com/software/social-media-management/metricool/)
- Relay source: `packages/`, `apps/web`, `apps/mcp`, `README.md`, live `/api/limits` and `/api/state`

> Pricing and feature availability change; verify on the vendor site before purchasing. This audit reflects public information as of 22 October 2026.

