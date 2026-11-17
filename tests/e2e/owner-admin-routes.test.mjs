// Owner vs customer URL guards
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { CloudStore } from "@relay/cloud";
import { startServer } from "../../apps/web/dist/server.js";
import { hashCustomerPassword } from "../../apps/web/dist/customer-auth.js";
import { cleanupTempDir, makeTempDir } from "../helpers.mjs";

function cookieFrom(response) {
  const raw = response.headers.getSetCookie?.() ?? [];
  const header = raw.find((value) => value.startsWith("relay_console_session=") || value.startsWith("relay_customer_session=")) || raw[0];
  assert.ok(header, "expected a session cookie");
  return header.split(";")[0];
}

test("owner admin routes redirect unsigned users to /admin and block customers", async () => {
  const root = await makeTempDir("relay-owner-routes-");
  const dbPath = path.join(root, "cloud.sqlite");
  const store = CloudStore.open(dbPath);
  const customer = store.createCustomer({ displayName: "Route Customer", email: "route@example.com" });
  store.setCustomerPassword(customer.id, await hashCustomerPassword("customer-password-route"));
  store.close();

  const env = {
    ...process.env,
    RELAY_CLOUD_ENABLED: "1",
    RELAY_CLOUD_TOKEN_KEY: "b".repeat(64),
    RELAY_CLOUD_DB: dbPath,
    RELAY_CLOUD_DATA_DIR: path.join(root, "tenants"),
    RELAY_DATA_DIR: path.join(root, "owner"),
    RELAY_CUSTOMER_SESSION_SECRET: "customer-session-secret-".repeat(3),
    RELAY_CONSOLE_PASSWORD: "owner-password-route",
    RELAY_PUBLIC_URL: "http://127.0.0.1",
    RELAY_MOCK: "1",
  };
  const running = await startServer({
    host: "127.0.0.1",
    port: 0,
    dataDir: path.join(root, "owner"),
    password: "owner-password-route",
    env,
    logger: () => undefined,
  });
  try {
    const base = running.url;
    for (const pathSuffix of ["/cloud-admin", "/manage"]) {
      const unsigned = await fetch(`${base}${pathSuffix}`, { redirect: "manual" });
      assert.equal(unsigned.status, 302, pathSuffix);
      assert.match(unsigned.headers.get("location") ?? "", /\/admin/);
    }

    const operatorLogin = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "owner-password-route" }),
    });
    assert.equal(operatorLogin.status, 200);
    const operatorCookie = cookieFrom(operatorLogin);

    const adminHome = await fetch(`${base}/admin`, { redirect: "manual", headers: { cookie: operatorCookie } });
    assert.equal(adminHome.status, 302);
    assert.match(adminHome.headers.get("location") ?? "", /\/cloud-admin/);

    const adminPage = await fetch(`${base}/cloud-admin`, { headers: { cookie: operatorCookie } });
    assert.equal(adminPage.status, 200);
    assert.match(await adminPage.text(), /Owner admin/);

    const customerLogin = await fetch(`${base}/api/customer/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "route@example.com", password: "customer-password-route" }),
    });
    assert.equal(customerLogin.status, 200);
    const customerCookie = cookieFrom(customerLogin);
    const customerBlocked = await fetch(`${base}/cloud-admin`, { redirect: "manual", headers: { cookie: customerCookie } });
    assert.equal(customerBlocked.status, 302);
    assert.match(customerBlocked.headers.get("location") ?? "", /^\/$/);
  } finally {
    await running.close();
    await cleanupTempDir(root);
  }
});