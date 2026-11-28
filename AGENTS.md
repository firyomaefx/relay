# Workspace rules

## Jev first, Jev last — mandatory

Every task in this workspace starts and ends with TypeSafe AI Jev.

1. **Start of task:** call one Jev tool to frame the work:
   - `jev_decide` — choose between approaches
   - `jev_find` / `jev_rerank` — choose the right files or notes
   - `jev_classify` / `jev_screen` — triage input
   - `jev_noul` — calibrate a proposition
2. **End of task, before reporting:** verify:
   - `jev_verify` — claims against evidence
   - `jev_gate` — patch + completion claims
   - `jev_review` — patch only
3. If Jev is down or unavailable, say so plainly and continue; never pretend it ran.
4. MCP tools are exposed as `mcp__jev__jev_*`. Shell fallback:
   `C:\Users\User\bin\jev.cmd` (`jev.cmd list`, then `jev.cmd jev_verify @args.json`).
5. This rule applies to small tasks too.

## Relay

Relay is the local social publishing server (X, Threads, TikTok, YouTube, Instagram).
Use Relay MCP tools for posting; do not substitute shell or browser automation.

### Relay Cloud (multi-tenant)

- **Sleep mode:** `RELAY_CLOUD_TENANT_SCHEDULER_MS` on **console** and **`relay-cloud-mcp`**; tenants pulse without an open browser. **System ready** when `npm run verify:system-ready` passes — see `docs/operations/system-ready-checklist.md`. VM gate: `npm run go-live:cloud` (local 4317/4321 then public URLs + cloudflared). Daily **Production sleep monitor** emails on drift when repo secrets are set. Operator checklist: `docs/operations/operator-handoff.md`.
- **Regression:** `npm run test:sleep-mode` (~47 tests); full gate `npm run verify:system-ready`.
- **Operator:** `sleep-mode-deploy.md`, `manus-relay.md` + `manus-daily-prompts.md`; optional revenue tracking in `rm4000-cloud-runbook.md`.
- **Deploy:** sleep-mode stack is on `main` (#61/#64); production still fails until the VM pulls `main`, enables `relay-cloud-mcp` on **4321**, and fixes cloudflared.

## Safety

- Never publish to a real account without explicit content and instruction.
- Ask before destructive actions.

## Cloudflare

When interacting with Cloudflare, use the `cf` CLI unless the project has a Wrangler configuration file.

- `cf` covers the whole Cloudflare API and returns JSON by default: `cf auth login`, `cf whoami`, `cf cli search <term>`, `cf schema`, `cf deploy` / `cf dev` / `cf build`, plus resource commands for DNS, zones, D1, KV and R2.
- Projects with `wrangler.jsonc` / `wrangler.json` / `wrangler.toml` use `wrangler` instead (`npx wrangler dev|deploy`).
- Cloudflare's remote MCP (`https://mcp.cloudflare.com/mcp`) is OAuth-gated and DSH's MCP client has no interactive OAuth flow. The `mcp-cloudflare` row is disabled; enable it only via a static-token header path, never by asking the user to complete a browser OAuth for the MCP client.
- Cloudflare agent skills are installed globally under `~/.agents/skills` (workers, wrangler, cf-cli, durable-objects, turnstile, agents-sdk, …) and load automatically.
