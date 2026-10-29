import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { CloudStore } from "../../packages/cloud/dist/index.js";
import { cleanupTempDir, httpJson, makeTempDir, requestSummary, startWebServer } from "../helpers.mjs";

const PORT = 45739;

test("manual cloud top-up records one payment and is idempotent", async () => {
  const dir = await makeTempDir("relay-cloud-admin-web-");
  const dbPath = path.join(dir, "cloud.sqlite");
  const store = CloudStore.open(dbPath);
  const customer = store.createCustomer({ displayName: "Top-up Customer" });
  store.close();

  const server = await startWebServer({
    dataDir: path.join(dir, "owner"),
    port: PORT,
    label: "cloud-admin-web",
    env: {
      RELAY_CLOUD_ENABLED: "1",
      RELAY_CLOUD_TOKEN_KEY: Buffer.alloc(32, 31).toString("base64"),
      RELAY_CLOUD_DB: dbPath,
      RELAY_CLOUD_DATA_DIR: path.join(dir, "tenants"),
    },
  });
  try {
    const customers = await httpJson(server.baseUrl, "/api/cloud/admin/customers");
    assert.equal(customers.status, 200, requestSummary(customers));
    assert.equal(customers.json.customers.some((entry) => entry.id === customer.id), true);

    const payload = { customerId: customer.id, amount: 500, reference: "BANK-2026-001", note: "invoice #1" };
    const first = await httpJson(server.baseUrl, "/api/cloud/admin/topup", { method: "POST", body: payload });
    assert.equal(first.status, 200, requestSummary(first));
    assert.equal(first.json.paymentReplayed, false);
    assert.equal(first.json.balance.available, 500);

    const duplicate = await httpJson(server.baseUrl, "/api/cloud/admin/topup", { method: "POST", body: payload });
    assert.equal(duplicate.status, 200, requestSummary(duplicate));
    assert.equal(duplicate.json.paymentReplayed, true);
    assert.equal(duplicate.json.balance.available, 500);

    const detail = await httpJson(server.baseUrl, `/api/cloud/admin/customers/${customer.id}`);
    assert.equal(detail.status, 200, requestSummary(detail));
    assert.equal(Array.isArray(detail.json.accounts), true);
    assert.equal(detail.json.usage.length >= 1, true);

    const payments = await httpJson(server.baseUrl, `/api/cloud/admin/payments?customer=${customer.id}`);
    assert.equal(payments.status, 200, requestSummary(payments));
    assert.equal(payments.json.payments.length, 1);
    assert.equal(payments.json.payments[0].providerPaymentId, "BANK-2026-001");

    const page = await fetch(`${server.baseUrl}/cloud-admin.html`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Cloud admin/);
  } finally {
    await server.stop();
    await cleanupTempDir(dir);
  }
});

