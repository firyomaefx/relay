# Relay Cloud — system ready checklist

**Ready** = unattended automation can run in production (sleep-mode pulse, email, Threads autoreply, onboarding, billing webhooks) without daily console visits. **Revenue targets are optional** and not part of this gate.

## Automated gates (run anywhere)

```bash
npm run build
npm run verify:system-ready
```

| Gate | Pass means |
|------|------------|
| `npm run test:sleep-mode` | Repo implements sleep mode, deploy-health, automation unit/e2e coverage |
| `node tools/production-readiness.mjs` | Public URLs up, payments + email configured, **public sleep-mode verify green** |

`verify:system-ready` exits **0** only when both pass — i.e. production is actually on the sleep-mode stack.

## VM deploy (required once)

Follow [operator-handoff.md](./operator-handoff.md) steps 0–6. Merge PR **#65** on `main` for `verify:system-ready` and system-ready docs (no code conflict).

**Copy-paste on the VM (after `relay.env` + cloudflared → 4321 are set):**

```bash
cd /opt/relay && git fetch origin main && git checkout main && git pull origin main
sudo DEPLOY_STRICT_SLEEP_VERIFY=1 DEPLOY_STRICT_PUBLIC_SLEEP_VERIFY=1 -u relay bash /opt/relay/deploy/deploy.sh
cd /opt/relay && npm run go-live:cloud
cd /opt/relay && npm run verify:system-ready   # from laptop OK too, after tunnel is green
```

1. Pull merged `main` (#64 stack; #65 adds docs gate).
2. `RELAY_CLOUD_ENABLED=1`, `RELAY_CLOUD_TENANT_SCHEDULER_MS=60000` in `/etc/relay/relay.env`.
3. **`relay-cloud-mcp`** on **4321**; cloudflared `cloud-mcp.duitpoket.fun` → **4321** (not 4320).
4. `sudo DEPLOY_STRICT_SLEEP_VERIFY=1 DEPLOY_STRICT_PUBLIC_SLEEP_VERIFY=1 -u relay bash /opt/relay/deploy/deploy.sh`
5. On VM: `npm run go-live:cloud` → all checks passed.

## Unattended ops (recommended after green)

| Item | Purpose |
|------|---------|
| `RELAY_OPERATOR_ALERT_EMAIL` + Brevo/Resend | Email when automation or public sleep verify fails |
| GitHub **Production sleep monitor** workflow | Daily public verify; no manual Actions checking |
| `RELAY_WAITLIST_AUTO_APPROVE=1` | Waitlist → invite without admin clicks |
| `/cloud-admin` → Platform deploy | `deploy-health` without SSH |

## Manus AI

Content drafts only — [manus-relay.md](./manus-relay.md). Not required for system ready.

## Optional (business, not deploy)

- `/cloud-admin` revenue card and `RELAY_REVENUE_GOAL_MYR` — tracking only; see [rm4000-cloud-runbook.md](./rm4000-cloud-runbook.md) if you set a sales target later.