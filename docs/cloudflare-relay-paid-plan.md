# Relay Cloud on Cloudflare Workers Paid — optimization plan

Status: 14 Nov 2026  
Scope: relay.duitpoket.fun and the `duitpoket.fun` Cloudflare account

## Where the money goes today

| Item | Current state |
|---|---|
| Workers Paid | $5/month base subscription |
| Relay website | Node app on the GCP VM, exposed through a Cloudflare Tunnel CNAME |
| Relay compute | GCP VM — **not** a Worker |
| Workers in account | `ipo-hunter`, `ipo-hunter-production`, `ipo-hunter-checkout-production`, `tengkolok-img` |
| R2 | Not enabled |
| KV / D1 | None |
| Static assets | Already served with `Cache-Control: public, max-age=31536000, immutable` |
| Media | Stored on the VM and served at `/media/<name>` with `max-age=3600` |
| Zone plan | Workers Paid is an account subscription; it does not include Pro WAF or Cloudflare Images |

The $5 is a base subscription, not a credit. Relay currently gets almost no value from it. This plan changes that without moving the core Node/SQLite app to Workers.

## Goals and guardrails

**Goals**

1. Make Relay faster and more reliable at the edge.
2. Get measurable use from the $5 plan.
3. Keep the monthly bill predictable and close to $5.
4. Avoid a risky Workers/D1 rewrite of Relay.

**Guardrails**

- Do not put the whole site behind Cloudflare Access; it would break OAuth callbacks and public media.
- Do not cache `/api/*`, auth, publish, or admin responses.
- Keep the GCP VM as the source of truth for posts, accounts, scheduler and SQLite.
- Every phase must have a rollback path.

## Baseline captured — 14 Nov 2026

Cloudflare zone analytics for the last 30 days (15 Oct–14 Nov):

| Metric | Value |
|---|---:|
| Requests | 128,743 |
| Edge response bytes | 2,243,748,622 (~2.24 GB) |
| 5xx responses | 298 |
| Top path by bytes | `/api/state` — 1.59 GB across 18,801 requests |
| `/media/*` sample | ~600 MB combined in the top paths |
| `/api/health` + `/health` | ~50 MB across ~60k probes |

The dominant avoidable cost is `/api/state`, not media. The client polls every
20 seconds and received the full 50-post history each time. Phase 2 therefore
includes a light polling mode (`/api/state?light=1`) that omits history.

## Phase 0 — Baseline and guardrails (1–2 days)

1. Record current metrics:
   - origin requests/day, bytes/day, p95 TTFB
   - cache hit ratio for static assets
   - media upload failures and `/media` 404s
   - publish success rate and scheduler lag
   - tunnel disconnect events
2. Enable Cloudflare budget/usage notifications for Workers and R2.
3. Tag resources by project so Relay costs are separable.
4. Add `admin.` and `media.` hostnames to the tunnel plan before changing production.

**Exit:** one page of baseline numbers and alert thresholds.

## Phase 1 — Move media to R2 (highest value, 2–4 days) — implemented 14 Nov 2026

This is the clearest use of the paid account and directly improves Relay.

### Targets

- New uploads go to R2 bucket `relay-media`.
- Public media is served from `https://media.duitpoket.fun` through an R2 custom domain.
- Existing `/media` route remains as a fallback during migration.
- Bucket has no public listing and uses unguessable keys.

### Implementation

1. Enable R2 and create the bucket + custom domain.
2. Add a storage adapter behind the existing media interface:
   - `putMedia(buffer, contentType, key)`
   - `getMediaUrl(key)`
   - `deleteMedia(key)`
   - local-disk fallback for development and rollback
3. Change `POST /api/media` to write to R2 first; keep a local copy for 30 days.
4. Set `RELAY_PUBLIC_MEDIA_BASE_URL=https://media.duitpoket.fun` for generated post media.
5. Migrate existing files from `.data/media` with the same basename keys.
6. Validate:
   - Instagram/Threads/TikTok can fetch the public URL
   - video posters and carousel frames still work
   - deleting a post does not delete media still referenced by another post
7. Add lifecycle rules for orphaned media after a retention window.

### Why it matters

- R2 has **zero egress fees**; the free tier is 10 GB-month, 1M Class A and 10M Class B operations.
- Reduces VM disk and bandwidth, and removes media delivery from the Node process.
- Gives a stable public media host instead of relying on the console URL.

