import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { CloudLedger, CloudStore } from "../../packages/cloud/dist/index.js";
import { cleanupTempDir, makeTempDir } from "../helpers.mjs";

test("billing alert timestamps persist per customer", async () => {
  const dir = await makeTempDir("relay-billing-notify-");
  const dbPath = path.join(dir, "cloud.sqlite");
  CloudStore.open(dbPath).close();
  const ledger = new CloudLedger(dbPath);
  try {
    assert.equal(ledger.lastBillingAlertAt("c1", "low_balance"), null);
    const at = new Date().toISOString();
    ledger.recordBillingAlert("c1", "low_balance", at);
    assert.equal(ledger.lastBillingAlertAt("c1", "low_balance"), at);
    const later = new Date(Date.now() + 1000).toISOString();
    ledger.recordBillingAlert("c1", "low_balance", later);
    assert.equal(ledger.lastBillingAlertAt("c1", "low_balance"), later);
  } finally {
    ledger.close();
    await cleanupTempDir(dir);
  }
});