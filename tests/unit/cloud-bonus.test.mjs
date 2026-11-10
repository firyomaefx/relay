// Owner bonus credit: ledger type, idempotency, amount checks, list and count.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { CloudLedger, CloudStore } from "../../packages/cloud/dist/index.js";
import { accountTierFor } from "../../apps/mcp/dist/cloud-accounts.js";
import { BONUS_MAX_USD, grantBonusCredit, listBonusGrants } from "../../apps/mcp/dist/cloud-bonus.js";
import { cleanupTempDir, makeTempDir } from "../helpers.mjs";

async function setup() {
  const dir = await makeTempDir("relay-cloud-bonus-");
  const dbPath = path.join(dir, "cloud.sqlite");
  const store = CloudStore.open(dbPath);
  const ledger = new CloudLedger(dbPath);
  const alice = store.createCustomer({ displayName: "Alice" });
  const ben = store.createCustomer({ displayName: "Ben" });
  const close = async () => {
    ledger.close();
    store.close();
    await cleanupTempDir(dir);
  };
  return { store, ledger, alice, ben, deps: { store, ledger }, close };
}

test("grant writes a bonus ledger entry, returns entry id and new balance", async () => {
  const { deps, ledger, alice, close } = await setup();
  try {
    const result = grantBonusCredit(deps, { customer_id: alice.id, amount_usd: 5, reason: "founding deal: 9.90 top-up" });
    assert.equal(result.ok, true);
    assert.equal(result.replayed, false);
    assert.match(result.entry_id, /^led_/);
    assert.equal(result.entry.type, "bonus");
    assert.equal(result.entry.amount_usd, 5);
    assert.equal(result.balance_usd, 5);
    assert.equal(result.available_usd, 5);
    const rows = ledger.entries(alice.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, "bonus");
    assert.equal(rows[0].amount, 5000);
    assert.equal(rows[0].reason, "founding deal: 9.90 top-up");
    assert.equal(ledger.balance(alice.id), 5000);
  } finally {
    await close();
  }
});

test("bonus credit never counts as a top-up, unlock or tier", async () => {
  const { deps, ledger, alice, close } = await setup();
  try {
    grantBonusCredit(deps, { customer_id: alice.id, amount_usd: 100, reason: "test grant" });
    assert.equal(ledger.largestTopup(alice.id), 0);
    assert.equal(ledger.totalTopups(alice.id), 0);
    assert.equal(accountTierFor(ledger.largestTopup(alice.id)).id, "locked");
    // A real top-up still behaves exactly as before.
    ledger.recordTopup({ customerId: alice.id, amount: 9900, reference: "BANK-BONUS-1", note: "paid" });
    assert.equal(ledger.largestTopup(alice.id), 9900);
    assert.equal(ledger.totalTopups(alice.id), 9900);
    assert.equal(accountTierFor(ledger.largestTopup(alice.id)).id, "starter");
    // The bonus is spendable balance.
    assert.equal(ledger.balance(alice.id), 109_900);
  } finally {
    await close();
  }
});

test("idempotency key returns the first entry and adds no second credit", async () => {
  const { deps, ledger, alice, ben, close } = await setup();
  try {
    const first = grantBonusCredit(deps, { customer_id: alice.id, amount_usd: 25, reason: "founding deal", idempotency_key: "found-1" });
    const again = grantBonusCredit(deps, { customer_id: alice.id, amount_usd: 25, reason: "founding deal", idempotency_key: "found-1" });
    assert.equal(again.replayed, true);
    assert.equal(again.entry_id, first.entry_id);
    assert.equal(ledger.balance(alice.id), 25_000);
    assert.equal(ledger.entries(alice.id).length, 1);
    assert.throws(
      () => grantBonusCredit(deps, { customer_id: alice.id, amount_usd: 5, reason: "founding deal", idempotency_key: "found-1" }),
      /different grant/,
    );
    assert.throws(
      () => grantBonusCredit(deps, { customer_id: ben.id, amount_usd: 25, reason: "founding deal", idempotency_key: "found-1" }),
      /different grant/,
    );
    assert.equal(ledger.balance(ben.id), 0);
    // Without a key every call is a new grant.
    grantBonusCredit(deps, { customer_id: alice.id, amount_usd: 1, reason: "a" });
    grantBonusCredit(deps, { customer_id: alice.id, amount_usd: 1, reason: "a" });
    assert.equal(ledger.balance(alice.id), 27_000);
  } finally {
    await close();
  }
});

test("bad amounts, missing reason and unknown customers are refused", async () => {
  const { deps, ledger, alice, close } = await setup();
  try {
    const bad = [0, -5, Number.NaN, Number.POSITIVE_INFINITY, BONUS_MAX_USD + 0.01, 1000, 1.2345];
    for (const amount_usd of bad) {
      assert.throws(() => grantBonusCredit(deps, { customer_id: alice.id, amount_usd, reason: "x" }), undefined, `amount ${amount_usd}`);
    }
    assert.throws(() => grantBonusCredit(deps, { customer_id: alice.id, amount_usd: 5, reason: "   " }), /reason is required/);
    assert.throws(() => grantBonusCredit(deps, { customer_id: "cus_missing", amount_usd: 5, reason: "x" }), /Unknown customer/);
    assert.equal(ledger.balance(alice.id), 0);
    assert.equal(ledger.entries(alice.id).length, 0);
    // The cap itself is allowed.
    grantBonusCredit(deps, { customer_id: alice.id, amount_usd: BONUS_MAX_USD, reason: "cap" });
    assert.equal(ledger.balance(alice.id), BONUS_MAX_USD * 1000);
  } finally {
    await close();
  }
});

test("list returns grants with count, total and filters", async () => {
  const { deps, alice, ben, close } = await setup();
  try {
    grantBonusCredit(deps, { customer_id: alice.id, amount_usd: 5, reason: "Founding deal: 9.90" });
    grantBonusCredit(deps, { customer_id: ben.id, amount_usd: 25, reason: "founding DEAL: 49.90" });
    grantBonusCredit(deps, { customer_id: ben.id, amount_usd: 2, reason: "apology for a late post" });
    deps.ledger.credit({ customerId: ben.id, amount: 9900, type: "topup", idempotencyKey: "t-1" }); // not a grant

    const all = listBonusGrants(deps, {});
    assert.equal(all.count, 3);
    assert.equal(all.total_usd, 32);
    assert.equal(all.grants.length, 3);
    assert.deepEqual(Object.keys(all.grants[0]).sort(), ["amount_usd", "created_at", "customer", "customer_id", "entry_id", "reason"]);
    assert.equal(all.grants.find((g) => g.customer_id === ben.id && g.amount_usd === 25).customer, "Ben");

    const founding = listBonusGrants(deps, { reason_contains: "founding deal" });
    assert.equal(founding.count, 2);
    assert.equal(founding.total_usd, 30);
    assert.equal(listBonusGrants(deps, { reason_contains: "100%_" }).count, 0);

    assert.equal(listBonusGrants(deps, { customer_id: ben.id }).count, 2);
    assert.equal(listBonusGrants(deps, { from: "2999-01-01" }).count, 0);
    assert.equal(listBonusGrants(deps, { to: "2000-01-01" }).count, 0);
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(listBonusGrants(deps, { from: today, to: today }).count, 3);
    assert.throws(() => listBonusGrants(deps, { from: "not a date" }), /not a valid date/);

    const limited = listBonusGrants(deps, { limit: 1 });
    assert.equal(limited.shown, 1);
    assert.equal(limited.count, 3);
  } finally {
    await close();
  }
});
