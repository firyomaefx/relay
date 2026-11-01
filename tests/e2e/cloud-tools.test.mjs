import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { CloudStore } from "../../packages/cloud/dist/index.js";
import { cleanupTempDir, makeTempDir, repoRoot, sleep, waitFor } from "../helpers.mjs";

const TOKEN_KEY = Buffer.alloc(32, 29).toString("base64");
const PORT = 44995;

async function mcp(base, key, method, params = {}) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: response.status, body: await response.json() };
}

async function tool(base, key, name, args = {}) {
  const result = await mcp(base, key, "tools/call", { name, arguments: args });
  const text = String(result.body?.result?.content?.[0]?.text ?? "");
  return { isError: Boolean(result.body?.result?.isError), text };
}

test("cloud surface exposes balance, usage and prices without changing the owner tools", async () => {
  const dir = await makeTempDir("relay-cloud-tools-");
  const dbPath = path.join(dir, "cloud.sqlite");
  const store = CloudStore.open(dbPath);
  const customer = store.createCustomer({ displayName: "Tools Customer" });
  const key = store.createApiKey(customer.id, "tools");
  store.close();

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

    const list = await mcp(base, key.key, "tools/list");
    const names = list.body.result.tools.map((entry) => entry.name);
    assert.ok(names.includes("relay_balance"));
    assert.ok(names.includes("relay_usage"));
    assert.ok(names.includes("relay_prices"));
    assert.ok(names.includes("relay_post"));
    assert.ok(names.includes("relay_cancel"));

    const balance = await tool(base, key.key, "relay_balance");
    assert.equal(balance.isError, false);
    const balanceJson = JSON.parse(balance.text);
    assert.equal(balanceJson.available, 0);
    assert.equal(balanceJson.held, 0);
    assert.equal(typeof balanceJson.currency, "string");

    const usage = await tool(base, key.key, "relay_usage", { limit: 5 });
    assert.equal(usage.isError, false);
    const usageJson = JSON.parse(usage.text);
    assert.deepEqual(usageJson.entries, []);

    const prices = await tool(base, key.key, "relay_prices");
    assert.equal(prices.isError, false);
    const pricesJson = JSON.parse(prices.text);
    assert.equal(typeof pricesJson.prices.x.text, "number");
  } finally {
    child.kill("SIGTERM");
    await sleep(300);
    await cleanupTempDir(dir);
  }
});
