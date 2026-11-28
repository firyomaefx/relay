import assert from "node:assert/strict";
import test from "node:test";
import { operatorRevenueDigestEmail } from "../../packages/cloud/dist/email.js";
import { loadOperatorRevenueDigestConfig } from "../../packages/cloud/dist/operator-notify.js";

test("operator revenue digest email includes RM goal", () => {
  const message = operatorRevenueDigestEmail({
    adminUrl: "https://relay.test/cloud-admin",
    goalMyr: 4000,
    goalDeadline: "2026-12-31",
    totalUsd: 120,
    estimatedMyr: 564,
    progressPercent: 14.1,
    paymentCount: 8,
    since: "2026-01-01T00:00:00.000Z",
    automationIssueCount: 0,
    sampleIssues: [],
  });
  assert.match(message.subject, /weekly/i);
  assert.match(message.text, /564/);
  assert.match(message.text, /4,000/);
});

test("revenue digest config defaults on when operator email is set", () => {
  const cfg = loadOperatorRevenueDigestConfig({
    RELAY_OPERATOR_ALERT_EMAIL: "ops@example.com",
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.email, "ops@example.com");
});