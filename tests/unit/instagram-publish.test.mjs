import assert from "node:assert/strict";
import { test } from "node:test";
import { InstagramAdapter } from "@relay/platforms";

// Traceability: REQ-016
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const notReady = () => json({ error: { message: "The media is not ready to be published. Please wait a moment.", type: "OAuthException", code: 9007, error_subcode: 2207027 } }, 400);

const account = { id: "instagram:17841", platform: "instagram", handle: "demo", mode: "live", connectedAt: "2026-01-01T00:00:00.000Z", scopes: [] };

function setup(handler) {
  const calls = [];
  const logs = [];
  const ctx = {
    dataDir: process.cwd(),
    env: { RELAY_INSTAGRAM_INITIAL_WAIT_MS: "0", RELAY_INSTAGRAM_POLL_INTERVAL_MS: "0", RELAY_INSTAGRAM_PUBLISH_RETRY_BASE_MS: "0" },
    fetch: async (url, init = {}) => {
      const call = { url: String(url), method: init.method ?? "GET", body: init.body ? String(init.body) : "" };
      calls.push(call);
      return handler(call, calls);
    },
    logger: (m) => logs.push(m),
    readMedia: async () => { throw new Error("not used"); },
    mediaPublicUrl: (item) => item.url ?? null,
    credentials: () => ({ clientId: "cid", clientSecret: "secret" }),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    forceMock: false,
    publicMediaBaseUrl: null,
  };
  return { ctx, calls, logs };
}

const input = (media) => ({ account, tokens: { accessToken: "tok" }, post: { platform: "instagram", parts: [{ text: "cap", media }], options: {} } });
const image = (n) => ({ kind: "image", url: `https://m.example/${n}.jpg`, mimeType: "image/jpeg" });
const video = { kind: "video", url: "https://m.example/v.mp4", mimeType: "video/mp4" };
const isPublish = (c) => c.url.endsWith("/media_publish");
const isStatus = (c) => c.url.includes("fields=status_code");
const isCreate = (c) => c.method === "POST" && c.url.endsWith("/media");

function happy(statusFor = () => "FINISHED") {
  return (call) => {
    if (isCreate(call)) return json({ id: `c${Math.random().toString(36).slice(2, 8)}` });
    if (isStatus(call)) return json({ status_code: statusFor(call) });
    if (isPublish(call)) return json({ id: "media-1" });
    return json({ permalink: "https://instagram.com/p/x" });
  };
}

test("single image: polls status_code before media_publish", async () => {
  const { ctx, calls } = setup(happy());
  const result = await new InstagramAdapter().publish(ctx, input([image(1)]));
  assert.equal(result.platformPostId, "media-1");
  const order = calls.map((c) => (isCreate(c) ? "create" : isStatus(c) ? "status" : isPublish(c) ? "publish" : "other"));
  assert.deepEqual(order.slice(0, 3), ["create", "status", "publish"]);
});

test("image container IN_PROGRESS twice then FINISHED: publishes once, after FINISHED", async () => {
  let n = 0;
  const { ctx, calls } = setup(happy(() => (++n < 3 ? "IN_PROGRESS" : "FINISHED")));
  await new InstagramAdapter().publish(ctx, input([image(1)]));
  assert.equal(calls.filter(isStatus).length, 3);
  assert.equal(calls.filter(isPublish).length, 1);
  assert.ok(calls.findIndex(isPublish) > calls.map(isStatus).lastIndexOf(true));
});

test("carousel: every child and the parent are polled before publishing", async () => {
  const { ctx, calls } = setup(happy());
  await new InstagramAdapter().publish(ctx, input([image(1), image(2), image(3)]));
  const creates = calls.filter(isCreate);
  assert.equal(creates.length, 4);
  const lastChildCreate = calls.indexOf(creates[2]);
  const parentCreate = calls.indexOf(creates[3]);
  const statusIdx = calls.map((c, i) => (isStatus(c) ? i : -1)).filter((i) => i >= 0);
  assert.equal(statusIdx.length, 4);
  assert.ok(statusIdx.slice(0, 3).every((i) => i > lastChildCreate && i < parentCreate), "children polled before parent is created");
  assert.ok(statusIdx[3] > parentCreate && statusIdx[3] < calls.findIndex(isPublish));
  assert.equal(calls.filter(isPublish).length, 1);
});

test("Reel: waits for processing and publishes once", async () => {
  let n = 0;
  const { ctx, calls } = setup(happy(() => (++n < 5 ? "IN_PROGRESS" : "FINISHED")));
  const result = await new InstagramAdapter().publish(ctx, input([video]));
  assert.equal(result.details.mediaType, "REELS");
  assert.equal(calls.filter(isStatus).length, 5);
  assert.equal(calls.filter(isPublish).length, 1);
});

