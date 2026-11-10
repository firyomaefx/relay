// Owner bonus tools appear only for the owner key on the Relay Cloud MCP.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { CloudStore } from "../../packages/cloud/dist/index.js";
import { cleanupTempDir, makeTempDir, repoRoot, sleep, waitFor } from "../helpers.mjs";

const PORT = 44989;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN_KEY = Buffer.alloc(32, 13).toString("base64");

async function rpc(key, id, method, params = {}) {
  const response = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await response.text();
  const line = text.split("\n").find((entry) => entry.startsWith("data:"));
  return { status: response.status, body: JSON.parse(line ? line.slice(5) : text) };
}

const callTool = (key, name, args) => rpc(key, 2, "tools/call", { name, arguments: args });
const payload = (res) => JSON.parse(res.body.result.content[0].text);

test("bonus tools are owner-only, write type bonus, and customers never see them", async () => {
  const dir = await makeTempDir("relay-cloud-bonus-mcp-");
  const dbPath = path.join(dir, "cloud.sqlite");
  const store = CloudStore.open(dbPath);
  const owner = store.ensureOwnerCustomer("Owner");
  const ownerKey = store.createApiKey(owner.id, "owner").key;
  const customer = store.createCustomer({ displayName: "Founding One" });
  const customerKey = store.createApiKey(customer.id, "customer").key;
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
        return (await fetch(`${BASE}/health`)).ok;
      } catch {
        return false;
      }
    }, { label: "cloud MCP health" });

    const ownerTools = (await rpc(ownerKey, 1, "tools/list")).body.result.tools.map((tool) => tool.name);
    const customerTools = (await rpc(customerKey, 1, "tools/list")).body.result.tools.map((tool) => tool.name);
    assert.ok(ownerTools.includes("relay_grant_bonus_credit"));
    assert.ok(ownerTools.includes("relay_list_bonus_grants"));
    assert.ok(!customerTools.includes("relay_grant_bonus_credit"));
    assert.ok(!customerTools.includes("relay_list_bonus_grants"));

    // A customer cannot call the tool even by guessing its name.
    const denied = await callTool(customerKey, "relay_grant_bonus_credit", { customer_id: customer.id, amount_usd: 5, reason: "self grant" });
    assert.ok(denied.body.error || denied.body.result?.isError, "customer call must fail");

    const granted = await callTool(ownerKey, "relay_grant_bonus_credit", {
      customer_id: customer.id,
      amount_usd: 5,
      reason: "founding deal test",
      idempotency_key: "e2e-1",
    });
    const first = payload(granted);
    assert.equal(first.entry.type, "bonus");
    assert.equal(first.balance_usd, 5);
    const replay = payload(await callTool(ownerKey, "relay_grant_bonus_credit", {
      customer_id: customer.id, amount_usd: 5, reason: "founding deal test", idempotency_key: "e2e-1",
    }));
    assert.equal(replay.replayed, true);
    assert.equal(replay.entry_id, first.entry_id);
    assert.equal(replay.balance_usd, 5);

    const tooBig = await callTool(ownerKey, "relay_grant_bonus_credit", { customer_id: customer.id, amount_usd: 101, reason: "x" });
    assert.ok(tooBig.body.error || tooBig.body.result?.isError);
    const unknown = await callTool(ownerKey, "relay_grant_bonus_credit", { customer_id: "cus_nope", amount_usd: 1, reason: "x" });
    assert.ok(unknown.body.error || unknown.body.result?.isError);

    const listed = payload(await callTool(ownerKey, "relay_list_bonus_grants", { reason_contains: "founding" }));
    assert.equal(listed.count, 1);
    assert.equal(listed.total_usd, 5);
    assert.equal(listed.grants[0].entry_id, first.entry_id);
    assert.equal(listed.grants[0].customer, "Founding One");
  } finally {
    child.kill("SIGTERM");
    await sleep(200);
    await cleanupTempDir(dir);
  }
});
