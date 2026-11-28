#!/usr/bin/env node
/**
 * VM-local sleep mode checks (127.0.0.1) before public verify-sleep-mode.
 * Separates tunnel/DNS mistakes from missing RELAY_CLOUD_ENABLED or relay-cloud-mcp.
 */
import {
  evaluateCloudMcpHealth,
  evaluateConsoleSleepMode,
} from "./verify-sleep-mode-lib.mjs";

const CONSOLE = (process.env.RELAY_CONSOLE_HEALTH_URL ?? "http://127.0.0.1:4317/api/health").replace(/\/+$/, "");
const CLOUD_MCP = (process.env.RELAY_CLOUD_MCP_HEALTH_URL ?? "http://127.0.0.1:4321/health").replace(/\/+$/, "");

let failed = 0;

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${url} returned non-JSON (${response.status})`);
  }
  return { ok: response.ok, status: response.status, json };
}

function pass(label) {
  console.log(`PASS ${label}`);
}

function fail(label, detail) {
  console.log(`FAIL ${label} — ${detail}`);
  failed += 1;
}

try {
  const health = await getJson(CONSOLE);
  if (!health.ok) fail("console health (local)", `HTTP ${health.status} — is relay-console running?`);
  else pass(`console health (local) ${health.status}`);

  const consoleEval = evaluateConsoleSleepMode(health.json);
  if (consoleEval.ok) pass(`console sleep mode pulseMs=${consoleEval.pulseMs}`);
  else fail("console sleep mode (local)", consoleEval.detail);

  const cloudHealth = await getJson(CLOUD_MCP);
  if (!cloudHealth.ok) {
    fail(
      "cloud MCP health (local)",
      `HTTP ${cloudHealth.status} — enable relay-cloud-mcp.service (port 4321)`,
    );
  } else pass(`cloud MCP health (local) ${cloudHealth.status}`);

  const mcpEval = evaluateCloudMcpHealth(cloudHealth.json, CLOUD_MCP);
  if (mcpEval.ok) {
    pass(`cloud MCP entrypoint (local) ${mcpEval.mcpName}`);
    if (mcpEval.pulseMs > 0) pass(`cloud MCP tenantSchedulerPulseMs=${mcpEval.pulseMs}`);
    else fail("cloud MCP sleep mode (local)", "missing cloud.tenantSchedulerPulseMs on /health");
  } else {
    fail("cloud MCP entrypoint (local)", mcpEval.detail);
  }
} catch (error) {
  fail("fetch (local)", error instanceof Error ? error.message : String(error));
}

console.log(failed === 0 ? "SLEEP-MODE LOCAL VERIFY PASS" : `SLEEP-MODE LOCAL VERIFY FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);