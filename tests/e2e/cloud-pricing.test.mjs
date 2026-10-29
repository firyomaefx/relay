import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { cleanupTempDir, httpJson, makeTempDir, startWebServer } from "../helpers.mjs";

const PORT = 45740;

test("public pricing page and price API work without a console session", async () => {
  const dataDir = await makeTempDir("relay-pricing-");
  const server = await startWebServer({
    dataDir,
    port: PORT,
    label: "pricing",
    env: { RELAY_CONSOLE_PASSWORD: "pricing-test-password" },
  });
  try {
    const page = await fetch(`${server.baseUrl}/pricing`, { redirect: "manual" });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Relay Cloud/);
    assert.match(html, /Prices by platform/);

    const api = await httpJson(server.baseUrl, "/api/pricing");
    assert.equal(api.status, 200);
    assert.equal(api.json.currency, "MYR");
    assert.equal(api.json.unit, "sen");
    assert.equal(api.json.freeAllowancePosts, 5);
    assert.equal(api.json.prices.x.text, 50);

    const protectedState = await httpJson(server.baseUrl, "/api/state");
    assert.equal(protectedState.status, 401);
  } finally {
    await server.stop();
    await cleanupTempDir(dataDir);
  }
});
