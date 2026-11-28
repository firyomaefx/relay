// Traceability: REQ-016
/**
 * Inbound Brevo webhook → promo follow-up is recorded in emailAutomation (mock mode).
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { cleanupTempDir, httpJson, isoIn, makeTempDir, requestSummary, startWebServer } from "../helpers.mjs";

const PORT = 45771;

let dataDir;
let server;

before(async () => {
  dataDir = await makeTempDir("relay-email-inbound-");
  server = await startWebServer({ dataDir, port: PORT, label: "email-inbound-e2e" });
});

after(async () => {
  await server?.stop();
  await cleanupTempDir(dataDir);
});

test("POST promo to library then inbound webhook records promo_sent", async () => {
  const brevo = await httpJson(server.baseUrl, "/api/connect/brevo", { method: "POST", body: {} });
  assert.equal(brevo.ok, true, requestSummary(brevo));
  const creds = await httpJson(server.baseUrl, "/api/credentials/brevo", {
    method: "PUT",
    body: { clientSecret: "xkeysib_e2e_mock_key_1234567890123456" },
  });
  assert.equal(creds.ok, true, requestSummary(creds));

  const saved = await httpJson(server.baseUrl, "/api/email/library", {
    method: "POST",
    body: {
      kind: "promo",
      subject: "Winter deal",
      htmlContent: "<p>Thanks for writing back — here is the offer.</p>",
      brevoMode: "transactional",
    },
  });
  assert.equal(saved.ok, true, requestSummary(saved));
  assert.equal(saved.json.entry?.kind, "promo");

  const program = await httpJson(server.baseUrl, "/api/email/program");
  assert.equal(program.ok, true, requestSummary(program));
  const secret = program.json.program?.webhookSecret;
  assert.ok(secret, "webhook secret should be allocated");
  assert.equal(program.json.program?.activePromoId, saved.json.entry.id);

  const inbound = await httpJson(server.baseUrl, `/api/hooks/brevo-inbound/${encodeURIComponent(secret)}`, {
    method: "POST",
    body: {
      from: { email: "buyer@example.com", name: "Buyer" },
      subject: "Re: hello",
      text: "Interested in pricing",
    },
  });
  assert.equal(inbound.ok, true, requestSummary(inbound));
  assert.equal(inbound.json.received, true);

  const log = await httpJson(server.baseUrl, "/api/email/automation/log?limit=20");
  assert.equal(log.ok, true, requestSummary(log));
  const promoSent = (log.json.actions ?? []).find((row) => row.kind === "promo_sent");
  assert.ok(promoSent, `expected promo_sent action, got ${JSON.stringify(log.json.actions)}`);
  assert.equal(promoSent.fromEmail, "buyer@example.com");
});

test("POST schedule from library creates a Brevo queue job", async () => {
  const saved = await httpJson(server.baseUrl, "/api/email/library", {
    method: "POST",
    body: {
      kind: "broadcast",
      subject: "Newsletter",
      htmlContent: "<p>Hello subscribers</p>",
      brevoMode: "transactional",
      recipients: { to: [{ email: "subscriber@example.com", name: "Sub" }] },
    },
  });
  const scheduleAt = isoIn(60 * 60 * 1000);
  const scheduled = await httpJson(server.baseUrl, `/api/email/library/${encodeURIComponent(saved.json.entry.id)}/schedule`, {
    method: "POST",
    body: { scheduleAt },
  });
  assert.equal(scheduled.ok, true, requestSummary(scheduled));
  const jobId = scheduled.json.jobId ?? scheduled.json.queueJobId;
  assert.ok(jobId, `expected job id in ${JSON.stringify(scheduled.json)}`);
  const queue = await httpJson(server.baseUrl, "/api/email/scheduled");
  assert.equal(queue.ok, true);
  assert.ok(
    (queue.json.queue ?? []).some((job) => job.id === jobId),
    "scheduled job should appear in email scheduled list",
  );
});