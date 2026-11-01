/**
 * X reply support: replyToId validation, adapter payload, and schedule_at.
 * Fully mocked; no network calls are made.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRelay, XAdapter } from "@relay/platforms";
import { cleanupTempDir, makeTempDir } from "../helpers.mjs";

const ID = "1234567890123456789";

async function withRelay(fn) {
  const dataDir = await makeTempDir("relay-xreply-");
  const relay = await createRelay({ dataDir, forceMock: true, env: {}, logger: () => {} });
  try {
    await fn(relay);
  } finally {
    await relay.close();
    await cleanupTempDir(dataDir);
  }
}

function xCtx(bodies) {
  return {
    dataDir: process.cwd(), env: {}, logger: () => {},
    now: () => new Date(),
    fetch: async (url, init = {}) => {
      bodies.push(JSON.parse(String(init.body ?? "{}")));
      return new Response(JSON.stringify({ data: { id: `t${bodies.length}` } }), { status: 200, headers: { "content-type": "application/json" } });
    },
    credentials: () => ({ clientId: "id", clientSecret: "secret" }),
    isLive: () => true,
  };
}

const xInput = (parts, options) => ({
  account: { id: "x:1", platform: "x", handle: "@relay_demo", mode: "live", connectedAt: new Date().toISOString() },
  tokens: { accessToken: "tok" },
  post: { platform: "x", parts, options },
});

test("validate accepts a numeric X replyToId (top-level and options.x)", async () => {
  await withRelay(async (relay) => {
    const a = await relay.validate({ platforms: ["x"], text: "short reply", replyToId: ID });
    assert.equal(a.ok, true, JSON.stringify(a.issues));
    assert.equal(a.normalized.x.options.replyToId, ID);
    const b = await relay.validate({ platforms: ["x"], text: "short reply", options: { x: { replyToId: ID } } });
    assert.equal(b.ok, true, JSON.stringify(b.issues));
  });
});

test("validate rejects bad X replyToId, quote+reply, and unsupported platforms", async () => {
  await withRelay(async (relay) => {
    const bad = await relay.validate({ platforms: ["x"], text: "t", replyToId: "abc" });
    assert.equal(bad.ok, false);
    assert.match(JSON.stringify(bad.issues), /numeric X post id/);
    const both = await relay.validate({ platforms: ["x"], text: "t", replyToId: ID, options: { x: { quotePostId: "5" } } });
    assert.equal(both.ok, false);
    const tk = await relay.validate({ platforms: ["x", "tiktok"], text: "t", replyToId: ID });
    assert.equal(tk.ok, false);
    assert.match(JSON.stringify(tk.issues), /only works on X and Threads/);
  });
});

test("X + Threads draft needs per-platform ids; Threads replyToId still works", async () => {
  await withRelay(async (relay) => {
    const amb = await relay.validate({ platforms: ["x", "threads"], text: "t", replyToId: ID });
    assert.equal(amb.ok, false);
    assert.match(JSON.stringify(amb.issues), /ambiguous/);
    const ok = await relay.validate({ platforms: ["x", "threads"], text: "t", replyToId: ID, options: { x: { replyToId: ID }, threads: { replyToId: "18133692964708115" } } });
    assert.equal(ok.ok, true, JSON.stringify(ok.issues));
    const th = await relay.validate({ platforms: ["threads"], text: "t", replyToId: "18133692964708115" });
    assert.equal(th.ok, true, JSON.stringify(th.issues));
  });
});

test("X adapter sends first part as a reply and chains the rest", async () => {
  const bodies = [];
  const result = await new XAdapter().publish(xCtx(bodies), xInput([{ text: "a", media: [] }, { text: "b", media: [] }], { replyToId: ID }));
  assert.deepEqual(bodies[0].reply, { in_reply_to_tweet_id: ID });
  assert.deepEqual(bodies[1].reply, { in_reply_to_tweet_id: "t1" });
  assert.equal(result.details.replyToId, ID);
});

test("X adapter without replyToId sends no reply on part 1", async () => {
  const bodies = [];
  await new XAdapter().publish(xCtx(bodies), xInput([{ text: "a", media: [] }], {}));
  assert.equal(bodies[0].reply, undefined);
});

test("scheduled X reply keeps replyToId in the queued job draft", async () => {
  await withRelay(async (relay) => {
    await relay.beginConnect("x");
    const scheduleAt = new Date(Date.now() + 3600_000).toISOString();
    const created = await relay.createPost({ platforms: ["x"], text: "later reply", replyToId: ID, scheduleAt });
    assert.equal(created.scheduled, true, JSON.stringify(created.report?.issues));
    const job = (await relay.listQueue()).find((j) => j.id === created.jobId);
    assert.equal(job.draft.replyToId, ID);
    await relay.cancelJob?.(created.jobId);
  });
});