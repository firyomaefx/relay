/**
 * Previews and evergreen scheduling: per-platform adapted variants and
 * recurring queue jobs. Fully mocked; no network calls are made.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRelay } from "@relay/platforms";
import { cleanupTempDir, isoIn, makeTempDir, waitFor } from "../helpers.mjs";

const options = (dataDir) => ({ dataDir, forceMock: true, env: {}, logger: () => {} });

test("preview adapts long text per platform without publishing", async () => {
  const dataDir = await makeTempDir("relay-preview-");
  let relay;
  try {
    relay = await createRelay(options(dataDir));
    await relay.beginConnect("x");
    await relay.beginConnect("instagram");
    const text = "word ".repeat(700).trim();

    const preview = await relay.preview({ platforms: ["x", "instagram"], text });
    const x = preview.platforms.find((entry) => entry.platform === "x");
    const instagram = preview.platforms.find((entry) => entry.platform === "instagram");

    assert.ok(x, "X preview must exist");
    assert.ok(x.parts.length > 1, `X should auto-thread, got ${x.parts.length} part(s)`);
    assert.equal(x.adapted, true);
    assert.equal(x.truncated, false);
    assert.ok(x.parts.every((part) => Array.from(part).length <= x.maxTextLength));

    assert.ok(instagram, "Instagram preview must exist");
    assert.equal(instagram.adapted, true);
    assert.equal(instagram.truncated, true, "Instagram cannot thread, so the preview must report truncation");
    assert.ok(instagram.issues.length > 0);

    assert.equal((await relay.history(5)).length, 0, "preview must never write history");
    assert.equal((await relay.listQueue()).length, 0, "preview must never queue a post");
  } finally {
    await relay?.close();
    await cleanupTempDir(dataDir);
  }
});

test("a non-threading platform previews only the first thread part", async () => {
  const dataDir = await makeTempDir("relay-preview-thread-");
  let relay;
  try {
    relay = await createRelay(options(dataDir));
    await relay.beginConnect("instagram");
    const preview = await relay.preview({
      platforms: ["instagram"],
      thread: [{ text: "first thread part" }, { text: "second thread part" }],
    });
    const instagram = preview.platforms[0];
    assert.equal(instagram.parts.length, 1);
    assert.equal(instagram.parts[0], "first thread part");
    assert.equal(instagram.truncated, true);
    assert.ok(instagram.issues.some((issue) => issue.includes("only the first part")));
  } finally {
    await relay?.close();
    await cleanupTempDir(dataDir);
  }
});

test("an overlong URL is hard-split within the X limit", async () => {
  const dataDir = await makeTempDir("relay-preview-url-");
  let relay;
  try {
    relay = await createRelay(options(dataDir));
    await relay.beginConnect("x");
    const url = `https://example.com/${"a".repeat(600)}`;
    const preview = await relay.preview({ platforms: ["x"], text: `Read this: ${url}` });
    const x = preview.platforms[0];
    assert.ok(x.parts.length > 1);
    assert.ok(x.parts.every((part) => Array.from(part).length <= x.maxTextLength), JSON.stringify(x.characterCounts));
  } finally {
    await relay?.close();
    await cleanupTempDir(dataDir);
  }
});

test("a recurring scheduled post enqueues its next occurrence after success", async () => {
  const dataDir = await makeTempDir("relay-recurrence-");
  let relay;
  try {
    relay = await createRelay(options(dataDir));
    await relay.beginConnect("x");

    const created = await relay.createPost({
      platforms: ["x"],
      text: "evergreen hello",
      scheduleAt: isoIn(1200),
      recurrence: { interval: "daily", count: 3 },
    });
    assert.equal(created.scheduled, true, `expected scheduled post: ${JSON.stringify(created.report.issues)}`);
    assert.ok(created.jobId);

    const done = await waitFor(
      async () => {
        await relay.runDueJobs();
        const jobs = await relay.listQueue();
        const current = jobs.find((entry) => entry.id === created.jobId);
        if (!current) throw new Error("recurring job disappeared");
        if (current.status === "failed") throw new Error(current.lastError);
        return current.status === "done" ? current : null;
      },
      { timeoutMs: 20000, intervalMs: 100, label: "recurring first occurrence" },
    );
    assert.equal(done.occurrence, 1);

    const jobs = await relay.listQueue();
    const next = jobs.find((entry) => entry.seriesId === created.jobId && entry.status === "pending");
    assert.ok(next, "a next occurrence must be queued");
    assert.equal(next.occurrence, 2);
    assert.equal(Date.parse(next.scheduleAt) - Date.parse(done.scheduleAt), 24 * 60 * 60 * 1000);
  } finally {
    await relay?.close();
    await cleanupTempDir(dataDir);
  }
});

test("recurrence requires a future schedule", async () => {
  const dataDir = await makeTempDir("relay-recurrence-invalid-");
  let relay;
  try {
    relay = await createRelay(options(dataDir));
    await relay.beginConnect("x");
    await assert.rejects(
      () =>
        relay.createPost({
          platforms: ["x"],
          text: "no future schedule",
          recurrence: { interval: "daily", count: 2 },
        }),
      (error) => error.code === "recurrence_requires_future_schedule",
    );
  } finally {
    await relay?.close();
    await cleanupTempDir(dataDir);
  }
});
