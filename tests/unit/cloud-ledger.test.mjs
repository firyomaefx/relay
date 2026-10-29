import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { CloudLedger, CloudStore } from "../../packages/cloud/dist/index.js";
import { cleanupTempDir, makeTempDir } from "../helpers.mjs";

test("ledger keeps whole-unit balances and reserves atomically", async () => {
  const dir = await makeTempDir("relay-cloud-ledger-");
  const dbPath = path.join(dir, "cloud.sqlite");
  CloudStore.open(dbPath).close();
  const ledger = new CloudLedger(dbPath);
  try {
    ledger.credit({ customerId: "c1", amount: 100, type: "topup", idempotencyKey: "topup-1" });
    assert.equal(ledger.balance("c1"), 100);
    const hold = ledger.reserve({ customerId: "c1", amount: 60, idempotencyKey: "res-1" });
    assert.deepEqual(ledger.balanceWithHold("c1"), { balance: 100, held: 60, available: 40 });
    ledger.commit(hold.id, 50, "post-1");
    assert.equal(ledger.balance("c1"), 50);
    assert.equal(ledger.balanceWithHold("c1").held, 0);

    const hold2 = ledger.reserve({ customerId: "c1", amount: 30, idempotencyKey: "res-2" });
    ledger.release(hold2.id);
    assert.equal(ledger.balance("c1"), 50);
    assert.equal(ledger.balanceWithHold("c1").available, 50);
  } finally {
    ledger.close();
    await cleanupTempDir(dir);
  }
});

test("manual payment is atomic and reference idempotency prevents double credit", async () => {
  const dir = await makeTempDir("relay-cloud-payment-");
  const dbPath = path.join(dir, "cloud.sqlite");
  CloudStore.open(dbPath).close();
  const ledger = new CloudLedger(dbPath);
  try {
    const first = ledger.recordTopup({ customerId: "c1", amount: 250, reference: "BANK-1", note: "invoice" });
    assert.equal(first.paymentReplayed, false);
    assert.equal(ledger.balance("c1"), 250);
    const duplicate = ledger.recordTopup({ customerId: "c1", amount: 250, reference: "BANK-1" });
    assert.equal(duplicate.paymentReplayed, true);
    assert.equal(ledger.balance("c1"), 250);
    assert.equal(ledger.listPayments("c1").length, 1);
  } finally { ledger.close(); await cleanupTempDir(dir); }
});

test("insufficient balance, idempotency and the last-balance race are safe", async () => {
  const dir = await makeTempDir("relay-cloud-ledger-race-");
  const dbPath = path.join(dir, "cloud.sqlite");
  CloudStore.open(dbPath).close();
  const ledger = new CloudLedger(dbPath);
  try {
    ledger.credit({ customerId: "c1", amount: 100, type: "topup", idempotencyKey: "topup-1" });
    assert.throws(
      () => ledger.reserve({ customerId: "c1", amount: 101, idempotencyKey: "too-much" }),
      (error) => error.code === "cloud_insufficient_balance",
    );
    // Same idempotency key returns the same reservation; no double hold.
    const first = ledger.reserve({ customerId: "c1", amount: 100, idempotencyKey: "same" });
    const duplicate = ledger.reserve({ customerId: "c1", amount: 100, idempotencyKey: "same" });
    assert.equal(first.id, duplicate.id);

    // A second hold cannot consume the same last balance.
    assert.throws(
      () => ledger.reserve({ customerId: "c1", amount: 1, idempotencyKey: "race" }),
      (error) => error.code === "cloud_insufficient_balance",
    );
    ledger.release(first.id);
    assert.equal(ledger.balance("c1"), 100);
  } finally {
    ledger.close();
    await cleanupTempDir(dir);
  }
});


