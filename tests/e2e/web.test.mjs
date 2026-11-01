/**
 * End-to-end test for the web console: spawns `node apps/web/dist/index.js` on a
 * fixed test port with a temporary data directory and drives every documented
 * API route over real HTTP.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  TINY_PNG_BASE64,
  cleanupTempDir,
  httpJson,
  isoIn,
  makeTempDir,
  platformEntry,
  requestSummary,
  sleep,
  startWebServer,
  tinyPngBuffer,
  waitFor,
} from "../helpers.mjs";

const TEST_PORT = 45731;

let dataDir;
let server;

before(async () => {
  dataDir = await makeTempDir("relay-web-e2e-");
  server = await startWebServer({ dataDir, port: TEST_PORT, label: "web-e2e" });
});

after(async () => {
  await server?.stop();
  await cleanupTempDir(dataDir);
});

test("GET /api/health reports a healthy simulated console", async () => {
  const health = await httpJson(server.baseUrl, "/api/health");
  assert.equal(health.ok, true, `GET /api/health failed: ${requestSummary(health)}`);
  assert.equal(health.json.ok, true);
  assert.equal(health.json.mock, true, "RELAY_MOCK=1 must put the console in simulated mode");
  assert.equal(typeof health.json.payments?.stripeConfigured, "boolean");
  assert.equal(typeof health.json.payments?.polarConfigured, "boolean");
  assert.equal(typeof health.json.payments?.polarSandbox, "boolean");
});

test("GET / serves the Relay console HTML shell", async () => {
  const response = await httpJson(server.baseUrl, "/");
  assert.equal(response.status, 200, `GET / failed: ${requestSummary(response)}`);
  assert.match(response.text, /Relay/, "the console HTML must mention Relay");
  assert.match(response.text, /<html[\s>]/i, "GET / should serve an HTML document");
});

test("POST /api/connect/x connects a simulated X account", async () => {
  const connected = await httpJson(server.baseUrl, "/api/connect/x", { method: "POST", body: {} });
  assert.equal(connected.ok, true, `POST /api/connect/x failed: ${requestSummary(connected)}`);
  assert.equal(connected.json.mode, "connected");
  assert.equal(connected.json.account.platform, "x");
  assert.equal(connected.json.account.mode, "mock");

  const state = await httpJson(server.baseUrl, "/api/state");
  assert.equal(state.ok, true, `GET /api/state failed: ${requestSummary(state)}`);
  const entry = platformEntry(state.json, "x");
  assert.ok(entry, "state should include an X platform entry");
  assert.equal(entry.connected, true);
  assert.equal(entry.account.handle, connected.json.account.handle);
  assert.equal(entry.live, false, "forced mock mode must never report live publishing");
});

test("POST /api/connect/:platform addAccount creates a second account and disconnects by id", async () => {
  const added = await httpJson(server.baseUrl, "/api/connect/x", {
    method: "POST",
    body: { addAccount: true, label: "Agency X" },
  });
  assert.equal(added.ok, true, `add account failed: ${requestSummary(added)}`);
  assert.match(added.json.account.id, /^acct_/);
  assert.equal(added.json.account.label, "Agency X");

  const state = await httpJson(server.baseUrl, "/api/state");
  const accounts = (state.json.accounts ?? []).filter((account) => account.platform === "x");
  assert.equal(accounts.length, 2, "the primary X account and the added account must both exist");
  assert.ok(accounts.some((account) => account.id === added.json.account.id));

  const removed = await httpJson(server.baseUrl, "/api/disconnect/x", {
    method: "POST",
    body: { accountId: added.json.account.id },
  });
  assert.equal(removed.ok, true, `disconnect by account id failed: ${requestSummary(removed)}`);
  const after = await httpJson(server.baseUrl, "/api/state");
  assert.equal((after.json.accounts ?? []).filter((account) => account.platform === "x").length, 1);
});

test("POST /api/media stores a base64 PNG and serves it back", async () => {
  const upload = await httpJson(server.baseUrl, "/api/media", {
    method: "POST",
    body: { filename: "relay-e2e.png", dataBase64: TINY_PNG_BASE64 },
  });
  assert.equal(upload.ok, true, `POST /api/media failed: ${requestSummary(upload)}`);
  assert.equal(typeof upload.json.path, "string", `expected a path in ${requestSummary(upload)}`);
  assert.match(upload.json.url, /^\/media\/[A-Za-z0-9._-]+$/, `expected a /media/<name> url, got ${upload.json.url}`);
  assert.equal(upload.json.kind, "image");

  const stored = await readFile(upload.json.path);
  assert.deepEqual(stored, tinyPngBuffer(), "the uploaded file must contain the decoded PNG bytes");

  const served = await fetch(`${server.baseUrl}${upload.json.url}`, { signal: AbortSignal.timeout(5000) });
  assert.equal(served.status, 200, `GET ${upload.json.url} should serve the uploaded media`);
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), tinyPngBuffer());

  // A full data URL is also accepted for the same field.
  const dataUrlUpload = await httpJson(server.baseUrl, "/api/media", {
    method: "POST",
    body: { filename: "relay-e2e-data-url.png", dataBase64: `data:image/png;base64,${TINY_PNG_BASE64}` },
  });
  assert.equal(dataUrlUpload.ok, true, `data URL upload failed: ${requestSummary(dataUrlUpload)}`);
});

test("POST /api/posts publishes text+media and GET /api/history records it", async () => {
  const mediaUpload = await httpJson(server.baseUrl, "/api/media", {
    method: "POST",
    body: { filename: "relay-e2e-post.png", dataBase64: TINY_PNG_BASE64 },
  });
  assert.equal(mediaUpload.ok, true, requestSummary(mediaUpload));

  const text = `Web e2e post ${Date.now()}`;
  const posted = await httpJson(server.baseUrl, "/api/posts", {
    method: "POST",
    body: {
      draft: {
        platforms: ["x"],
        text,
        media: [{ path: mediaUpload.json.path, kind: "image" }],
      },
    },
  });
  assert.equal(posted.ok, true, `POST /api/posts failed: ${requestSummary(posted)}`);
  assert.equal(posted.json.scheduled, false, "a post with no scheduleAt publishes immediately");
  assert.equal(posted.json.report.ok, true, `draft should be valid: ${JSON.stringify(posted.json.report?.issues)}`);
  assert.equal(posted.json.results.length, 1);
  assert.equal(posted.json.results[0].ok, true, `publish failed: ${JSON.stringify(posted.json.results)}`);
  assert.equal(posted.json.results[0].mode, "mock");

  const history = await httpJson(server.baseUrl, "/api/history");
  assert.equal(history.ok, true, `GET /api/history failed: ${requestSummary(history)}`);
  assert.ok(Array.isArray(history.json.history), "history response must contain a history array");
  const record = history.json.history.find((entry) => entry.draft?.text === text);
  assert.ok(record, `history should contain the new post: ${JSON.stringify(history.json.history)}`);
  assert.equal(record.results[0].ok, true);
  assert.equal(record.results[0].mode, "mock");
  assert.equal(record.draft.media.length, 1);
});

test("POST /api/validate rejects a 300 character X post", async () => {
  const response = await httpJson(server.baseUrl, "/api/validate", {
    method: "POST",
    body: { draft: { platforms: ["x"], text: "v".repeat(300) } },
  });
  // Validation failures are a domain outcome: accept 200 with a report (per the
  // documented contract) or a 400/422 transport error.
  assert.notEqual(response.status, 500, `validation crashed: ${requestSummary(response)}`);
  const report = response.json?.report ?? response.json;
  assert.ok(report && typeof report === "object", `expected a validation report: ${requestSummary(response)}`);
  assert.equal(report.ok, false, "a 300 character X draft must be invalid");
  assert.equal(report.perPlatform?.x?.ok, false);
  assert.ok(
    Array.isArray(report.issues) && report.issues.some((issue) => issue.code === "text_too_long"),
    `expected a text_too_long issue: ${JSON.stringify(report.issues)}`,
  );

  const validResponse = await httpJson(server.baseUrl, "/api/validate", {
    method: "POST",
    body: { draft: { platforms: ["x"], text: "short and valid" } },
  });
  const validReport = validResponse.json?.report ?? validResponse.json;
  assert.equal(validReport.ok, true, `short draft should validate: ${requestSummary(validResponse)}`);
});

test("POST /api/preview returns adapted per-platform variants", async () => {
  const response = await httpJson(server.baseUrl, "/api/preview", {
    method: "POST",
    body: { draft: { platforms: ["x", "instagram"], text: "word ".repeat(700).trim() } },
  });
  assert.equal(response.ok, true, `preview failed: ${requestSummary(response)}`);
  assert.ok(Array.isArray(response.json.platforms));
  const x = response.json.platforms.find((entry) => entry.platform === "x");
  const instagram = response.json.platforms.find((entry) => entry.platform === "instagram");
  assert.ok(x && x.parts.length > 1, "X preview should auto-thread");
  assert.equal(instagram.truncated, true, "Instagram cannot thread and should report truncation");
});

test("a scheduled post can be canceled and never publishes", async () => {
  const text = `Web scheduled post ${Date.now()}`;
  const scheduleAt = isoIn(6000);
  const created = await httpJson(server.baseUrl, "/api/posts", {
    method: "POST",
    body: { draft: { platforms: ["x"], text, scheduleAt } },
  });
  assert.equal(created.ok, true, `POST /api/posts (scheduled) failed: ${requestSummary(created)}`);
  assert.equal(created.json.scheduled, true, "a future scheduleAt must queue the post");
  const jobId = created.json.jobId;
  assert.ok(jobId, "a scheduled post must return a jobId");

  const pendingJob = await waitFor(
    async () => {
      const state = await httpJson(server.baseUrl, "/api/state");
      assert.equal(state.ok, true, `GET /api/state failed: ${requestSummary(state)}`);
      return (state.json.queue ?? []).find((job) => job.id === jobId && job.status === "pending") ?? null;
    },
    { timeoutMs: 15000, intervalMs: 200, label: "the scheduled job to appear in the queue" },
  );
  assert.equal(pendingJob.scheduleAt, new Date(scheduleAt).toISOString());

  const canceled = await httpJson(server.baseUrl, `/api/queue/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
    body: {},
  });
  assert.equal(canceled.ok, true, `POST /api/queue/:id/cancel failed: ${requestSummary(canceled)}`);
  assert.equal(canceled.json.ok, true);
  assert.equal(canceled.json.canceled, true);

  const canceledJob = await waitFor(
    async () => {
      const state = await httpJson(server.baseUrl, "/api/state");
      return (state.json.queue ?? []).find((job) => job.id === jobId && job.status === "canceled") ?? null;
    },
    { timeoutMs: 15000, intervalMs: 200, label: "the job status to become canceled" },
  );
  assert.equal(canceledJob.status, "canceled");
  assert.match(canceledJob.lastError ?? "", /cancel/i);

  // A canceled job must not add a history record.
  await sleep(1500);
  let history;
  try {
    history = await httpJson(server.baseUrl, "/api/history");
  } catch (error) {
    throw new Error(
      `server died before GET /api/history (running=${server.running}, exitCode=${server.child.exitCode})\n${error.message}\n--- server output ---\n${server.tail()}`,
    );
  }
  assert.equal(
    (history.json.history ?? []).some((entry) => entry.draft?.text === text),
    false,
    "a canceled scheduled post must never be published",
  );

  // Canceling an unknown id is a 404.
  const missing = await httpJson(server.baseUrl, "/api/queue/job_does-not-exist/cancel", {
    method: "POST",
    body: {},
  });
  assert.equal(missing.status, 404, `canceling an unknown job should be 404, got ${requestSummary(missing)}`);
});

test("PUT and DELETE /api/credentials/x manage encrypted client credentials", async () => {
  const clientId = "relay-e2e-client-id";
  const clientSecret = "relay-e2e-client-secret-4b7d";
  const putResponse = await httpJson(server.baseUrl, "/api/credentials/x", {
    method: "PUT",
    body: { clientId, clientSecret },
  });
  assert.equal(putResponse.ok, true, `PUT /api/credentials/x failed: ${requestSummary(putResponse)}`);

  const configured = await waitFor(
    async () => {
      const state = await httpJson(server.baseUrl, "/api/state");
      assert.equal(state.ok, true);
      const info = (state.json.credentials ?? []).find((entry) => entry.platform === "x");
      return info?.configured ? info : null;
    },
    { timeoutMs: 10000, intervalMs: 200, label: "X credentials to be reported configured" },
  );
  assert.equal(configured.source, "settings");

  const state = await httpJson(server.baseUrl, "/api/state");
  assert.equal(state.text.includes(clientSecret), false, "the console must never expose the client secret over HTTP");

  const credentialsFile = path.join(dataDir, "credentials.enc.json");
  const raw = await readFile(credentialsFile, "utf8");
  assert.equal(raw.includes(clientSecret), false, "credentials.enc.json must not contain the plaintext client secret");
  assert.equal(raw.includes(clientId), false, "credentials.enc.json must not contain the plaintext client id");
  const blob = JSON.parse(raw);
  assert.equal(blob.alg, "aes-256-gcm");

  const deleteResponse = await httpJson(server.baseUrl, "/api/credentials/x", { method: "DELETE", body: {} });
  assert.equal(deleteResponse.ok, true, `DELETE /api/credentials/x failed: ${requestSummary(deleteResponse)}`);

  await waitFor(
    async () => {
      const current = await httpJson(server.baseUrl, "/api/state");
      const info = (current.json.credentials ?? []).find((entry) => entry.platform === "x");
      return info && info.configured === false ? info : null;
    },
    { timeoutMs: 10000, intervalMs: 200, label: "X credentials to be removed" },
  );
});
