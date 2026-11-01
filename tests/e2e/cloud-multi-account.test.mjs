import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { CloudLedger, CloudStore } from "../../packages/cloud/dist/index.js";
import { cleanupTempDir, makeTempDir, repoRoot, sleep, waitFor } from "../helpers.mjs";

const TOKEN_KEY = Buffer.alloc(32, 45).toString("base64");
const PORT = 44999;

async function call(base, key, name, args = {}) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await response.json();
  return { isError: Boolean(body?.result?.isError), text: String(body?.result?.content?.[0]?.text ?? "") };
}

test("cloud accounts unlock 3 per platform at $10 and 10 per platform at $50", async () => {
  const dir = await makeTempDir("relay-multi-cloud-");
  const dbPath = path.join(dir, "cloud.sqlite");
  const pricePath = path.join(dir, "prices.json");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(pricePath, JSON.stringify({
    currency: "USD", unit: "milliUSD", free_allowance_milli_usd: 500,
    free_excluded_platforms: ["x"], prices: { x: { text: 20 }, threads: { text: 20 } },
  }));
  const store = CloudStore.open(dbPath);
  const customer = store.createCustomer({ displayName: "Multi Account Customer" });
  const key = store.createApiKey(customer.id, "multi");
  store.close();

  const child = spawn(process.execPath, ["apps/mcp/dist/cloud-entry.js"], {
    cwd: repoRoot,
    env: {
      ...process.env, RELAY_CLOUD_ENABLED: "1", RELAY_CLOUD_TOKEN_KEY: TOKEN_KEY,
      RELAY_CLOUD_DB: dbPath, RELAY_CLOUD_DATA_DIR: path.join(dir, "tenants"),
      RELAY_CLOUD_PRICES: pricePath, RELAY_DATA_DIR: path.join(dir, "owner"),
      RELAY_CLOUD_MCP_PORT: String(PORT), RELAY_MOCK: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = `http://127.0.0.1:${PORT}`;
  let ledger;
  try {
    await waitFor(async () => {
      try { return (await fetch(`${base}/health`)).ok; } catch { return false; }
    }, { label: "cloud MCP health" });

    // The first account per platform is the legacy baseline.
    assert.equal((await call(base, key.key, "relay_connect", { platform: "x" })).isError, false);
    const blocked = await call(base, key.key, "relay_connect", { platform: "x" });
    assert.equal(blocked.isError, true);
    assert.match(blocked.text, /Top up at least \$10\.00/);

    ledger = new CloudLedger(dbPath);
    ledger.recordTopup({ customerId: customer.id, amount: 10000, reference: "MULTI-10" });
    assert.equal((await call(base, key.key, "relay_connect", { platform: "x" })).isError, false);
    assert.equal((await call(base, key.key, "relay_connect", { platform: "x" })).isError, false);
    const fourth = await call(base, key.key, "relay_connect", { platform: "x" });
    assert.equal(fourth.isError, true);
    assert.match(fourth.text, /account limit reached \(3\/3\)/);

    ledger.recordTopup({ customerId: customer.id, amount: 40000, reference: "MULTI-50" });
    for (let index = 4; index <= 10; index += 1) {
      const connected = await call(base, key.key, "relay_connect", { platform: "x", label: `X ${index}` });
      assert.equal(connected.isError, false, connected.text);
    }
    const eleventh = await call(base, key.key, "relay_connect", { platform: "x" });
    assert.equal(eleventh.isError, true);
    assert.match(eleventh.text, /account limit reached \(10\/10\)/);

    const status = await call(base, key.key, "relay_cloud_accounts", { action: "status" });
    const body = JSON.parse(status.text);
    assert.equal(body.tier.id, "scale");
    assert.equal(body.platforms.x.used, 10);
    assert.equal(body.platforms.x.limit, 10);
  } finally {
    child.kill("SIGTERM");
    ledger?.close();
    await sleep(300);
    await cleanupTempDir(dir);
  }
});
