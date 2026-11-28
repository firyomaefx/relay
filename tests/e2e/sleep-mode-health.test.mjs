import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { cleanupTempDir, httpJson, makeTempDir, requestSummary, sleep, startWebServer, waitFor } from "../helpers.mjs";

const PORT = 45750;

test("health exposes cloud sleep mode and records tenant pulse", async () => {
  const dir = await makeTempDir("relay-sleep-health-");
  const server = await startWebServer({
    dataDir: path.join(dir, "owner"),
    port: PORT,
    label: "sleep-health",
    env: {
      RELAY_CLOUD_ENABLED: "1",
      RELAY_CLOUD_TOKEN_KEY: Buffer.alloc(32, 51).toString("base64"),
      RELAY_CLOUD_DB: path.join(dir, "cloud.sqlite"),
      RELAY_CLOUD_DATA_DIR: path.join(dir, "tenants"),
      RELAY_CLOUD_TENANT_SCHEDULER_MS: "1000",
      RELAY_PUBLIC_URL: "https://relay.test",
    },
  });
  try {
    const health = await httpJson(server.baseUrl, "/api/health");
    assert.equal(health.ok, true, requestSummary(health));
    assert.equal(health.json.cloud?.enabled, true);
    assert.equal(health.json.cloud?.tenantSchedulerPulseMs, 1000);
    assert.equal(health.json.cloud?.publicBaseConfigured, true);

    await waitFor(async () => {
      const again = await httpJson(server.baseUrl, "/api/health");
      return Boolean(again.json.cloud?.lastTenantPulseAt);
    }, { label: "tenant pulse telemetry", timeoutMs: 8000, intervalMs: 200 });

    const final = await httpJson(server.baseUrl, "/api/health");
    assert.ok(final.json.cloud.lastTenantPulseAt);
    await sleep(100);
  } finally {
    await server.stop();
    await cleanupTempDir(dir);
  }
});