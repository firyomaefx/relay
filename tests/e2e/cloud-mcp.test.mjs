import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { CloudStore } from "../../packages/cloud/dist/index.js";
import { cleanupTempDir, makeTempDir, repoRoot, sleep, waitFor } from "../helpers.mjs";

const TOKEN_KEY = Buffer.alloc(32, 11).toString("base64");
const PORT = 44991;

async function initialize(base, key) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

test("cloud MCP entry fails closed when cloud mode is off", async () => {
  const child = spawn(process.execPath, ["apps/mcp/dist/cloud-entry.js"], {
    cwd: repoRoot,
    env: { ...process.env, RELAY_CLOUD_ENABLED: "0", RELAY_CLOUD_MCP_PORT: String(PORT + 1) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exitCode = await new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  assert.notEqual(exitCode, 0);
});

test("cloud MCP entry rejects missing keys and resolves a valid key to one customer", async () => {
  const dir = await makeTempDir("relay-cloud-mcp-");
  const dbPath = path.join(dir, "cloud.sqlite");
  const store = CloudStore.open(dbPath);
  const customer = store.createCustomer({ displayName: "Cloud Customer" });
  const key = store.createApiKey(customer.id, "test");
  store.close();

  const child = spawn(process.execPath, ["apps/mcp/dist/cloud-entry.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      RELAY_CLOUD_ENABLED: "1",
      RELAY_CLOUD_TOKEN_KEY: TOKEN_KEY,
      RELAY_CLOUD_DB: dbPath,
      RELAY_CLOUD_MCP_PORT: String(PORT),
      RELAY_DATA_DIR: dir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitFor(async () => {
      try {
        const health = await fetch(`http://127.0.0.1:${PORT}/health`);
        return health.ok;
      } catch {
        return false;
      }
    }, { label: "cloud MCP health" });

    const rejected = await initialize(`http://127.0.0.1:${PORT}`, "rly_wrong_wrong");
    assert.equal(rejected.status, 401);

    const accepted = await initialize(`http://127.0.0.1:${PORT}`, key.key);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body?.result?.serverInfo?.name, "relay-cloud");

    const whoami = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${key.key}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "relay_cloud_whoami", arguments: {} } }),
    });
    assert.equal(whoami.status, 200);
    const whoamiBody = await whoami.json();
    const text = whoamiBody?.result?.content?.[0]?.text ?? "";
    assert.match(text, new RegExp(customer.id));
  } finally {
    child.kill("SIGTERM");
    await sleep(200);
    await cleanupTempDir(dir);
  }
});
