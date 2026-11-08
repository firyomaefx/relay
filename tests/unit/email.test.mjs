// Traceability: REQ-016
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { loadEmailConfig, sendEmail, waitlistConfirmationEmail } from "../../packages/cloud/dist/email.js";

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
      RELAY_RESEND_API_KEY: "re_test",
      RELAY_EMAIL_FROM: "Relay <hello@example.com>",
      RELAY_EMAIL_REPLY_TO: "support@example.com",
      RELAY_RESEND_API_BASE: `http://127.0.0.1:${port}`,
    });
    assert.ok(config);
    const message = waitlistConfirmationEmail({ name: "Aina", position: 4 });
    const result = await sendEmail(config, { ...message, to: "aina@example.com" });
    assert.deepEqual(result, { sent: true, id: "em_test_1" });
    assert.equal(captured.method, "POST");
    assert.equal(captured.auth, "Bearer re_test");
    assert.equal(captured.contentType, "application/json");
    assert.deepEqual(captured.body.to, ["aina@example.com"]);
    assert.equal(captured.body.reply_to, "support@example.com");
    assert.match(captured.body.subject, /waitlist/);
    assert.match(captured.body.text, /#4/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

