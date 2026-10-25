/**
 * Threads reply-chain regression tests (incident 2026-10-23 19:28 MYT: part 2
 * publish failed with code 24 / subcode 4279009). Fully mocked Graph API; no
 * network calls are made.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ThreadsAdapter } from "@relay/platforms";
import { normalizeFor } from "@relay/core";

const ENV = { RELAY_THREADS_REPLY_SETTLE_MS: "0", RELAY_THREADS_NOT_FOUND_BACKOFF_MS: "0", RELAY_THREADS_POLL_INTERVAL_MS: "0" };

function form(call) {
  return Object.fromEntries(new URLSearchParams(String(call.init?.body ?? "")));
}

function notFound(id) {
  return new Response(JSON.stringify({ error: { message: "The requested resource does not exist", type: "OAuthException", code: 24, error_subcode: 4279009, error_user_title: "Media Tidak Ditemui", error_user_msg: `Media dengan id ${id} tidak boleh ditemui.` } }), { status: 400, headers: { "content-type": "application/json" } });
}

function harness({ failPublishTimes = 0 } = {}) {
  const calls = [];
  const logs = [];
  const status = new Map();
  let n = 0;
  let pub = 0;
  let failed = 0;
  const ctx = {
    dataDir: process.cwd(), env: ENV, logger: (m) => logs.push(m),
    fetch: async (url, init = {}) => {
      const call = { url: String(url), method: (init.method ?? "GET").toUpperCase(), init };
      calls.push(call);
      const u = new URL(call.url);
      let body;
      if (call.method === "POST" && u.pathname.endsWith("/threads")) {
        const id = `container-${++n}`; status.set(id, 0); body = { id };
      } else if (call.method === "GET" && u.searchParams.get("fields") === "status,error_message") {
        const id = u.pathname.split("/").pop();
        const seen = (status.get(id) ?? 0) + 1; status.set(id, seen);
        body = { status: seen < 2 ? "IN_PROGRESS" : "FINISHED" };
      } else if (call.method === "POST" && u.pathname.endsWith("/threads_publish")) {
        const creation = form(call).creation_id;
        if (pub >= 1 && failed < failPublishTimes) { failed += 1; return notFound(creation); }
        body = { id: `published-${++pub}` };
      } else if (call.method === "GET" && u.pathname.endsWith("/me/threads")) {
        body = { data: [] };
      } else throw new Error(`Unexpected ${call.method} ${call.url}`);
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
    readMedia: async () => ({ buffer: Buffer.from("x"), mimeType: "image/jpeg", filename: "x.jpg" }),
    mediaPublicUrl: (item) => item.url ?? null,
    credentials: () => ({ clientId: "c", clientSecret: "s" }),
    now: () => new Date(), forceMock: false, publicMediaBaseUrl: null,
  };
  return { ctx, calls, logs };
}

function input(parts, options = {}) {
  return {
    account: { id: "threads:user-1", platform: "threads", handle: "@duitpoket_test", mode: "live", connectedAt: "2026-01-01T00:00:00.000Z" },
    tokens: { accessToken: "token" },
    post: { platform: "threads", parts, options },
  };
}

const img = (i) => ({ kind: "image", url: `https://media.test/${i}.jpg` });

test("carousel + text chain: replies target PUBLISHED ids, every container is FINISHED before publish, 24/4279009 is retried", async () => {
  const { ctx, calls, logs } = harness({ failPublishTimes: 2 });
  const result = await new ThreadsAdapter().publish(ctx, input([
    { text: "main", media: [img(1), img(2), img(3)] },
    { text: "part 2", media: [] },
    { text: "part 3", media: [] },
  ]));
  const creates = calls.filter((c) => c.method === "POST" && c.url.endsWith("/threads")).map(form);
  // 3 children (1-3), carousel container-4, reply containers 5 and 6
  assert.equal(creates[3].media_type, "CAROUSEL");
  assert.equal(creates[3].reply_to_id, undefined);
  assert.equal(creates[4].reply_to_id, "published-1", "part 2 replies to the published carousel id");
  assert.equal(creates[5].reply_to_id, "published-2", "part 3 replies to part 2's published id");
  for (const c of creates) assert.ok(!/^container-/.test(c.reply_to_id ?? ""), "never reply to a container id");
  // each publish is preceded by a FINISHED status for its creation id
  calls.forEach((c, idx) => {
    if (!(c.method === "POST" && c.url.endsWith("/threads_publish"))) return;
    const id = form(c).creation_id;
    const lastPoll = calls.slice(0, idx).filter((p) => p.method === "GET" && p.url.includes(`/${id}?fields=status,error_message`));
    assert.ok(lastPoll.length >= 2, `${id} polled until FINISHED before publish`);
  });
  const publishes = calls.filter((c) => c.method === "POST" && c.url.endsWith("/threads_publish")).map((c) => form(c).creation_id);
  assert.deepEqual(publishes, ["container-4", "container-5", "container-5", "container-5", "container-6"]);
  assert.deepEqual(result.details.parts.map((p) => p.postId), ["published-1", "published-2", "published-3"]);
  assert.deepEqual(result.details.parts.map((p) => p.replyToId), [null, "published-1", "published-2"]);
  assert.ok(logs.some((l) => l.includes("retry 1/4")));
  assert.ok(logs.some((l) => l.includes("part 2 published media id published-2")));
});

test("replyToId chains all parts under an existing published post", async () => {
  const { ctx, calls } = harness();
  const result = await new ThreadsAdapter().publish(ctx, input([{ text: "a", media: [] }, { text: "b", media: [] }], { replyToId: "18100000000000001" }));
  const creates = calls.filter((c) => c.method === "POST" && c.url.endsWith("/threads")).map(form);
  assert.deepEqual(creates.map((c) => c.reply_to_id), ["18100000000000001", "published-1"]);
  assert.equal(result.details.replyToId, "18100000000000001");
});

test("replyToId must be numeric; non-numeric is rejected before any provider call", async () => {
  const { ctx, calls } = harness();
  await assert.rejects(new ThreadsAdapter().publish(ctx, input([{ text: "a", media: [] }], { replyToId: "container-1" })), /numeric/);
  assert.equal(calls.length, 0);
});

test("non-retryable errors are not retried", async () => {
  const { ctx, calls } = harness();
  ctx.fetch = async (url, init = {}) => { calls.push({ url: String(url), method: init.method }); return new Response(JSON.stringify({ error: { message: "bad", code: 100 } }), { status: 400, headers: { "content-type": "application/json" } }); };
  await assert.rejects(new ThreadsAdapter().publish(ctx, input([{ text: "a", media: [] }])));
  assert.equal(calls.filter((c) => String(c.url).endsWith("/threads")).length, 1);
});

test("top-level replyToId / parentPostId map onto options.threads.replyToId only for threads", () => {
  assert.equal(normalizeFor("threads", { platforms: ["threads"], text: "x", replyToId: "123" }).options.replyToId, "123");
  assert.equal(normalizeFor("threads", { platforms: ["threads"], text: "x", parentPostId: "456" }).options.replyToId, "456");
  assert.equal(normalizeFor("threads", { platforms: ["threads"], text: "x", replyToId: "1", options: { threads: { replyToId: "2" } } }).options.replyToId, "2");
  assert.equal(normalizeFor("x", { platforms: ["x"], text: "x", replyToId: "123" }).options.replyToId, "123");
  assert.equal(normalizeFor("tiktok", { platforms: ["tiktok"], text: "x", replyToId: "123" }).options.replyToId, undefined);
});
