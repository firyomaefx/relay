import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { CloudStore, CloudLedger } from "../../packages/cloud/dist/index.js";
import { cleanupTempDir, makeTempDir, repoRoot, sleep, waitFor } from "../helpers.mjs";

const TOKEN_KEY = Buffer.alloc(32, 13).toString("base64");
const PORT = 44992;

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
  return { status: response.status, isError: Boolean(json?.result?.isError), text: String(json?.result?.content?.[0]?.text ?? "") };
}

test("cloud customers A and B cannot read, cancel or publish into each other's data", async () => {
  const dir = await makeTempDir("relay-cloud-isolation-");
  const dbPath = path.join(dir, "cloud.sqlite");
  const store = CloudStore.open(dbPath);
  const a = store.createCustomer({ displayName: "Tenant A" });
  const b = store.createCustomer({ displayName: "Tenant B" });
  const keyA = store.createApiKey(a.id, "A");
  const keyB = store.createApiKey(b.id, "B");
  store.close();
  const ledger = new CloudLedger(dbPath);
  ledger.credit({ customerId: a.id, amount: 1000, type: "topup", idempotencyKey: "seed-a" });
  ledger.credit({ customerId: b.id, amount: 1000, type: "topup", idempotencyKey: "seed-b" });
  ledger.close();

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

    assert.equal((await call(base, keyA.key, "relay_connect", { platform: "x" })).isError, false);
    assert.equal((await call(base, keyB.key, "relay_connect", { platform: "x" })).isError, false);

    const at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const aJob = await call(base, keyA.key, "relay_post", { platforms: ["x"], text: "A scheduled only", schedule_at: at });
    const bJob = await call(base, keyB.key, "relay_post", { platforms: ["x"], text: "B scheduled only", schedule_at: at });
    assert.equal(aJob.isError, false, aJob.text);
    assert.equal(bJob.isError, false, bJob.text);

    const idA = /job_[0-9a-f-]+/.exec(aJob.text)?.[0];
    const idB = /job_[0-9a-f-]+/.exec(bJob.text)?.[0];
    assert.ok(idA && idB && idA !== idB);

    const aQueue = await call(base, keyA.key, "relay_queue", {});
    const bQueue = await call(base, keyB.key, "relay_queue", {});
    assert.match(aQueue.text, new RegExp(idA));
    assert.equal(aQueue.text.includes(idB), false);
    assert.match(bQueue.text, new RegExp(idB));
    assert.equal(bQueue.text.includes(idA), false);

    const crossCancel = await call(base, keyA.key, "relay_cancel", { job_id: idB });
    assert.equal(crossCancel.isError, true);

    const ownCancel = await call(base, keyB.key, "relay_cancel", { job_id: idB });
    assert.equal(ownCancel.isError, false, ownCancel.text);

    const aPost = await call(base, keyA.key, "relay_post", { platforms: ["x"], text: "A immediate post" });
    assert.equal(aPost.isError, false, aPost.text);
    const aHistory = await call(base, keyA.key, "relay_history", {});
    const bHistory = await call(base, keyB.key, "relay_history", {});
    assert.match(aHistory.text, /A immediate post/);
    assert.equal(bHistory.text.includes("A immediate post"), false);
  } finally {
    child.kill("SIGTERM");
    await sleep(300);
    await cleanupTempDir(dir);
  }
});



