import assert from "node:assert/strict";
import { test } from "node:test";
import { LinkedInAdapter } from "@relay/platforms";

function makeContext(handler, options = {}) {
  const calls = [];
  const ctx = {
    dataDir: process.cwd(),
    env: {},
    logger: () => {},
    fetch: async (url, init = {}) => {
      const call = { url: String(url), init };
      calls.push(call);
      return handler(call);
    },
    readMedia: async () => ({ buffer: Buffer.from("media-bytes"), mimeType: "image/png", filename: "test.png" }),
    mediaPublicUrl: (item) => item.url ?? null,
    credentials: () => ({ clientId: "linkedin-client", clientSecret: "linkedin-secret" }),
    now: () => new Date("2026-11-01T00:00:00.000Z"),
    forceMock: false,
    publicMediaBaseUrl: null,
    ...options,
  };
  return { ctx, calls };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const account = {
  id: "acct_linkedin",
  platform: "linkedin",
  handle: "relay-demo",
  externalId: "member-123",
  mode: "live",
  connectedAt: "2026-11-01T00:00:00.000Z",
};

test("LinkedIn authorize requests OpenID and member publishing scopes", async () => {
  const { ctx } = makeContext(() => jsonResponse({}));
  const result = await new LinkedInAdapter().authorize(ctx, {
    state: "state-1",
    codeVerifier: "verifier",
    redirectUri: "https://relay.example/auth/callback/linkedin",
  });
  assert.equal(result.kind, "redirect");
  const url = new URL(result.url);
  assert.equal(url.origin + url.pathname, "https://www.linkedin.com/oauth/v2/authorization");
  assert.equal(url.searchParams.get("scope"), "openid profile w_member_social");
  assert.equal(url.searchParams.get("state"), "state-1");
  assert.equal(url.searchParams.get("redirect_uri"), "https://relay.example/auth/callback/linkedin");
});

test("LinkedIn exchange maps userinfo sub to the person identity", async () => {
  const { ctx } = makeContext((call) => {
    if (call.url.includes("accessToken")) return jsonResponse({ access_token: "access", expires_in: 3600, scope: "openid profile w_member_social" });
    if (call.url.includes("userinfo")) return jsonResponse({ sub: "member-123", name: "Relay Tester", picture: "https://img.example/a.png" });
    return jsonResponse({});
  });
  const result = await new LinkedInAdapter().exchange(ctx, {
    code: "code-1",
    state: "state-1",
    codeVerifier: "verifier",
    redirectUri: "https://relay.example/auth/callback/linkedin",
  });
  assert.equal(result.profile.externalId, "member-123");
  assert.equal(result.profile.displayName, "Relay Tester");
  assert.equal(result.tokens.accessToken, "access");
});

test("LinkedIn text post uses the versioned headers and reads x-restli-id", async () => {
  const { ctx, calls } = makeContext(() =>
    new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:123" } }),
  );
  const result = await new LinkedInAdapter().publish(ctx, {
    account,
    tokens: { accessToken: "token-1" },
    post: { platform: "linkedin", parts: [{ text: "Hello LinkedIn", media: [] }], options: {} },
  });
  assert.equal(result.platformPostId, "urn:li:share:123");
  assert.match(result.url, /urn%3Ali%3Ashare%3A123/);
  const post = calls.find((call) => call.url === "https://api.linkedin.com/rest/posts");
  assert.ok(post);
  assert.equal(post.init.headers["LinkedIn-Version"], "202608");
  assert.equal(post.init.headers["X-Restli-Protocol-Version"], "2.0.0");
  const body = JSON.parse(post.init.body);
  assert.equal(body.author, "urn:li:person:member-123");
  assert.equal(body.commentary, "Hello LinkedIn");
  assert.equal(body.lifecycleState, "PUBLISHED");
});

test("LinkedIn image post uploads an asset before creating the post", async () => {
  const { ctx, calls } = makeContext((call) => {
    if (call.url.includes("action=initializeUpload")) {
      return jsonResponse({ value: { uploadUrl: "https://upload.example/image", image: "urn:li:image:789" } });
    }
    if (call.url === "https://upload.example/image") return new Response("", { status: 200 });
    if (call.url === "https://api.linkedin.com/rest/posts") {
      return new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:456" } });
    }
    return jsonResponse({});
  });
  const result = await new LinkedInAdapter().publish(ctx, {
    account,
    tokens: { accessToken: "token-1" },
    post: {
      platform: "linkedin",
      parts: [{ text: "Image post", media: [{ kind: "image", path: "test.png" }] }],
      options: {},
    },
  });
  assert.equal(result.platformPostId, "urn:li:share:456");
  assert.ok(calls.some((call) => call.url.includes("action=initializeUpload")));
  assert.ok(calls.some((call) => call.url === "https://upload.example/image"));
  const post = calls.find((call) => call.url === "https://api.linkedin.com/rest/posts");
  assert.equal(JSON.parse(post.init.body).content.media.id, "urn:li:image:789");
});

test("LinkedIn video post initializes, uploads, finalizes, polls and posts", async () => {
  const { ctx, calls } = makeContext((call) => {
    if (call.url.includes("videos?action=initializeUpload")) {
      return jsonResponse({
        value: {
          video: "urn:li:video:555",
          uploadInstructions: [{ uploadUrl: "https://upload.example/video", firstByte: 0, lastByte: 10 }],
        },
      });
    }
    if (call.url === "https://upload.example/video") {
      return new Response("", { status: 200, headers: { etag: "part-1" } });
    }
    if (call.url.includes("videos?action=finalizeUpload")) return jsonResponse({});
    if (call.url.includes("urn%3Ali%3Avideo%3A555")) return jsonResponse({ status: "AVAILABLE" });
    if (call.url === "https://api.linkedin.com/rest/posts") {
      return new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:video" } });
    }
    return jsonResponse({});
  });
  const result = await new LinkedInAdapter().publish(ctx, {
    account,
    tokens: { accessToken: "token-1" },
    post: {
      platform: "linkedin",
      parts: [{ text: "Video post", media: [{ kind: "video", path: "test.mp4" }] }],
      options: {},
    },
  });
  assert.equal(result.platformPostId, "urn:li:share:video");
  assert.ok(calls.some((call) => call.url.includes("action=initializeUpload")));
  assert.ok(calls.some((call) => call.url === "https://upload.example/video"));
  assert.ok(calls.some((call) => call.url.includes("action=finalizeUpload")));
  assert.ok(calls.some((call) => call.url.includes("urn%3Ali%3Avideo%3A555")));
  const post = calls.find((call) => call.url === "https://api.linkedin.com/rest/posts");
  assert.equal(JSON.parse(post.init.body).content.media.id, "urn:li:video:555");
});

test("LinkedIn mock mode never calls live APIs", async () => {
  const { ctx, calls } = makeContext(() => jsonResponse({}), { forceMock: true });
  const result = await new LinkedInAdapter().publish(ctx, {
    account: { ...account, mode: "mock" },
    tokens: null,
    post: { platform: "linkedin", parts: [{ text: "Mock", media: [] }], options: {} },
  });
  assert.equal(result.mock, true);
  assert.equal(calls.length, 0);
});
