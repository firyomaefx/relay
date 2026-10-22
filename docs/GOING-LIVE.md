# Going live: developer apps and credentials

Relay ships in **simulated mode**. To publish for real you need a developer app for each platform
you want, plus the credentials below. Relay talks to the official APIs only — no scraping, no
browser automation.

> Provider consoles and policies change. Treat the steps as a guide and verify scopes/redirect
> URIs against the current docs for each platform.

## Redirect URIs

Every app needs the console's OAuth callback registered. With the defaults that is:

| Platform | Redirect URI |
| --- | --- |
| X | `http://127.0.0.1:4317/auth/callback/x` |
| Threads | `http://127.0.0.1:4317/auth/callback/threads` |
| TikTok | `http://127.0.0.1:4317/auth/callback/tiktok` |

If you change `RELAY_HOST`, `RELAY_PORT` or `RELAY_CONSOLE_URL`, use
`<RELAY_CONSOLE_URL>/auth/callback/<platform>` instead and keep them in sync. The console's
**Settings** screen shows the exact URLs for your current configuration.

## X (Twitter)

1. Create a project and app at <https://developer.x.com>.
2. Add an **OAuth 2.0** client. Confidential client (client id + secret) is what Relay expects;
   register the callback URL above. App permissions must be **Read and write**.
3. Copy **Client ID** and **Client Secret** into Settings (or `X_CLIENT_ID` / `X_CLIENT_SECRET`).
4. Sign in from the console. Relay requests
   `tweet.read tweet.write users.read offline.access media.write` with PKCE.

Notes:
- Posting limits depend on your API plan. A free/basic plan may be enough for low volume; check
  your current tier before scheduling a lot.
- The adapter uploads images with the v2 media upload API and videos with the v2
  INIT/APPEND/FINALIZE flow. If your account/plan rejects an endpoint, the error returned by X is
  shown in the console and in `relay_history`.
- Token refresh uses the stored refresh token (`offline.access`), so long-lived use works without
  re-connecting.

## Threads (Meta)

1. Create an app at <https://developers.facebook.com>.
2. Add the **Threads API** product and configure the Threads use case.
3. Copy the **App ID** and **App Secret** into Settings
   (`THREADS_CLIENT_ID` / `THREADS_CLIENT_SECRET`).
4. Register the callback URL above in the Threads settings and sign in from the console.
5. Relay requests `threads_basic`, `threads_content_publish`, `threads_manage_replies` and
   `threads_read_replies`. Reconnect an older Threads account to grant the read-only comment scope.

Notes:
- **Media must be publicly reachable.** The Threads API accepts `image_url` / `video_url`, not
  binary uploads. Expose the console through a tunnel and set `RELAY_PUBLIC_MEDIA_BASE_URL`, e.g.
  `ngrok http 4317` → `RELAY_PUBLIC_MEDIA_BASE_URL=https://<id>.ngrok-free.app`. Files uploaded in
  the composer live in `.data/media/` and Relay will build `https://…/media/<file>` URLs for them.
  You can also pass media `url` values directly (MCP) or use remote URLs.
- The console exchanges the short-lived token for a long-lived one (~60 days) and refreshes it when
  needed. Re-connect if Meta revokes it.
- Video containers are polled until Meta reports `FINISHED`; failed containers surface Meta's
  `error_message`.

## TikTok

1. Create an app at <https://developers.tiktok.com>.
2. Add the **Content Posting API** product and the **Login Kit** scopes
   `user.info.basic`, `video.publish`, `video.upload`.
3. Copy the **Client key** and **Client secret** into Settings
   (`TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET`).
4. Register the callback URL above and sign in from the console.

Notes:
- **Audit matters.** Until your app passes TikTok's content-posting audit, the API only allows
  private posts. Relay exposes `tiktokPrivacy` (and the `selfOnly` shorthand) on posts — use
  `SELF_ONLY` for an unaudited app.
- **Videos** upload directly: Relay initialises the publish, uploads the file in chunks, then polls
  the publish status until it completes.
- **Photo carousels** use `PULL_FROM_URL` and therefore need public image URLs, same as Threads.
  Set `RELAY_PUBLIC_MEDIA_BASE_URL`.
- Direct Post requires the account to be eligible (e.g. not a private/underage account) and the
  caption/cover limits enforced by TikTok; Relay validates length, media count and type locally.

## Public media URL (Threads and TikTok photos)

Both APIs fetch media over the internet, so local files need a public URL:

```bash
# one-time tunnel while Relay is running on 4317
ngrok http 4317
# then, in .env:
RELAY_PUBLIC_MEDIA_BASE_URL=https://<random>.ngrok-free.app
```

Relay only exposes files under `.data/media/` at `/media/<name>` (path traversal is rejected), so
pointing a tunnel at the console is the intended setup. Keep the tunnel private/authenticated if
you are posting personal media.

## Verifying a live connection

- Console → Accounts: the platform badge should read **Live** after signing in; **Simulated** means
  credentials were not picked up (check Settings, `.env`, and that Relay was restarted).
- `GET /api/health` exposes the resolved mode.
- From MCP: `relay_console` reports per-platform `configured` / `live`, and `relay_accounts` shows
  the connected handle and mode.
- Publish a text-only post first; then try media and a thread. Results are per platform, so one
  failure does not hide the others.
