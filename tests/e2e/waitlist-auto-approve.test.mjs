import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { cleanupTempDir, httpJson, makeTempDir, requestSummary, startWebServer } from "../helpers.mjs";

const PORT = 45742;

test("RELAY_WAITLIST_AUTO_APPROVE invites founding signups without admin", async () => {
  const dir = await makeTempDir("relay-waitlist-auto-");
  const server = await startWebServer({
    dataDir: path.join(dir, "owner"),
    port: PORT,
    label: "waitlist-auto",
    env: {
      RELAY_CLOUD_ENABLED: "1",
      RELAY_CLOUD_TOKEN_KEY: Buffer.alloc(32, 33).toString("base64"),
      RELAY_CLOUD_DB: path.join(dir, "cloud.sqlite"),
      RELAY_CLOUD_DATA_DIR: path.join(dir, "tenants"),
      RELAY_WAITLIST_LIMIT: "10",
      RELAY_WAITLIST_AUTO_APPROVE: "1",
    },
  });
  try {
    const signup = await httpJson(server.baseUrl, "/api/waitlist", {
      method: "POST",
      body: { name: "Auto Aina", email: "auto@example.com", platforms: "threads" },
    });
    assert.equal(signup.status, 201, requestSummary(signup));
    assert.equal(signup.json.autoApproved, true);
    assert.equal(signup.json.status, "invited");
    assert.match(signup.json.setupUrl ?? "", /\/setup\?token=/);

    const list = await httpJson(server.baseUrl, "/api/cloud/admin/waitlist?status=invited");
    assert.equal(list.status, 200);
    assert.equal(list.json.entries.some((entry) => entry.email === "auto@example.com"), true);

    const customers = await httpJson(server.baseUrl, "/api/cloud/admin/customers");
    assert.equal(customers.json.customers.some((entry) => entry.displayName === "Auto Aina"), true);
  } finally {
    await server.stop();
    await cleanupTempDir(dir);
  }
});