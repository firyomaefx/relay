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

    const me = await httpJson(server.baseUrl, "/api/cloud/admin/me");
    assert.equal(me.status, 200, requestSummary(me));
    assert.equal(me.json.balance.available, 0);
    assert.equal(me.json.freeCredit.limit, 500);
    assert.equal(me.json.freeCredit.remaining, 500);

    const billing = await httpJson(server.baseUrl, "/api/cloud/admin/billing");
    assert.equal(billing.status, 200, requestSummary(billing));
    assert.equal(billing.json.totalAvailable, 500);
    assert.equal(billing.json.payments.length, 0);
    assert.equal(billing.json.providers.stripe, false);
    assert.equal(billing.json.providers.polar, false);

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

    const connectToken = await httpJson(server.baseUrl, "/api/cloud/admin/connect-token", { method: "POST", body: { customerId: customer.id } });
    assert.equal(connectToken.status, 201, requestSummary(connectToken));
    assert.match(connectToken.json.url, /^https:\/\/cloud-mcp\.duitpoket\.fun\/mcp\?token=rlc_/);

    const checkout = await httpJson(server.baseUrl, "/api/cloud/admin/checkout", { method: "POST", body: { customerId: customer.id, amount: 10_000 } });
    assert.equal(checkout.status, 503, requestSummary(checkout));

    const page = await fetch(`${server.baseUrl}/cloud-admin.html`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Cloud admin/);
  } finally {
    await server.stop();
    await cleanupTempDir(dir);
  }
});


