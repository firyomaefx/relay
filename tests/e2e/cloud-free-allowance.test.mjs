import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { CloudLedger, CloudStore } from "../../packages/cloud/dist/index.js";
import { cleanupTempDir, makeTempDir, repoRoot, sleep, waitFor } from "../helpers.mjs";

const TOKEN_KEY = Buffer.alloc(32, 43).toString("base64");
const PORT = 44997;

async function call(base, key, name, args = {}) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await response.json();
  return { isError: Boolean(body?.result?.isError), text: String(body?.result?.content?.[0]?.text ?? "") };
}

test("free text posts spend free credit; X is excluded and the credit is finite", async () => {
  const dir = await makeTempDir("relay-cloud-free-");
  const dbPath = path.join(dir, "cloud.sqlite");
  const pricePath = path.join(dir, "prices.json");
  writeFileSync(pricePath, JSON.stringify({
    currency: "USD",
    unit: "milliUSD",
    free_allowance_milli_usd: 12,
    free_excluded_platforms: ["x"],
    prices: { threads: { text: 3 }, x: { text: 3 } },
  }));
  const store = CloudStore.open(dbPath);
  const customer = store.createCustomer({ displayName: "Free Customer" });
  const key = store.createApiKey(customer.id, "free");
  store.close();

  const ledger = new CloudLedger(dbPath);
  try {
    assert.equal(ledger.freeRemaining(customer.id, 12), 12);
  } finally {
    ledger.close();
  }

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
      RELAY_MOCK: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = `http://127.0.0.1:${PORT}`;
  try {
    await waitFor(async () => {
      try { return (await fetch(`${base}/health`)).ok; } catch { return false; }
    }, { label: "cloud MCP health" });
    assert.equal((await call(base, key.key, "relay_connect", { platform: "threads" })).isError, false);
    assert.equal((await call(base, key.key, "relay_connect", { platform: "x" })).isError, false);

    const quoted = await call(base, key.key, "relay_validate", {
      platforms: ["threads"],
      thread: [{ text: "one" }, { text: "two" }, { text: "three" }],
    });
    assert.equal(quoted.isError, false, quoted.text);
    assert.match(quoted.text, /Estimated cost/);
    assert.match(quoted.text, /3 part\(s\)/);
    // Threads consumes 3 milliUSD from the free credit; X is explicitly excluded.
    const freePost = await call(base, key.key, "relay_post", { platforms: ["threads"], text: "free text post" });
    assert.equal(freePost.isError, false, freePost.text);
    const xPost = await call(base, key.key, "relay_post", { platforms: ["x"], text: "X must be paid" });
    assert.equal(xPost.isError, true);
    assert.match(xPost.text, /Insufficient balance/i);

    // Spend the remaining 9 milliUSD, then the next free-eligible post must be paid.
    for (let index = 0; index < 3; index += 1) {
      const result = await call(base, key.key, "relay_post", { platforms: ["threads"], text: `free text post ${index}` });
      assert.equal(result.isError, false, result.text);
    }
    const exhausted = await call(base, key.key, "relay_post", { platforms: ["threads"], text: "free credit exhausted" });
    assert.equal(exhausted.isError, true);
    assert.match(exhausted.text, /Insufficient balance/i);
  } finally {
    child.kill("SIGTERM");
    await sleep(300);
    await cleanupTempDir(dir);
  }
});

