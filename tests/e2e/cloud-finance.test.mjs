import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { CloudLedger, CloudStore } from "../../packages/cloud/dist/index.js";
import { cleanupTempDir, makeTempDir, repoRoot, sleep, waitFor } from "../helpers.mjs";

const TOKEN_KEY = Buffer.alloc(32, 23).toString("base64");
const PORT = 44994;

async function call(base, key, name, args = {}) {
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
  return { isError: Boolean(json?.result?.isError), text: String(json?.result?.content?.[0]?.text ?? "") };
}

function json(text) {
  const start = text.indexOf("{");
  return JSON.parse(text.slice(start));
}

test("reserves, charges, refunds on failure and cancels scheduled holds", async () => {
  const dir = await makeTempDir("relay-cloud-finance-");
  const dbPath = path.join(dir, "cloud.sqlite");
  const store = CloudStore.open(dbPath);
  const customer = store.createCustomer({ displayName: "Finance Customer" });
  const poor = store.createCustomer({ displayName: "Poor Customer" });
  const key = store.createApiKey(customer.id, "finance");
  const poorKey = store.createApiKey(poor.id, "poor");
  store.close();
  const seed = new CloudLedger(dbPath);
  seed.credit({ customerId: customer.id, amount: 100, type: "topup", idempotencyKey: "seed" });
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
    assert.equal((await call(base, key.key, "relay_connect", { platform: "x" })).isError, false);
    assert.equal((await call(base, poorKey.key, "relay_connect", { platform: "x" })).isError, false);

    const first = await call(base, key.key, "relay_post", { platforms: ["x"], text: "paid post one" });
    assert.equal(first.isError, false, first.text);
    const balance = json((await call(base, key.key, "relay_balance")).text);
    assert.equal(balance.available, 80);
    assert.equal(balance.held, 0);

    // Duplicate publish fails after the hold; the hold must be released.
    const duplicate = await call(base, key.key, "relay_post", { platforms: ["x"], text: "paid post one" });
    assert.equal(duplicate.isError, true);
    const afterDuplicate = json((await call(base, key.key, "relay_balance")).text);
    assert.equal(afterDuplicate.available, 80);

    const at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const scheduled = await call(base, key.key, "relay_post", { platforms: ["x"], text: "paid scheduled", schedule_at: at });
    assert.equal(scheduled.isError, false, scheduled.text);
    const held = json((await call(base, key.key, "relay_balance")).text);
    assert.equal(held.available, 60);
    assert.equal(held.held, 20);
    const jobId = /job_[0-9a-f-]+/.exec(scheduled.text)?.[0];
    assert.ok(jobId);
    assert.equal((await call(base, key.key, "relay_cancel", { job_id: jobId })).isError, false);
    const cancelled = json((await call(base, key.key, "relay_balance")).text);
    assert.equal(cancelled.available, 80);
    assert.equal(cancelled.held, 0);

    const poor = await call(base, poorKey.key, "relay_post", { platforms: ["x"], text: "no money" });
    assert.equal(poor.isError, true);
    assert.match(poor.text, /Insufficient balance/i);

    const usage = await call(base, key.key, "relay_usage", {});
    assert.match(usage.text, /charge/);
    const prices = await call(base, key.key, "relay_prices", {});
    assert.match(prices.text, /"currency"/);
  } finally {
    child.kill("SIGTERM");
    await sleep(300);
    await cleanupTempDir(dir);
  }
});


