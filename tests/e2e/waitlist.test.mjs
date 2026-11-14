// Traceability: REQ-016
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { cleanupTempDir, httpJson, makeTempDir, requestSummary, startWebServer } from "../helpers.mjs";

const PORT = 45741;

test("public waitlist accepts requests, dedupes email, and admin approval stops at the batch cap", async () => {
  const dir = await makeTempDir("relay-waitlist-");
  const server = await startWebServer({
    dataDir: path.join(dir, "owner"),
    port: PORT,
    label: "waitlist-web",
    env: {
      RELAY_CLOUD_ENABLED: "1",
      RELAY_CLOUD_TOKEN_KEY: Buffer.alloc(32, 32).toString("base64"),
      RELAY_CLOUD_DB: path.join(dir, "cloud.sqlite"),
      RELAY_CLOUD_DATA_DIR: path.join(dir, "tenants"),
      RELAY_WAITLIST_LIMIT: "2",
    },
  });
  try {
    const page = await fetch(`${server.baseUrl}/waitlist`);
    assert.equal(page.status, 200);
    const pageText = await page.text();
    assert.match(pageText, /One post\./);
    assert.match(pageText, /Request early access/);
    assert.match(pageText, /ChatGPT/);
    assert.match(pageText, /Content first/);
    assert.match(pageText, /id="waitlistForm"/);

    const pageResponse = await fetch(`${server.baseUrl}/waitlist`);
    assert.equal(pageResponse.headers.get("cache-control"), "no-store");
    const assetResponse = await fetch(`${server.baseUrl}/waitlist.css?v=cache-test`);
    assert.equal(assetResponse.headers.get("cache-control"), "public, max-age=31536000, immutable");

    const first = await httpJson(server.baseUrl, "/api/waitlist", {
      method: "POST",
      body: { name: "Aina", email: "Aina@example.com", phone: "+60123456789", platforms: ["Threads", "TikTok"], volume: "1–20" },
    });
    assert.equal(first.status, 201, requestSummary(first));
    assert.equal(first.json.ok, true);
    assert.equal(first.json.position, 1);

    const minimal = await httpJson(server.baseUrl, "/api/waitlist", {
      method: "POST",
      body: { name: "No Phone", email: "nophone@example.com" },
    });
    assert.equal(minimal.status, 201, requestSummary(minimal));
    assert.equal(minimal.json.ok, true);

    const duplicate = await httpJson(server.baseUrl, "/api/waitlist", {
      method: "POST",
      body: { name: "Aina again", email: "aina@example.com", phone: "+60123456789" },
    });
    assert.equal(duplicate.status, 200, requestSummary(duplicate));
    assert.equal(duplicate.json.duplicate, true);

    const second = await httpJson(server.baseUrl, "/api/waitlist", {
      method: "POST",
      body: { name: "Ben", email: "ben@example.com", phone: "+6591234567", volume: "21–100" },
    });
    assert.equal(second.status, 201, requestSummary(second));

    const status = await httpJson(server.baseUrl, "/api/waitlist");
    assert.equal(status.status, 200);
    assert.equal(status.json.accepted, 0);
    assert.equal(status.json.limit, 2);
    assert.equal(status.json.open, true);
    assert.equal(status.json.acceptingRequests, true);
    assert.equal(status.json.batch, "founding");

    const list = await httpJson(server.baseUrl, "/api/cloud/admin/waitlist?status=pending");
    assert.equal(list.status, 200, requestSummary(list));
    assert.equal(list.json.entries.length, 3);
    const aina = list.json.entries.find((entry) => entry.name === "Aina");
    const ben = list.json.entries.find((entry) => entry.name === "Ben");
    assert.ok(aina && ben);

    const approved = await httpJson(server.baseUrl, `/api/cloud/admin/waitlist/${aina.id}/approve`, {
      method: "POST",
      body: {},
    });
    assert.equal(approved.status, 201, requestSummary(approved));
    assert.match(approved.json.connectUrl, /\/connect\?token=rlc_/);
    assert.equal(approved.json.entry.status, "invited");

    const approvedSecond = await httpJson(server.baseUrl, `/api/cloud/admin/waitlist/${ben.id}/approve`, {
      method: "POST",
      body: {},
    });
    assert.equal(approvedSecond.status, 201, requestSummary(approvedSecond));

    const full = await httpJson(server.baseUrl, "/api/waitlist", {
      method: "POST",
      body: { name: "Third", email: "third@example.com", phone: "+60111222333" },
    });
    assert.equal(full.status, 201, requestSummary(full));
    assert.equal(full.json.batch, "next");

    const fullStatus = await httpJson(server.baseUrl, "/api/waitlist");
    assert.equal(fullStatus.json.open, false);
    assert.equal(fullStatus.json.acceptingRequests, true);
    assert.equal(fullStatus.json.batch, "next");

    const customers = await httpJson(server.baseUrl, "/api/cloud/admin/customers");
    assert.equal(customers.status, 200);
    assert.equal(customers.json.customers.some((entry) => entry.displayName === "Aina"), true);
    assert.equal(customers.json.customers.some((entry) => entry.displayName === "Ben"), true);
  } finally {
    await server.stop();
    await cleanupTempDir(dir);
  }
});

