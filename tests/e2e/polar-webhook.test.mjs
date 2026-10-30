import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { CloudStore } from "../../packages/cloud/dist/index.js";
import { cleanupTempDir, httpJson, makeTempDir, startWebServer } from "../helpers.mjs";

const PORT = 45752;
const SECRET = "whsec_cmVsYXktcG9sYXItdGVzdA==";

test("Polar webhook credits a customer idempotently and rejects bad signatures", async () => {
  const dir = await makeTempDir("relay-polar-webhook-");
  const dbPath = path.join(dir, "cloud.sqlite");
  const store = CloudStore.open(dbPath);
  const customer = store.createCustomer({ displayName: "Polar Customer" });
  store.close();

  const server = await startWebServer({
    dataDir: path.join(dir, "owner"),
    port: PORT,
    label: "polar-webhook",
    env: {
      RELAY_CLOUD_ENABLED: "1",
      RELAY_CLOUD_TOKEN_KEY: Buffer.alloc(32, 39).toString("base64"),
      RELAY_CLOUD_DB: dbPath,
      RELAY_CLOUD_DATA_DIR: path.join(dir, "tenants"),
      RELAY_POLAR_ACCESS_TOKEN: "polar_oat_test",
      RELAY_POLAR_PRODUCT_ID: "00000000-0000-4000-8000-000000000000",
      RELAY_POLAR_WEBHOOK_SECRET: SECRET,
      RELAY_POLAR_API_BASE: "https://sandbox-api.polar.sh",
    },
  });
  try {
    const payload = JSON.stringify({
      type: "order.paid",
      data: {
        id: "order_test_1",
        totalAmount: 1000,
        currency: "usd",
        metadata: { customer_id: customer.id, amount_milli: "10000" },
      },
    });
    const id = "msg_test_1";
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const key = Buffer.from(SECRET.slice(6), "base64");
    const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${payload}`, "utf8").digest("base64");
    const send = (sig) => fetch(`${server.baseUrl}/api/polar/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": id,
        "webhook-timestamp": timestamp,
        "webhook-signature": sig,
      },
      body: payload,
    });

    assert.equal((await send(`v1,${signature}`)).status, 200);
    const detail = await httpJson(server.baseUrl, `/api/cloud/admin/customers/${customer.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.customer.available, 10_000);
    assert.equal(detail.json.payments.length, 1);
    assert.equal(detail.json.payments[0].provider, "polar");

    // Replaying the same Polar order must not double-credit.
    assert.equal((await send(`v1,${signature}`)).status, 200);
    const replay = await httpJson(server.baseUrl, `/api/cloud/admin/customers/${customer.id}`);
    assert.equal(replay.json.customer.available, 10_000);

    assert.equal((await send("v1,deadbeef")).status, 400);
  } finally {
    await server.stop();
    await cleanupTempDir(dir);
  }
});
