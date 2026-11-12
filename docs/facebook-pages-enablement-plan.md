# Enable Facebook Pages in Relay Cloud

**Answer: Yes — for Facebook Pages. No — for personal Facebook profiles.**

## Production attempt — 12 Nov 2026

The code path and feature flag were deployed and exercised. The existing saved Meta/Instagram app ID was accepted by Relay but Facebook rejected the OAuth dialog with `PLATFORM__INVALID_APP_ID`. That means it is not a valid Facebook app ID for Facebook Login; it is the Instagram app credential.

To avoid showing a broken Facebook button to users, the production flag is back to `RELAY_ENABLE_FACEBOOK=0` and the public “available” copy was reverted. The enablement code remains deployed and tested.

**Blocked on:** a valid Facebook app (not the Instagram-only app), its `FACEBOOK_CLIENT_ID` / `FACEBOOK_CLIENT_SECRET`, a Facebook Login for Business `FACEBOOK_CONFIG_ID`, Page admin access, and Meta App Review / Business Verification.

## Meta setup progress — 12 Nov 2026

- Existing Meta app found: **Relay Threads**, App ID `1116133960897314`. It is a valid Facebook app and already has Facebook Login for Business.
- Added the **Manage everything on your Page** use case.
- Saved App domains `relay.duitpoket.fun`, Privacy URL `https://relay.duitpoket.fun/privacy`, Terms URL `https://relay.duitpoket.fun/terms`, and Category `Education`.
- Added the valid OAuth redirect URI `https://relay.duitpoket.fun/auth/callback/facebook`.
- App credentials were set on production and the Facebook card was enabled for a live test.
- The live OAuth test failed with Meta's developer error:
  `Invalid Scopes: pages_read_engagement, pages_manage_posts`.
  These are advanced Page permissions and are not available to the app until App Review approves them.
- The `DuitPoket` business portfolio is still **Unverified**.
- The app is still **ineligible for submission** because it is missing a valid 1024x1024 App icon.
- Production was returned to `RELAY_ENABLE_FACEBOOK=0`; the broken button is not exposed.
- The app secret was retrieved only for configuration and is not recorded here.

**Next exact steps:** upload a 1024x1024 app icon and save Basic settings; start Business Verification for DuitPoket; submit App Review for `pages_show_list`, `pages_read_engagement`, and `pages_manage_posts` with a screencast that creates/edits/deletes a Page post; confirm the Page admin Page ID; then set production credentials and flag and retest.

## Icon and permission requests — 13 Nov 2026

- Uploaded the new Relay Cloud logo as a 1024x1024 PNG and saved it in App Settings → Basic. The "currently ineligible for submission" warning cleared.
- Added `pages_read_engagement` and `pages_manage_posts` to the **Manage everything on your Page** use case. Both now show **Ready for testing**.
- Both permissions now appear in **App Review → New requests**, alongside `pages_show_list`. The review has **not** been submitted.
- Remaining before submission:
  - Business Verification for DuitPoket is still outstanding.
  - Each permission needs a written use-case description, a screencast, and a completed API test call.
  - `pages_manage_posts` review expects create/edit/delete; Relay currently implements create only.
  - The Page ID and admin access still need to be confirmed.
- Production stays at `RELAY_ENABLE_FACEBOOK=0` until review is approved.


Meta does not allow a third-party app to publish to a personal Facebook timeline. The supported business path is a **Facebook Page** owned or managed by the customer. Relay already has a Page adapter; it is feature-flagged and off in production.

## Current state

- `packages/platforms/src/adapters/facebook.ts` implements Facebook Login, Page token exchange and Page publishing for text, link, one photo, multi-photo and one video.
- `packages/platforms/src/index.ts` registers the adapter only when `RELAY_ENABLE_FACEBOOK=1`.
- `apps/web/public/app.js` already has the Facebook Page card, limits and preview.
- `config/cloud-prices.json` already has Facebook pricing.
- Unit and API tests exist in `tests/unit/facebook.test.mjs` and `tests/e2e/facebook-api.test.mjs`.
- Production has **no Facebook credentials and no feature flag set**, so the UI does not show it.

## Two gaps to close before public launch

1. **Login flow:** the adapter currently sends `scope=...` on the OAuth dialog. Meta now recommends **Facebook Login for Business** with a `config_id`. The adapter needs to send `config_id` and drop `scope` for the business login dialog.
2. **Page selection:** the adapter takes the first Page from `/me/accounts`. A customer with multiple Pages cannot choose which one Relay publishes to. For a single-owner Page this is acceptable for a private beta; for customers it needs a Page picker.

Also note: the App Review instructions for `pages_manage_posts` ask the reviewer to see create, edit **and delete**. Relay currently supports create only. Either add Facebook delete (and optionally edit) to the app, or make the create-only use case very explicit and accept review risk.

## Phase 1 — Meta app and permissions

