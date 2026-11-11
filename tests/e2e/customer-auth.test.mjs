// Traceability: customer session isolation and operator guard requirements
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { CloudStore } from "@relay/cloud";
import { startServer } from "../../apps/web/dist/server.js";
import { createInviteToken, hashCustomerPassword } from "../../apps/web/dist/customer-auth.js";
import { cleanupTempDir, makeTempDir } from "../helpers.mjs";

function cookieFrom(response) {
  const raw = response.headers.getSetCookie?.() ?? [];
  const header = raw.find((value) => value.startsWith("relay_customer_session=") || value.startsWith("relay_console_session=")) || raw[0];
  assert.ok(header, "expected a session cookie");
  return header.split(";")[0];
}

test("customer session is isolated from operator admin routes", async () => {
  const root = await makeTempDir("relay-customer-http-");
  const dbPath = path.join(root, "cloud.sqlite");
  const store = CloudStore.open(dbPath);
  const customer = store.createCustomer({ displayName: "HTTP Customer", email: "http-customer@example.com" });
  store.setCustomerPassword(customer.id, await hashCustomerPassword("customer-password-2026"));
  const invite = createInviteToken();
  store.createCustomerInvite(customer.id, invite.tokenHash, 60_000);
  store.close();

  const env = {
    ...process.env,
    RELAY_CLOUD_ENABLED: "1",
    RELAY_CLOUD_TOKEN_KEY: "a".repeat(64),
    RELAY_CLOUD_DB: dbPath,
    RELAY_CLOUD_DATA_DIR: path.join(root, "tenants"),
    RELAY_DATA_DIR: path.join(root, "owner"),
    RELAY_CLOUD_MCP_PORT: "43219",
    RELAY_CUSTOMER_SESSION_SECRET: "customer-session-secret-".repeat(3),
    RELAY_CONSOLE_PASSWORD: "operator-password-2026",
    RELAY_PUBLIC_URL: "http://127.0.0.1",
    RELAY_MOCK: "1",
  };
  const running = await startServer({ host: "127.0.0.1", port: 0, dataDir: path.join(root, "owner"), password: "operator-password-2026", env, logger: () => undefined });
  try {
    const base = running.url;
    const customerLogin = await fetch(`${base}/api/customer/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "http-customer@example.com", password: "customer-password-2026" }),
    });
    assert.equal(customerLogin.status, 200);
    const customerCookie = cookieFrom(customerLogin);
    assert.match(customerCookie, /^relay_customer_session=/);

    const session = await fetch(`${base}/api/session`, { headers: { cookie: customerCookie } });
    assert.deepEqual((await session.json()).role, "customer");
    const state = await fetch(`${base}/api/state`, { headers: { cookie: customerCookie } });
    assert.equal(state.status, 200);
    assert.equal((await state.json()).role, "customer");

    const profile = await fetch(`${base}/api/cloud/profile`, { headers: { cookie: customerCookie } });
    assert.equal(profile.status, 200);
    assert.equal((await profile.json()).customer.email, "http-customer@example.com");
    const me = await fetch(`${base}/api/cloud/me`, { headers: { cookie: customerCookie } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).customer.id, customer.id);
    const billing = await fetch(`${base}/api/cloud/billing`, { headers: { cookie: customerCookie } });
    assert.equal(billing.status, 200);
    const adminAsCustomer = await fetch(`${base}/api/cloud/admin/customers`, { headers: { cookie: customerCookie } });
    assert.equal(adminAsCustomer.status, 403);

    const accepted = await fetch(`${base}/api/customer/accept-invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: invite.token, password: "customer-password-2026b" }),
    });
    assert.equal(accepted.status, 200);
    const replay = await fetch(`${base}/api/customer/accept-invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: invite.token, password: "customer-password-2026c" }),
    });
    assert.equal(replay.status, 400);
    const relogin = await fetch(`${base}/api/customer/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "http-customer@example.com", password: "customer-password-2026b" }),
    });
    assert.equal(relogin.status, 200);

    const operatorLogin = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "operator-password-2026" }),
    });
    assert.equal(operatorLogin.status, 200);
    const operatorCookie = cookieFrom(operatorLogin);
    assert.match(operatorCookie, /^relay_console_session=/);
    const operatorSession = await fetch(`${base}/api/session`, { headers: { cookie: operatorCookie } });
    assert.equal((await operatorSession.json()).role, "operator");
    const adminAsOperator = await fetch(`${base}/api/cloud/admin/customers`, { headers: { cookie: operatorCookie } });
    assert.equal(adminAsOperator.status, 200);
  } finally {
    await running.close();
    await cleanupTempDir(root);
  }
});
