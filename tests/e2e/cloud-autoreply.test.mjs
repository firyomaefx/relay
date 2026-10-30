import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { CloudLedger, CloudStore } from "../../packages/cloud/dist/index.js";
import { cleanupTempDir, makeTempDir, repoRoot, sleep, waitFor } from "../helpers.mjs";

const TOKEN_KEY = Buffer.alloc(32, 44).toString("base64");
const PORT = 44998;

async function call(base, key, name, args = {}) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await response.json();
  return { isError: Boolean(body?.result?.isError), text: String(body?.result?.content?.[0]?.text ?? "") };
}

test("cloud auto-reply requires a paid 10 USD top-up, DeepSeek key and Threads reply readiness", async () => {
  const dir = await makeTempDir("relay-cloud-autoreply-");
  const dbPath = path.join(dir, "cloud.sqlite");
  const pricePath = path.join(dir, "prices.json");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(pricePath, JSON.stringify({
    currency: "USD",
    unit: "milliUSD",
    free_allowance_milli_usd: 500,
    free_excluded_platforms: ["x"],
    prices: { threads: { text: 20 }, x: { text: 20 } },
  }));
  const store = CloudStore.open(dbPath);
  const customer = store.createCustomer({ displayName: "Auto Reply Customer" });
  const key = store.createApiKey(customer.id, "autoreply");
  store.close();

  const child = spawn(process.execPath, ["apps/mcp/dist/cloud-entry.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      RELAY_CLOUD_ENABLED: "1",
      RELAY_CLOUD_TOKEN_KEY: TOKEN_KEY,
      RELAY_CLOUD_DB: dbPath,
      RELAY_CLOUD_DATA_DIR: path.join(dir, "tenants"),
      RELAY_CLOUD_PRICES: pricePath,
      RELAY_DATA_DIR: path.join(dir, "owner"),
      RELAY_CLOUD_MCP_PORT: String(PORT),
      DEEPSEEK_API_KEY: "sk-owner-global-key-1234567890",
      RELAY_MOCK: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = `http://127.0.0.1:${PORT}`;
  let ledger;
  try {
    await waitFor(async () => {
      try { return (await fetch(`${base}/health`)).ok; } catch { return false; }
    }, { label: "cloud MCP health" });

    const initial = await call(base, key.key, "relay_cloud_autoreply", { action: "status" });
    assert.equal(initial.isError, false, initial.text);
    const initialStatus = JSON.parse(initial.text);
    assert.equal(initialStatus.eligible, false);
    assert.equal(initialStatus.paidTopupMilliUsd, 0);
    assert.equal(initialStatus.keyConfigured, false);
    assert.equal(initialStatus.threadsConnected, false);

    const setKey = await call(base, key.key, "relay_cloud_autoreply", {
      action: "set_key",
      api_key: "sk-test-deepseek-key-1234567890",
    });
    assert.equal(setKey.isError, false, setKey.text);

    const blocked = await call(base, key.key, "relay_cloud_autoreply", { action: "enable" });
    assert.equal(blocked.isError, true);
    assert.match(blocked.text, /Top up at least \$10\.00/);

    ledger = new CloudLedger(dbPath);
    ledger.recordTopup({
      customerId: customer.id,
      amount: 10000,
      reference: "AUTOREPLY-TEST-TOPUP",
      note: "test paid top-up",
    });

    const needsThreads = await call(base, key.key, "relay_cloud_autoreply", { action: "enable" });
    assert.equal(needsThreads.isError, true);
    assert.match(needsThreads.text, /Connect a Threads account/);

    assert.equal((await call(base, key.key, "relay_connect", { platform: "threads" })).isError, false);

    const eligible = await call(base, key.key, "relay_cloud_autoreply", { action: "status" });
    const status = JSON.parse(eligible.text);
    assert.equal(status.paidTopupMilliUsd, 10000);
    assert.equal(status.keyConfigured, true);
    assert.equal(status.threadsReady, true);
    assert.equal(status.eligible, true);

    const enabled = await call(base, key.key, "relay_cloud_autoreply", { action: "enable" });
    assert.equal(enabled.isError, false, enabled.text);
    const enabledStatus = JSON.parse(enabled.text);
    assert.equal(enabledStatus.active, true);

    const disabled = await call(base, key.key, "relay_cloud_autoreply", { action: "disable" });
    assert.equal(disabled.isError, false, disabled.text);
    assert.equal(JSON.parse(disabled.text).active, false);
  } finally {
    child.kill("SIGTERM");
    ledger?.close();
    await sleep(300);
    await cleanupTempDir(dir);
  }
});



