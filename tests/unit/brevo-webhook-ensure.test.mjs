import assert from "node:assert/strict";
import test from "node:test";
import {
  brevoWebhookEnsureEnabled,
  loadBrevoWebhookEnsureCooldownMs,
  maybeEnsureBrevoInboundWebhook,
  CloudLedger,
  CloudStore,
} from "../../packages/cloud/dist/index.js";
import { cleanupTempDir, makeTempDir } from "../helpers.mjs";
import path from "node:path";

test("brevo webhook ensure env defaults", () => {
  assert.equal(brevoWebhookEnsureEnabled({}), true);
  assert.equal(brevoWebhookEnsureEnabled({ RELAY_BREVO_WEBHOOK_ENSURE: "0" }), false);
  assert.equal(loadBrevoWebhookEnsureCooldownMs({}), 24 * 60 * 60 * 1000);
});

test("maybeEnsureBrevoInboundWebhook skips when webhook already registered", async () => {
  const dataDir = await makeTempDir("brevo-ensure-");
  const dbPath = path.join(dataDir, "cloud.sqlite");
  const store = CloudStore.open(dbPath);
  const ledger = new CloudLedger(dbPath);
  const customer = store.createCustomer({ displayName: "Mail", email: "mail@example.com" });
  const relay = {
    accounts: async () => [{ platform: "brevo", id: "brevo:1" }],
    getEmailProgram: async () => ({
      health: { webhookRegistered: true },
      libraryCount: 1,
      program: {},
    }),
    ensureBrevoEmailAutomation: async () => {
      throw new Error("should not call");
    },
  };
  try {
    const out = await maybeEnsureBrevoInboundWebhook(customer, relay, ledger, {});
    assert.equal(out.attempted, false);
  } finally {
    ledger.close();
    store.close();
    await cleanupTempDir(dataDir);
  }
});

test("maybeEnsureBrevoInboundWebhook respects cooldown after attempt", async () => {
  const dataDir = await makeTempDir("brevo-ensure-cd-");
  const dbPath = path.join(dataDir, "cloud.sqlite");
  const store = CloudStore.open(dbPath);
  const ledger = new CloudLedger(dbPath);
  const customer = store.createCustomer({ displayName: "Mail", email: "mail2@example.com" });
  let calls = 0;
  const relay = {
    accounts: async () => [{ platform: "brevo", id: "brevo:1" }],
    getEmailProgram: async () => ({
      health: { webhookRegistered: false },
      libraryCount: 2,
      program: {},
    }),
    ensureBrevoEmailAutomation: async () => {
      calls += 1;
      return { ok: false, detail: "simulated" };
    },
  };
  try {
    const first = await maybeEnsureBrevoInboundWebhook(customer, relay, ledger, {
      RELAY_BREVO_WEBHOOK_ENSURE_COOLDOWN_MS: "60000",
    });
    assert.equal(first.attempted, true);
    assert.equal(calls, 1);
    const second = await maybeEnsureBrevoInboundWebhook(customer, relay, ledger, {
      RELAY_BREVO_WEBHOOK_ENSURE_COOLDOWN_MS: "60000",
    });
    assert.equal(second.attempted, false);
    assert.equal(calls, 1);
  } finally {
    ledger.close();
    store.close();
    await cleanupTempDir(dataDir);
  }
});