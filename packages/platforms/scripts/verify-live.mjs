/**
 * Exercises the live (non-mock) code paths of the X, Threads and TikTok
 * adapters with an injected fake fetch. Run after building:
 *
 *   npm run build -w @relay/platforms
 *   node packages/platforms/scripts/verify-live.mjs
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ThreadsAdapter, TikTokAdapter, XAdapter } from "../dist/index.js";
import { AuthError, RelayError } from "@relay/core";

let checks = 0;

async function check(label, fn) {
  const result = fn();
  if (result && typeof result.then === "function") await result;
  checks += 1;
  console.log(`ok ${checks} - ${label}`);
}

function context(handler, overrides = {}) {
  const calls = [];
  const fetchStub = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const record = {
      url,
      method: (init.method ?? "GET").toUpperCase(),
      headers: init.headers ?? {},
      body: init.body,
    };
    calls.push(record);
    return handler(record, calls);
  };
  const ctx = {
    dataDir: "C:/tmp/relay-data",
    env: {},
    fetch: fetchStub,
    logger: () => {},
    readMedia: async (item) =>
      item.kind === "video"
        ? { buffer: Buffer.alloc(9 * 1024 * 1024, 7), mimeType: "video/mp4", filename: "clip.mp4" }
        : { buffer: Buffer.from("fake-image-bytes"), mimeType: "image/jpeg", filename: "photo.jpg" },
    mediaPublicUrl: (item) => item.url ?? "https://public.example/media/photo.jpg",
    credentials: (platform) => ({ clientId: `client-${platform}`, clientSecret: `secret-${platform}` }),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    forceMock: false,
    publicMediaBaseUrl: "https://public.example",
    ...overrides,
  };
  return { ctx, calls };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function empty(status = 204) {
  return new Response(null, { status });
}

function jsonBody(record) {
  assert.equal(typeof record.body, "string", `expected JSON body for ${record.url}`);
  return JSON.parse(record.body);
}

function formBody(record) {
  if (record.body instanceof URLSearchParams) return record.body;
  if (typeof record.body === "string") return new URLSearchParams(record.body);
  throw new Error(`expected form body for ${record.url}`);
}

function formEntries(body) {
  assert.ok(body instanceof FormData, "expected a FormData body");
  return Object.fromEntries([...body.entries()].map(([key, value]) => [key, value instanceof Blob ? value : String(value)]));
}

function account(platform, handle, id) {
  return {
    id: id ?? `${platform}:acct-1`,
    platform,
    handle,
    mode: "live",
    connectedAt: "2026-01-01T00:00:00.000Z",
  };
}

function resolved(platform, parts, options = {}) {
  return {
    platform,
    parts: parts.map((part) => ({ text: part.text ?? "", media: part.media ?? [] })),
    options,
  };
}

function unexpected(record) {
  throw new Error(`unexpected ${record.method} ${record.url}`);
}

// ---------------------------------------------------------------------------
// X
// ---------------------------------------------------------------------------

async function testX() {
  console.log("\n# X (Twitter)");
  const adapter = new XAdapter();
  const verifier = "v".repeat(50);
  const redirectUri = "http://127.0.0.1:4317/auth/callback/x";

  {
    const { ctx, calls } = context(unexpected);
    const result = await adapter.authorize(ctx, { state: "state-x", codeVerifier: verifier, redirectUri });
    await check("X authorize: twitter.com PKCE redirect with required scopes", () => {
      assert.equal(result.kind, "redirect");
      const url = new URL(result.url);
      assert.equal(url.origin, "https://twitter.com");
      assert.equal(url.pathname, "/i/oauth2/authorize");
      assert.equal(url.searchParams.get("response_type"), "code");
      assert.equal(url.searchParams.get("client_id"), "client-x");
      assert.equal(url.searchParams.get("redirect_uri"), redirectUri);
      assert.equal(url.searchParams.get("scope"), "tweet.read tweet.write users.read offline.access media.write");
      assert.equal(url.searchParams.get("state"), "state-x");
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      assert.equal(url.searchParams.get("code_challenge"), createHash("sha256").update(verifier).digest("base64url"));
      assert.equal(calls.length, 0);
    });
  }

  {
    const { ctx, calls } = context(unexpected, { forceMock: true });
    const auth = await adapter.authorize(ctx, { state: "mock", codeVerifier: "mock", redirectUri });
    await check("X mock mode: authorize/publish stay offline and unchanged", async () => {
      assert.equal(auth.kind, "mock");
      assert.equal(auth.profile.handle, "relay_demo");
      assert.deepEqual(auth.scopes, ["tweet.read", "tweet.write", "users.read", "offline.access"]);
      const published = await adapter.publish(ctx, {
        account: account("x", "relay_demo"),
        tokens: null,
        post: resolved("x", [{ text: "hello" }]),
      });
      assert.equal(published.mock, true);
      assert.match(published.platformPostId, /^mock_x_/);
      assert.equal(calls.length, 0);
    });
  }

  {
    const { ctx, calls } = context((record) => {
      if (record.url === "https://api.x.com/2/oauth2/token") {
        return json({
          access_token: "x-access",
          refresh_token: "x-refresh",
          expires_in: 7200,
          token_type: "bearer",
          scope: "tweet.read tweet.write users.read offline.access media.write",
        });
      }
      if (record.url.startsWith("https://api.x.com/2/users/me")) {
        return json({
          data: { id: "42", name: "X User", username: "xuser", profile_image_url: "https://img.example/u.jpg" },
        });
      }
      return unexpected(record);
    });
    const result = await adapter.exchange(ctx, { code: "auth-code", state: "state-x", codeVerifier: verifier, redirectUri });
    await check("X exchange: basic-auth token POST + profile GET", () => {
      assert.equal(calls.length, 2);
      const tokenCall = calls[0];
      assert.equal(tokenCall.method, "POST");
      assert.equal(tokenCall.headers.Authorization, `Basic ${Buffer.from("client-x:secret-x").toString("base64")}`);
      assert.equal(tokenCall.headers["Content-Type"], "application/x-www-form-urlencoded");
      const body = formBody(tokenCall);
      assert.equal(body.get("grant_type"), "authorization_code");
      assert.equal(body.get("code"), "auth-code");
      assert.equal(body.get("redirect_uri"), redirectUri);
      assert.equal(body.get("code_verifier"), verifier);
      assert.equal(calls[1].url, "https://api.x.com/2/users/me?user.fields=profile_image_url");
      assert.equal(calls[1].headers.Authorization, "Bearer x-access");
      assert.deepEqual(result.profile, {
        externalId: "42",
        handle: "xuser",
        displayName: "X User",
        avatarUrl: "https://img.example/u.jpg",
      });
      assert.equal(result.tokens.accessToken, "x-access");
      assert.equal(result.tokens.refreshToken, "x-refresh");
      assert.equal(result.tokens.expiresAt, "2026-01-01T02:00:00.000Z");
      assert.deepEqual(result.scopes, ["tweet.read", "tweet.write", "users.read", "offline.access", "media.write"]);
    });
  }

  {
    let tweetIndex = 0;
    const { ctx, calls } = context((record) => {
      if (record.url === "https://api.x.com/2/media/upload") return json({ data: { id: "media-1" } });
      if (record.url === "https://api.x.com/2/tweets") {
        tweetIndex += 1;
        return json({ data: { id: String(99 + tweetIndex) } });
      }
      return unexpected(record);
    });
    const result = await adapter.publish(ctx, {
      account: account("x", "xuser"),
      tokens: { accessToken: "x-access", refreshToken: "x-refresh" },
      post: resolved(
        "x",
        [
          { text: "first", media: [{ path: "photo.jpg", kind: "image" }] },
          { text: "second" },
        ],
        { quotePostId: "999" },
      ),
    });
    await check("X publish: image multipart upload, thread reply chain, quote post", () => {
      assert.equal(calls[0].url, "https://api.x.com/2/media/upload");
      assert.equal(calls[0].headers.Authorization, "Bearer x-access");
      const entries = formEntries(calls[0].body);
      assert.equal(entries.media_category, "tweet_image");
      assert.ok(entries.media instanceof Blob);
      assert.equal(entries.media.type, "image/jpeg");
      const tweetCalls = calls.filter((call) => call.url === "https://api.x.com/2/tweets");
      assert.equal(tweetCalls.length, 2);
      assert.deepEqual(jsonBody(tweetCalls[0]), {
        text: "first",
        media: { media_ids: ["media-1"] },
        quote_tweet_id: "999",
      });
      assert.deepEqual(jsonBody(tweetCalls[1]), { text: "second", reply: { in_reply_to_tweet_id: "100" } });
      assert.equal(result.platformPostId, "100");
      assert.equal(result.url, "https://x.com/xuser/status/100");
      assert.equal(result.mock, false);
      assert.deepEqual(result.details.partIds, ["100", "101"]);
    });
  }

  {
    let appended = 0;
    const { ctx, calls } = context((record) => {
      if (record.url.endsWith("/2/media/upload/initialize")) return json({ data: { id: "media-v" } });
      if (record.url.includes("/2/media/upload/media-v/append")) {
        appended += 1;
        return empty(204);
      }
      if (record.url.endsWith("/2/media/upload/media-v/finalize")) {
        return json({ data: { id: "media-v", processing_info: { state: "pending", check_after_secs: 0 } } });
      }
      if (record.url.startsWith("https://api.x.com/2/media/upload?command=STATUS")) {
        return json({ data: { id: "media-v", processing_info: { state: "succeeded" } } });
      }
      if (record.url === "https://api.x.com/2/tweets") return json({ data: { id: "200" } });
      return unexpected(record);
    });
    const result = await adapter.publish(ctx, {
      account: account("x", "@xuser"),
      tokens: { accessToken: "x-access" },
      post: resolved("x", [{ text: "video post", media: [{ path: "clip.mp4", kind: "video" }] }]),
    });
    await check("X publish: chunked video upload + processing status poll", () => {
      assert.equal(appended, 3, "9 MiB video should upload in 4 MiB chunks");
      const init = jsonBody(calls.find((call) => call.url.endsWith("/initialize")));
      assert.equal(init.media_category, "tweet_video");
      assert.equal(init.media_type, "video/mp4");
      const statusCall = calls.find((call) => call.url.includes("command=STATUS"));
      assert.ok(statusCall);
      assert.match(statusCall.url, /media_id=media-v/);
      assert.equal(result.url, "https://x.com/xuser/status/200");
    });
  }

  {
    const { ctx } = context(() => json({ title: "Unauthorized", detail: "Invalid token" }, 401));
    await check("X publish: 401 becomes AuthError", async () => {
      await assert.rejects(
        adapter.publish(ctx, {
          account: account("x", "xuser"),
          tokens: { accessToken: "expired" },
          post: resolved("x", [{ text: "hi" }]),
        }),
        (error) => error instanceof AuthError && /Invalid token/.test(error.message),
      );
    });
  }

  {
    const { ctx, calls } = context(() =>
      json({ access_token: "x-new", refresh_token: "x-new-r", expires_in: 3600, token_type: "bearer" }),
    );
    const refreshed = await adapter.refresh(ctx, { accessToken: "x-old", refreshToken: "x-old-r", scope: "tweet.read" });
    await check("X refresh: refresh_token grant + rotated token + expiry", () => {
      assert.equal(calls[0].url, "https://api.x.com/2/oauth2/token");
      assert.equal(calls[0].headers.Authorization, `Basic ${Buffer.from("client-x:secret-x").toString("base64")}`);
      const body = formBody(calls[0]);
      assert.equal(body.get("grant_type"), "refresh_token");
      assert.equal(body.get("refresh_token"), "x-old-r");
      assert.equal(refreshed.accessToken, "x-new");
      assert.equal(refreshed.refreshToken, "x-new-r");
      assert.equal(refreshed.expiresAt, "2026-01-01T01:00:00.000Z");
      assert.equal(refreshed.scope, "tweet.read");
    });
  }
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

async function testThreads() {
  console.log("\n# Threads (Meta)");
  const adapter = new ThreadsAdapter();
  const redirectUri = "http://127.0.0.1:4317/auth/callback/threads";
  const liveAccount = account("threads", "threader", "threads:77");
  const liveTokens = { accessToken: "threads-long", refreshToken: "threads-long" };

  {
    const { ctx, calls } = context(unexpected);
    const result = await adapter.authorize(ctx, { state: "state-t", codeVerifier: "ignored", redirectUri });
    await check("Threads authorize: threads.net dialog with publish scopes", () => {
      assert.equal(result.kind, "redirect");
      const url = new URL(result.url);
      assert.equal(url.origin, "https://threads.net");
      assert.equal(url.pathname, "/oauth/authorize");
      assert.equal(url.searchParams.get("client_id"), "client-threads");
      assert.equal(url.searchParams.get("redirect_uri"), redirectUri);
      assert.equal(url.searchParams.get("scope"), "threads_basic,threads_content_publish,threads_manage_replies");
      assert.equal(url.searchParams.get("response_type"), "code");
      assert.equal(url.searchParams.get("state"), "state-t");
      assert.equal(calls.length, 0);
    });
  }

  {
    const { ctx, calls } = context((record) => {
      if (record.url === "https://graph.threads.net/oauth/access_token") {
        return json({ access_token: "threads-short", user_id: "77" });
      }
      if (record.url.startsWith("https://graph.threads.net/access_token?")) {
        return json({ access_token: "threads-long", token_type: "bearer", expires_in: 5184000 });
      }
      if (record.url.startsWith("https://graph.threads.net/v1.0/me?")) {
        return json({
          id: "77",
          username: "threader",
          threads_profile_picture_url: "https://pic.example/t.jpg",
        });
      }
      return unexpected(record);
    });
    const result = await adapter.exchange(ctx, { code: "code-t", state: "state-t", codeVerifier: "ignored", redirectUri });
    await check("Threads exchange: short -> long-lived token + profile", () => {
      assert.equal(calls.length, 3);
      const tokenCall = calls[0];
      assert.equal(tokenCall.method, "POST");
      const tokenBody = formBody(tokenCall);
      assert.equal(tokenBody.get("client_id"), "client-threads");
      assert.equal(tokenBody.get("client_secret"), "secret-threads");
      assert.equal(tokenBody.get("grant_type"), "authorization_code");
      assert.equal(tokenBody.get("code"), "code-t");
      assert.equal(tokenBody.get("redirect_uri"), redirectUri);

      const longCall = calls[1];
      assert.equal(longCall.method, "GET");
      const longUrl = new URL(longCall.url);
      assert.equal(longUrl.pathname, "/access_token");
      assert.equal(longUrl.searchParams.get("grant_type"), "th_exchange_token");
      assert.equal(longUrl.searchParams.get("client_secret"), "secret-threads");
      assert.equal(longUrl.searchParams.get("access_token"), "threads-short");

      assert.equal(calls[2].headers.Authorization, "Bearer threads-long");
      assert.deepEqual(result.profile, {
        externalId: "77",
        handle: "threader",
        displayName: "threader",
        avatarUrl: "https://pic.example/t.jpg",
      });
      assert.equal(result.tokens.accessToken, "threads-long");
      assert.equal(result.tokens.refreshToken, "threads-long");
      assert.equal(result.tokens.expiresAt, "2026-03-02T00:00:00.000Z");
      assert.deepEqual(result.scopes, ["threads_basic", "threads_content_publish", "threads_manage_replies"]);
    });
  }

  {
    let containerIndex = 0;
    const containers = [];
    const { ctx, calls } = context((record) => {
      if (record.url === "https://graph.threads.net/v1.0/77/threads") {
        containerIndex += 1;
        const id = `container-${containerIndex}`;
        containers.push({ id, params: formBody(record) });
        return json({ id });
      }
      if (record.url === "https://graph.threads.net/v1.0/77/threads_publish") {
        const creationId = formBody(record).get("creation_id");
        return json({ id: creationId.replace("container", "post") });
      }
      return unexpected(record);
    });
    const result = await adapter.publish(ctx, {
      account: liveAccount,
      tokens: liveTokens,
      post: resolved("threads", [
        { text: "first", media: [{ path: "photo.jpg", kind: "image" }] },
        { text: "second" },
      ]),
    });
    await check("Threads publish: image container + reply chain to published id", () => {
      assert.equal(containers.length, 2);
      assert.equal(containers[0].params.get("media_type"), "IMAGE");
      assert.equal(containers[0].params.get("image_url"), "https://public.example/media/photo.jpg");
      assert.equal(containers[0].params.get("text"), "first");
      assert.equal(containers[0].params.get("reply_to_id"), null);
      assert.equal(containers[1].params.get("media_type"), "TEXT");
      assert.equal(containers[1].params.get("reply_to_id"), "post-1");
      assert.equal(calls.length, 4);
      assert.equal(result.platformPostId, "post-1");
      assert.equal(result.url, "https://www.threads.net/@threader/post/post-1");
      assert.equal(result.mock, false);
      assert.equal(result.details.parts.length, 2);
    });
  }

  {
    let statusCalls = 0;
    const { ctx, calls } = context((record) => {
      if (record.url === "https://graph.threads.net/v1.0/77/threads") return json({ id: "container-v" });
      if (record.url.startsWith("https://graph.threads.net/v1.0/container-v?fields=status,error_message")) {
        statusCalls += 1;
        return json(statusCalls === 1 ? { status: "IN_PROGRESS" } : { status: "FINISHED" });
      }
      if (record.url === "https://graph.threads.net/v1.0/77/threads_publish") return json({ id: "post-v" });
      return unexpected(record);
    });
    const result = await adapter.publish(ctx, {
      account: liveAccount,
      tokens: liveTokens,
      post: resolved("threads", [{ text: "video", media: [{ path: "clip.mp4", kind: "video" }] }]),
    });
    await check("Threads publish: video polling until FINISHED, then publish", () => {
      assert.equal(statusCalls, 2);
      const create = calls.find((call) => call.url === "https://graph.threads.net/v1.0/77/threads");
      assert.equal(formBody(create).get("media_type"), "VIDEO");
      assert.equal(formBody(create).get("video_url"), "https://public.example/media/photo.jpg");
      assert.equal(result.platformPostId, "post-v");
    });
  }

  {
    const { ctx, calls } = context((record) => {
      if (record.url === "https://graph.threads.net/v1.0/77/threads") return json({ id: "container-bad" });
      if (record.url.startsWith("https://graph.threads.net/v1.0/container-bad?fields=status,error_message")) {
        return json({ status: "ERROR", error_message: "Unsupported video codec" });
      }
      if (record.url === "https://graph.threads.net/v1.0/77/threads_publish") return json({ id: "should-not-publish" });
      return unexpected(record);
    });
    await check("Threads publish: video ERROR fails with provider message and no publish", async () => {
      await assert.rejects(
        adapter.publish(ctx, {
          account: liveAccount,
          tokens: liveTokens,
          post: resolved("threads", [{ text: "video", media: [{ path: "clip.mp4", kind: "video" }] }]),
        }),
        (error) => error instanceof RelayError && /Unsupported video codec/.test(error.message),
      );
      assert.equal(calls.some((call) => call.url.endsWith("/threads_publish")), false);
    });
  }

  {
    const { ctx } = context(unexpected, { mediaPublicUrl: () => null });
    await check("Threads publish: missing public media URL is an actionable RelayError", async () => {
      await assert.rejects(
        adapter.publish(ctx, {
          account: liveAccount,
          tokens: liveTokens,
          post: resolved("threads", [{ text: "img", media: [{ path: "photo.jpg", kind: "image" }] }]),
        }),
        (error) =>
          error instanceof RelayError &&
          error.code === "media_public_url_required" &&
          /RELAY_PUBLIC_MEDIA_BASE_URL/.test(error.message),
      );
    });
  }

  {
    const { ctx } = context(() => json({ error: { message: "Invalid OAuth access token", type: "OAuthException", code: 190 } }, 400));
    await check("Threads publish: Graph OAuthException maps to AuthError", async () => {
      await assert.rejects(
        adapter.publish(ctx, {
          account: liveAccount,
          tokens: liveTokens,
          post: resolved("threads", [{ text: "hi" }]),
        }),
        (error) => error instanceof AuthError && /Invalid OAuth access token/.test(error.message),
      );
    });
  }

  {
    const { ctx, calls } = context(() => json({ access_token: "threads-refreshed", token_type: "bearer", expires_in: 5184000 }));
    const refreshed = await adapter.refresh(ctx, { accessToken: "threads-long", refreshToken: "threads-long" });
    await check("Threads refresh: refresh_access_token with current long-lived token", () => {
      assert.equal(calls[0].method, "GET");
      const url = new URL(calls[0].url);
      assert.equal(url.pathname, "/refresh_access_token");
      assert.equal(url.searchParams.get("grant_type"), "th_refresh_token");
      assert.equal(url.searchParams.get("access_token"), "threads-long");
      assert.equal(refreshed.accessToken, "threads-refreshed");
      assert.equal(refreshed.refreshToken, "threads-refreshed");
      assert.equal(refreshed.expiresAt, "2026-03-02T00:00:00.000Z");
    });
  }

  {
    const { ctx, calls } = context(unexpected, { forceMock: true });
    const published = await adapter.publish(ctx, {
      account: account("threads", "relay.demo"),
      tokens: null,
      post: resolved("threads", [{ text: "hello" }]),
    });
    await check("Threads mock mode: publish stays offline", () => {
      assert.equal(published.mock, true);
      assert.match(published.platformPostId, /^mock_threads_/);
      assert.equal(calls.length, 0);
    });
  }
}

// ---------------------------------------------------------------------------
// TikTok
// ---------------------------------------------------------------------------

async function testTikTok() {
  console.log("\n# TikTok");
  const adapter = new TikTokAdapter();
  const redirectUri = "http://127.0.0.1:4317/auth/callback/tiktok";
  const liveAccount = account("tiktok", "Tik User", "tiktok:open-123");
  const liveTokens = { accessToken: "tt-access", refreshToken: "tt-refresh" };
  const verifier = "w".repeat(50);

  {
    const { ctx, calls } = context(unexpected);
    const result = await adapter.authorize(ctx, { state: "state-k", codeVerifier: verifier, redirectUri });
    await check("TikTok authorize: PKCE authorize URL with publish scopes", () => {
      assert.equal(result.kind, "redirect");
      const url = new URL(result.url);
      assert.equal(url.origin, "https://www.tiktok.com");
      assert.equal(url.pathname, "/v2/auth/authorize/");
      assert.equal(url.searchParams.get("client_key"), "client-tiktok");
      assert.equal(url.searchParams.get("response_type"), "code");
      assert.equal(url.searchParams.get("scope"), "user.info.basic,video.publish,video.upload");
      assert.equal(url.searchParams.get("redirect_uri"), redirectUri);
      assert.equal(url.searchParams.get("state"), "state-k");
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      // TikTok deviates from RFC 7636: it expects lowercase hex, not base64url.
      assert.equal(url.searchParams.get("code_challenge"), createHash("sha256").update(verifier).digest("hex"));
      assert.match(url.searchParams.get("code_challenge"), /^[0-9a-f]{64}$/);
      assert.equal(calls.length, 0);
    });
  }

  {
    const { ctx, calls } = context((record) => {
      if (record.url === "https://open.tiktokapis.com/v2/oauth/token/") {
        return json({
          access_token: "tt-access",
          expires_in: 86400,
          open_id: "open-123",
          refresh_expires_in: 31536000,
          refresh_token: "tt-refresh",
          scope: "user.info.basic,video.publish,video.upload",
          token_type: "Bearer",
        });
      }
      if (record.url.startsWith("https://open.tiktokapis.com/v2/user/info/")) {
        return json({
          data: { user: { open_id: "open-123", avatar_url: "https://avatar.example/t.jpg", display_name: "Tik User" } },
          error: { code: "ok", message: "", log_id: "" },
        });
      }
      return unexpected(record);
    });
    const result = await adapter.exchange(ctx, { code: "code-k", state: "state-k", codeVerifier: verifier, redirectUri });
    await check("TikTok exchange: form token POST with PKCE verifier + user info", () => {
      assert.equal(calls.length, 2);
      const tokenCall = calls[0];
      assert.equal(tokenCall.method, "POST");
      const body = formBody(tokenCall);
      assert.equal(body.get("client_key"), "client-tiktok");
      assert.equal(body.get("client_secret"), "secret-tiktok");
      assert.equal(body.get("code"), "code-k");
      assert.equal(body.get("grant_type"), "authorization_code");
      assert.equal(body.get("redirect_uri"), redirectUri);
      assert.equal(body.get("code_verifier"), verifier);
      assert.equal(calls[1].url, "https://open.tiktokapis.com/v2/user/info/?fields=open_id,avatar_url,display_name");
      assert.equal(calls[1].headers.Authorization, "Bearer tt-access");
      assert.deepEqual(result.profile, {
        externalId: "open-123",
        handle: "Tik User",
        displayName: "Tik User",
        avatarUrl: "https://avatar.example/t.jpg",
      });
      assert.equal(result.tokens.expiresAt, "2026-01-02T00:00:00.000Z");
      assert.deepEqual(result.scopes, ["user.info.basic", "video.publish", "video.upload"]);
    });
  }

  {
    let statusCalls = 0;
    const { ctx, calls } = context((record) => {
      if (record.url === "https://open.tiktokapis.com/v2/post/publish/video/init/") {
        return json({ data: { publish_id: "pub-1", upload_url: "https://upload.example/tt" }, error: { code: "ok" } });
      }
      if (record.url === "https://upload.example/tt") {
        assert.equal(record.method, "PUT");
        return empty(201);
      }
      if (record.url === "https://open.tiktokapis.com/v2/post/publish/status/fetch/") {
        statusCalls += 1;
        return json(
          statusCalls === 1
            ? { data: { publish_id: "pub-1", status: "PROCESSING_UPLOAD", uploaded_bytes: 1 }, error: { code: "ok" } }
            : { data: { publish_id: "pub-1", status: "PUBLISH_COMPLETE" }, error: { code: "ok" } },
        );
      }
      return unexpected(record);
    });
    const result = await adapter.publish(ctx, {
      account: liveAccount,
      tokens: liveTokens,
      post: resolved("tiktok", [{ text: "my video", media: [{ path: "clip.mp4", kind: "video" }] }], {
        selfOnly: true,
        disableComment: true,
      }),
    });
    await check("TikTok publish video: init, chunk PUT, status poll, SELF_ONLY", () => {
      const initCall = calls.find((call) => call.url.endsWith("/video/init/"));
      const initBody = jsonBody(initCall);
      assert.deepEqual(initBody.post_info, {
        title: "my video",
        privacy_level: "SELF_ONLY",
        disable_comment: true,
      });
      assert.equal(initBody.source_info.source, "FILE_UPLOAD");
      assert.equal(initBody.source_info.video_size, 9 * 1024 * 1024);
      assert.equal(initBody.source_info.chunk_size, 9 * 1024 * 1024);
      assert.equal(initBody.source_info.total_chunk_count, 1);
      assert.equal(initCall.headers.Authorization, "Bearer tt-access");

      const upload = calls.find((call) => call.url === "https://upload.example/tt");
      assert.equal(upload.headers["Content-Type"], "video/mp4");
      assert.equal(upload.headers["Content-Range"], `bytes 0-${9 * 1024 * 1024 - 1}/${9 * 1024 * 1024}`);
      assert.equal(upload.headers["Content-Length"], String(9 * 1024 * 1024));

      assert.equal(statusCalls, 2);
      const statusCall = calls.find((call) => call.url.endsWith("/publish/status/fetch/"));
      assert.deepEqual(jsonBody(statusCall), { publish_id: "pub-1" });
      assert.equal(result.platformPostId, "pub-1");
      assert.equal(result.mock, false);
      assert.equal(result.details.mediaType, "video");
      assert.equal(result.details.privacy, "SELF_ONLY");
      assert.equal(result.details.status, "PUBLISH_COMPLETE");
    });
  }

  {
    const bigBuffer = Buffer.alloc(65 * 1024 * 1024, 3);
    const { ctx, calls } = context((record) => {
      if (record.url === "https://open.tiktokapis.com/v2/post/publish/video/init/") {
        return json({ data: { publish_id: "pub-big", upload_url: "https://upload.example/big" }, error: { code: "ok" } });
      }
      if (record.url === "https://upload.example/big") return empty(201);
      if (record.url === "https://open.tiktokapis.com/v2/post/publish/status/fetch/") {
        return json({ data: { publish_id: "pub-big", status: "PUBLISH_COMPLETE" }, error: { code: "ok" } });
      }
      return unexpected(record);
    }, { readMedia: async () => ({ buffer: bigBuffer, mimeType: "video/mp4", filename: "big.mp4" }) });
    const result = await adapter.publish(ctx, {
      account: liveAccount,
      tokens: liveTokens,
      post: resolved("tiktok", [{ text: "big video", media: [{ path: "big.mp4", kind: "video" }] }]),
    });
    await check("TikTok video: multi-chunk floor math with oversized final chunk", () => {
      const init = jsonBody(calls[0]);
      assert.equal(init.source_info.chunk_size, 10 * 1024 * 1024);
      assert.equal(init.source_info.total_chunk_count, 6);
      const uploads = calls.filter((call) => call.url === "https://upload.example/big");
      assert.equal(uploads.length, 6);
      assert.equal(uploads[0].headers["Content-Range"], `bytes 0-${10 * 1024 * 1024 - 1}/${65 * 1024 * 1024}`);
      const last = uploads[uploads.length - 1];
      assert.equal(last.headers["Content-Range"], `bytes ${50 * 1024 * 1024}-${65 * 1024 * 1024 - 1}/${65 * 1024 * 1024}`);
      assert.equal(last.headers["Content-Length"], String(15 * 1024 * 1024));
      assert.equal(result.platformPostId, "pub-big");
    });
  }

  {
    const { ctx, calls } = context((record) => {
      if (record.url === "https://open.tiktokapis.com/v2/post/publish/content/init/") {
        return json({ data: { publish_id: "pub-2" }, error: { code: "ok" } });
      }
      if (record.url === "https://open.tiktokapis.com/v2/post/publish/status/fetch/") {
        return json({ data: { publish_id: "pub-2", status: "PUBLISH_COMPLETE" }, error: { code: "ok" } });
      }
      return unexpected(record);
    });
    const result = await adapter.publish(ctx, {
      account: liveAccount,
      tokens: liveTokens,
      post: resolved("tiktok", [
        {
          text: "photo carousel",
          media: [
            { url: "https://public.example/a.jpg", kind: "image" },
            { url: "https://public.example/b.jpg", kind: "image" },
          ],
        },
      ], { tiktokPrivacy: "MUTUAL_FOLLOW_FRIENDS", disableComment: false }),
    });
    await check("TikTok publish photos: PULL_FROM_URL carousel + privacy option", () => {
      const init = jsonBody(calls.find((call) => call.url.endsWith("/content/init/")));
      assert.equal(init.media_type, "PHOTO");
      assert.equal(init.post_mode, "DIRECT_POST");
      assert.equal(init.post_info.privacy_level, "MUTUAL_FOLLOW_FRIENDS");
      assert.equal(init.source_info.source, "PULL_FROM_URL");
      assert.equal(init.source_info.photo_cover_index, 0);
      assert.deepEqual(init.source_info.photo_images, ["https://public.example/a.jpg", "https://public.example/b.jpg"]);
      assert.equal(result.platformPostId, "pub-2");
      assert.equal(result.details.mediaType, "photo");
    });
  }

  {
    const { ctx } = context(unexpected, { mediaPublicUrl: () => null });
    await check("TikTok photo publish: missing public URL is an actionable RelayError", async () => {
      await assert.rejects(
        adapter.publish(ctx, {
          account: liveAccount,
          tokens: liveTokens,
          post: resolved("tiktok", [{ text: "photo", media: [{ path: "photo.jpg", kind: "image" }] }]),
        }),
        (error) => error instanceof RelayError && error.code === "media_public_url_required",
      );
    });
  }

  {
    const { ctx } = context(() => json({ error: { code: "access_token_invalid", message: "Access token is invalid" } }, 401));
    await check("TikTok 401 token failure becomes AuthError", async () => {
      await assert.rejects(
        adapter.publish(ctx, {
          account: liveAccount,
          tokens: liveTokens,
          post: resolved("tiktok", [{ text: "video", media: [{ path: "clip.mp4", kind: "video" }] }]),
        }),
        (error) => error instanceof AuthError && /Access token is invalid/.test(error.message),
      );
    });
  }

  {
    const { ctx } = context((record) => {
      if (record.url === "https://open.tiktokapis.com/v2/post/publish/content/init/") {
        return json({ data: { publish_id: "pub-3" }, error: { code: "ok" } });
      }
      if (record.url === "https://open.tiktokapis.com/v2/post/publish/status/fetch/") {
        // TikTok reports some failures with HTTP 200 and a non-"ok" error.code.
        return json({ data: {}, error: { code: "publish_id_invalid", message: "Invalid publish id" } });
      }
      return unexpected(record);
    });
    await check("TikTok HTTP-200 error envelope becomes RelayError", async () => {
      await assert.rejects(
        adapter.publish(ctx, {
          account: liveAccount,
          tokens: liveTokens,
          post: resolved("tiktok", [{ text: "photo", media: [{ url: "https://public.example/a.jpg", kind: "image" }] }]),
        }),
        (error) => error instanceof RelayError && /Invalid publish id/.test(error.message),
      );
    });
  }

  {
    const { ctx, calls } = context(() =>
      json({ access_token: "tt-new", refresh_token: "tt-new-r", expires_in: 3600, token_type: "Bearer" }),
    );
    const refreshed = await adapter.refresh(ctx, { accessToken: "tt-old", refreshToken: "tt-old-r", scope: "video.publish" });
    await check("TikTok refresh: refresh_token grant", () => {
      assert.equal(calls[0].url, "https://open.tiktokapis.com/v2/oauth/token/");
      const body = formBody(calls[0]);
      assert.equal(body.get("client_key"), "client-tiktok");
      assert.equal(body.get("client_secret"), "secret-tiktok");
      assert.equal(body.get("grant_type"), "refresh_token");
      assert.equal(body.get("refresh_token"), "tt-old-r");
      assert.equal(refreshed.accessToken, "tt-new");
      assert.equal(refreshed.refreshToken, "tt-new-r");
      assert.equal(refreshed.expiresAt, "2026-01-01T01:00:00.000Z");
      assert.equal(refreshed.scope, "video.publish");
    });
  }

  {
    const { ctx, calls } = context(unexpected, { forceMock: true });
    const published = await adapter.publish(ctx, {
      account: account("tiktok", "relaydemo"),
      tokens: null,
      post: resolved("tiktok", [{ text: "hello", media: [{ path: "clip.mp4", kind: "video" }] }]),
    });
    await check("TikTok mock mode: publish stays offline and unchanged", () => {
      assert.equal(published.mock, true);
      assert.match(published.platformPostId, /^mock_tiktok_/);
      assert.equal(calls.length, 0);
    });
  }
}

await testX();
await testThreads();
await testTikTok();
console.log(`\nAll ${checks} live-adapter checks passed.`);
