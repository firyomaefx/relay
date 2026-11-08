// REQ-002, REQ-030
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { CloudStore } from "../../packages/cloud/dist/index.js";
import { cleanupTempDir, makeTempDir, sleep } from "../helpers.mjs";

async function withStore(fn) {
  const dir = await makeTempDir("relay-connect-session-");
  const store = CloudStore.open(path.join(dir, "cloud.sqlite"));
  try {
    await fn(store);
  } finally {
    store.close();
    await cleanupTempDir(dir);
  }
}

test("connect session is tenant-bound, short-lived and single-flow", async () => {
  await withStore(async (store) => {
    const customer = store.createCustomer({ displayName: "Session Customer" });
    const created = store.createConnectSession(customer.id, ["claude-desktop", "cursor"], 60_000);
    assert.match(created.token, /^rcs_[0-9a-f]{10}_/);
    assert.equal(created.status, "pending");
    assert.deepEqual(created.requestedClients, ["claude-desktop", "cursor"]);
    assert.equal(new Date(created.expiresAt).getTime() - new Date(created.createdAt).getTime(), 60_000);

    const found = store.getConnectSession(created.token, created.id);
    assert.equal(found.id, created.id);
    assert.equal(found.customerId, customer.id);
    assert.equal(found.status, "pending");

    const consumed = store.consumeConnectSession(created.token, created.id);
    assert.equal(consumed.status, "consumed");
    assert.notEqual(consumed.usedAt, null);

    assert.throws(
      () => store.getConnectSession(created.token, created.id),
      (error) => error.code === "cloud_connect_session_used",
    );
  });
});

test("connect session rejects wrong token and expiry", async () => {
  await withStore(async (store) => {
    const customer = store.createCustomer({ displayName: "Expiry Customer" });
    const created = store.createConnectSession(customer.id, [], 1);
    await sleep(10);
    assert.throws(
      () => store.getConnectSession(created.token, created.id),
      (error) => error.code === "cloud_connect_session_expired",
    );

    const other = store.createConnectSession(customer.id, [], 60_000);
    assert.throws(
      () => store.getConnectSession(other.token, "cs_missing"),
      (error) => error.code === "cloud_connect_session_invalid",
    );
    assert.throws(
      () => store.getConnectSession("rcs_bad_token", other.id),
      (error) => error.code === "cloud_connect_session_invalid",
    );
  });
});

test("connect session token cannot be used for another tenant's session id", async () => {
  await withStore(async (store) => {
    const one = store.createCustomer({ displayName: "Tenant One" });
    const two = store.createCustomer({ displayName: "Tenant Two" });
    const a = store.createConnectSession(one.id, [], 60_000);
    const b = store.createConnectSession(two.id, [], 60_000);
    assert.throws(
      () => store.getConnectSession(a.token, b.id),
      (error) => error.code === "cloud_connect_session_invalid",
    );
  });
});
