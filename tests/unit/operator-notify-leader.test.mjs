import assert from "node:assert/strict";
import test from "node:test";
import { operatorNotifyHostAllowed } from "../../packages/cloud/dist/operator-notify.js";

test("operatorNotifyHostAllowed defaults to both hosts", () => {
  assert.equal(operatorNotifyHostAllowed({}, "console"), true);
  assert.equal(operatorNotifyHostAllowed({}, "cloud-mcp"), true);
  assert.equal(operatorNotifyHostAllowed({ RELAY_OPERATOR_NOTIFY_LEADER: "both" }, "console"), true);
});

test("operatorNotifyHostAllowed honors single leader", () => {
  const env = { RELAY_OPERATOR_NOTIFY_LEADER: "cloud-mcp" };
  assert.equal(operatorNotifyHostAllowed(env, "cloud-mcp"), true);
  assert.equal(operatorNotifyHostAllowed(env, "console"), false);
});