1. Create or open a **Business type** app in the [Meta App Dashboard](https://developers.facebook.com/apps/).
2. Add **Facebook Login for Business**.
3. Create a login configuration:
   - Token type: **User access token** (Relay acts on a Page admin's behalf and stores a Page token).
   - Asset: the customer's Facebook Page.
   - Permissions:
     - `pages_show_list`
     - `pages_read_engagement`
     - `pages_manage_posts`
   - Copy the generated **Configuration ID**.
4. Add the exact OAuth redirect URI:
   `https://relay.duitpoket.fun/auth/callback/facebook`
5. Set App Domains and the Website URL to `relay.duitpoket.fun`.
6. Complete the app basics: privacy policy, terms, data-deletion instructions, app icon, category and contact email.
7. Add the Page admin as an app Tester while the app is in Development mode.
8. Complete **Business Verification**.
9. Submit **App Review** for the three Page permissions, including `public_profile` advanced access where the dashboard requires it.
10. Switch the app to **Live** only after approval.

Official references:

- [Facebook Login for Business](https://developers.facebook.com/documentation/facebook-login/facebook-login-for-business)
- [Permissions reference](https://developers.facebook.com/documentation/development/permissions)
- [pages_manage_posts](https://developers.facebook.com/docs/permissions/reference/pages_manage_posts)
- [App Review](https://developers.facebook.com/docs/app-review)
- [Business verification](https://developers.facebook.com/documentation/development/release/business-verification)
- [Access levels](https://developers.facebook.com/docs/graph-api/overview/access-levels)

## Phase 2 — Code changes

### 2.1 Business login configuration

Add `FACEBOOK_CONFIG_ID` to configuration and change `FacebookAdapter.authorize`:

```ts
const configId = ctx.env.FACEBOOK_CONFIG_ID?.trim();
if (!configId) throw new ConfigurationError("FACEBOOK_CONFIG_ID is required", "facebook_config_missing");
url.searchParams.set("config_id", configId);
url.searchParams.set("response_type", "code");
// do not send scope when config_id is used
```

Keep `redirect_uri` and signed `state`. Update the authorize unit test from `scope` to `config_id`.

### 2.2 Page token exchange

The existing exchange is close to correct:

1. Exchange `code` for a short-lived user token.
2. Exchange for a long-lived user token.
3. Call `GET /me/accounts?fields=id,name,access_token,picture{url},tasks`.
4. Filter to Pages where `tasks` includes `CREATE_CONTENT` or `MANAGE`.
5. Store the **Page** id, name, avatar and Page token, encrypted at rest, exactly as other platform tokens are stored.

Add:
- Clear error when no Page is returned.
- Handling for expired/invalid Page tokens → reconnect message.
- `appsecret_proof` on server-side Graph requests.
- Optional `FACEBOOK_PAGE_ID` for a private single-Page beta.

### 2.3 Multiple Pages (recommended before customer launch)

The current one-result connect flow cannot offer a picker. Add a short-lived Page-selection step:

- After token exchange, return the available Pages (id, name, avatar) to the console.
- Show a Page picker in the connect flow.
- Store the selected Page token.
- Add an account label such as `Page name`.

If this is not built, document that a customer can connect only the first Page returned and must remove other Page roles before connecting. That is not acceptable for agencies.

### 2.4 Publish path

Existing adapter behavior:

- Text/link → `/{page-id}/feed`
- One photo → `/{page-id}/photos` with `url`
- Up to 10 photos → unpublished photos, then `/{page-id}/feed` with `attached_media`
- One video → `/{page-id}/videos` with `file_url`

Requirements to verify:

- `RELAY_PUBLIC_URL` is the public HTTPS origin; Facebook fetches media from `publicMediaUrl`.
- Media URL is reachable without a console session.
- Video is MP4/MOV and within 1 GB; photos are JPEG/PNG/WebP and within 10 MB.
- Facebook posts are single-part only. Long text is not auto-threaded.
- Relay keeps its own scheduler; it does not use Facebook `scheduled_publish_time`.
- Retry only the failed platform; never duplicate a successful Page post.

### 2.5 Delete/edit

`packages/core/src/service.ts` currently says Facebook delete is not available. For App Review, add at least:

- `DELETE /{post-id}` with the Page token for delete.
- Optionally `POST /{post-id}` with `message` for edit.

If create-only is intentional, write the App Review use case around publishing only and be prepared for a reviewer rejection.

### 2.6 Copy and UI

With the flag on and credentials present, `availablePlatforms()` already shows Facebook after the adapter registers. Update:

- `apps/web/public/landing.html` — remove “waiting on Meta review”.
- `apps/web/public/site-i18n.js` — same copy in English and BM.
- `apps/web/public/docs.html` — remove “stays off until review”; keep the Page-only note.
- `apps/web/public/waitlist.html` — Facebook no longer “waiting on review”.
- `apps/web/public/pricing.html` — confirm Facebook is shown in the platform/pricing matrix.
- `README` / deployment docs — add the env keys.

Do not show Facebook in marketing until the app is actually Live and the flag is on.

## Phase 3 — Configuration and deployment

Add to `/etc/relay/relay.env` on production:

```env
RELAY_ENABLE_FACEBOOK=1
FACEBOOK_CLIENT_ID=<Meta app id>
FACEBOOK_CLIENT_SECRET=<Meta app secret>
FACEBOOK_CONFIG_ID=<Facebook Login for Business configuration id>
# optional private beta
FACEBOOK_PAGE_ID=<page id>
```

- `RELAY_PUBLIC_URL` must already be `https://relay.duitpoket.fun`.
- Restart the web process through the normal deploy path.
- Confirm `/api/state` includes `facebook` in `settings.platforms`.
- Confirm the Accounts screen shows the Facebook Page card and “Sign in with Facebook”.
- Confirm the MCP `relay_connect` platform enum includes Facebook once the flag is on.

The current process has no systemd auto-restart; add supervision separately so a failed OAuth test cannot leave the site down.

## Phase 4 — Test plan

### Local / mock

- Feature flag off: Facebook hidden from UI/MCP.
- Flag on, no credentials: mock connect/publish works, UI clear.
- Flag on, credentials + config: OAuth URL contains `config_id`, not `scope`.
- Token exchange stores Page id/name/token, not user token.
- Text, link, one photo, 10-photo carousel and one video.
- Mixed video + image rejected.
- Second part rejected.
- Permission error maps to reconnect message.
- Pricing: text 20 milliUSD, video 40 milliUSD.

### Meta Development mode

- App Tester is a Page admin.
- Sign in with Facebook → approve all three permissions.
- Page name/avatar appears in Accounts.
- Publish text, photo and video to a **test Page**.
- Verify the posts on Facebook.
- Revoke the app in Facebook Business Integrations; next publish shows reconnect.
- Disconnect in Relay removes the Page token.

### Production canary

- Enable for the owner Page only.
- Publish a real text post, a photo post, and a scheduled post.
- Check scheduler, retries, billing and history.
- Monitor Graph API errors and Page token failures for 48 hours.
- Then enable customer onboarding.

### App Review screencast

Record one uninterrupted flow:

1. Log in with Facebook.
2. Grant `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`.
3. Select the Page (or show the connected Page).
4. Create a post in Relay.
5. Publish it and show it on the Facebook Page.
6. If requested, edit and delete it and show the result.

## Phase 5 — Rollout and rollback

- Beta: set `RELAY_ENABLE_FACEBOOK=1` only on the owner/canary environment.
- Public: after Meta Live approval, enable for all customers and update marketing copy.
- Rollback: remove the flag or set `RELAY_ENABLE_FACEBOOK=0`, restart. Facebook disappears from UI/MCP; existing tokens remain stored but inactive. Re-enable after fixing.

## Effort and critical path

- Meta app setup and review: **the critical path**, roughly 1–3 weeks; business verification and review can take longer.
- Code for single-Page, config_id, tests and copy: **~1 day**.
- Multi-Page picker: **~1–2 days**.
- Delete/edit for App Review: **~1 day**.
- Production canary: **1–2 hours plus observation**.

## Risks

1. **Personal profiles are not supportable.** Only Pages.
2. **App Review is the gate.** Do not advertise Facebook as available before Live approval.
3. **`pages_manage_posts` is broad.** It can create, edit and delete Page content; review needs a clear use case and screencast.
4. **No Page picker** means multi-Page admins may connect the wrong Page.
5. **Page token expiry/revocation** must produce a reconnect path, not a failed publish.
6. **No delete/edit** may cause review friction because the permission’s screencast asks for them.
7. **Media must be publicly fetchable** by Facebook; private or local URLs will fail.


## Facebook Page edit/delete implementation — 13 Nov 2026

- Added `updatePost` and `deletePost` to the Facebook Pages adapter.
- Added `editPublishedPost` to `RelayService`, with edit history recorded on the post result.
- Added operator-only `POST /api/posts/edit` and `POST /api/posts/delete` routes.
- Added **Edit** and **Delete** actions on Published Facebook Page rows.
- Facebook publish calls now include the Page access token (previously omitted).
- Added adapter tests for edit, delete, and publish token use.
- Deployed as `3e3a714` (`fbadmin`); `npm test` passes 261 tests.

### Meta progress and remaining blockers

- App icon is uploaded and saved.
- App domains now contains `duitpoket.fun`.
- `pages_read_engagement` and `pages_manage_posts` are attached to the Page use case and listed in App Review.
- Business Verification was started in the Security Centre but stopped at the legal business-type step. It needs the real legal entity type and documents for DuitPoket.
- The App Review submission is still not submitted. It needs:
  - Business Verification completed.
  - A screencast of create → edit → delete on a real Page.
  - One completed API test call per permission.
  - Allowed usage, Data handling, and Reviewer instructions completed.
- Page ID/admin is still unconfirmed. Graph API Explorer token generation did not return a token, so the Page connection test is still pending.
- Production remains at `RELAY_ENABLE_FACEBOOK=0`.
