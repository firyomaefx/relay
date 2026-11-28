# Relay Cloud production readiness

Last audited: 2026-11-17 (Asia/Kuala_Lumpur)

See **[owner-urls.md](./owner-urls.md)** for the full owner vs customer bookmark sheet.

## Public surface

| URL | Purpose | Expected |
|---|---|---|
| `https://relay.duitpoket.fun/pricing` | Public prices, $0.50 starter credit and $10 examples | 200 HTML |
| `https://relay.duitpoket.fun/connect` | MCP connection guide and one-click Cursor install | 200 HTML |
| `https://relay.duitpoket.fun/contact` | Agency / access request form | 200 HTML |
| `https://relay.duitpoket.fun/billing/success` | Stripe return page | 200 HTML |
| `https://relay.duitpoket.fun/billing/cancel` | Stripe cancel page | 200 HTML |
| `https://relay.duitpoket.fun/login` | **Customer** sign in | 200 HTML |
| `https://relay.duitpoket.fun/admin` | **Owner** sign in | 200 HTML; signed-in owner → `/cloud-admin` |
| `https://relay.duitpoket.fun/cloud-admin` | Owner admin (waitlist, customers) | Unsigned → **302 `/admin`**; customer session → **302 `/`** |
| `https://relay.duitpoket.fun/manage` | Alias for owner admin | Same as `/cloud-admin` |
| `https://cloud-mcp.duitpoket.fun/mcp` | Streamable HTTP MCP | 401 in a browser; use an MCP client |
| `https://cloud-mcp.duitpoket.fun/health` | Cloud health | 200 JSON |
| `https://cloud-mcp.duitpoket.fun/.well-known/oauth-protected-resource` | OAuth discovery | 200 JSON |

The public link crawl is checked with `node tools/audit-live-links.mjs`. It exits non-zero on any 4xx/5xx link.

## MCP authentication

- API key: `Authorization: Bearer <customer-api-key>`.
- OAuth: discovery + dynamic registration + customer-scoped access/refresh tokens.
- One-click URL: admin can create a revocable `.../mcp?token=rlc_...` link. The token is customer-scoped and stored only as a hash.
- OAuth tokens survive process restarts because the signing secret is derived from `RELAY_CLOUD_TOKEN_KEY`.

## Free allowance

- $0.50 free starter credit per customer (500 milliUSD).
- Text = $0.02 per part; video = $0.04 per part. Free credit is spent at the real post price.
- X is excluded from free allowance.
- Free credit is held on reservation and consumed only on a successful post.
- Failed, cancelled and rejected posts release the hold.
- Paid posts reserve and settle through the same ledger.

## Payments

Stripe Checkout is implemented behind environment variables:

```env
RELAY_STRIPE_SECRET_KEY=sk_live_...
RELAY_STRIPE_WEBHOOK_SECRET=whsec_...
RELAY_STRIPE_CURRENCY=usd
RELAY_STRIPE_SUCCESS_URL=https://relay.duitpoket.fun/billing/success?session_id={CHECKOUT_SESSION_ID}
RELAY_STRIPE_CANCEL_URL=https://relay.duitpoket.fun/billing/cancel
RELAY_PUBLIC_URL=https://relay.duitpoket.fun
```

Admin checkout: `POST /api/cloud/admin/checkout` with `{ customerId, amount }` where amount is milliUSD (10,000 = $10.00). It returns a Stripe Checkout URL.

Webhook: `POST /api/stripe/webhook`, Stripe signature required. `checkout.session.completed` with `payment_status=paid` credits the ledger with the Stripe session ID as the idempotency reference.

Until Stripe keys are installed, checkout returns 503 and manual top-up remains available.

### Polar sandbox

Polar Checkout is implemented as a second payment provider. The current production install points at the **Polar sandbox** only; it does not charge real money.

```env
RELAY_POLAR_ACCESS_TOKEN=polar_oat_...
RELAY_POLAR_PRODUCT_ID=...
RELAY_POLAR_WEBHOOK_SECRET=whsec_...
RELAY_POLAR_API_BASE=https://sandbox-api.polar.sh
RELAY_POLAR_SUCCESS_URL=https://relay.duitpoket.fun/billing/success
RELAY_POLAR_CANCEL_URL=https://relay.duitpoket.fun/billing/cancel
```

- Admin checkout: `POST /api/cloud/admin/polar-checkout` with `{ customerId }` or the **Create Polar checkout** button on `/cloud-admin.html`.
- Webhook: `POST /api/polar/webhook`, Standard Webhooks signature required. `order.paid` credits the ledger using the order ID as the idempotency reference.
- The sandbox product used for the trial is `Relay Cloud Sandbox Credit` at `US$10`.
- Sandbox checkout URL creation and signed webhook delivery were verified. A real card payment was not completed; a signed sandbox event was used to verify the credit path.

