# 1,000-visitor load simulation — 12 Nov 2026

Target: production Relay Cloud origin `http://127.0.0.1:4317`, measured from the production VM over loopback. Cloudflare and browser caches were deliberately bypassed, so this is a worst-case origin test.

## Environment

- Production VM: 2 vCPU, 3.8 GB RAM, 2 GB swap, Node 24.22.1
- Single `apps/web/dist/index.js` process on port 4317
- SQLite waitlist DB
- Cloudflare tunnel in front
- Load tool: `tools/relay-load.mjs`

## Results

### 1,000 cold page views — 25 concurrent

```
elapsed        1,776 ms
throughput     563 req/s
success         1,000 / 1,000
p50             36 ms
p95             88 ms
p99            109 ms
max            134 ms
```

### 1,000 cold full-page loads — 5 assets each, 50 concurrent

5,000 requests total: HTML + CSS + JS + two brand images.

```
elapsed        5,674 ms
throughput     881 req/s
success         5,000 / 5,000
p50             51 ms
p95             98 ms
p99            165 ms
max            195 ms
```

### 1,000 simultaneous page requests — 1,000 concurrent

```
elapsed        1,968 ms
throughput     508 req/s
success         1,000 / 1,000
p50          1,439 ms
p95          1,547 ms
max          1,552 ms
```

### 1,000 waitlist API reads — 25 concurrent

```
elapsed          963 ms
throughput     1,038 req/s
success         1,000 / 1,000
p50             19 ms
p95             50 ms
```

### 1,000 waitlist API reads — 1,000 concurrent

```
elapsed        1,631 ms
throughput     613 req/s
success         1,000 / 1,000
p50          1,144 ms
p95          1,166 ms
max          1,234 ms
```

### 1,000 SQLite waitlist inserts — sequential write benchmark

```
elapsed        2,435 ms
throughput     411 inserts/s
p50             2.32 ms
p95             2.88 ms
p99             4.22 ms
```

This excludes confirmation-email delivery.

## Verdict

**Yes for 1,000 website visitors.** Even 1,000 simultaneous page requests completed with zero errors. Real traffic spread over a minute is about 17 visitors/s, far below the measured 500–1,000 req/s.

The realistic bottleneck is not page traffic. It is the **write + email path if 1,000 people sign up at the same time**:

- SQLite serializes writes; measured ~411 inserts/s.
- The waitlist endpoint also awaits the confirmation email provider.
- The first waitlist batch is capped at 100 accepted customers.

## Hardening applied

Static versioned assets are now sent with:

```
Cache-Control: public, max-age=31536000, immutable
```

HTML remains `no-store`. Cloudflare now serves assets as `cf-cache-status: HIT` after the first fetch. This removes most repeat asset traffic from the origin.

## Remaining risks

1. **Single Node process, no systemd/PM2 restart.** A process crash requires a manual restart. Add a supervised service with `Restart=always` and a health check.
2. **No rate limit on waitlist POST.** A burst of signups can serialize SQLite writes and email sending. Add a token bucket per IP and a small background queue for confirmation emails.
3. **No 5xx/latency alerting** yet. Add a Cloudflare/uptime check and origin CPU/event-loop monitoring.
4. If sustained traffic exceeds ~500 req/s, move to 4 vCPU or cluster the web process.
