import assert from "node:assert/strict";
import test from "node:test";
import { isPulseStale, recordTenantSchedulerPulse, tenantSchedulerPulseStatus } from "../../packages/cloud/dist/pulse-telemetry.js";

test("pulse telemetry records per process", () => {
  recordTenantSchedulerPulse("console", { tenants: 2, errors: 0 });
  const snap = tenantSchedulerPulseStatus("console");
  assert.ok(snap);
  assert.equal(snap.tenantCount, 2);
  assert.equal(tenantSchedulerPulseStatus("cloud-mcp"), null);
});

test("isPulseStale treats missing at as stale after grace uptime", () => {
  assert.equal(isPulseStale(60_000, undefined, 30), false);
  assert.equal(isPulseStale(60_000, undefined, 200), true);
});