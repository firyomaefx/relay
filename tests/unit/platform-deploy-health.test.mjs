// Traceability: REQ-016
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { probePlatformDeployHealth } from "../../packages/cloud/dist/platform-deploy-health.js";

test("probePlatformDeployHealth passes when console and cloud MCP expose sleep mode", async () => {
  const consoleServer = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        ok: true,
        gitSha: "abc123def456",
        cloud: {
          enabled: true,
          tenantSchedulerPulseMs: 60_000,
          lastTenantPulseAt: new Date().toISOString(),
        },
      }),
    );
  });
  const cloudServer = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        ok: true,
        name: "relay-cloud-mcp",
        gitSha: "abc123def456",
        cloud: { tenantSchedulerPulseMs: 60_000, lastTenantPulseAt: new Date().toISOString() },
      }),
    );
  });
  await Promise.all([
    new Promise((resolve) => consoleServer.listen(0, "127.0.0.1", resolve)),
    new Promise((resolve) => cloudServer.listen(0, "127.0.0.1", resolve)),
  ]);
  const consolePort = consoleServer.address().port;
  const cloudPort = cloudServer.address().port;
  try {
    const out = await probePlatformDeployHealth({
      RELAY_CONSOLE_HEALTH_URL: `http://127.0.0.1:${consolePort}/api/health`,
      RELAY_CLOUD_MCP_HEALTH_URL: `http://127.0.0.1:${cloudPort}/health`,
    });
    assert.equal(out.ok, true, out.issues.join("; "));
    assert.equal(out.console.gitSha, "abc123def456");
    assert.equal(out.cloudMcp.name, "relay-cloud-mcp");
  } finally {
    consoleServer.close();
    cloudServer.close();
  }
});

test("probePlatformDeployHealth flags missing console pulse when cloud block has no enabled", async () => {
  const consoleServer = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ cloud: { tenantSchedulerPulseMs: 0 } }));
  });
  const cloudServer = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        name: "relay-cloud-mcp",
        cloud: { tenantSchedulerPulseMs: 60_000, lastTenantPulseAt: new Date().toISOString() },
      }),
    );
  });
  await Promise.all([
    new Promise((resolve) => consoleServer.listen(0, "127.0.0.1", resolve)),
    new Promise((resolve) => cloudServer.listen(0, "127.0.0.1", resolve)),
  ]);
  const consolePort = consoleServer.address().port;
  const cloudPort = cloudServer.address().port;
  try {
    const out = await probePlatformDeployHealth({
      RELAY_CONSOLE_HEALTH_URL: `http://127.0.0.1:${consolePort}/api/health`,
      RELAY_CLOUD_MCP_HEALTH_URL: `http://127.0.0.1:${cloudPort}/health`,
    });
    assert.equal(out.ok, false);
    assert.ok(out.issues.some((line) => line.includes("TENANT_SCHEDULER")));
  } finally {
    consoleServer.close();
    cloudServer.close();
  }
});

test("probePlatformDeployHealth flags owner MCP on cloud port", async () => {
  const consoleServer = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ cloud: { enabled: true, tenantSchedulerPulseMs: 60_000 } }));
  });
  const cloudServer = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ name: "relay-mcp-http" }));
  });
  await Promise.all([
    new Promise((resolve) => consoleServer.listen(0, "127.0.0.1", resolve)),
    new Promise((resolve) => cloudServer.listen(0, "127.0.0.1", resolve)),
  ]);
  const consolePort = consoleServer.address().port;
  const cloudPort = cloudServer.address().port;
  try {
    const out = await probePlatformDeployHealth({
      RELAY_CONSOLE_HEALTH_URL: `http://127.0.0.1:${consolePort}/api/health`,
      RELAY_CLOUD_MCP_HEALTH_URL: `http://127.0.0.1:${cloudPort}/health`,
    });
    assert.equal(out.ok, false);
    assert.ok(out.issues.some((line) => line.includes("relay-mcp")));
  } finally {
    consoleServer.close();
    cloudServer.close();
  }
});