// Traceability: REQ-016
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { CloudFinance } from "../../apps/mcp/dist/cloud-finance.js";
import { CloudLedger, CloudStore, PriceTable } from "../../packages/cloud/dist/index.js";
import { cleanupTempDir, makeTempDir } from "../helpers.mjs";

test("CloudFinance quotes and settles every thread part on every platform", async () => {
  const dir = await makeTempDir("relay-cloud-finance-parts-");
  const dbPath = path.join(dir, "cloud.sqlite");
  const pricePath = path.join(dir, "prices.json");
  writeFileSync(pricePath, JSON.stringify({
    currency: "USD",
    unit: "milliUSD",
    free_allowance_milli_usd: 500,
    free_excluded_platforms: ["x"],
    prices: { x: { text: 3 }, threads: { text: 3 } },
  }));
  const store = CloudStore.open(dbPath);
  const customer = store.createCustomer({ displayName: "Thread Customer" });
  const ledger = new CloudLedger(dbPath);
  const finance = new CloudFinance({
    store,
    ledger,
    prices: PriceTable.load(pricePath),
    tenants: { get: async () => { throw new Error("not used"); }, recordMappings: async () => {} },
  });
  try {
    const draft = {
      platforms: ["x", "threads"],
      thread: [{ text: "one" }, { text: "two" }, { text: "three" }],
    };
    const quote = finance.quote(customer, draft);
    assert.equal(quote.total, 18);
    assert.equal(quote.lines.length, 2);
    assert.equal(quote.lines[0].parts, 3);
    assert.equal(quote.lines[0].amount, 9);
    // X is excluded from free credit; Threads uses 9 milliUSD of the 500 free.
    assert.equal(quote.lines[0].freeAmount, 0);
    assert.equal(quote.lines[1].freeAmount, 9);
    assert.equal(quote.lines[1].paidAmount, 0);
    assert.equal(quote.freeCreditApplied, 9);
    assert.equal(quote.paidTotal, 9); // X is paid

    ledger.recordTopup({ customerId: customer.id, amount: 9, currency: "USD", provider: "manual", reference: "test-topup" });
    const hold = await finance.hooks(customer).beforePost(draft);
    assert.ok(hold);
    await finance.hooks(customer).afterPost(hold, {
      scheduled: false,
      results: [
        { platform: "x", ok: true, mode: "mock", postId: "x_1" },
        { platform: "threads", ok: true, mode: "mock", postId: "th_1" },
      ],
      report: { ok: true, issues: [], perPlatform: {} },
    });
    assert.equal(ledger.balance(customer.id), 0);
    assert.equal(ledger.freeRemaining(customer.id, 500), 491);

    // A failed platform must not be charged; a successful Threads thread still consumes free credit.
    ledger.recordTopup({ customerId: customer.id, amount: 9, currency: "USD", provider: "manual", reference: "test-topup-2" });
    const failedHold = await finance.hooks(customer).beforePost(draft);
    await finance.hooks(customer).afterPost(failedHold, {
      scheduled: false,
      results: [
        { platform: "x", ok: false, mode: "mock", error: "x failed" },
        { platform: "threads", ok: true, mode: "mock", postId: "th_2" },
      ],
      report: { ok: false, issues: [], perPlatform: {} },
    });
    assert.equal(ledger.balance(customer.id), 9);
    assert.equal(ledger.freeRemaining(customer.id, 500), 482);
  } finally {
    ledger.close();
    store.close();
    await cleanupTempDir(dir);
  }
});

test("CloudFinance gives owner accounts their full operator free credit", async () => {
  const dir = await makeTempDir("relay-cloud-finance-owner-");
  const dbPath = path.join(dir, "cloud.sqlite");
  const pricePath = path.join(dir, "prices.json");
  writeFileSync(pricePath, JSON.stringify({
    currency: "USD",
    unit: "milliUSD",
    free_allowance_milli_usd: 500,
    free_excluded_platforms: ["x"],
    prices: { threads: { text: 20 }, linkedin: { text: 20 } },
  }));
  const store = CloudStore.open(dbPath);
  const owner = store.createCustomer({ displayName: "Owner", owner: true });
  const ledger = new CloudLedger(dbPath);
  const finance = new CloudFinance({
    store,
    ledger,
    prices: PriceTable.load(pricePath),
    tenants: { get: async () => { throw new Error("not used"); }, recordMappings: async () => {} },
  });
  try {
    // Consume more than the customer starter allowance, as the production owner has.
    const seed = ledger.reserve({ customerId: owner.id, amount: 0, freeUnits: 600, freeLimit: 10_000, idempotencyKey: "owner-free-seed" });
    ledger.commit(seed.id, 0, undefined, 600);

    const draft = { platforms: ["threads", "linkedin"], text: "Launch post" };
    const quote = finance.quote(owner, draft);
    assert.equal(quote.total, 40);
    assert.equal(quote.freeCreditApplied, 40);
    assert.equal(quote.paidTotal, 0);

    const balance = finance.balance(owner.id);
    assert.equal(balance.available, 0);
    assert.equal(balance.freeCredit.remaining, 9_900);
    assert.equal(balance.totalAvailable, 9_900);

    const hold = await finance.hooks(owner).beforePost(draft);
    assert.ok(hold);
  } finally {
    ledger.close();
    store.close();
    await cleanupTempDir(dir);
  }
});

