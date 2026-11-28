import test from "node:test";
import assert from "node:assert/strict";
import { JsonStore, emptyEmailProgramState } from "@relay/core";
import { applyActivePromoToQueue, libraryEntryToDraft, upsertEmailLibraryEntry } from "@relay/core";
import { EmailAutomationEngine, emailAutomationEnvEnabled } from "@relay/core";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

test("emailAutomationEnvEnabled defaults on", () => {
  assert.equal(emailAutomationEnvEnabled({}), true);
  assert.equal(emailAutomationEnvEnabled({ RELAY_EMAIL_AUTOMATION_ENABLED: "false" }), false);
});

test("registerBrevoInboundWebhook is idempotent when webhook ids exist", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "relay-brevo-reg-"));
  const store = await JsonStore.open(path.join(dir, "db.json"));
  await store.mutate((db) => {
    db.emailProgram = { ...emptyEmailProgramState(), brevoWebhookIds: [42] };
  });
  const engine = new EmailAutomationEngine({
    store,
    now: () => new Date().toISOString(),
    logger: () => undefined,
    env: {},
    brevoApiKey: () => "key",
    publicBaseUrl: () => "https://relay.example",
    sendPost: async () => ({ ok: true }),
  });
  const result = await engine.registerBrevoInboundWebhook();
  assert.equal(result.ok, true);
  assert.match(result.detail, /already registered/i);
  await rm(dir, { recursive: true, force: true });
});

test("promo save updates queued brevo jobs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "relay-email-"));
  const file = path.join(dir, "db.json");
  const store = await JsonStore.open(file);
  const now = new Date().toISOString();
  await store.mutate((db) => {
    db.emailProgram = emptyEmailProgramState();
  });
  const promo = await upsertEmailLibraryEntry(
    store,
    undefined,
    { kind: "promo", subject: "Promo v1", htmlContent: "<p>one</p>" },
    now,
  );
  await store.mutate((db) => {
    db.queue.push({
      id: "job_1",
      createdAt: now,
      scheduleAt: new Date(Date.now() + 86_400_000).toISOString(),
      status: "pending",
      attempts: 0,
      draft: libraryEntryToDraft(promo, new Date(Date.now() + 86_400_000).toISOString()),
    });
  });
  await upsertEmailLibraryEntry(
    store,
    promo.id,
    { kind: "promo", subject: "Promo v2", htmlContent: "<p>two</p>" },
    now,
  );
  const updated = store.read((db) => applyActivePromoToQueue(db));
  assert.equal(updated, 1);
  const subject = store.read((db) => db.queue[0].draft.options?.brevo?.brevoSubject);
  assert.equal(subject, "Promo v2");
  await rm(dir, { recursive: true, force: true });
});

test("inbound dedupe prevents double promo", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "relay-email-"));
  const file = path.join(dir, "db.json");
  const store = await JsonStore.open(file);
  const sends = [];
  const engine = new EmailAutomationEngine({
    store,
    now: () => new Date("2026-01-01T12:00:00.000Z"),
    logger: () => undefined,
    env: {},
    sendPost: async () => {
      sends.push(1);
      return { ok: true, providerRef: { kind: "transactional", messageId: "m1" } };
    },
    brevoApiKey: () => "test-key",
    deepSeekApiKey: () => undefined,
    publicBaseUrl: () => "https://relay.test",
  });
  await store.mutate((db) => {
    db.emailProgram = { automationEnabled: true, activePromoId: undefined };
    db.emailProgram.activePromoId = undefined;
  });
  await upsertEmailLibraryEntry(
    store,
    undefined,
    { kind: "promo", subject: "Hi", htmlContent: "<p>deal</p>" },
    new Date().toISOString(),
  );
  const payload = { from: { email: "buyer@example.com" }, subject: "Re: hello", text: "Interested" };
  await engine.handleInboundPayload(payload);
  await engine.handleInboundPayload(payload);
  assert.equal(sends.length, 1);
  await rm(dir, { recursive: true, force: true });
});