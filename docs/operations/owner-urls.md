# Relay Cloud — two logins (bookmark sheet)

There are only **two** sign-in pages. Pick the row that matches you.

| Who | Bookmark | Sign in with |
|-----|----------|--------------|
| **You** (run Relay, waitlist, billing) | https://relay.duitpoket.fun/admin | Admin password (env) → then **https://relay.duitpoket.fun/cloud-admin** |
| **Customer** (approved user, publishes posts) | https://relay.duitpoket.fun/login | Email + password from setup email |

**Daily work for you:** `/admin` → `/cloud-admin` (same as `/manage`).

If the customer login page footer still says “Operator sign in”, production has not deployed the latest release yet — merge [PR #57](https://cursor.com/codebase/ttrg/relay/pull/57) and redeploy.

## Public (no login)

| URL | Purpose |
|-----|---------|
| https://relay.duitpoket.fun/ | Marketing |
| https://relay.duitpoket.fun/waitlist | Join early access |
| https://relay.duitpoket.fun/pricing | Rates |
| https://relay.duitpoket.fun/docs | MCP docs |
| https://relay.duitpoket.fun/contact | Contact |

## Customer pages

| URL | Purpose |
|-----|---------|
| https://relay.duitpoket.fun/login | Customer sign in |
| https://relay.duitpoket.fun/forgot-password | Reset link by email |
| https://relay.duitpoket.fun/setup | First password (from email) |
| https://relay.duitpoket.fun/reset-password | New password (reset email) |
| https://relay.duitpoket.fun/ | Composer |
| https://relay.duitpoket.fun/connect | MCP guide |

## Admin pages (you)

| URL | Purpose |
|-----|---------|
| https://relay.duitpoket.fun/admin | Admin login |
| https://relay.duitpoket.fun/cloud-admin | Waitlist, customers, billing |
| https://relay.duitpoket.fun/manage | Same as cloud-admin |
| https://relay.duitpoket.fun/ | Composer (optional; banner → admin) |

## Redirects

- Not signed in on `/cloud-admin` or `/manage` → `/admin` (not customer `/login`).
- Signed-in admin on `/admin` → `/cloud-admin`.
- Customer on `/cloud-admin` → `/` (composer).