/**
 * Unit tests for the draft source label ("Claude", "Grokbot"): stored with
 * queued jobs, shown in queue/history text, never sent to a platform.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createRelay } from "@relay/platforms";
import { formatQueueJob, labelPrefix } from "../../apps/mcp/dist/format.js";
import { cleanupTempDir, makeTempDir } from "../helpers.mjs";

const dirs = [];
const relays = [];

async function relayAt(now = () => new Date("2026-10-27T00:00:00Z")) {
  const dataDir = await makeTempDir("relay-label-");
  dirs.push(dataDir);
  const relay = await createRelay({ dataDir, forceMock: true, env: {}, logger: () => {}, now });
  relays.push(relay);
  return relay;
}

after(async () => {
  for (const relay of relays) await relay?.close();
  for (const dir of dirs) await cleanupTempDir(dir);
});

test("a queued job keeps its label and the label is not part of the published text", async () => {
  const relay = await relayAt();
  const result = await relay.createPost({
    platforms: ["threads"],
    text: "Dana kecemasan korang cukup berapa bulan?",
    scheduleAt: "2026-10-30T00:00:00Z",
    label: "Claude",
  });
  assert.equal(result.scheduled, true, JSON.stringify(result));
  const jobs = await relay.listQueue();
  const job = jobs.find((entry) => entry.id === result.jobId);
  assert.ok(job, "job must be in the queue");
  assert.equal(job.draft.label, "Claude");
  const report = await relay.validate(job.draft);
  assert.equal(report.ok, true, JSON.stringify(report.issues));
  assert.equal(report.normalized.threads.parts[0].text, "Dana kecemasan korang cukup berapa bulan?");
  assert.ok(!JSON.stringify(report.normalized).includes("Claude"), "label must never reach the platform payload");
});

test("labels longer than 40 characters are rejected", async () => {
  const relay = await relayAt();
  const report = await relay.validate({ platforms: ["threads"], text: "ok", label: "x".repeat(41) });
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.code === "label_invalid"), JSON.stringify(report.issues));
});

test("queue text shows the label in front", () => {
  assert.equal(labelPrefix({ label: " Claude " }), "[Claude] ");
  assert.equal(labelPrefix({}), "");
  const line = formatQueueJob({
    id: "job_1",
    status: "pending",
    scheduleAt: "2026-10-30T00:00:00.000Z",
    createdAt: "2026-10-27T00:00:00.000Z",
    attempts: 0,
    draft: { platforms: ["threads"], text: "Hello", label: "Grokbot" },
  });
  assert.match(line, /\[Grokbot\] Hello/);
});