For live use, replace the sandbox access token, API base and product ID with live values and create a live webhook endpoint. Do not leave a sandbox token installed on a public production checkout.

## Verification

```bash
npm run build
npm test                 # 169 tests, recursive test discovery
node tools/audit-live-links.mjs
node tools/production-readiness.mjs
```

## Operational state

- **GCS offsite backup:** active. The VM service account has `roles/storage.objectAdmin` and `devstorage.read_write`; backup script uploads the encrypted tarball and `.sha256` to `gs://relay-prod-backups-a22a835c`. Verified: `relay-20261029T202909Z.tgz`.
- **Uptime alerting:** active. Cloud Monitoring checks `relay.duitpoket.fun/api/health` and `cloud-mcp.duitpoket.fun/health` every 5 minutes. Alert policy `Relay production uptime` notifies the email channel `Relay production alerts` (`ttrgautomation@gmail.com`).
- **Stripe / Polar / email:** confirm on each deploy with `GET /api/health` (`payments.*`, `emailConfigured`). Platform mail: `RELAY_EMAIL_PROVIDER=brevo|resend`, `RELAY_BREVO_API_KEY` or `RELAY_RESEND_API_KEY`, and `RELAY_EMAIL_FROM`. Customer email publishing uses per-tenant `BREVO_API_KEY` via `relay_connect` / Settings.
- **Email program (Brevo):** console **Email** tab stores library entries, schedules via Brevo, and runs inbound automation when `RELAY_PUBLIC_URL` (or `RELAY_PUBLIC_BASE_URL`) is set so Relay can register `POST /api/hooks/brevo-inbound/{secret}`. Verify the inbound domain in Brevo or set `RELAY_BREVO_INBOUND_DOMAIN`. Optional `RELAY_EMAIL_AUTOMATION_ENABLED=false` disables reply/promo automation. DeepSeek (tenant or env key) improves reply classification; without it, rule-based promo follow-ups still run for known contacts.
- **Sleep mode (cloud tenants):** set `RELAY_CLOUD_TENANT_SCHEDULER_MS=60000` on **both** the console web process and **cloud MCP** (`apps/mcp/src/cloud-entry.ts`). Each calls `TenantManager.pulseTenantSchedulers()` so queue, Brevo email inbound polls, and Threads auto-reply run without an open browser tab. **`RELAY_THREADS_AUTOREPLY_AUTO_ENABLE`** (default on) turns on Threads auto-reply after a qualifying top-up or when the customer saves DeepSeek, if Threads is connected. The owner scheduler still runs on the main data directory. Operator **Revenue goal** and **Automation health** on `/cloud-admin` use `GET /api/cloud/admin/revenue-summary` and `GET /api/cloud/admin/automation-health`. `GET /api/health` exposes `cloud.tenantSchedulerPulseMs` for uptime checks. New customers get a welcome email and a starter promo library row after `/setup`.
- **System ready gate:** [system-ready-checklist.md](./system-ready-checklist.md) (`npm run verify:system-ready`).
- **Manus AI (external):** see [manus-relay.md](./manus-relay.md) — optional content assist.
- **Billing emails:** `RELAY_LOW_BALANCE_MILLI_USD` and cooldown env vars; console + cloud MCP runs low-balance checks on the tenant pulse. Stripe/Polar webhooks send one top-up receipt per payment (`RELAY_TOPUP_RECEIPT_EMAIL`).
- **Operator alerts:** `RELAY_OPERATOR_ALERT_EMAIL` + `RELAY_OPERATOR_ALERT_COOLDOWN_MS` (default 24h). Pulse runs automation-health rules and emails a digest when issues exist (stalled queue, missing Brevo webhook, stale inbound). **`RELAY_OPERATOR_REVENUE_DIGEST`** (default on) sends a weekly RM goal snapshot with automation issue count (`RELAY_OPERATOR_REVENUE_DIGEST_COOLDOWN_MS`, default 7 days).
- **Contact requests:** stored locally at `/var/lib/relay/.data/contact-requests.ndjson`. Set `RELAY_CONTACT_WEBHOOK_URL` to forward each request to Slack/Google Chat/Zapier.
- **Self-service signup:** set `RELAY_WAITLIST_AUTO_APPROVE=1` to auto-invite waitlist rows under `RELAY_WAITLIST_LIMIT` on signup and on each tenant-scheduler pulse (clears pending backlog without daily admin). Otherwise approve in `/cloud-admin`.
- **Real-account E2E:** requires a real customer account and platform app credentials.
- **OAuth client registrations:** now self-validating signed client IDs, so they survive process restarts. Access/refresh tokens are signed from `RELAY_CLOUD_TOKEN_KEY`.










