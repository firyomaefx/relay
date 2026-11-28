# Relay Cloud sleep mode — deploy checklist

Use after merging the automation branch to `main` and rolling the console + cloud MCP services.

On the production VM, enable **`relay-cloud-mcp.service`** (`deploy/relay-cloud-mcp.service`) alongside `relay-console` and owner `relay-mcp`. Both console and cloud MCP must run with the same `/etc/relay/relay.env` sleep-mode variables.

`GET $RELAY_CLOUD_PUBLIC_URL/health` must return **`"name": "relay-cloud-mcp"`** with a `cloud` object. If you see **`relay-mcp-http`**, the public URL is wired to the owner MCP process, not `cloud-entry.js` — tenant sleep-mode pulse and finance reconciliation will not run.

## Required env (production)

| Variable | Purpose |
|----------|---------|
| `RELAY_CLOUD_ENABLED=1` | Cloud tenants + admin |
| `RELAY_CLOUD_TENANT_SCHEDULER_MS=60000` | Customer schedulers without open console |
| `RELAY_PUBLIC_URL` or `RELAY_PUBLIC_BASE_URL` | Brevo inbound webhook registration |
| `RELAY_EMAIL_PROVIDER` + API key | Platform email (invites, receipts, alerts) |
| `RELAY_STRIPE_*` or live Polar | Customer top-ups |
| `RELAY_OPERATOR_ALERT_EMAIL` | Daily digest when automation-health fails |
| `RELAY_OPERATOR_NOTIFY_LEADER` | `cloud-mcp` to send operator digests from cloud MCP only (default `both`) |

## Recommended

| Variable | Purpose |
|----------|---------|
| `RELAY_WAITLIST_AUTO_APPROVE=1` | Auto-invite founding waitlist (under limit) |
| `RELAY_REVENUE_GOAL_MYR=4000` | Admin revenue card target |
| `RELAY_LOW_BALANCE_MILLI_USD=1000` | Customer low-balance nudge ($1) |
| `DEPLOY_STRICT_SLEEP_VERIFY=1` | Fail deploy if `verify-sleep-mode` fails (after first green deploy) |

## Verify (once)

```bash
npm run build
npm run test:sleep-mode
sudo npm run check:cloudflared-sleep   # on VM; uses /etc/cloudflared/config.yml
node tools/production-readiness.mjs
node tools/verify-sleep-mode.mjs

See also [rm4000-cloud-runbook.md](./rm4000-cloud-runbook.md) for the revenue goal and operator email loop.
curl -s "$RELAY_PUBLIC_URL/api/health" | jq '.cloud'
```

1. `/cloud-admin` → **Revenue goal** and **Automation health** load.
2. Customer completes `/setup` → welcome email + Email tab starter promo.
3. Connect Brevo → inbound webhook registers (Automation health shows webhook ok).
4. Optional: submit waitlist with auto-approve → setup email without admin click.

RM4,000 by 31 Dec 2026 is **sales**, not deploy: track on the revenue card after real top-ups.