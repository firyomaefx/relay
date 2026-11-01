/**
 * Unit tests for draft validation and per-platform normalization.
 *
 * These run against the built packages (`npm run build` first) through the same
 * `createRelay()` entry point that apps/mcp and apps/web use.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { after, before, test } from "node:test";
import { createRelay } from "@relay/platforms";
import { cleanupTempDir, makeTempDir, writeTinyPng } from "../helpers.mjs";

let dataDir;
let relay;

before(async () => {
  dataDir = await makeTempDir("relay-validation-");
  relay = await createRelay({
    dataDir,
    forceMock: true,
    // Deliberately empty env: no provider credentials, no ambient RELAY_* knobs.
    env: {},
    logger: () => {},
  });
});

after(async () => {
  await relay?.close();
  await cleanupTempDir(dataDir);
});

test("rejects text longer than 280 characters on X", async () => {
  const report = await relay.validate({ platforms: ["x"], text: "a".repeat(281) });

  assert.equal(report.ok, false, "a 281 character X post must be rejected");
  assert.equal(report.perPlatform.x.ok, false);
  assert.ok(
    report.issues.some((issue) => issue.platform === "x" && issue.code === "text_too_long"),
    `expected a text_too_long issue for x, got ${JSON.stringify(report.issues)}`,
  );
});

test("300 characters is fine for Threads but rejected for X", async () => {
  const text = "b".repeat(300);

  const threadsOnly = await relay.validate({ platforms: ["threads"], text });
  assert.equal(
    threadsOnly.ok,
    true,
    `Threads allows 500 characters, so 300 must pass: ${JSON.stringify(threadsOnly.issues)}`,
  );

  const both = await relay.validate({ platforms: ["x", "threads"], text });
  assert.equal(both.ok, false, "the combined draft must fail because of X");
  assert.equal(both.perPlatform.x.ok, false);
  assert.equal(both.perPlatform.threads.ok, true, "Threads itself must remain valid");
  assert.ok(
    both.issues.some((issue) => issue.platform === "x" && issue.code === "text_too_long"),
    `expected an X text_too_long issue, got ${JSON.stringify(both.issues)}`,
  );
});

test("rejects a TikTok post without media", async () => {
  const report = await relay.validate({ platforms: ["tiktok"], text: "No media here" });

  assert.equal(report.ok, false);
  assert.equal(report.perPlatform.tiktok.ok, false);
  assert.ok(
    report.issues.some((issue) => issue.platform === "tiktok" && issue.code === "media_required"),
    `expected media_required for tiktok, got ${JSON.stringify(report.issues)}`,
  );
});

test("normalizes a 3-part thread for X and Threads", async () => {
  const report = await relay.validate({
    platforms: ["x", "threads"],
    thread: [{ text: " Part one " }, { text: "Part two" }, { text: "Part three" }],
  });

  assert.equal(report.ok, true, `thread should be valid: ${JSON.stringify(report.issues)}`);

  const xPost = report.normalized.x;
  const threadsPost = report.normalized.threads;
  assert.ok(xPost, "normalized X post missing");
  assert.ok(threadsPost, "normalized Threads post missing");
  assert.equal(xPost.platform, "x");
  assert.equal(threadsPost.platform, "threads");
  assert.equal(xPost.parts.length, 3);
  assert.equal(threadsPost.parts.length, 3);
  assert.deepEqual(
    xPost.parts.map((part) => part.text),
    ["Part one", "Part two", "Part three"],
    "thread part text must be trimmed and preserved in order",
  );
  assert.equal(xPost.options.replySetting, undefined);
});

test("rejects an invalid scheduleAt timestamp", async () => {
  const report = await relay.validate({ platforms: ["x"], text: "later", scheduleAt: "definitely-not-a-date" });

  assert.equal(report.ok, false);
  assert.ok(
    report.issues.some((issue) => issue.code === "schedule_invalid"),
    `expected schedule_invalid, got ${JSON.stringify(report.issues)}`,
  );
});

test("rejects media whose local file does not exist", async () => {
  const missing = path.join(dataDir, "media", "does-not-exist.png");
  const report = await relay.validate({
    platforms: ["x"],
    text: "with media",
    media: [{ path: missing, kind: "image" }],
  });

  assert.equal(report.ok, false);
  assert.equal(report.perPlatform.x.ok, false);
  assert.ok(
    report.issues.some((issue) => issue.platform === "x" && issue.code === "media_unreadable"),
    `expected media_unreadable, got ${JSON.stringify(report.issues)}`,
  );
});

test("Threads accepts a 20-item carousel and rejects 21 items", async () => {
  const media = Array.from({ length: 20 }, (_, index) => ({
    kind: "image",
    url: `https://media.test/${index}.png`,
  }));

  const accepted = await relay.validate({ platforms: ["threads"], text: "Carousel", media });
  assert.equal(accepted.ok, true, `20 media items must pass: ${JSON.stringify(accepted.issues)}`);

  const rejected = await relay.validate({
    platforms: ["threads"],
    text: "Too many",
    media: [...media, { kind: "image", url: "https://media.test/20.png" }],
  });
  assert.equal(rejected.ok, false);
  assert.ok(
    rejected.issues.some((issue) => issue.platform === "threads" && issue.code === "too_many_media"),
    `expected too_many_media for 21 Threads items, got ${JSON.stringify(rejected.issues)}`,
  );
});

test("Threads media in mock mode does not require a public URL", async () => {
  const png = await writeTinyPng(path.join(dataDir, "threads-tiny.png"));

  const report = await relay.validate({
    platforms: ["threads"],
    text: "Threads with an image",
    media: [{ path: png, kind: "image" }],
  });

  assert.equal(
    report.ok,
    true,
    `simulated Threads publishing must not demand a public URL: ${JSON.stringify(report.issues)}`,
  );
  assert.deepEqual(
    report.issues.filter((issue) => issue.code === "media_public_url_required"),
    [],
    "no media_public_url_required issue expected while forced into mock mode",
  );
  assert.equal(report.normalized.threads.parts[0].media.length, 1);
});
