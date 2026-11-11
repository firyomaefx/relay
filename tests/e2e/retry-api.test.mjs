// The retry endpoint refuses to resend a platform that already succeeded.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { cleanupTempDir, httpJson, makeTempDir, requestSummary, startWebServer } from "../helpers.mjs";

const PORT = 45749;

test("POST /api/retry retries failed targets and refuses a fully successful post", async () => {
  const dir = await makeTempDir("relay-retry-api-");
  const server = await startWebServer({ dataDir: path.join(dir, "data"), port: PORT, label: "retry-api" });
  try {
    const missingTarget = await httpJson(server.baseUrl, "/api/retry", { method: "POST", body: {} });
    assert.equal(missingTarget.status, 400, requestSummary(missingTarget));

    const failedPost = await httpJson(server.baseUrl, "/api/posts", {
      method: "POST",
      body: { draft: { platforms: ["x"], text: "no x account is connected yet" } },
    });
    assert.equal(failedPost.status, 200, requestSummary(failedPost));
    assert.equal(failedPost.json.results[0].ok, false);
    assert.ok(failedPost.json.recordId);

    const retried = await httpJson(server.baseUrl, "/api/retry", {
      method: "POST",
      body: { recordId: failedPost.json.recordId },
    });
    assert.equal(retried.status, 200, requestSummary(retried));
    assert.deepEqual(retried.json.retried, ["x"]);
    assert.deepEqual(retried.json.skipped, []);
    assert.notEqual(retried.json.recordId, failedPost.json.recordId, "retry creates a new history entry");

    const unknown = await httpJson(server.baseUrl, "/api/retry", {
      method: "POST",
      body: { recordId: "post_missing" },
    });
    assert.equal(unknown.status, 404, requestSummary(unknown));

    const connected = await httpJson(server.baseUrl, "/api/connect/x", { method: "POST", body: {} });
    assert.equal(connected.status, 200, requestSummary(connected));
    const success = await httpJson(server.baseUrl, "/api/posts", {
      method: "POST",
      body: { draft: { platforms: ["x"], text: "this post succeeds once" } },
    });
    assert.equal(success.status, 200, requestSummary(success));
    assert.equal(success.json.results[0].ok, true);

    const nothing = await httpJson(server.baseUrl, "/api/retry", {
      method: "POST",
      body: { recordId: success.json.recordId },
    });
    assert.equal(nothing.status, 400, requestSummary(nothing));
    assert.match(nothing.json.error, /already succeeded/i);
  } finally {
    await server.stop();
    await cleanupTempDir(dir);
  }
});
