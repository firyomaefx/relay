// Traceability: REQ-016
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  customerLowBalanceEmail,
  operatorAutomationDigestEmail,
  customerPasswordResetEmail,
  customerTopupReceiptEmail,
  customerWelcomeEmail,
  loadEmailConfig,
  sendEmail,
  waitlistConfirmationEmail,
} from "../../packages/cloud/dist/email.js";

test("operator automation digest lists issues", () => {
  const message = operatorAutomationDigestEmail({
    issues: ["Aina: webhook missing"],
    adminUrl: "https://relay.example/cloud-admin",
    issueCount: 1,
  });
  assert.match(message.subject, /automation issue/i);
  assert.match(message.text, /webhook missing/);
});

test("billing emails include top-up links", () => {
  const low = customerLowBalanceEmail({ name: "Aina", availableMilliUsd: 400, topupUrl: "https://relay.example/topup" });
  assert.match(low.subject, /low/i);
  assert.match(low.text, /top-up|topup/i);
  const receipt = customerTopupReceiptEmail({ name: "Aina", amountMilliUsd: 9900, provider: "stripe", consoleUrl: "https://relay.example" });
  assert.match(receipt.text, /9\.90/);
});

test("welcome email points to email tab and DeepSeek", () => {
  const message = customerWelcomeEmail({ name: "Aina", consoleUrl: "https://relay.example" });
  assert.match(message.subject, /welcome/i);
  assert.match(message.text, /Email tab/i);
  assert.match(message.text, /DeepSeek/i);
  assert.match(message.text, /top up/i);
  assert.match(message.html, /\/login/);
  const withTopup = customerWelcomeEmail({
    name: "Aina",
    consoleUrl: "https://relay.example",
    topupUrl: "https://relay.example/topup",
  });
  assert.match(withTopup.html, /https:\/\/relay\.example\/topup/);
  assert.match(withTopup.html, /Top up balance/);
});

test("password reset email contains only a user-chosen link", () => {
  const message = customerPasswordResetEmail({ name: "Aina", resetUrl: "https://relay.example/reset-password?token=abc" });
  assert.match(message.subject, /reset/i);
  assert.match(message.text, /choose a new password/i);
  assert.doesNotMatch(message.text, /temporary password/i);
  assert.match(message.text, /https:\/\/relay\.example\/reset-password\?token=abc/);
});

test("email client skips cleanly without configuration", async () => {
  assert.equal(loadEmailConfig({}), null);
  const result = await sendEmail(null, { to: "a@example.com", subject: "x", text: "x", html: "<p>x</p>" });
  assert.deepEqual(result, { sent: false, skipped: "not_configured" });
});

test("email client posts a Resend message and reports the provider id", async () => {
  let captured;
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      captured = { method: req.method, auth: req.headers.authorization, contentType: req.headers["content-type"], body: JSON.parse(body) };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "em_test_1" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const config = loadEmailConfig({
      RELAY_EMAIL_PROVIDER: "resend",
      RELAY_RESEND_API_KEY: "re_test",
      RELAY_EMAIL_FROM: "Relay <hello@example.com>",
      RELAY_EMAIL_REPLY_TO: "support@example.com",
      RELAY_RESEND_API_BASE: `http://127.0.0.1:${port}`,
    });
    assert.ok(config);
    const message = waitlistConfirmationEmail({ name: "Aina", position: 4, batch: "founding" });
    const result = await sendEmail(config, { ...message, to: "aina@example.com" });
    assert.deepEqual(result, { sent: true, id: "em_test_1" });
    assert.equal(captured.method, "POST");
    assert.equal(captured.auth, "Bearer re_test");
    assert.equal(captured.contentType, "application/json");
    assert.deepEqual(captured.body.to, ["aina@example.com"]);
    assert.equal(captured.body.reply_to, "support@example.com");
    assert.match(captured.body.subject, /early-access/);
    assert.match(captured.body.text, /#4/);
    assert.match(captured.body.text, /manual queue is complete/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("email client posts a Brevo message and reports messageId", async () => {
  let captured;
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      captured = {
        method: req.method,
        apiKey: req.headers["api-key"],
        path: req.url,
        body: JSON.parse(body),
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ messageId: "<brevo-msg-1@relay>" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const config = loadEmailConfig({
      RELAY_EMAIL_PROVIDER: "brevo",
      RELAY_BREVO_API_KEY: "xkeysib_test",
      RELAY_EMAIL_FROM: "Relay <hello@example.com>",
      RELAY_EMAIL_REPLY_TO: "support@example.com",
      RELAY_BREVO_API_BASE: `http://127.0.0.1:${port}`,
    });
    assert.ok(config);
    assert.equal(config.provider, "brevo");
    const result = await sendEmail(config, {
      to: "aina@example.com",
      subject: "Test",
      text: "Hello",
      html: "<p>Hello</p>",
    });
    assert.deepEqual(result, { sent: true, id: "<brevo-msg-1@relay>" });
    assert.equal(captured.method, "POST");
    assert.equal(captured.apiKey, "xkeysib_test");
    assert.equal(captured.path, "/v3/smtp/email");
    assert.equal(captured.body.sender.email, "hello@example.com");
    assert.equal(captured.body.sender.name, "Relay");
    assert.deepEqual(captured.body.to, [{ email: "aina@example.com" }]);
    assert.deepEqual(captured.body.replyTo, { email: "support@example.com" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

