import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { centsToMilliUSD, loadPolarConfig, verifyPolarWebhook } from "../../apps/web/dist/polar.js";

test("Polar amounts convert from cents to milliUSD", () => {
  assert.equal(centsToMilliUSD(1000), 10_000);
  assert.equal(centsToMilliUSD(500), 5_000);
  assert.throws(() => centsToMilliUSD(0), /Invalid/);
});

test("Polar Standard Webhooks signatures are verified and tampering is rejected", () => {
  const secret = Buffer.from("relay-polar-test-secret").toString("base64");
  const key = `whsec_${secret}`;
  const id = "msg_test";
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify({ type: "order.paid", data: { id: "order_test" } });
  const signature = createHmac("sha256", Buffer.from(secret, "base64"))
    .update(`${id}.${timestamp}.${body}`, "utf8")
    .digest("base64");
  const headers = {
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${signature}`,
  };
  assert.equal(verifyPolarWebhook(Buffer.from(body), headers, key), true);
  assert.equal(verifyPolarWebhook(Buffer.from(`${body} `), headers, key), false);
  assert.equal(verifyPolarWebhook(Buffer.from(body), { ...headers, "webhook-signature": "v1,bad" }, key), false);
});

test("Polar checkout requires a complete access token, product and webhook secret", () => {
  const base = {
    RELAY_POLAR_ACCESS_TOKEN: "polar_oat_test",
    RELAY_POLAR_PRODUCT_ID: "00000000-0000-4000-8000-000000000000",
  };
  assert.equal(loadPolarConfig(base), null);
  assert.ok(loadPolarConfig({ ...base, RELAY_POLAR_WEBHOOK_SECRET: "whsec_test" }));
});
