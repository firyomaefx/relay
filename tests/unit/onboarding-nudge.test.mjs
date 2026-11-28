import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { CloudLedger, CloudStore, runOnboardingTopupNudges, AUTOREPLY_MIN_TOPUP_MILLI_USD } from "../../packages/cloud/dist/index.js";
import { cleanupTempDir, makeTempDir } from "../helpers.mjs";

test("runOnboardingTopupNudges skips customers with paid top-up", async () => {
  const dir = await makeTempDir("relay-nudge-");
  const dbPath = path.join(dir, "cloud.sqlite");
  const store = CloudStore.open(dbPath);
  const customer = store.createCustomer({ displayName: "Paid User", email: "paid@example.com" });
  store.close();
  const ledger = new CloudLedger(dbPath);
  ledger.recordTopup({
    customerId: customer.id,
    amount: AUTOREPLY_MIN_TOPUP_MILLI_USD,
    reference: "NUDGE-PAID",
  });
  const store2 = CloudStore.open(dbPath);
  const result = await runOnboardingTopupNudges(store2, ledger, null, {
    enabled: true,
    minAccountAgeMs: 0,
    cooldownMs: 1,
  });
  assert.equal(result.sent, 0);
  store2.close();
  ledger.close();
  await cleanupTempDir(dir);
});