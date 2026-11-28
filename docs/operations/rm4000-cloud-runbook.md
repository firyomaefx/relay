# Relay Cloud revenue runbook (optional RM goal)

**Deploy gate:** use [system-ready-checklist.md](./system-ready-checklist.md) — not revenue.

This doc is for **optional** sales tracking (`RELAY_REVENUE_GOAL_MYR`). Customer payments are outside the repo; the app tracks progress and sends digests.

**Sleep mode live:** `GET https://relay.duitpoket.fun/api/health` includes `cloud.tenantSchedulerPulseMs` and recent `lastTenantPulseAt` after VM deploy.

## Go live (once)

1. Merge PR #61 to `main`.
2. On the VM: `sudo DEPLOY_STRICT_SLEEP_VERIFY=1 -u relay bash /opt/relay/deploy/deploy.sh`.
3. **Cloudflare tunnel:** add `cloud-mcp.duitpoket.fun` → `http://127.0.0.1:4321` to `/etc/cloudflared/config.yml` (see `deploy/cloudflared-config.yml.example`), then `sudo systemctl reload cloudflared`. Run `npm run check:cloudflared-sleep` on the VM.
4. Enable units: `relay-console`, `relay-mcp`, **`relay-cloud-mcp`** (see [sleep-mode-deploy.md](./sleep-mode-deploy.md)).
5. Fill `/etc/relay/relay.env` from `deploy/.env.example` (`RELAY_CLOUD_ENABLED=1`, sleep pulse, Brevo, Stripe/Polar, `RELAY_OPERATOR_ALERT_EMAIL`, `RELAY_WAITLIST_AUTO_APPROVE=1`).
6. Set **`usd_myr_rate`** in cloud prices JSON so weekly operator email and `/cloud-admin` show RM.
7. Verify: `npm run go-live:cloud` (or `verify-sleep-mode` + `check:cloudflared-sleep` on VM) and `node tools/production-readiness.mjs`.
8. Ongoing: GitHub **Production sleep monitor** workflow (daily) runs `verify-sleep-mode` against the public URL; redeploy if it fails.

## Hands-off loops (no daily console)

| Loop | Mechanism |
|------|-----------|
| Queue, Brevo inbound, Threads AR | `RELAY_CLOUD_TENANT_SCHEDULER_MS=60000` on console + cloud MCP |
| Waitlist → customer | `RELAY_WAITLIST_AUTO_APPROVE=1` + pulse backlog processor |
| Post-setup | Welcome email with fresh MCP `/connect?token=...`, email library seed, tenant scheduler |
| Top-up unlock | Stripe/Polar webhooks → auto-enable Threads AR when eligible |
| Low balance / receipts | `billing-notify` on pulse |
| No top-up after 3 days | `RELAY_ONBOARDING_TOPUP_NUDGE` |
| Automation breaks | Daily email to `RELAY_OPERATOR_ALERT_EMAIL` |
| RM goal progress | Weekly revenue digest (same operator email) |

## Manus AI (~300 credits/day)

Use **outside** Relay for research and copy drafts; paste into Relay Email library or `relay_post`. Details: [manus-relay.md](./manus-relay.md).

## Metrics

- Admin: `/cloud-admin` → Revenue goal + Automation health
- API: `GET /api/cloud/admin/revenue-summary`
- Health: `GET /api/health` → `cloud.tenantSchedulerPulseMs` and `publicBaseConfigured`

## When something fails

1. `npm run verify:sleep-mode` — missing `cloud` block means old build or `RELAY_CLOUD_ENABLED` off.
2. Automation health table — per-tenant issues (webhook, scheduler, Threads AR).
3. Operator automation digest — only when `issueCount > 0`.