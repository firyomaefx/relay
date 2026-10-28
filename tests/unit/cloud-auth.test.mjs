import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadCloudConfig, CloudStore } from "../../packages/cloud/dist/index.js";
import { cleanupTempDir, makeTempDir, MCP_TOOL_NAMES } from "../helpers.mjs";

const TOKEN_KEY = Buffer.alloc(32, 7).toString("base64");

test("cloud mode is disabled by default without opening any database", () => {
  const config = loadCloudConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.dbPath, "");
  assert.equal(config.tokenKey, null);
  assert.equal(MCP_TOOL_NAMES.length, 19);
  assert.equal(MCP_TOOL_NAMES.includes("relay_balance"), false);
});

test("cloud mode refuses to start without RELAY_CLOUD_TOKEN_KEY", () => {
  assert.throws(
    () => loadCloudConfig({ RELAY_CLOUD_ENABLED: "1" }),
    (error) => error.code === "cloud_token_key_missing",
  );
});

test("valid API key resolves to exactly one customer; unknown and revoked keys are rejected", async () => {
  const dir = await makeTempDir("relay-cloud-auth-");
  const dbPath = path.join(dir, "cloud.sqlite");
  const store = CloudStore.open(dbPath);
  try {
    const config = loadCloudConfig({
      RELAY_CLOUD_ENABLED: "1",
      RELAY_CLOUD_TOKEN_KEY: TOKEN_KEY,
      RELAY_CLOUD_DB: dbPath,
    });
    assert.equal(config.enabled, true);

    const a = store.createCustomer({ displayName: "Customer A" });
    const b = store.createCustomer({ displayName: "Customer B" });
    const keyA = store.createApiKey(a.id, "A key");
    const keyB = store.createApiKey(b.id, "B key");

    assert.match(keyA.key, /^rly_[0-9a-f]{10}_/);
    assert.notEqual(keyA.key, keyB.key);

    const identityA = store.resolveApiKey(keyA.key);
    const identityB = store.resolveApiKey(keyB.key);
    assert.equal(identityA.customer.id, a.id);
    assert.equal(identityB.customer.id, b.id);
    assert.notEqual(identityA.customer.id, identityB.customer.id);

    // The raw key must never be stored, only its hash and prefix.
    const rawDb = await readFile(dbPath, "utf8");
    assert.equal(rawDb.includes(keyA.key), false);

    store.revokeApiKey(keyA.id);
    assert.throws(
      () => store.resolveApiKey(keyA.key),
      (error) => error.code === "cloud_api_key_revoked",
    );
    assert.throws(
      () => store.resolveApiKey("rly_unknown_unknown"),
      (error) => error.code === "cloud_api_key_invalid",
    );
  } finally {
    store.close();
    await cleanupTempDir(dir);
  }
});

test("one owner customer is allowed", async () => {
  const dir = await makeTempDir("relay-cloud-owner-");
  const store = CloudStore.open(path.join(dir, "cloud.sqlite"));
  try {
    const owner = store.createCustomer({ displayName: "Owner", owner: true });
    assert.equal(owner.owner, true);
    assert.throws(
      () => store.createCustomer({ displayName: "Second owner", owner: true }),
      (error) => error.code === "cloud_owner_exists",
    );
  } finally {
    store.close();
    await cleanupTempDir(dir);
  }
});