### Cost expectation

Likely **$0 extra** at current volume; beyond the free tier, storage is about $0.015/GB-month and reads $0.36/million.

## Phase 2 — Edge caching, rate limits and bot protection (2–3 days) — in progress

1. Add Cache Rules:
   - `/assets/*`, `/app.js`, `/styles.css`: long-lived immutable cache (already correct).
   - `/media/*` after R2 migration: long cache at `media.duitpoket.fun`.
   - `/api/*`, `/auth/*`, `/settings*`: bypass cache.
2. Add rate limiting on:
   - `/api/cloud/login`
   - `/api/media`
   - publish endpoints
3. Configure bot protection so it does **not** challenge OAuth callbacks or platform media fetches.
4. Confirm only the tunnel reaches the origin; remove any public GCP ingress.

**Exit:** origin request volume drops without changing publish success.

## Phase 3 — Turnstile and admin access (2–3 days)

### Turnstile

- Add Turnstile to sign-in and registration.
- Verify server-side in the login route.
- Keep API keys and automation on a bypass path.

### Cloudflare Access

- Prefer a dedicated `admin.relay.duitpoket.fun` hostname routed through the same tunnel.
- Put Access in front of that hostname only.
- Use email OTP or an identity provider; the Zero Trust free tier covers up to 50 users.
- Use a service token for automation that needs the admin API.
- Do **not** gate the public app, OAuth callbacks, or `/media`.

**Exit:** admin surface requires SSO; public publishing still works.

## Phase 4 — Reliability and observability (3–5 days)

1. **Tunnel HA**
   - Run a second `cloudflared` connector.
   - A second connector on the same VM protects against process failure, not VM failure.
   - For real origin HA, add a second small origin and a Cloudflare load balancer later.
2. **Health Worker**
   - A Workers Cron Trigger checks Relay `/api/health` every 5 minutes.
   - Alert to email/Telegram on failure, 5xx rate, or scheduler lag.
   - This is a legitimate, low-cost use of the Workers Paid plan.
3. **Backups to R2**
   - Nightly SQLite backup plus media manifest, encrypted, 30-day retention.
   - Monthly restore test.
4. **Observability**
   - Enable Workers Logs only for the health Worker.
   - Watch the Dec 2026 Workers Logs pricing change; keep retention short.
5. **Alerting**
   - Tunnel disconnected
   - 5xx above threshold
   - media 404 spike
   - publish failure spike

## Phase 5 — Only if metrics justify it (next quarter)

Evaluate, but do not do pre-emptively:

- **Queues / Durable Objects** for scheduled publishing only if scheduler reliability misses target.
- **D1** only for a new edge-side feature; not a drop-in replacement for Relay's JSON/SQLite store.
- **Cloudflare Images** only if image transformation becomes a product requirement; it is a separate paid product.
- **Workers AI** only for a concrete content feature, not to consume the plan.

## Cost model

| Item | Expected |
|---|---|
| Workers Paid | $5/month (already paid) |
| R2 | $0 at current volume if under 10 GB and operation free tier |
| Cloudflare Access | $0 up to 50 users |
| Turnstile | $0 |
| Tunnel / DNS / TLS | $0 |
| GCP VM | unchanged; likely lower bandwidth/disk after media offload |
| Pro WAF / Images | not required for this plan |

## Success measures

- Media bytes served by the VM: **down 70%+**
- Origin requests: **down 30%+**
- Static asset cache hit ratio: **>90%**
- `/media` 404 rate: **<0.5%**
- Publish success rate: **>99%**
- Tunnel uptime: **99.9%**
- Cloudflare bill: **$5 base plus R2 only if free tier is exceeded**

## What not to do

- Do not migrate Relay to Workers just because the plan is paid.
- Do not put Access in front of the whole domain.
- Do not cache authenticated or API responses.
- Do not enable R2 lifecycle deletion without checking media references.
- Do not add paid WAF/Images/Queues before Phase 1 metrics are stable.

## Suggested 30/60/90

**30 days:** baseline, R2 media, cache/rate-limit rules.  
**60 days:** Turnstile, admin Access, tunnel HA, backups, health Worker.  
**90 days:** review metrics; decide whether Queues/Durable Objects or Cloudflare Images are justified.
