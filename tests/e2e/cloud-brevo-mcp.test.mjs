// Traceability: REQ-016
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { CloudStore } from "../../packages/cloud/dist/index.js";
import { cleanupTempDir, makeTempDir, repoRoot, sleep, spawnNode, waitFor } from "../helpers.mjs";

const TOKEN_KEY = Buffer.alloc(32, 17).toString("base64");
const PORT = 44997;

async function mcpCall(base, key, name, args = {}) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

test("cloud MCP lists Brevo contact lists in mock tenant", async () => {
  const dir = await makeTempDir("relay-cloud-brevo-");
  const dbPath = path.join(dir, "cloud.sqlite");
  const store = CloudStore.open(dbPath);
  const customer = store.createCustomer({ displayName: "Brevo Tenant" });
  const key = store.createApiKey(customer.id, "brevo-test");
  store.close();

  const child = spawnNode("apps/mcp/dist/cloud-entry.js", {
    cwd: repoRoot,
    env: {
      ...process.env,
      RELAY_CLOUD_ENABLED: "1",
      RELAY_CLOUD_TOKEN_KEY: TOKEN_KEY,
      RELAY_CLOUD_DB: dbPath,
      RELAY_CLOUD_MCP_PORT: String(PORT),
      RELAY_DATA_DIR: path.join(dir, "owner"),
      RELAY_MOCK: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitFor(
      async () => {
        try {
          const health = await fetch(`http://127.0.0.1:${PORT}/health`);
          return health.ok;
        } catch {
          return false;
        }
      },
      { label: "cloud MCP health" },
    );

    const connect = await mcpCall(`http://127.0.0.1:${PORT}`, key.key, "relay_connect", {
      platform: "brevo",
      api_key: "xkeysib_e2e_mock_key_1234567890",
    });
    assert.equal(connect.status, 200);
    const connectText = connect.body?.result?.content?.[0]?.text ?? "";
    assert.match(connectText, /Connected Brevo Email/i);

    const lists = await mcpCall(`http://127.0.0.1:${PORT}`, key.key, "relay_brevo_lists", {});
    assert.equal(lists.status, 200);
    const listsText = lists.body?.result?.content?.[0]?.text ?? "";
    assert.match(listsText, /Newsletter \(mock\)/i);
  } finally {
    child.kill("SIGTERM");
    await sleep(200);
    await cleanupTempDir(dir);
  }
});