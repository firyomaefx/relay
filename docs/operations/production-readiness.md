# Relay production readiness

Last audited: 2026-11-01

## Verified

| Check | Result |
|---|---|
| Build | Passing |
| Tests | 169 passing |
| Public link audit | 10 checked, 0 broken |
| Console health | HTTP 200 |
| Cloud MCP health | HTTP 200 |
| OAuth metadata | HTTP 200 |
| Billing screen | Available |
| Scheduler lock | Tested |
| Encrypted credentials | Enabled |

Run the checks locally:

```bash
npm run build
npm test
node tools/production-readiness.mjs
node tools/audit-live-links.mjs
```

## Operational posture

- The console binds to localhost by default. Use a TLS tunnel or reverse proxy for public access.
- Platform credentials are encrypted at rest with AES-256-GCM.
- Only one Relay process owns the scheduler lock, preventing duplicate scheduled posts.
- Health endpoints are available on the console and Cloud MCP.
- Backups and uptime monitoring are operator-managed in a hosted deployment.
- The Billing screen exposes available credit, starter credit and payment history without exposing secrets.

## Not yet enabled

- Live card checkout
- Self-service signup and customer portal
- Transactional email
- Full real-account end-to-end publishing on every platform
- Final TikTok and Meta app approvals
- LinkedIn company pages

These are deployment or commercial integrations, not gaps in the publishing core.
