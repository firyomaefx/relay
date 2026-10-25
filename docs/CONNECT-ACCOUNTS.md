# Connect your real X, Threads and TikTok accounts

Relay can post for real, but each network only gives tokens to an **app registered in your name**.
That is the one-time setup below (about 10–15 minutes per platform). After the keys are saved in
Relay, connecting an account is one click — exactly like Metricool.

> Why does Metricool not ask for these keys? Because Metricool itself is the registered app. Your
> self-hosted Relay has to be its own app, so the apps must be created under your accounts.

Open the console (Start Menu → **Relay** → http://127.0.0.1:4317) → **Settings**. Each platform card
has an **Open developer portal** link, the **Redirect URI** with a **Copy** button, and the exact
scopes Relay requests.

## Start with X (easiest, ~10 minutes)

1. In Relay **Settings → X app**, click **Open X developer portal** and sign in with your X account.
2. If you have no developer account yet, apply for free access (choose the **Free** tier; it is
   enough for normal posting volume). Then create a **Project** and an **App**.
3. Open the app → **User authentication settings** → **Set up**:
   - App permissions: **Read and write**
   - Type of App: **Web App, Automated App or Bot**
   - Callback URI / Redirect URL: click **Copy** on the X card in Relay and paste it
     (`http://127.0.0.1:4317/auth/callback/x`)
   - Website URL: any URL you control, e.g. `https://x.com`
4. Save. Copy the app's **OAuth 2.0 Client ID** and **Client Secret**.
5. In Relay **Settings → X app**, paste both and click **Save** (they are encrypted at rest).
6. Go to **Accounts** → **Sign in with X**. A browser tab opens on x.com, you approve access, and
   the account flips from **Simulated** to **Live**. That's it — compose and publish for real.

Scopes Relay requests: `tweet.read tweet.write users.read offline.access media.write` (PKCE,
OAuth 2.0). Refresh tokens are stored so you only sign in once.

## Threads (Meta, ~10 minutes)

1. In Relay **Settings → Threads app**, click **Open Meta app dashboard**.
2. **Create app** → choose the **Threads** use case / add the **Threads API** product.
3. In the app settings, add the **Redirect URI** copied from Relay
   (`http://127.0.0.1:4317/auth/callback/threads`).
4. Copy the **App ID** (Client ID) and **App Secret**, paste into Relay's Threads card, **Save**.
5. **Accounts → Sign in with Threads**, approve, done.

Scopes: `threads_basic`, `threads_content_publish`, `threads_manage_replies`, `threads_read_replies`.
`threads_read_replies` is read-only and powers comment reading (`GET /api/threads/comments` and the
`relay_threads_comments` MCP tool). `threads_manage_replies` powers the **explicit** reply-to-comment
feature: `POST /api/threads/reply` with `{ "comment_id": "...", "text": "..." }`, or the
`relay_threads_reply` MCP tool. Either path returns `{ "id": "...", "permalink": "..." }` (the
permalink is optional). A reply is posted **only** when that endpoint or tool is called explicitly —
there are no scheduled replies, auto-replies, or batch auto-posting hooks. Media posts (images/video)
use public URLs — see **Public media** below. If Meta requires your app to be in Live mode, add your
own account as a tester/admin; app review is only needed when other people use your app.

> **Upgrading an existing Threads connection:** tokens issued before `threads_read_replies` /
> `threads_manage_replies` were added do not carry the new scopes. Disconnect and reconnect Threads
> (or use **Reconnect**) so Meta shows the new permissions and issues a token with them. Comment
> reading and replying then return error code `threads_scope_missing` (HTTP 403) instead of silently
> failing if the required scope is still absent. In mock mode the reply is simulated and no real
> Threads API call is made.

## TikTok (~15 minutes, plus review for public posts)

1. In Relay **Settings → TikTok app**, click **Open TikTok developer portal**.
2. Create an app, add **Login Kit** and **Content Posting API**. Add the Redirect URI copied from
   Relay (`http://127.0.0.1:4317/auth/callback/tiktok`) and the scopes
   `user.info.basic`, `video.publish`, `video.upload`.
3. **Sandbox → Target users:** while the app is in sandbox/staging mode, add the exact TikTok account
   you will sign in with. Without a target user, TikTok rejects the sign-in with
   `We couldn't log in with TikTok ... client_key`.
4. Copy the **Client key** and **Client secret** into Relay's TikTok card and **Save**.
5. **Accounts → Sign in with TikTok**, approve.

If TikTok insists on HTTPS for your app platform, add a **Desktop** platform and register the
loopback redirect (`http://127.0.0.1:*/…`, wildcard port), or use the HTTPS tunnel described below.
TikTok's PKCE challenge must be hex-encoded SHA-256 — Relay already handles this.

**Important:** until TikTok approves your app for **Direct Post**, the API only allows private
(`SELF_ONLY`) posts. In the composer's TikTok options choose **SELF_ONLY** while testing. Public
posting needs TikTok's content-posting audit — that is a review process only TikTok can grant, and
it is why Metricool can post publicly while a fresh personal app cannot.

## If a provider rejects the localhost redirect

X accepts `http://127.0.0.1` callbacks. Some Meta/TikTok app types insist on **HTTPS**. If you see a
"redirect URI mismatch" or "invalid redirect" error:

1. Expose the console through an HTTPS tunnel, e.g. `cloudflared tunnel --url http://127.0.0.1:4317`
   or `ngrok http 4317`.
2. Put the tunnel URL into Relay's `.env` as `RELAY_CONSOLE_URL=https://<tunnel-url>` and restart the
   Relay app.
3. Add `https://<tunnel-url>/auth/callback/<platform>` as the redirect URI in that provider's app.
4. Use the same tunnel URL while connecting.

Threads and TikTok **media** posts also fetch files from a public URL: set
`RELAY_PUBLIC_MEDIA_BASE_URL` to that same tunnel (Relay serves `/media/*`). X uploads files directly
and does not need this.

## Checking it worked

- **Accounts** shows the real handle with a **Live** badge.
- **Settings → Developer apps** shows the platform as configured (`saved` or `from env`).
- Publish a short text post to one platform first, then try media/threads.
- Errors from the provider are shown per platform in the composer result and in **History**.

## Troubleshooting

| Message / symptom | Fix |
| --- | --- |
| X: `Something went wrong — You weren't able to give access to the App` | Open the app's **User authentication settings**, fill in **Website URL**, **Callback URI** (exact, no trailing slash), permissions **Read and write**, app type **Web App, Automated App or Bot**, then **Save** and retry. This page usually means that form was never saved. |
| TikTok: `We couldn't log in with TikTok ... client_key` | Add your account under **Sandbox → Target users**, confirm **Login Kit** is enabled, and make the registered redirect URI byte-for-byte equal to the one in Relay. |
| `redirect_uri` mismatch | The URI in the provider app must exactly equal the one on the Relay card (scheme, port, path, no trailing slash). |
| `invalid_client` / unauthorized | Wrong client id/secret, or the app is not enabled for the OAuth product you use. |
| Sign-in opens but returns with an error | Check the console is running on the port in the redirect URI, and that no other process owns port 4317. |
| Account stays **Simulated** | Credentials were not saved/loaded. Re-open Settings; the card should say `saved`. Then disconnect and sign in again. |
| Threads reply returns `threads_scope_missing` (403) | The stored account lacks `threads_manage_replies`. Disconnect and reconnect Threads so Meta grants the reply-management scope. |
| Threads media fails preflight | Set `RELAY_PUBLIC_MEDIA_BASE_URL` (public tunnel) and reconnect; Threads fetches media by URL. |
| TikTok posts stay private | App not audited: use `SELF_ONLY` or apply for TikTok's audit. |

Need the console restarted? Right-click the Relay tray icon → **Exit**, then Start Menu → **Relay**.
