# Deploying Relay to a Google Cloud e2-micro

**PR #61 is on `main` (Nov 2026).** Production still serves a pre-sleep-mode console until you run `deploy/deploy.sh` on the VM (see `docs/operations/operator-handoff.md`). If `/api/health` has **no `cloud` field**, the running binary predates #61.

Free tier: e2-micro, 30 GB standard disk, us-central1 / us-west1 / us-east1. Ubuntu 24.04. Node >= 22.18 (24 LTS recommended).

1. `sudo useradd -r -m -d /opt/relay relay`; install Node 24, git, curl, cloudflared.
2. `sudo -u relay git clone https://origin.cursor.com/git/ttrg/relay.git /opt/relay`  
   Older VMs may still have `ttrg/duitpoket-relay` (PR #1 also merged); pull **`main`** from whichever remote the VM uses before `deploy.sh`.
3. `sudo mkdir -p /etc/relay && sudo cp deploy/.env.example /etc/relay/relay.env && sudo chmod 600 /etc/relay/relay.env`; fill it in.
   Set `RELAY_CONSOLE_URL` and `RELAY_PUBLIC_MEDIA_BASE_URL` to `https://relay.duitpoket.fun` (OAuth callbacks are built from it), `RELAY_HOST=127.0.0.1`, `RELAY_DATA_DIR=/opt/relay/.data`, `RELAY_NO_BROWSER=1`.
4. Copy `.data/` from the laptop (accounts/tokens/queue live in `.data`); `chown -R relay`.
5. `sudo cp deploy/*.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now relay-console relay-mcp relay-cloud-mcp`
   Set cloud and sleep-mode vars in `/etc/relay/relay.env` (see `deploy/.env.example` and [docs/operations/sleep-mode-deploy.md](../docs/operations/sleep-mode-deploy.md)). Copy `deploy/cloudflared-config.yml.example` ingress: console **4317**, owner MCP **4320**, **cloud-mcp.duitpoket.fun → 4321** (`relay-cloud-mcp.service`).
6. Tunnel: copy tunnel credentials JSON to `/etc/cloudflared/`, use `deploy/cloudflared-config.yml.example` as `/etc/cloudflared/config.yml`, `sudo cloudflared service install`. Stop the laptop tunnel first.
7. Updates: `sudo -u relay bash deploy/deploy.sh` (relay user needs sudo for `systemctl restart relay-console relay-mcp relay-cloud-mcp`).

### Sleep mode verify

`DEPLOY_STRICT_SLEEP_VERIFY=1` fails the deploy on **localhost** checks (`verify-sleep-mode-local`) and the on-VM **cloudflared** config probe. Public URL verify runs as a **warning** unless `DEPLOY_STRICT_PUBLIC_SLEEP_VERIFY=1` (use after tunnel points `cloud-mcp` at **4321**). CI **Deploy production** runs public verify in a separate step.

After #61, run `node tools/verify-sleep-mode.mjs` on the VM or rely on CI **Production sleep monitor**.

| Symptom | Fix |
|---------|-----|
| `/api/health` has no `cloud` block | Redeploy console from `main`; set `RELAY_CLOUD_ENABLED=1` |
| `cloud-mcp.duitpoket.fun/health` shows `name: relay-mcp-http` | Tunnel or DNS points at owner MCP (4320), not **relay-cloud-mcp** on **4321** (`deploy/relay-cloud-mcp.service`) |
| `cloud` block but stale `lastTenantPulseAt` | Check `RELAY_CLOUD_TENANT_SCHEDULER_MS`; ensure **both** console and `relay-cloud-mcp` use `/etc/relay/relay.env` |

### One-shot from your laptop (IAP)

```bash
gcloud compute ssh relay-prod --zone=asia-southeast1-b \
  --command='sudo -u relay bash /opt/relay/deploy/deploy.sh'
```

### Auto-deploy on push (optional)

Register a GitHub Actions self-hosted runner on the VM with labels `self-hosted` and `relay-prod`. Pushes to `main` on **`ttrg/relay`** (Origin) then run `.github/workflows/deploy-production.yml`.

MCP: `https://mcp.duitpoket.fun/mcp`, header `Authorization: Bearer $RELAY_MCP_HTTP_TOKEN` (falls back to `.data/mcp-http-token`).
