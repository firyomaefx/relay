# Relay Cloud URL map

Use this as your bookmark sheet. **Owner** pages use the env console password (`/admin`). **Customers** use email + password (`/login`).

## Public (prospects)

| URL | Purpose |
|-----|---------|
| https://relay.duitpoket.fun/ | Marketing home |
| https://relay.duitpoket.fun/waitlist | Join early access |
| https://relay.duitpoket.fun/pricing | Rates and founding deal |
| https://relay.duitpoket.fun/docs | MCP developer docs |
| https://relay.duitpoket.fun/contact | Contact form |

## Customer (approved users)

| URL | Purpose |
|-----|---------|
| https://relay.duitpoket.fun/login | Customer sign in |
| https://relay.duitpoket.fun/forgot-password | Request password reset link |
| https://relay.duitpoket.fun/setup | First-time password (from email) |
| https://relay.duitpoket.fun/reset-password | New password (from reset email) |
| https://relay.duitpoket.fun/ | Composer (requires customer session) |
| https://relay.duitpoket.fun/connect | MCP connection guide |

## Owner (you only)

| URL | Purpose |
|-----|---------|
| https://relay.duitpoket.fun/admin | Owner sign in |
| https://relay.duitpoket.fun/cloud-admin | Waitlist, customers, billing (**daily bookmark**) |
| https://relay.duitpoket.fun/manage | Alias → same as `/cloud-admin` |
| https://relay.duitpoket.fun/ | Composer (optional; banner links back to admin) |

**Daily workflow:** open `/admin` → lands on `/cloud-admin` after sign-in → approve waitlist → customer uses `/setup` then `/login`.

## Redirect rules

- Unsigned `/cloud-admin` or `/manage` → `/admin` (not customer `/login`).
- Signed-in owner visiting `/admin` → `/cloud-admin`.
- Customer session on `/cloud-admin` → `/` (composer).