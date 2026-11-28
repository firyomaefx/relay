# Operator handoff — Relay Cloud automation

**PR #61 merged to `main`** (~3:24 PM MYT on 28 Nov 2026). **Goal not complete until production verify passes and RM4,000 is earned from customer top-ups.**

## Repo status (agent-verified)

| Check | Result |
|-------|--------|
| `npm run test:sleep-mode` | 47 tests (`cursor/cloud-go-live-stack-67db` = #62 + #63 + main + deploy-health) |
| `npm test` | 307 tests on stack branch |
| Manus evaluation | `docs/operations/manus-relay.md` |
| **Shipped** | [#61](https://cursor.com/codebase/ttrg/relay/pull/61) on `main`; merge [#62](https://cursor.com/codebase/ttrg/relay/pull/62) + [#63](https://cursor.com/codebase/ttrg/relay/pull/63) or one **go-live stack** PR before VM pull |

## Production status (live URLs, re-check anytime)

```bash
npm run verify:sleep-mode
```

**Last public check (5:43 PM MYT, 28 Nov 2026):** FAIL (2) — console still has no `cloud` block; `cloud-mcp` returns `relay-mcp-http`.

After deploy, open **`/cloud-admin` → Platform deploy (sleep mode)** or `GET /api/cloud/admin/deploy-health` on the VM for the same probes without SSH.

Expected failures **until** you deploy:

1. **`/api/health`** — no `cloud` object (old console build or `RELAY_CLOUD_ENABLED` off).
2. **`cloud-mcp.duitpoket.fun/health`** — `name: relay-mcp-http` (tunnel points at owner MCP **4320**, not **cloud-entry** on **4321**).

## Your checklist (cannot be done from a cloud agent)

0. **On the VM:** `cd /opt/relay && git remote -v`. **Two remotes exist:** `ttrg/relay` ([PR #61](https://cursor.com/codebase/ttrg/relay/pull/61)) vs legacy **`ttrg/duitpoket-relay`** ([PR #1 sleep-mode port](https://cursor.com/codebase/ttrg/duitpoket-relay/pull/1) — merge **one** of them on the repo your VM pulls). Optional: `RELAY_DEPLOY_EXPECT_ORIGIN=ttrg/relay` in `/etc/relay/relay.env`. See `deploy/DEPLOY.md`.
1. **VM pull `main`:** `cd /opt/relay && git fetch origin main && git checkout main && git pull origin main` (duitpoket-relay **#1** also merged if your remote is that repo).
2. **`/etc/relay/relay.env`:** `RELAY_CLOUD_ENABLED=1`, `RELAY_CLOUD_TENANT_SCHEDULER_MS=60000`, sleep + email + billing vars (`deploy/.env.example`).
3. **Units:** `sudo cp deploy/relay-cloud-mcp.service /etc/systemd/system/` if missing; `sudo systemctl daemon-reload && sudo systemctl enable --now relay-cloud-mcp`.
4. **`/etc/cloudflared/config.yml`:** ingress `cloud-mcp.duitpoket.fun` → `http://127.0.0.1:4321` (see `deploy/cloudflared-config.yml.example`); `sudo systemctl reload cloudflared`.
5. **Deploy build** (picks up #61 console + MCP): `sudo DEPLOY_STRICT_SLEEP_VERIFY=1 -u relay bash /opt/relay/deploy/deploy.sh` after steps 2–4 (public URL verify is warn-only until tunnel is fixed). (public URL is warn-only unless `DEPLOY_STRICT_PUBLIC_SLEEP_VERIFY=1`)
   - When tunnel is fixed: `sudo DEPLOY_STRICT_SLEEP_VERIFY=1 DEPLOY_STRICT_PUBLIC_SLEEP_VERIFY=1 -u relay bash /opt/relay/deploy/deploy.sh` or `npm run go-live:cloud`
6. **Pass gate:** `npm run verify:sleep-mode-local`, then `npm run go-live:cloud` (on the VM this auto-runs local 4317/4321 probes first) and `node tools/production-readiness.mjs`.
7. **Revenue:** drive waitlist → setup → top-up; monitor `/cloud-admin` and weekly operator email (`RELAY_REVENUE_GOAL_MYR=4000`).

## Manus (≈300 credits/day)

Daily copy/research only — [manus-daily-prompts.md](./manus-daily-prompts.md). Paste outputs into Relay Email library or MCP; do not expect Manus to fix tunnel or deploy.

## When live

- GitHub **Production sleep monitor** (daily) runs `tools/production-sleep-verify.mjs`. Add repo secrets **`RELAY_OPERATOR_ALERT_EMAIL`**, **`RELAY_BREVO_API_KEY`**, **`RELAY_EMAIL_FROM`** so you get email when prod drifts (no need to check Actions daily).
- Monitor fails → redeploy or fix tunnel (`verify:sleep-mode-local` on VM first).
- `RELAY_OPERATOR_NOTIFY_LEADER=cloud-mcp` if operator digests should fire only from cloud MCP pulse.