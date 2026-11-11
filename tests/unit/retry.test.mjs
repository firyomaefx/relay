// Retrying a failed post must touch only the platforms that failed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { RelayService } from "@relay/core";
import { createAdapters } from "@relay/platforms";
import { cleanupTempDir, makeTempDir } from "../helpers.mjs";

async function makeRelay(onX, onThreads) {
  const dataDir = await makeTempDir("relay-retry-");
  const calls = { x: 0, threads: 0 };
  const adapters = createAdapters({ forceMock: true }).map((adapter) => {
    if (adapter.platform === "x") {
      const wrapped = Object.create(adapter);
      wrapped.publish = async (ctx, input) => {
        calls.x += 1;
        await onX?.(calls.x);
        return adapter.publish(ctx, input);
      };
      return wrapped;
    }
    if (adapter.platform === "threads") {
      const wrapped = Object.create(adapter);
      wrapped.publish = async (ctx, input) => {
        calls.threads += 1;
        await onThreads?.(calls.threads);
        return adapter.publish(ctx, input);
      };
      return wrapped;
    }
    return adapter;
  });
  const relay = await RelayService.open({ dataDir, adapters, forceMock: true, env: {}, logger: () => {} });
  await relay.beginConnect("x");
  await relay.beginConnect("threads");
  return { relay, dataDir, calls };
}

test("retry sends only the failed platform and keeps the original history record", async () => {
  const { relay, dataDir, calls } = await makeRelay((attempt) => {
    if (attempt === 1) throw new Error("X rejected the first attempt");
  });
  try {
    const created = await relay.createPost({ platforms: ["x", "threads"], text: "retry only the failure" });
    assert.equal(created.results.find((entry) => entry.platform === "x").ok, false);
    assert.equal(created.results.find((entry) => entry.platform === "threads").ok, true);
    assert.equal(calls.x, 1);
    assert.equal(calls.threads, 1);

    const retried = await relay.retryFailed({ recordId: created.recordId });
    assert.deepEqual(retried.retried, ["x"]);
    assert.deepEqual(retried.skipped, ["threads"]);
    assert.equal(retried.results.length, 1);
    assert.equal(retried.results[0].platform, "x");
    assert.equal(retried.results[0].ok, true);
    assert.equal(calls.x, 2);
    assert.equal(calls.threads, 1, "a platform that already succeeded must not be posted again");

    const history = await relay.history(10);
    assert.equal(history.length, 2, "retry adds a new history entry");
    const original = history.find((entry) => entry.id === created.recordId);
    assert.equal(original.results.length, 2, "the old record is left intact");
    assert.equal(original.results.find((entry) => entry.platform === "x").ok, false);
    assert.equal(original.results.find((entry) => entry.platform === "threads").ok, true);
  } finally {
    await relay.close();
    await cleanupTempDir(dataDir);
  }
});

test("a fully failed post retries every platform", async () => {
  const { relay, dataDir, calls } = await makeRelay(
    (attempt) => {
      if (attempt === 1) throw new Error("X failed");
    },
    (attempt) => {
      if (attempt === 1) throw new Error("Threads failed");
    },
  );
  try {
    const created = await relay.createPost({ platforms: ["x", "threads"], text: "both need another try" });
    assert.equal(created.results.every((entry) => !entry.ok), true);

    const retried = await relay.retryFailed({ recordId: created.recordId });
    assert.deepEqual(retried.retried, ["x", "threads"]);
    assert.deepEqual(retried.skipped, []);
    assert.equal(calls.x, 2);
    assert.equal(calls.threads, 2);
    assert.equal(retried.results.every((entry) => entry.ok), true);
  } finally {
    await relay.close();
    await cleanupTempDir(dataDir);
  }
});

test("a post with no failures is refused instead of posting it again", async () => {
  const { relay, dataDir, calls } = await makeRelay();
  try {
    const created = await relay.createPost({ platforms: ["x"], text: "nothing failed here" });
    await assert.rejects(
      () => relay.retryFailed({ recordId: created.recordId }),
      (error) => error.code === "retry_nothing_failed",
    );
    assert.equal(calls.x, 1, "the retry must not call the adapter when nothing failed");
  } finally {
    await relay.close();
    await cleanupTempDir(dataDir);
  }
});
