/**
 * Unit tests for the scheduler: queued posts fire exactly once with mock results,
 * validation failures at execution time end the job as failed, and the single
 * owner lock file is written/released correctly.
 */
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createRelay } from "@relay/platforms";
import {
  cleanupTempDir,
  isoIn,
  makeTempDir,
  readJsonFileRetry,
  readSchedulerLock,
  waitFor,
  writeTinyPng,
} from "../helpers.mjs";

const relayOptions = (dataDir) => ({ dataDir, forceMock: true, env: {}, logger: () => {} });

test("a scheduled post fires once, is recorded once, and the job ends done", async () => {
  const dataDir = await makeTempDir("relay-scheduler-ok-");
  let relay;
  try {
    relay = await createRelay(relayOptions(dataDir));
    await relay.beginConnect("x");

    const scheduleAt = isoIn(1500);
    const created = await relay.createPost({ platforms: ["x"], text: "scheduled hello", scheduleAt });
    assert.equal(created.scheduled, true, `expected a scheduled post, got ${JSON.stringify(created.report.issues)}`);
    assert.ok(created.jobId, "createPost must return the queued job id");

    const job = await waitFor(
      async () => {
        await relay.runDueJobs();
        const jobs = await relay.listQueue();
        const current = jobs.find((entry) => entry.id === created.jobId);
        if (!current) throw new Error(`job ${created.jobId} disappeared from the queue`);
        if (current.status === "failed") throw new Error(`scheduled job failed: ${current.lastError}`);
        return current.status === "done" ? current : null;
      },
      { timeoutMs: 20000, intervalMs: 100, label: "scheduled job to finish" },
    );

    assert.equal(job.status, "done");
    assert.equal(job.attempts, 1, "the job must only be attempted once");
    assert.ok(job.results, "a done job must carry results");
    assert.equal(job.results.length, 1);
    assert.equal(job.results[0].platform, "x");
    assert.equal(job.results[0].ok, true);
    assert.equal(job.results[0].mode, "mock");
    assert.equal(job.results[0].error, undefined);

    const history = await relay.history(50);
    assert.equal(history.length, 1, "a scheduled publish must add exactly one history record");
    assert.equal(history[0].draft.text, "scheduled hello");
    assert.equal(history[0].scheduledFor, job.scheduleAt);
    assert.equal(history[0].results.length, 1);
    assert.equal(history[0].results[0].ok, true);
    assert.equal(history[0].results[0].mode, "mock");

    // Further scheduler ticks must not publish the same job again.
    assert.equal(await relay.runDueJobs(), 0);
    assert.equal(await relay.runDueJobs(), 0);
    assert.equal((await relay.history(50)).length, 1, "re-running the scheduler must not duplicate history");
  } finally {
    await relay?.close();
    await cleanupTempDir(dataDir);
  }
});

test("a scheduled job whose draft becomes invalid ends failed and records the failure", async () => {
  const dataDir = await makeTempDir("relay-scheduler-fail-");
  let relay;
  try {
    relay = await createRelay(relayOptions(dataDir));
    await relay.beginConnect("tiktok");

    const mediaPath = await writeTinyPng(path.join(dataDir, "scheduled-tiktok.png"));
    const created = await relay.createPost({
      platforms: ["tiktok"],
      text: "tiktok scheduled post",
      media: [{ path: mediaPath, kind: "image" }],
      scheduleAt: isoIn(1500),
    });
    assert.equal(created.scheduled, true, JSON.stringify(created.report.issues));
    assert.ok(created.jobId);

    // The media disappears between queueing and the due time: execution-time
    // validation must fail the job instead of publishing.
    await rm(mediaPath);

    const job = await waitFor(
      async () => {
        await relay.runDueJobs();
        const jobs = await relay.listQueue();
        const current = jobs.find((entry) => entry.id === created.jobId);
        if (!current) throw new Error(`job ${created.jobId} disappeared from the queue`);
        return current.status === "pending" || current.status === "running" ? null : current;
      },
      { timeoutMs: 20000, intervalMs: 100, label: "scheduled job to fail validation" },
    );

    assert.equal(job.status, "failed");
    assert.equal(job.attempts, 1);
    assert.ok(job.lastError, "a failed job must explain why it failed");
    assert.match(job.lastError, /validation/i, `lastError should mention validation, got: ${job.lastError}`);
    assert.equal(job.results.length, 1);
    assert.equal(job.results[0].platform, "tiktok");
    assert.equal(job.results[0].ok, false);
    assert.match(job.results[0].error, /file not found|media/i, "the result error should point at the missing media");

    const history = await relay.history(50);
    const records = history.filter((record) => record.draft.text === "tiktok scheduled post");
    assert.equal(records.length, 1, "a failed scheduled job still produces one history record");
    assert.equal(records[0].results[0].ok, false);
  } finally {
    await relay?.close();
    await cleanupTempDir(dataDir);
  }
});

