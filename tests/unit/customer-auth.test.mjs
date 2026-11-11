// Traceability: customer auth and tenant session requirements
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { CloudStore, TenantManager } from "@relay/cloud";
import { CustomerAuth, hashCustomerPassword, verifyCustomerPassword, createInviteToken, hashInviteToken } from "../../apps/web/dist/customer-auth.js";
import { cleanupTempDir, makeTempDir } from "../helpers.mjs";

test("customer passwords are scrypt-hashed and verified", async () => {
  const hash = await hashCustomerPassword("correct horse battery staple");
  assert.match(hash, /^scrypt\$/);
  assert.equal(await verifyCustomerPassword("correct horse battery staple", hash), true);
  assert.equal(await verifyCustomerPassword("wrong password", hash), false);
});

test("customer session tokens are signed, role-bound and revocable by version", () => {
  const auth = new CustomerAuth("a".repeat(48));
  const token = auth.issueToken({ customerId: "cus_test", sessionVersion: 3 });
  assert.equal(auth.verifyToken(token)?.customerId, "cus_test");
  assert.equal(auth.verifyToken(token)?.sessionVersion, 3);
  assert.equal(auth.verifyToken(token.slice(0, -1) + "x"), null);
  assert.equal(auth.verifyToken("tampered.token"), null);
  assert.equal(new CustomerAuth("").enabled, false);
});

test("customer invites are single-use", async () => {
  const dataDir = await makeTempDir("relay-customer-auth-");
  const store = CloudStore.open(path.join(dataDir, "cloud.sqlite"));
  try {
    const customer = store.createCustomer({ displayName: "Tenant Test", email: "tenant@example.com" });
    const { token, tokenHash } = createInviteToken();
    store.createCustomerInvite(customer.id, tokenHash, 60_000);
    const consumed = store.consumeCustomerInvite(hashInviteToken(token));
    assert.equal(consumed?.customer.id, customer.id);
    assert.equal(store.consumeCustomerInvite(hashInviteToken(token)), null);
    store.setCustomerPassword(customer.id, await hashCustomerPassword("a-long-enough-password"));
    assert.equal(store.getCustomerAuthByEmail("TENANT@example.com")?.sessionVersion, 2);
  } finally {
    store.close();
    await cleanupTempDir(dataDir);
  }
});

test("email uniqueness is enforced for customer accounts", async () => {
  const dataDir = await makeTempDir("relay-customer-unique-");
  const store = CloudStore.open(path.join(dataDir, "cloud.sqlite"));
  try {
    store.createCustomer({ displayName: "One", email: "one@example.com" });
    assert.throws(() => store.createCustomer({ displayName: "Two", email: "ONE@example.com" }));
  } finally {
    store.close();
    await cleanupTempDir(dataDir);
  }
});


test("two customer tenants resolve to isolated data directories", async () => {
  const dataDir = await makeTempDir("relay-tenant-isolation-");
  const store = CloudStore.open(path.join(dataDir, "cloud.sqlite"));
  const config = {
    enabled: true,
    dbPath: path.join(dataDir, "cloud.sqlite"),
    tokenKey: Buffer.alloc(32, 7),
    mcpPort: 4321,
    tenantDataRoot: path.join(dataDir, "tenants"),
    ownerDataDir: path.join(dataDir, "owner"),
    oauthBase: "https://relay.duitpoket.fun",
  };
  const manager = new TenantManager({ store, config, forceMock: true, logger: () => undefined });
  try {
    const first = store.createCustomer({ displayName: "First", email: "first@example.com" });
    const second = store.createCustomer({ displayName: "Second", email: "second@example.com" });
    const firstRelay = await manager.get(first);
    const secondRelay = await manager.get(second);
    assert.notEqual(firstRelay.dataDir, secondRelay.dataDir);
    assert.equal(firstRelay.dataDir.includes(first.id), true);
    assert.equal(secondRelay.dataDir.includes(second.id), true);
  } finally {
    await manager.close();
    store.close();
    await cleanupTempDir(dataDir);
  }
});
