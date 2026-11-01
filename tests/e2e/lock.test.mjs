/**
 * End-to-end scheduler lock test: two web console processes share one data
 * directory (different ports). Exactly one of them may own scheduler.lock, and a
 * post queued through either process must be published exactly once by the owner.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  cleanupTempDir,
  httpJson,
  isoIn,
  makeTempDir,
  readSchedulerLock,
  requestSummary,
  sleep,
  startWebServer,
  waitFor,
} from "../helpers.mjs";

const PORT_A = 45732;
const PORT_B = 45733;

async function readDb(dbPath) {
  try {
    return JSON.parse(await readFile(dbPath, "utf8"));
  } catch {
    return null;
  }
}

test(
  "two consoles sharing one data dir have exactly one scheduler owner and publish a queued post once",
  { timeout: 240000 },
  async () => {
    const dataDir = await makeTempDir("relay-lock-e2e-");
    const dbPath = path.join(dataDir, "db.json");
    let serverA;
    let serverB;
    try {
      serverA = await startWebServer({ dataDir, port: PORT_A, label: "web-a" });
      serverB = await startWebServer({ dataDir, port: PORT_B, label: "web-b" });

      // --- exactly one process owns the scheduler lock ------------------------
      const lock = await waitFor(async () => {
        const owner = await readSchedulerLock(dataDir);
        return owner?.pid ? owner : null;
      }, { timeoutMs: 20000, intervalMs: 100, label: "scheduler.lock to be written" });

      const pids = [serverA.pid, serverB.pid];
      assert.ok(
        pids.includes(lock.pid),
        `scheduler.lock pid ${lock.pid} must be one of the two server pids (${pids.join(", ")})`,
      );
      const ownerServer = lock.pid === serverA.pid ? serverA : serverB;
      const otherServer = ownerServer === serverA ? serverB : serverA;
      assert.ok(ownerServer !== otherServer);

      const stateA = await httpJson(serverA.baseUrl, "/api/state");
      const stateB = await httpJson(serverB.baseUrl, "/api/state");
      assert.equal(stateA.ok, true, `GET /api/state failed on console A: ${requestSummary(stateA)}`);
      assert.equal(stateB.ok, true, `GET /api/state failed on console B: ${requestSummary(stateB)}`);
      const ownedFlags = [stateA.json.scheduler?.ownedByThisProcess, stateB.json.scheduler?.ownedByThisProcess];
      assert.deepEqual(
        [...ownedFlags].sort(),
        [false, true],
        `exactly one console must report scheduler ownership, got A=${ownedFlags[0]} B=${ownedFlags[1]}`,
      );
      const ownerState = ownerServer === serverA ? stateA : stateB;
      assert.equal(
        ownerState.json.scheduler.ownedByThisProcess,
        true,
        "the console whose pid is in scheduler.lock must report ownedByThisProcess=true",
      );

      // --- a post queued on the non-owner is published by the owner -----------
      const connect = await httpJson(otherServer.baseUrl, "/api/connect/x", { method: "POST", body: {} });
      assert.equal(connect.ok, true, `POST /api/connect/x failed: ${requestSummary(connect)}`);

      const text = `Lock e2e scheduled post ${Date.now()}`;
      const created = await httpJson(otherServer.baseUrl, "/api/posts", {
        method: "POST",
        body: { draft: { platforms: ["x"], text, scheduleAt: isoIn(2000) } },
      });
      assert.equal(created.ok, true, `POST /api/posts failed: ${requestSummary(created)}`);
      assert.equal(created.json.scheduled, true, "the post must be queued for the shared scheduler");
      assert.ok(created.json.jobId, "a scheduled post must return a jobId");

      const published = await waitFor(
        async () => {
          const db = await readDb(dbPath);
          if (!db) return null;
          const records = (db.posts ?? []).filter((record) => record.draft?.text === text);
          return records.length > 0 && records[0].results?.length > 0 ? records : null;
        },
        {
          timeoutMs: 45000,
          intervalMs: 250,
          label: "the shared scheduler to publish the queued post",
          onTimeout: () => `--- console A output ---\n${serverA.tail()}\n--- console B output ---\n${serverB.tail()}`,
        },
      );
      assert.equal(published.length, 1, "the queued post must be published exactly once");
      assert.equal(published[0].results?.[0]?.ok, true, `publish result should be ok: ${JSON.stringify(published[0].results)}`);
      assert.equal(published[0].results?.[0]?.mode, "mock");

      // --- no duplicate on a later scheduler tick -----------------------------
      await sleep(2500);
      const dbAfter = await readDb(dbPath);
      const recordsAfter = (dbAfter?.posts ?? []).filter((record) => record.draft?.text === text);
      assert.equal(recordsAfter.length, 1, "a later scheduler tick must not publish the post again");

      // --- the lock owner did not change --------------------------------------
      const lockAfter = await readSchedulerLock(dataDir);
      assert.equal(lockAfter.pid, lock.pid, "the scheduler lock owner must stay stable");

      const ownerQueue = await httpJson(ownerServer.baseUrl, "/api/queue");
      assert.equal(ownerQueue.ok, true, `GET /api/queue failed on the owner console: ${requestSummary(ownerQueue)}`);
      const job = (ownerQueue.json.queue ?? []).find((entry) => entry.id === created.json.jobId);
      assert.ok(job, "the owner console should list the published job");
      assert.equal(job.status, "done");
      assert.equal(job.attempts, 1);
    } finally {
      await serverB?.stop();
      await serverA?.stop();
      await cleanupTempDir(dataDir);
    }
  },
);