test("a scheduler in one instance publishes a job queued by another instance exactly once", async () => {
  // Regression test: the web console and the MCP server share one data directory
  // but only one of them owns the scheduler lock. The lock owner must see jobs
  // queued by the other process without needing a mutation of its own.
  const dataDir = await makeTempDir("relay-scheduler-cross-process-");
  const opened = [];
  try {
    const serviceA = await createRelay(relayOptions(dataDir));
    opened.push(serviceA);
    await serviceA.beginConnect("x");
    // Open B after the connection so both instances start with a current snapshot.
    const serviceB = await createRelay(relayOptions(dataDir));
    opened.push(serviceB);

    const created = await serviceB.createPost({
      platforms: ["x"],
      text: "queued by another process",
      scheduleAt: isoIn(1500),
    });
    assert.equal(created.scheduled, true, JSON.stringify(created.report.issues));

    const job = await waitFor(
      async () => {
        // A never mutates before this point: it must refresh its view of the
        // shared store to discover B's queued job.
        await serviceA.runDueJobs();
        const jobs = await serviceA.listQueue();
        const current = jobs.find((entry) => entry.id === created.jobId);
        if (!current) throw new Error("the scheduler instance cannot see the job queued by the other instance");
        if (current.status === "failed") throw new Error(`cross-process job failed: ${current.lastError}`);
        return current.status === "done" ? current : null;
      },
      {
        timeoutMs: 20000,
        intervalMs: 100,
        label: "another instance's scheduled job to publish",
        onTimeout: () => `queue: ${JSON.stringify(serviceA.listQueue())}`,
      },
    );

    assert.equal(job.status, "done");
    assert.equal(job.attempts, 1);
    assert.equal(job.results[0].ok, true);
    assert.equal(job.results[0].mode, "mock");

    // Neither view may contain the published post twice.
    await serviceA.runDueJobs();
    await serviceA.runDueJobs();
    const historyA = (await serviceA.history(50)).filter((record) => record.draft.text === "queued by another process");
    assert.equal(historyA.length, 1, "the shared scheduler must publish the job exactly once (instance A history)");

    const db = await readJsonFileRetry(path.join(dataDir, "db.json"));
    const persisted = db.posts.filter((record) => record.draft.text === "queued by another process");
    assert.equal(persisted.length, 1, "the shared scheduler must publish the job exactly once (db.json)");

    const historyB = (await serviceB.history(50)).filter((record) => record.draft.text === "queued by another process");
    assert.equal(historyB.length, 1, "the queueing instance must see the published record exactly once");
  } finally {
    await Promise.all(opened.map((service) => service.close()));
    await cleanupTempDir(dataDir);
  }
});

test("startScheduler takes the single-owner lock and stopScheduler releases it", async () => {
  const dataDir = await makeTempDir("relay-scheduler-lock-");
  let relay;
  try {
    relay = await createRelay(relayOptions(dataDir));

    const started = await relay.startScheduler(1000);
    assert.equal(started.running, true);
    assert.equal(started.ownedByThisProcess, true, "the first process must own the scheduler");

    const lock = await waitFor(async () => readSchedulerLock(dataDir), {
      timeoutMs: 5000,
      intervalMs: 50,
      label: "scheduler.lock to appear",
    });
    assert.equal(lock.pid, process.pid, "scheduler.lock must record this process pid");

    const status = await relay.schedulerStatus();
    assert.equal(status.running, true);
    assert.equal(status.ownedByThisProcess, true);

    await relay.stopScheduler();
    assert.equal(await readSchedulerLock(dataDir), null, "stopScheduler must release scheduler.lock");
    const stopped = await relay.schedulerStatus();
    assert.equal(stopped.ownedByThisProcess, false);
  } finally {
    await relay?.close();
    await cleanupTempDir(dataDir);
  }
});
