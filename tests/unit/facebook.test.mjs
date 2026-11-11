// Facebook Pages stays behind RELAY_ENABLE_FACEBOOK until Meta review is done.
import assert from "node:assert/strict";
import { test } from "node:test";
import { RelayService } from "@relay/core";
import { createAdapters } from "@relay/platforms";
import { FacebookAdapter } from "@relay/platforms";
import { PriceTable } from "../../packages/cloud/dist/index.js";
import { cleanupTempDir, makeTempDir } from "../helpers.mjs";

const connectedAt = "2026-01-01T00:00:00.000Z";

function formBodyOf(call) {
  const body = call.init?.body;
  if (body instanceof URLSearchParams) return Object.fromEntries(body);
  if (typeof body === "string") return Object.fromEntries(new URLSearchParams(body));
  return {};
}

function makeContext({ onFetch, env = {} } = {}) {
  const calls = [];
  const ctx = {
    dataDir: process.cwd(),
    env: { RELAY_ENABLE_FACEBOOK: "1", ...env },
    logger: () => {},
    fetch: async (url, init = {}) => {
      const call = { url: String(url), init };
      calls.push(call);
      const payload = await onFetch(call);
      if (payload instanceof Response) return payload;
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    },
    readMedia: async () => ({ buffer: Buffer.from("test"), mimeType: "image/png", filename: "test.png" }),
    mediaPublicUrl: (item) => item.url ?? null,
    credentials: () => ({ clientId: "fb-client", clientSecret: "fb-secret" }),
    now: () => new Date(connectedAt),
    forceMock: false,
    publicMediaBaseUrl: "https://media.test",
  };
  return { ctx, calls };
}

function input(media = [], options = {}) {
  return {
    account: {
      id: "facebook:page-1",
      platform: "facebook",
      handle: "Relay Demo Page",
      displayName: "Relay Demo Page",
      externalId: "page-1",
      mode: "live",
      connectedAt,
    },
    tokens: { accessToken: "page-token" },
    post: {
      platform: "facebook",
      parts: [{ text: "Hello from the Page", media }],
      options,
    },
  };
}

test("Facebook authorize requests the three Page permissions and the callback", async () => {
  const { ctx } = makeContext({ onFetch: () => ({}) });
  const result = await new FacebookAdapter().authorize(ctx, {
    state: "state-1",
    codeVerifier: "verifier",
    redirectUri: "https://relay.test/auth/callback/facebook",
  });
  assert.equal(result.kind, "redirect");
  const url = new URL(result.url);
  assert.equal(url.hostname, "www.facebook.com");
  assert.equal(url.searchParams.get("scope"), "pages_show_list,pages_read_engagement,pages_manage_posts");
  assert.equal(url.searchParams.get("redirect_uri"), "https://relay.test/auth/callback/facebook");
  assert.equal(url.searchParams.get("state"), "state-1");
});

test("Facebook code exchange stores the Page id, name and Page token", async () => {
  const { ctx, calls } = makeContext({
    onFetch: (call) => {
      const url = new URL(call.url);
      if (url.pathname.endsWith("/oauth/access_token") && url.searchParams.get("code")) return { access_token: "short-user" };
      if (url.pathname.endsWith("/oauth/access_token")) return { access_token: "long-user" };
      if (url.pathname.endsWith("/me/accounts")) {
        return {
          data: [
            { id: "page-1", name: "Relay Demo Page", access_token: "page-token", picture: { data: { url: "https://cdn.test/page.png" } } },
          ],
        };
      }
      throw new Error(`Unexpected Facebook request: ${call.url}`);
    },
  });
  const result = await new FacebookAdapter().exchange(ctx, {
    code: "code-1",
    state: "state-1",
    codeVerifier: "verifier",
    redirectUri: "https://relay.test/auth/callback/facebook",
  });
  assert.equal(result.profile.externalId, "page-1");
  assert.equal(result.profile.handle, "Relay Demo Page");
  assert.equal(result.profile.avatarUrl, "https://cdn.test/page.png");
  assert.equal(result.tokens.accessToken, "page-token");
  assert.equal(calls.length, 3);
});

