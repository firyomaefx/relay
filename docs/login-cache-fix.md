# Login cache fix — all entry points

## Symptom

Cloudflare Access accepted the email OTP, but the Relay operator password page showed:

> Complete the verification challenge.

The Turnstile widget itself showed **Success**.

## Root cause

Not Access, not the operator password, and not Turnstile Siteverify.

The browser was running an **older cached `/login.js`** from before Turnstile was added. That script sent only the password and no `cf-turnstile-response` value. Relay returned HTTP 400 `turnstile_required`, which uses the same message as the client-side missing-token guard.

Evidence from production before the fix:

- `/login.js` had no `turnstileToken` marker.
- Cloudflare served it with `cf-cache-status: HIT` and an age of about 45 hours.
- All recent `POST /api/login` requests returned **400**, not 401 (wrong password) or 403 (failed Siteverify).

The root page was a cache/versioning problem, not a credential problem.

## Fix

1. Both login pages now reference versioned scripts:
   - `/login` → `customer-login.html` → `/customer-login.js?v=20261115turnstile`
   - `/admin` → `login.html` → `/login.js?v=20261115turnstile`
2. Cloudflare cache was purged for the bare `/login.js` and `/customer-login.js`.
3. Origin now sends `Cache-Control: no-cache` for those two scripts, so even an old HTML reference revalidates instead of running a stale copy.
4. Tests assert that both pages load a versioned script and that the scripts revalidate.

## Every entry point

| Entry | Page | Script |
|---|---|---|
| `/login` | `customer-login.html` | `customer-login.js?v=20261115turnstile` |
| `/login.html` | `customer-login.html` | `customer-login.js?v=20261115turnstile` |
| `/admin` | `login.html` | `login.js?v=20261115turnstile` |
| `/admin/` | `login.html` | `login.js?v=20261115turnstile` |
| `/admin/login` | `login.html` | `login.js?v=20261115turnstile` |

Every public page that links “Log in” points to `/login`; none embeds a private copy of the login script. Customer login links to `/admin` only for the operator entry point.

## Future changes

When editing either login script, bump the `?v=` value in its HTML page. The e2e test fails if a login page loses the version marker, and the cache header test fails if either script stops revalidating.

## User action

Reload the login page with **Ctrl+Shift+R** once, or close and reopen the tab. Then complete Access OTP and the Relay operator password as normal.

## Verification

- Deployed `7222cae` (versioned scripts) and `040813f` (revalidate policy).
- Production `/login` returns 200 with `customer-login.js?v=...`.
- Production `/admin` is Access-protected and serves `login.js?v=...` after Access.
- Versioned scripts contain the Turnstile token code.
- Targeted login page/cache tests pass.
