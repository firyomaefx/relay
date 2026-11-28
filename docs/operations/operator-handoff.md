# Operator handoff — Relay Cloud automation (PR #61)

Use this after technical work on branch `cursor/brevo-email-scheduling-67db`. **Goal not complete until production verify passes and RM4,000 is earned from customer top-ups.**

## Repo status (agent-verified)

| Check | Result |
|-------|--------|
| `npm run test:sleep-mode` | 39 tests |
| `npm test` | 302 tests |
| Manus evaluation | `docs/operations/manus-relay.md` |
| PR | [#61](https://cursor.com/codebase/ttrg/relay/pull/61) → `main` — **merge conflicts resolved**; **Bugbot complete (neutral/advisory)**; **CI passing** — merge in Origin UI (agent token cannot merge) |

## Production status (live URLs, re-check anytime)

```bash
npm run verify:sleep-mode
```

Expected failures **until** you deploy:

1. **`/api/health`** — no `cloud` object (old console build or `RELAY_CLOUD_ENABLED` off).
2. **`cloud-mcp.duitpoket.fun/health`** — `name: relay-mcp-http` (tunnel points at owner MCP **4320**, not **cloud-entry** on **4321**).

## Your checklist (cannot be done from a cloud agent)

0. **On the VM:** `cd /opt/relay && git remote -v`. **Two remotes exist:** `ttrg/relay` ([PR #61](https://cursor.com/codebase/ttrg/relay/pull/61)) vs legacy **`ttrg/duitpoket-relay`** ([PR #1 sleep-mode port](https://cursor.com/codebase/ttrg/duitpoket-relay/pull/1) — merge **one** of them on the repo your VM pulls). Optional: `RELAY_DEPLOY_EXPECT_ORIGIN=ttrg/relay` in `/etc/relay/relay.env`. See `deploy/DEPLOY.md`.
1. **Merge PR #61** on **`ttrg/relay`** to `main` (Bugbot review; high-touch billing/webhook paths).
2. **VM deploy:** `sudo DEPLOY_STRICT_SLEEP_VERIFY=1 -u relay bash /opt/relay/deploy/deploy.sh`.
3. **`/etc/cloudflared/config.yml`:** add ingress `cloud-mcp.duitpoket.fun` → `http://127.0.0.1:4321` (see `deploy/cloudflared-config.yml.example`); `sudo systemctl reload cloudflared`.
4. **`sudo systemctl enable --now relay-cloud-mcp`**.
5. **`/etc/relay/relay.env`:** `RELAY_CLOUD_ENABLED=1`, sleep + email + billing vars (`deploy/.env.example`).
6. **Pass gate:** on VM `npm run verify:sleep-mode-local` (127.0.0.1 — catches missing `RELAY_CLOUD_ENABLED` / dead `relay-cloud-mcp` before tunnel checks), then `npm run go-live:cloud` and `node tools/production-readiness.mjs`.
7. **Revenue:** drive waitlist → setup → top-up; monitor `/cloud-admin` and weekly operator email (`RELAY_REVENUE_GOAL_MYR=4000`).

## Manus (≈300 credits/day)

Daily copy/research only — [manus-daily-prompts.md](./manus-daily-prompts.md). Paste outputs into Relay Email library or MCP; do not expect Manus to fix tunnel or deploy.

## When live

- GitHub **Production sleep monitor** (daily) runs `tools/production-sleep-verify.mjs`. Add repo secrets **`RELAY_OPERATOR_ALERT_EMAIL`**, **`RELAY_BREVO_API_KEY`**, **`RELAY_EMAIL_FROM`** so you get email when prod drifts (no need to check Actions daily).
- Monitor fails → redeploy or fix tunnel (`verify:sleep-mode-local` on VM first).
- `RELAY_OPERATOR_NOTIFY_LEADER=cloud-mcp` if operator digests should fire only from cloud MCP pulse.