test("media_publish 9007/2207027 is retried on the same container, then succeeds", async () => {
  let publishes = 0;
  const base = happy();
  const { ctx, calls, logs } = setup((call, all) => {
    if (isPublish(call) && ++publishes < 3) return notReady();
    return base(call, all);
  });
  const result = await new InstagramAdapter().publish(ctx, input([image(1)]));
  assert.equal(result.platformPostId, "media-1");
  const publishCalls = calls.filter(isPublish);
  assert.equal(publishCalls.length, 3);
  assert.equal(new Set(publishCalls.map((c) => c.body)).size, 1, "same creation_id every time");
  assert.equal(calls.filter(isCreate).length, 1, "no duplicate container");
  assert.equal(logs.length, 2);
});

test("media_publish keeps answering 9007: gives up after 5 attempts, as a non-auth error (no token refresh replay)", async () => {
  const base = happy();
  const { ctx, calls } = setup((call, all) => (isPublish(call) ? notReady() : base(call, all)));
  await assert.rejects(() => new InstagramAdapter().publish(ctx, input([image(1)])), (e) => e.code === "instagram_media_not_ready" && /not ready/i.test(e.message));
  assert.equal(calls.filter(isPublish).length, 5);
  assert.equal(calls.filter(isCreate).length, 1);
});

test("other publish errors are NOT retried (could have posted)", async () => {
  const base = happy();
  for (const failure of [
    () => json({ error: { message: "Server hiccup", code: 2, is_transient: true } }, 500),
    () => json({ error: { message: "Invalid parameter", code: 100, error_subcode: 2207026 } }, 400),
  ]) {
    const { ctx, calls } = setup((call, all) => (isPublish(call) ? failure() : base(call, all)));
    await assert.rejects(() => new InstagramAdapter().publish(ctx, input([image(1)])));
    assert.equal(calls.filter(isPublish).length, 1);
  }
  const { ctx, calls } = setup((call, all) => {
    if (isPublish(call)) throw new TypeError("socket hang up");
    return base(call, all);
  });
  await assert.rejects(() => new InstagramAdapter().publish(ctx, input([image(1)])), (e) => e.code === "provider_network_error");
  assert.equal(calls.filter(isPublish).length, 1);
});

test("container ERROR or EXPIRED fails clearly and never publishes", async () => {
  for (const status of ["ERROR", "EXPIRED"]) {
    const { ctx, calls } = setup(happy(() => status));
    await assert.rejects(() => new InstagramAdapter().publish(ctx, input([image(1)])), (e) => e.code === "instagram_media_processing_failed" && e.message.includes(status));
    assert.equal(calls.filter(isPublish).length, 0);
  }
});

test("container stuck IN_PROGRESS: times out without publishing", async () => {
  const { ctx, calls } = setup(happy(() => "IN_PROGRESS"));
  await assert.rejects(() => new InstagramAdapter().publish(ctx, input([image(1)])), (e) => e.code === "instagram_media_processing_timeout");
  assert.equal(calls.filter(isStatus).length, 40);
  assert.equal(calls.filter(isPublish).length, 0);
});

test("a dropped status request is tolerated, three in a row are not", async () => {
  let n = 0;
  const base = happy();
  const flaky = setup((call, all) => {
    if (isStatus(call) && ++n <= 2) throw new TypeError("fetch failed");
    return base(call, all);
  });
  await new InstagramAdapter().publish(flaky.ctx, input([image(1)]));
  assert.equal(flaky.calls.filter(isPublish).length, 1);
  const dead = setup((call, all) => {
    if (isStatus(call)) throw new TypeError("fetch failed");
    return base(call, all);
  });
  await assert.rejects(() => new InstagramAdapter().publish(dead.ctx, input([image(1)])), (e) => e.code === "provider_network_error");
  assert.equal(dead.calls.filter(isPublish).length, 0);
});

test("9007 without the OAuthException type is retried too", async () => {
  let publishes = 0;
  const base = happy();
  const { ctx, calls } = setup((call, all) => {
    if (isPublish(call) && ++publishes < 2) return json({ error: { message: "not ready", code: 9007, error_subcode: 2207027 } }, 400);
    return base(call, all);
  });
  await new InstagramAdapter().publish(ctx, input([image(1)]));
  assert.equal(calls.filter(isPublish).length, 2);
});

test("a real token failure (code 190) is not treated as not-ready", async () => {
  const base = happy();
  const { ctx, calls } = setup((call, all) =>
    isPublish(call) ? json({ error: { message: "Invalid OAuth access token", type: "OAuthException", code: 190 } }, 400) : base(call, all));
  await assert.rejects(() => new InstagramAdapter().publish(ctx, input([image(1)])), (e) => e.code === "auth_error");
  assert.equal(calls.filter(isPublish).length, 1);
});
