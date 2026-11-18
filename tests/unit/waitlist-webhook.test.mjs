// Traceability: REQ-016
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  buildWaitlistCreatedPayload,
  loadWaitlistWebhookConfig,
  notifyWaitlistCreated,
  waitlistWebhookHeaders,
} from "../../apps/web/dist/waitlist-webhook.js";

test("waitlist webhook config is absent without a URL", () => {
  assert.equal(loadWaitlistWebhookConfig({}), null);
  assert.equal(loadWaitlistWebhookConfig({ RELAY_WAITLIST_WEBHOOK_KEY: "secret" }), null);
});

test("waitlist webhook auth header uses Bearer for Authorization", () => {
  const headers = waitlistWebhookHeaders({
    url: "https://example.test/hook",
    key: "tok",
    keyHeader: "Authorization",
  });
  assert.equal(headers.Authorization, "Bearer tok");
  assert.equal(headers["content-type"], "application/json");

  const custom = waitlistWebhookHeaders({
    url: "https://example.test/hook",
    key: "tok",
    keyHeader: "X-Hook-Secret",
  });
  assert.equal(custom["X-Hook-Secret"], "tok");
  assert.equal(custom.Authorization, undefined);
});

test("waitlist created payload omits personal fields", () => {
  const payload = buildWaitlistCreatedPayload({ id: "wl_1", createdAt: "2026-01-01T00:00:00.000Z" }, 7);
  assert.deepEqual(payload, {
    event: "waitlist.created",
    waitlist_id: "wl_1",
    created_at: "2026-01-01T00:00:00.000Z",
    pending_total: 7,
  });
  assert.equal(JSON.stringify(payload).includes("email"), false);
});

test("notifyWaitlistCreated POSTs JSON and retries once", async () => {
  let hits = 0;
  let captured;
  const server = createServer((req, res) => {
    hits += 1;
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      captured = { auth: req.headers.authorization, body: JSON.parse(body) };
      res.statusCode = hits === 1 ? 503 : 204;
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const url = `http://127.0.0.1:${port}/hook`;
  const logs = [];
  try {
    notifyWaitlistCreated(
      loadWaitlistWebhookConfig({
        RELAY_WAITLIST_WEBHOOK_URL: url,
        RELAY_WAITLIST_WEBHOOK_KEY: "re_test_key",
        RELAY_WAITLIST_WEBHOOK_KEY_HEADER: "Authorization",
      }),
      buildWaitlistCreatedPayload({ id: "wl_retry", createdAt: "2026-01-02T00:00:00.000Z" }, 3),
      (message) => logs.push(message),
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(hits, 2);
    assert.equal(captured.auth, "Bearer re_test_key");
    assert.deepEqual(captured.body, {
      event: "waitlist.created",
      waitlist_id: "wl_retry",
      created_at: "2026-01-02T00:00:00.000Z",
      pending_total: 3,
    });
    assert.equal(logs.length, 0);
  } finally {
    server.close();
  }
});