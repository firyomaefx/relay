import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { CloudStore } from "../../packages/cloud/dist/index.js";
import { cleanupTempDir, httpJson, makeTempDir, startWebServer } from "../helpers.mjs";

const PORT = 45751;

test("Stripe webhook credits a customer idempotently and rejects bad signatures", async () => {
  const dir = await makeTempDir("relay-stripe-webhook-");
  const dbPath = path.join(dir, "cloud.sqlite");
  const store = CloudStore.open(dbPath);
  const customer = store.createCustomer({ displayName: "Stripe Customer" });
  store.close();

  const server = await startWebServer({
    dataDir: path.join(dir, "owner"),
    port: PORT,
    label: "stripe-webhook",
    env: {
      RELAY_CLOUD_ENABLED: "1",
      RELAY_CLOUD_TOKEN_KEY: Buffer.alloc(32, 37).toString("base64"),
      RELAY_CLOUD_DB: dbPath,
      RELAY_CLOUD_DATA_DIR: path.join(dir, "tenants"),
      RELAY_STRIPE_SECRET_KEY: "sk_test_dummy",
      RELAY_STRIPE_WEBHOOK_SECRET: "whsec_test",
    },
  });
  try {
    const payload = JSON.stringify({
      id: "evt_test_1",
      type: "checkout.session.completed",
      data: { object: { id: "cs_test_1", payment_status: "paid", metadata: { customer_id: customer.id, amount_milli: "10000" } } },
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", "whsec_test").update(`${timestamp}.${payload}`, "utf8").digest("hex");
    const send = (header) => fetch(`${server.baseUrl}/api/stripe/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": header },
      body: payload,
    });

    assert.equal((await send(`t=${timestamp},v1=${signature}`)).status, 200);
    const detail = await httpJson(server.baseUrl, `/api/cloud/admin/customers/${customer.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.customer.available, 10_000);
    assert.equal(detail.json.payments.length, 1);
    assert.equal(detail.json.payments[0].provider, "stripe");

    // Replaying the same Stripe event must not double-credit.
    assert.equal((await send(`t=${timestamp},v1=${signature}`)).status, 200);
    const replay = await httpJson(server.baseUrl, `/api/cloud/admin/customers/${customer.id}`);
    assert.equal(replay.json.customer.available, 10_000);

    assert.equal((await send(`t=${timestamp},v1=deadbeef`)).status, 400);
  } finally {
    await server.stop();
    await cleanupTempDir(dir);
  }
});

