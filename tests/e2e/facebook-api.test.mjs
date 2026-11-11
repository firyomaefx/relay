// Facebook Pages is available only when the feature flag is on.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { cleanupTempDir, httpJson, makeTempDir, requestSummary, startWebServer } from "../helpers.mjs";

const PORT = 45750;

test("flag-enabled Facebook connects and publishes a Page post through /api/posts", async () => {
  const dir = await makeTempDir("relay-facebook-api-");
  const server = await startWebServer({
    dataDir: path.join(dir, "data"),
    port: PORT,
    label: "facebook-api",
    env: { RELAY_ENABLE_FACEBOOK: "1" },
  });
  try {
    const stateBefore = await httpJson(server.baseUrl, "/api/state");
    assert.equal(stateBefore.status, 200, requestSummary(stateBefore));
    assert.equal(stateBefore.json.settings.platforms.some((entry) => entry.platform === "facebook"), true);

    const connected = await httpJson(server.baseUrl, "/api/connect/facebook", { method: "POST", body: {} });
    assert.equal(connected.status, 200, requestSummary(connected));
    assert.equal(connected.json.account.platform, "facebook");
    assert.equal(connected.json.account.mode, "mock");

    const posted = await httpJson(server.baseUrl, "/api/posts", {
      method: "POST",
      body: { draft: { platforms: ["facebook"], text: "Facebook Page post from the test" } },
    });
    assert.equal(posted.status, 200, requestSummary(posted));
    assert.equal(posted.json.results[0].platform, "facebook");
    assert.equal(posted.json.results[0].ok, true);
    assert.equal(posted.json.results[0].mode, "mock");

    const history = await httpJson(server.baseUrl, "/api/history");
    assert.equal(history.status, 200, requestSummary(history));
    assert.equal(history.json.history[0].results[0].platform, "facebook");
  } finally {
    await server.stop();
    await cleanupTempDir(dir);
  }
});
