# Relay Cloud — Tencent to Google Cloud migration plan

**Goal:** move the live Relay console, MCP server and scheduler from Tencent Cloud Singapore to a GCE VM in `asia-southeast1` with minimal downtime and a tested rollback.

**Decision:** use a **GCE VM**, not Cloud Run/GKE. Relay depends on a persistent local JSON store, local media, a long-running scheduler, systemd and optional Chromium. A VM preserves the current architecture. Re-platforming can happen later.

---

## 1. Current state (inventory)

| Item | Current value |
|---|---|
| Provider / region | Tencent Cloud Singapore / `43.156.234.123` |
| OS | Ubuntu 22.04.5 LTS x86_64 |
| CPU / RAM | 2 vCPU / 1.9 GB |
| Disk | 40 GB, 8.9 GB used |
| Node | v24.13.1, npm 11.8.0 |
| App | `/opt/relay` (~71 MB) |
| Data | `/var/lib/relay/.data` (~33 MB) |
| Env | `/etc/relay/relay.env` |
| Services | `relay-console`, `relay-mcp`, `cloudflared` |
| Ports | console `127.0.0.1:4317`, MCP `127.0.0.1:4320` |
| Public edge | Cloudflare Tunnel `5a1efe42-9826-4ed5-82b7-13e20295e0ac` |
| Hostnames | `relay.duitpoket.fun`, `mcp.duitpoket.fun` |
| DNS | Cloudflare proxied, TTL 300 |
| TLS | terminated by Cloudflare |
| TikTok Web worker | local laptop worker; not part of this server migration |
| Backups | none automated currently (a gap) |

**Important:** the TikTok Web bridge remains on the laptop after this migration. Do not move it to GCP until cloud TikTok login is solved.

---

## 2. Target architecture

- **GCE VM:** `relay-prod`, `asia-southeast1-b`, `e2-medium` (2 vCPU / 4 GB), 40–50 GB balanced PD, Ubuntu 22.04 LTS.
- **No public app ports:** console and MCP bind to loopback.
- **Cloudflare Tunnel outbound** to Cloudflare; same hostnames, same tunnel.
- **Firewall:** deny all ingress except IAP SSH from `35.235.240.0/20`; no public 80/443.
- **OS Login + IAP** for SSH; no shared SSH keys.
- **Backups:** daily encrypted data archive to GCS + weekly VM snapshot.
- **Monitoring:** GCP uptime check, Cloud Logging/Ops Agent, budget alerts.

**Why `e2-medium`:** current server uses under 2 GB, but Node build, ffmpeg and occasional browser work need headroom. `e2-small` (2 GB) risks OOM. If the cloud TikTok worker moves here later, move to `e2-standard-2` or `e2-medium` with 8 GB.

---

## 3. Migration phases

### Phase 0 — Freeze and safety (T-48h)
- [ ] Announce maintenance window.
- [ ] Export a full backup of Tencent: data, env, tunnel config, systemd units, version file.
- [ ] Take a Tencent snapshot.
- [ ] Confirm GCP project, billing, region and quota.
- [ ] Confirm who owns Cloudflare DNS/tunnel access.
- [ ] Record current `.relay-version`, service status and test post/read-only endpoints.

### Phase 1 — Provision GCP (T-24h, no traffic)
```bash
gcloud compute instances create relay-prod \
  --zone=asia-southeast1-b \
  --machine-type=e2-medium \
  --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size=50GB \
  --boot-disk-type=pd-balanced \
  --tags=relay-prod \
  --metadata=enable-oslogin=TRUE

gcloud compute firewall-rules create relay-iap-ssh \
  --direction=INGRESS --action=ALLOW --rules=tcp:22 \
  --source-ranges=35.235.240.0/20 --target-tags=relay-prod
```
- [ ] Reserve a static external IP only if SSH fallback is required; otherwise use IAP.
- [ ] Enable OS Login, IAP TCP forwarding and Cloud Monitoring.
- [ ] Set a budget alert.
- [ ] Install Node 24, npm, git, ffmpeg, rsync, cloudflared.
- [ ] Create `relay` system user and directories with the same ownership as Tencent.

### Phase 2 — Stage the application (T-12h)
- [ ] Clone the exact production commit from Cursor Origin.
- [ ] `npm ci`, `npm run build`.
- [ ] Copy `/etc/relay/relay.env` securely (scp, not chat).
- [ ] Create `/etc/systemd/system/relay-console.service` and `relay-mcp.service` with the same `User=relay`, env file and loopback ports.
- [ ] Do **not** start the scheduler against production data yet.
- [ ] Verify build and unit files with `systemd-analyze verify`.

