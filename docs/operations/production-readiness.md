# Relay Cloud production readiness

Last audited: 2026-10-30 (Asia/Kuala_Lumpur)

## Public surface

| URL | Purpose | Expected |
|---|---|---|
| `https://relay.duitpoket.fun/pricing` | Public prices, $0.50 starter credit and $10 examples | 200 HTML |
| `https://relay.duitpoket.fun/connect` | MCP connection guide and one-click Cursor install | 200 HTML |
| `https://relay.duitpoket.fun/contact` | Agency / access request form | 200 HTML |
| `https://relay.duitpoket.fun/billing/success` | Stripe return page | 200 HTML |
| `https://relay.duitpoket.fun/billing/cancel` | Stripe cancel page | 200 HTML |
| `https://relay.duitpoket.fun/login` | Console login | 200 HTML |
| `https://relay.duitpoket.fun/cloud-admin.html` | Admin; requires session | 302 → `/login` when signed out |
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

- 25 lifetime units per customer.
- Text = 1 unit; video = 2 units.
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
npm test                 # 158 tests, recursive test discovery
node tools/audit-live-links.mjs
node tools/production-readiness.mjs
```

## Operational state

- **GCS offsite backup:** active. The VM service account has `roles/storage.objectAdmin` and `devstorage.read_write`; backup script uploads the encrypted tarball and `.sha256` to `gs://relay-prod-backups-a22a835c`. Verified: `relay-20261029T202909Z.tgz`.
- **Uptime alerting:** active. Cloud Monitoring checks `relay.duitpoket.fun/api/health` and `cloud-mcp.duitpoket.fun/health` every 5 minutes. Alert policy `Relay production uptime` notifies the email channel `Relay production alerts` (`ttrgautomation@gmail.com`).
- **Stripe:** code-complete; live keys are not installed. Checkout returns 503 until `RELAY_STRIPE_SECRET_KEY` and `RELAY_STRIPE_WEBHOOK_SECRET` are set.
- **Polar:** sandbox product, access token and webhook are installed on production for the operator trial. `GET /api/health` reports `payments.polarSandbox: true`; public checkout must stay disabled. Live product/token/webhook are required before monetization.
- **Contact requests:** stored locally at `/var/lib/relay/.data/contact-requests.ndjson`. Set `RELAY_CONTACT_WEBHOOK_URL` to forward each request to Slack/Google Chat/Zapier; no direct transactional-email provider is connected yet.
- **Self-service signup:** not implemented. Customers are provisioned by an operator.
- **Real-account E2E:** requires a real customer account and platform app credentials.
- **OAuth client registrations:** now self-validating signed client IDs, so they survive process restarts. Access/refresh tokens are signed from `RELAY_CLOUD_TOKEN_KEY`.