test("Facebook publishes text, a link, one photo, a multi-photo post and a video", async () => {
  for (const [label, media, endpoint, expected] of [
    ["text", [], "/v23.0/page-1/feed", { message: "Hello from the Page" }],
    ["link", [], "/v23.0/page-1/feed", { link: "https://shop.test/item" }],
    ["photo", [{ kind: "image", url: "https://media.test/one.png" }], "/v23.0/page-1/photos", { url: "https://media.test/one.png" }],
    ["video", [{ kind: "video", url: "https://media.test/clip.mp4" }], "/v23.0/page-1/videos", { file_url: "https://media.test/clip.mp4" }],
  ]) {
    const { ctx, calls } = makeContext({ onFetch: () => ({ id: `${label}_1` }) });
    const draft = input(media);
    if (label === "link") draft.post.parts[0].text = "Shop here https://shop.test/item";
    const result = await new FacebookAdapter().publish(ctx, draft);
    assert.equal(result.platformPostId, `${label}_1`);
    assert.equal(new URL(calls[0].url).pathname, endpoint);
    for (const [key, value] of Object.entries(expected)) assert.equal(formBodyOf(calls[0])[key], value, `${label}: ${key}`);
  }
});

test("Facebook multi-photo posts use unpublished photos then attached_media", async () => {
  const { ctx, calls } = makeContext({
    onFetch: (call) => {
      const path = new URL(call.url).pathname;
      if (path.endsWith("/photos")) return { id: `photo-${calls.length}` };
      if (path.endsWith("/feed")) return { id: "multi-post-1" };
      throw new Error(`Unexpected Facebook request: ${call.url}`);
    },
  });
  const result = await new FacebookAdapter().publish(
    ctx,
    input([
      { kind: "image", url: "https://media.test/one.png" },
      { kind: "image", url: "https://media.test/two.png" },
    ]),
  );
  assert.equal(result.platformPostId, "multi-post-1");
  assert.equal(calls.length, 3);
  assert.equal(formBodyOf(calls[0]).published, "false");
  assert.deepEqual(JSON.parse(formBodyOf(calls[2])["attached_media[0]"]), { media_fbid: "photo-1" });
  assert.deepEqual(JSON.parse(formBodyOf(calls[2])["attached_media[1]"]), { media_fbid: "photo-2" });
});

test("Facebook turns a Page permission error into a reconnect message", async () => {
  const { ctx } = makeContext({
    onFetch: () => new Response(JSON.stringify({ error: { message: "(#10) Application does not have permission for this action", code: 10, type: "OAuthException" } }), {
      status: 403,
      headers: { "content-type": "application/json" },
    }),
  });
  await assert.rejects(
    () => new FacebookAdapter().publish(ctx, input()),
    (error) => error.code === "facebook_page_permission" && /Reconnect the Page/.test(error.message),
  );
});

test("Facebook refuses a second part and mixed video media", async () => {
  const { ctx } = makeContext({ onFetch: () => ({ id: "never" }) });
  await assert.rejects(
    () => new FacebookAdapter().publish(ctx, {
      ...input(),
      post: { platform: "facebook", parts: [{ text: "one", media: [] }, { text: "two", media: [] }], options: {} },
    }),
    (error) => error.code === "facebook_single_post_only",
  );
  await assert.rejects(
    () => new FacebookAdapter().publish(ctx, input([
      { kind: "video", url: "https://media.test/clip.mp4" },
      { kind: "image", url: "https://media.test/one.png" },
    ])),
    (error) => error.code === "facebook_video_mixed_media",
  );
});

test("Facebook is absent unless the feature flag is enabled", () => {
  assert.equal(createAdapters({ env: {} }).some((adapter) => adapter.platform === "facebook"), false);
  assert.equal(createAdapters({ env: { RELAY_ENABLE_FACEBOOK: "1" } }).some((adapter) => adapter.platform === "facebook"), true);
});

test("Facebook quotes text and video at the configured prices", () => {
  const prices = PriceTable.load("config/cloud-prices.json");
  const text = prices.quote({ platforms: ["facebook"], text: "hello" }, ["facebook"]);
  assert.equal(text.total, 20);
  const video = prices.quote({ platforms: ["facebook"], text: "hello", media: [{ kind: "video", url: "https://media.test/clip.mp4" }] }, ["facebook"]);
  assert.equal(video.total, 40);
});

test("a flagged Facebook platform can connect and publish in mock mode", async () => {
  const dataDir = await makeTempDir("relay-facebook-");
  let relay;
  try {
    relay = await RelayService.open({
      dataDir,
      adapters: createAdapters({ env: { RELAY_ENABLE_FACEBOOK: "1" } }),
      env: { RELAY_ENABLE_FACEBOOK: "1" },
      forceMock: true,
      logger: () => {},
    });
    await relay.beginConnect("facebook");
    const created = await relay.createPost({ platforms: ["facebook"], text: "Page post in mock mode" });
    assert.equal(created.results[0].ok, true);
    assert.equal(created.results[0].mode, "mock");
    const statuses = await relay.platformStatuses();
    assert.equal(statuses.some((entry) => entry.platform === "facebook"), true);
  } finally {
    await relay?.close();
    await cleanupTempDir(dataDir);
  }
});
