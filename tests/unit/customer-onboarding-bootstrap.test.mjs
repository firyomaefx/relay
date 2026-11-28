import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  bootstrapCustomerAfterSetup,
  CloudStore,
  TenantManager,
} from "../../packages/cloud/dist/index.js";
import { cleanupTempDir, makeTempDir } from "../helpers.mjs";

test("bootstrapCustomerAfterSetup rotates active connect tokens and returns MCP URL", async () => {
  const dataDir = await makeTempDir("relay-onboard-bootstrap-");
  const store = CloudStore.open(path.join(dataDir, "cloud.sqlite"));
  const config = {
    enabled: true,
    dbPath: path.join(dataDir, "cloud.sqlite"),
    tokenKey: Buffer.alloc(32, 11),
    mcpPort: 4321,
    tenantDataRoot: path.join(dataDir, "tenants"),
    ownerDataDir: path.join(dataDir, "owner"),
    oauthBase: "https://relay.test",
  };
  const tenants = new TenantManager({
    store,
    config,
    forceMock: true,
    consoleUrl: "https://relay.test",
    logger: () => undefined,
  });
  try {
    const customer = store.createCustomer({ displayName: "Sleep Customer", email: "sleep@example.com" });
    const waitlistToken = store.createConnectToken(customer.id, "Waitlist invite");
    const result = await bootstrapCustomerAfterSetup(customer, tenants, store, null, {
      publicBase: "https://relay.test",
      sendWelcome: false,
    });
    assert.match(result.connectUrl, /^https:\/\/relay\.test\/connect\?token=/);
    const urlToken = new URL(result.connectUrl).searchParams.get("token");
    assert.ok(urlToken);
    assert.notEqual(urlToken, waitlistToken.token);
    const tokens = store.listConnectTokens(customer.id);
    const revoked = tokens.filter((t) => t.id === waitlistToken.id);
    const active = tokens.filter((t) => t.status === "active");
    assert.equal(revoked[0]?.status, "revoked");
    assert.equal(active.length, 1);
    assert.equal(result.schedulerStarted, true);
  } finally {
    await tenants.close();
    store.close();
    await cleanupTempDir(dataDir);
  }
});