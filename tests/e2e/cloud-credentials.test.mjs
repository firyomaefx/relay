import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { CloudStore, CloudLedger } from "../../packages/cloud/dist/index.js";
import { cleanupTempDir, makeTempDir, repoRoot, sleep, waitFor } from "../helpers.mjs";

const TOKEN_KEY = Buffer.alloc(32, 17).toString("base64");
const PORT = 44993;

async function callMcp(base, key, name, args = {}) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const json = await response.json();
  return { status: response.status, isError: Boolean(json?.result?.isError), text: String(json?.result?.content?.[0]?.text ?? "") };
}

async function api(base, key, method, route, body) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

test("cloud customers connect their own credentials and cannot post without an account", async () => {
  const dir = await makeTempDir("relay-cloud-credentials-");
  const dbPath = path.join(dir, "cloud.sqlite");
  const store = CloudStore.open(dbPath);
  const customer = store.createCustomer({ displayName: "Credentials Customer" });
  const noCredentials = store.createCustomer({ displayName: "No Credentials" });
  const key = store.createApiKey(customer.id, "test");
  const emptyKey = store.createApiKey(noCredentials.id, "empty");
  store.close();
  const seed = new CloudLedger(dbPath);
  seed.credit({ customerId: customer.id, amount: 1000, type: "topup", idempotencyKey: "seed-customer" });
  seed.credit({ customerId: noCredentials.id, amount: 1000, type: "topup", idempotencyKey: "seed-empty" });
  seed.close();

  const child = spawn(process.execPath, ["apps/mcp/dist/cloud-entry.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      RELAY_CLOUD_ENABLED: "1",
      RELAY_CLOUD_TOKEN_KEY: TOKEN_KEY,
      RELAY_CLOUD_DB: dbPath,
      RELAY_CLOUD_DATA_DIR: path.join(dir, "tenants"),
      RELAY_DATA_DIR: path.join(dir, "owner"),
      RELAY_CLOUD_OAUTH_BASE: "https://relay.example.test",
      RELAY_CLOUD_MCP_PORT: String(PORT),
      RELAY_MOCK: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = `http://127.0.0.1:${PORT}`;
  try {
    await waitFor(async () => {
      try {
        return (await fetch(`${base}/health`)).ok;
      } catch {
        return false;
      }
    }, { label: "cloud MCP health" });

    const before = await api(base, key.key, "GET", "/cloud/accounts");
    assert.equal(before.status, 200);
    assert.equal(before.body.platforms.find((entry) => entry.platform === "x").status, "not_connected");

    const missing = await api(base, emptyKey.key, "POST", "/cloud/connect/x");
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /credentials/i);

    const saved = await api(base, key.key, "PUT", "/cloud/credentials/x", {
      clientId: "test-client",
      clientSecret: "test-secret",
    });
    assert.equal(saved.status, 200);

    const connected = await api(base, key.key, "POST", "/cloud/connect/x");
    assert.equal(connected.status, 200);
    assert.equal(connected.body.mode, "connected");

    const after = await api(base, key.key, "GET", "/cloud/accounts");
    assert.equal(after.status, 200);
    assert.equal(after.body.platforms.find((entry) => entry.platform === "x").status, "ready");

    const secret = await readFile(path.join(dir, "tenants", customer.id, "secret.key"));
    const expected = createHmac("sha256", Buffer.from(TOKEN_KEY, "base64")).update(`relay-cloud-tenant:${customer.id}`).digest();
    assert.deepEqual(secret, expected);

    const noAccountPost = await callMcp(base, emptyKey.key, "relay_post", { platforms: ["x"], text: "must fail" });
    assert.equal(noAccountPost.isError, true);
    assert.match(noAccountPost.text, /account|connect/i);
  } finally {
    child.kill("SIGTERM");
    await sleep(300);
    await cleanupTempDir(dir);
  }
});