### Phase 3 — Copy data (maintenance window, T-0)
1. Stop writes on Tencent:
```bash
sudo systemctl stop relay-console relay-mcp
```
2. Copy data, env, tunnel config and version:
```bash
sudo tar -C / -czf /tmp/relay-migrate.tgz \
  var/lib/relay/.data etc/relay/relay.env etc/cloudflared \
  opt/relay/.relay-version
```
3. Transfer over SSH/IAP.
4. On GCP:
```bash
sudo tar -C / -xzf /tmp/relay-migrate.tgz
sudo chown -R relay:relay /var/lib/relay /opt/relay
sudo chmod 700 /var/lib/relay/.data
sudo rm -f /var/lib/relay/.data/scheduler.lock
```
5. Confirm file count/checksums for `db.json`, `secret.key`, `credentials.enc.json`, media and MCP token.
6. Start services on GCP:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now relay-console relay-mcp
curl -fsS http://127.0.0.1:4317/health
curl -fsS http://127.0.0.1:4320/health
```
7. Validate through an SSH local port-forward **before** public cutover:
```bash
ssh -L 14317:127.0.0.1:4317 -L 14320:127.0.0.1:4320 <gcp-vm>
curl http://127.0.0.1:14317/
```

### Phase 4 — Tunnel cutover
Preferred: reuse the existing tunnel so hostnames and OAuth redirect URIs do not change.

1. Install cloudflared on GCP and copy `/etc/cloudflared/config.yml` + `<tunnel-id>.json`.
2. Keep old connector stopped.
3. Start new connector:
```bash
sudo systemctl enable --now cloudflared
```
4. Verify:
```bash
curl -I https://relay.duitpoket.fun
curl -I https://mcp.duitpoket.fun/mcp
```
5. Run smoke tests:
   - login with console password
   - `/api/state`
   - MCP `tools/list`
   - history/queue loads
   - media URL from a known post loads
   - create a **mock/simulated** post, not a live customer post

### Phase 5 — Verify before declaring success
- [ ] Both services active and restart-safe.
- [ ] Scheduler owns exactly one lock; no duplicate scheduler.
- [ ] OAuth callback URLs unchanged; test X/Threads/Instagram status endpoints.
- [ ] Existing media and avatars resolve.
- [ ] Data counts match Tencent: posts, queue, accounts, comments, auto-reply state.
- [ ] MCP bearer token still works; 19 tools listed.
- [ ] TikTok Web worker still runs locally and can reach Relay media if needed.
- [ ] Cloudflare tunnel reconnect survives reboot.
- [ ] GCP reboot test passes.
- [ ] Backups run and restore to a scratch directory.

### Phase 6 — Stability and decommission
- [ ] Keep Tencent powered off but intact for 7 days.
- [ ] Monitor GCP errors, latency and memory for 72 hours.
- [ ] After 7 days, snapshot final Tencent state and delete the VM.
- [ ] Remove old tunnel connector only after GCP has been stable for 7 days.
- [ ] Update runbooks and the grant pitch infrastructure section.

---

## 4. Rollback

Rollback trigger: login failure, MCP failure, data mismatch, or scheduler not running after 30 minutes.

1. Stop GCP `cloudflared`, `relay-console`, `relay-mcp`.
2. Start Tencent `cloudflared`, `relay-console`, `relay-mcp`.
3. Confirm DNS/hostnames return the old console.
4. Restore data only if a migration write occurred.

**RTO target:** under 30 minutes. **RPO:** zero for the cutover window if Tencent is stopped before copy.

---

## 5. Security and secrets

- Never paste `relay.env`, tunnel credentials or `secret.key` into chat.
- Copy secrets over SSH; keep permissions `600`.
- Do not expose ports 4317/4320 publicly; Cloudflare Tunnel is the only edge.
- Use IAP + OS Login; disable password SSH.
- Restrict GCP service account to least privilege (logging/monitoring/storage for backups).
- Store a copy of `secret.key` offline; losing it makes encrypted credentials unrecoverable.
- Enable Cloud Audit Logs and GCP budget alerts.

---

## 6. Cost estimate (verify in GCP calculator)

| Item | Approx monthly |
|---|---:|
| `e2-medium` Singapore | USD 25–35 |
| 50 GB balanced PD | USD 5–8 |
| Static IP (if reserved) | USD 3 |
| Egress / Cloudflare | low; Cloudflare free tier |
| GCS backups | USD 1–3 |
| **Total** | **~USD 35–50/month** |

Current Tencent spend should be compared after one billing cycle.

---

## 7. What not to do

- Do not migrate to Cloud Run without redesigning the scheduler, local media and browser worker.
- Do not run both old and new schedulers against the same data.
- Do not change OAuth redirect URIs during the migration.
- Do not move the TikTok laptop worker to GCP until cloud TikTok login is reliable.
- Do not delete Tencent before the rollback window ends.

---

## 8. Execution checklist

- [ ] Backup + snapshot
- [ ] GCP VM + firewall + OS Login
- [ ] Runtime installed
- [ ] App staged and built
- [ ] Env copied
- [ ] Data copied and checksummed
- [ ] Services start
- [ ] Local smoke test
- [ ] Tunnel cutover
- [ ] Public smoke test
- [ ] 72h monitoring
- [ ] 7-day rollback window
- [ ] Decommission Tencent

---

*Prepared for Relay Cloud. Verify all commands against the current Tencent configuration before execution; do not run cutover without a fresh backup.*
