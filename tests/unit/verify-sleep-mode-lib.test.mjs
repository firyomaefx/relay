import assert from "node:assert/strict";
import test from "node:test";
import {
  consoleSleepModeMissing,
  evaluateCloudMcpHealth,
  evaluateConsoleSleepMode,
  formatSleepDriftOperatorAlert,
} from "../../tools/verify-sleep-mode-lib.mjs";

test("evaluateCloudMcpHealth accepts relay-cloud-mcp", () => {
  const out = evaluateCloudMcpHealth(
    {
      name: "relay-cloud-mcp",
      cloud: { tenantSchedulerPulseMs: 60000, lastTenantPulseAt: "2026-01-01T00:00:00.000Z" },
    },
    "https://cloud-mcp.test",
  );
  assert.equal(out.ok, true);
  assert.equal(out.pulseMs, 60000);
});

test("evaluateConsoleSleepMode accepts enabled cloud with pulse", () => {
  const out = evaluateConsoleSleepMode({ cloud: { enabled: true, tenantSchedulerPulseMs: 60_000 } });
  assert.equal(out.ok, true);
  assert.equal(out.pulseMs, 60_000);
});

test("formatSleepDriftOperatorAlert embeds verify output", () => {
  const msg = formatSleepDriftOperatorAlert("FAIL cloud MCP entrypoint — wrong port");
  assert.match(msg.subject, /FAILED/);
  assert.match(msg.text, /FAIL cloud MCP/);
  assert.match(msg.html, /wrong port/);
  assert.doesNotMatch(msg.html, /<script/);
});

test("evaluateConsoleSleepMode hints RELAY_CLOUD_ENABLED when disabled", () => {
  const out = evaluateConsoleSleepMode({ cloud: { enabled: false } });
  assert.equal(out.ok, false);
  assert.match(out.detail, /RELAY_CLOUD_ENABLED/);
});

test("consoleSleepModeMissing detects absent cloud block", () => {
  assert.equal(consoleSleepModeMissing({ ok: true }), true);
  assert.equal(consoleSleepModeMissing({ cloud: { enabled: false } }), true);
  assert.equal(consoleSleepModeMissing({ cloud: { enabled: true } }), false);
});

test("evaluateCloudMcpHealth rejects owner MCP on cloud URL", () => {
  const out = evaluateCloudMcpHealth({ name: "relay-mcp-http", transport: "streamable-http" }, "https://cloud-mcp.test");
  assert.equal(out.ok, false);
  assert.match(out.detail, /relay-mcp/);
  assert.match(out.detail, /4321/);
});