import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  AUTOREPLY_MIN_TOPUP_MILLI_USD,
  CloudLedger,
  CloudStore,
  maybeAutoEnableThreadsAutoReply,
} from "../../packages/cloud/dist/index.js";
import { createRelay } from "../../packages/platforms/dist/index.js";
import { cleanupTempDir, makeTempDir } from "../helpers.mjs";

test("maybeAutoEnableThreadsAutoReply enables when top-up, key, and mock Threads are ready", async () => {
  const dir = await makeTempDir("relay-ar-auto-");
  const dbPath = path.join(dir, "cloud.sqlite");
  const dataDir = path.join(dir, "tenant");
  const store = CloudStore.open(dbPath);
  const customer = store.createCustomer({ displayName: "AR Auto" });
  store.close();
  const ledger = new CloudLedger(dbPath);
  ledger.recordTopup({ customerId: customer.id, amount: AUTOREPLY_MIN_TOPUP_MILLI_USD, reference: "AR-1" });

  const relay = await createRelay({
    dataDir,
    forceMock: true,
    env: { ...process.env, DEEPSEEK_API_KEY: "sk-test-deepseek-key-1234567890", RELAY_MOCK: "1" },
  });
  await relay.setDeepSeekApiKey("sk-test-deepseek-key-1234567890");
  await relay.beginConnect("threads");
  await relay.setThreadsAutoReplyEnabled(false);

  assert.equal(relay.isThreadsAutoReplyEnabled(), false);
  const first = await maybeAutoEnableThreadsAutoReply(customer, relay, ledger);
  assert.equal(first.enabled, true);
  assert.equal(relay.isThreadsAutoReplyEnabled(), true);

  const second = await maybeAutoEnableThreadsAutoReply(customer, relay, ledger);
  assert.equal(second.enabled, false);
  assert.equal(second.reason, "already_enabled");

  await relay.close();
  await cleanupTempDir(dir);
});