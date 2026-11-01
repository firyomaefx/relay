/**
 * Unit tests for incremental persistence, partial-success results and the core
 * duplicate-content guard.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { RelayService } from "@relay/core";
import { createAdapters, createRelay, ThreadsAdapter } from "@relay/platforms";
import { cleanupTempDir, makeTempDir } from "../helpers.mjs";

const baseOptions = (dataDir) => ({ dataDir, forceMock: true, env: {}, logger: () => {} });

test("a later part failure keeps the first part as a persisted partial success", async () => {
  const dataDir = await makeTempDir("relay-partial-persist-");
  let relay;
  try {
    const fakeThreads = {
      platform: "threads",
      limits: new ThreadsAdapter().limits,
      isConfigured: () => true,
      isLive: () => true,
      authorize: async () => ({
        kind: "mock",
        profile: { externalId: "user-1", handle: "tester", displayName: "Tester" },
        scopes: ["threads_basic", "threads_content_publish", "threads_manage_replies"],
      }),
      exchange: async () => {
        throw new Error("not used");
      },
      publish: async (ctx) => {
        assert.ok(ctx.onPartPublished, "the core must provide the part callback");
        await ctx.onPartPublished({
          platform: "threads",
          part: 1,
          postId: "threads-post-1",
          url: "https://www.threads.net/@tester/post/threads-post-1",
          details: { containerId: "container-1" },
        });

        // The callback must have committed the part before the adapter moved on.
        const db = JSON.parse(await readFile(path.join(ctx.dataDir, "db.json"), "utf8"));
        const record = db.posts.find((entry) => entry.status === "publishing");
        assert.ok(record, "the history record must exist before publishing");
        assert.equal(record.results.length, 1);
        assert.equal(record.results[0].postId, "threads-post-1");
        assert.equal(record.results[0].url, "https://www.threads.net/@tester/post/threads-post-1");
        assert.deepEqual(
          record.results[0].publishedParts.map((part) => part.postId),
          ["threads-post-1"],
        );

        throw new Error("Threads part 2 failed: media rejected");
      },
    };

    const adapters = createAdapters({ forceMock: true }).map((adapter) =>
      adapter.platform === "threads" ? fakeThreads : adapter,
    );
    relay = await RelayService.open({ ...baseOptions(dataDir), adapters });
    await relay.beginConnect("threads");

    const draft = {
      platforms: ["threads"],
      thread: [{ text: "part one" }, { text: "part two" }],
    };
    const created = await relay.createPost(draft);
    assert.equal(created.results.length, 1);
    const result = created.results[0];
    assert.equal(result.ok, true, "a partial publish is still a success");
    assert.equal(result.status, "partial");
    assert.equal(result.postId, "threads-post-1");
    assert.equal(result.url, "https://www.threads.net/@tester/post/threads-post-1");
    assert.equal(result.failedPart, 2);
    assert.match(result.error, /part 2 failed/);
    assert.deepEqual(
      result.publishedParts.map((part) => ({ part: part.part, postId: part.postId })),
      [{ part: 1, postId: "threads-post-1" }],
    );

    const history = await relay.history(10);
    assert.equal(history.length, 1, "the partial publish must keep one history record");
    assert.equal(history[0].status, "partial");
    assert.equal(history[0].results[0].postId, "threads-post-1");
    assert.equal(history[0].results[0].publishedParts.length, 1);

    // A partial success is still a published post for the duplicate guard.
    await assert.rejects(
      () => relay.createPost(draft),
      (error) => error.code === "duplicate_recent_post" && error.statusCode === 409,
    );
  } finally {
    await relay?.close();
    await cleanupTempDir(dataDir);
  }
});

test("the duplicate guard blocks recent identical content and force bypasses it", async () => {
  const dataDir = await makeTempDir("relay-idempotency-");
  let relay;
  try {
    relay = await createRelay(baseOptions(dataDir));
    await relay.beginConnect("x");

    const draft = { platforms: ["x"], text: "identical content for the guard" };
    const first = await relay.createPost(draft);
    assert.equal(first.results[0].ok, true);

    await assert.rejects(
      () => relay.createPost(draft),
      (error) => {
        assert.equal(error.code, "duplicate_recent_post");
        assert.equal(error.statusCode, 409);
        assert.equal(error.details.platform, "x");
        assert.equal(error.details.previousPostId, first.results[0].postId);
        assert.match(error.message, /force: true/);
        return true;
      },
    );

    const forced = await relay.createPost(draft, { force: true });
    assert.equal(forced.results[0].ok, true);
    assert.notEqual(forced.results[0].postId, first.results[0].postId);

    const different = await relay.createPost({ platforms: ["x"], text: "different content for the guard" });
    assert.equal(different.results[0].ok, true);

    assert.equal((await relay.history(10)).length, 3, "blocked attempts must not create history records");
  } finally {
    await relay?.close();
    await cleanupTempDir(dataDir);
  }
});
