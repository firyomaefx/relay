import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { amountToCents, verifyStripeSignature } from "../../apps/web/dist/billing.js";

test("Stripe amounts convert from milliUSD to cents", () => {
  assert.equal(amountToCents(10_000), 1000);
  assert.equal(amountToCents(3_000), 300);
  assert.throws(() => amountToCents(15), /multiple of 10/);
  assert.throws(() => amountToCents(0), /positive/);
});

test("Stripe webhook signatures are verified and tampering is rejected", () => {
  const secret = "whsec_test";
  const payload = JSON.stringify({ id: "evt_test", type: "checkout.session.completed" });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", secret).update(`${timestamp}.${payload}`, "utf8").digest("hex");
  const header = `t=${timestamp},v1=${signature}`;
  assert.equal(verifyStripeSignature(payload, header, secret), true);
  assert.equal(verifyStripeSignature(`${payload} `, header, secret), false);
  assert.equal(verifyStripeSignature(payload, `t=${timestamp - 1000},v1=${signature}`, secret), false);
});
