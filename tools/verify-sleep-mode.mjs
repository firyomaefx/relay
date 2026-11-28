#!/usr/bin/env node
/**
 * Post-deploy checks for Relay Cloud sleep mode (see docs/operations/sleep-mode-deploy.md).
 */
import {
  consoleSleepModeMissing,
  evaluateCloudMcpHealth,
  sleepModeRepairHintText,
} from "./verify-sleep-mode-lib.mjs";

const BASE = (process.env.RELAY_PUBLIC_URL ?? "https://relay.duitpoket.fun").replace(/\/+$/, "");
const CLOUD_MCP = (process.env.RELAY_CLOUD_MCP_URL ?? "https://cloud-mcp.duitpoket.fun").replace(/\/+$/, "");

let failed = 0;

async function getJson(url) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20_000) });
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

function warn(label, detail) {
  console.log(`WARN ${label} — ${detail}`);
}

function pulseLooksStale(pulseMs, lastAt, uptimeSeconds) {
  if (!lastAt) return uptimeSeconds > Math.max(120, (pulseMs * 2) / 1000);
  const ageMs = Date.now() - Date.parse(lastAt);
  if (!Number.isFinite(ageMs)) return true;
  return ageMs > pulseMs * 2 + 30_000;
}

try {
  const health = await getJson(`${BASE}/api/health`);
  if (!health.ok) fail("console health", `HTTP ${health.status}`);
  else pass(`console health ${health.status}`);

  if (!consoleSleepModeMissing(health.json)) {
    const cloud = health.json.cloud;
    if (cloud.enabled) pass("cloud.enabled");
    else warn("cloud", "cloud.enabled is false");
    if (cloud.tenantSchedulerPulseMs > 0) pass(`tenantSchedulerPulseMs=${cloud.tenantSchedulerPulseMs}`);
    else fail("sleep mode pulse", "tenantSchedulerPulseMs missing or 0 — set RELAY_CLOUD_TENANT_SCHEDULER_MS");
    if (cloud.publicBaseConfigured) pass("public base URL configured");
    else fail("Brevo inbound", "RELAY_PUBLIC_URL or RELAY_PUBLIC_BASE_URL unset on server");
    const uptime = health.json.uptimeSeconds ?? 0;
    if (cloud.lastTenantPulseAt) pass(`lastTenantPulseAt ${cloud.lastTenantPulseAt}`);
    else if (uptime > 180) fail("tenant pulse", "no lastTenantPulseAt after 3m uptime — check console pulse loop");
    else warn("tenant pulse", "waiting for first pulse");
    if (cloud.lastTenantPulseAt && pulseLooksStale(cloud.tenantSchedulerPulseMs, cloud.lastTenantPulseAt, uptime)) {
      fail("tenant pulse stale", "lastTenantPulseAt too old — schedulers may be stuck");
    }
  } else {
    const enabledOff = health.json.cloud?.enabled === false;
    const sha = health.json.gitSha;
    const shaHint = typeof sha === "string" && sha ? ` (deployed gitSha ${sha.slice(0, 7)})` : " (no gitSha — console predates deploy stamp)";
    fail(
      "sleep mode build",
      enabledOff
        ? `cloud.enabled is false — set RELAY_CLOUD_ENABLED=1 and redeploy console${shaHint}`
        : `health JSON has no cloud block — pull main + deploy on VM (console predates PR #61 sleep mode)${shaHint}`,
    );
  }

  if (health.json.emailConfigured) pass("platform email configured");
  else warn("email", "emailConfigured false — invites and billing emails will not send");

  const pay = health.json.payments ?? {};
  if (pay.stripeConfigured || pay.polarConfigured) pass("payments configured");
  else warn("payments", "no Stripe/Polar — customer top-up is manual only");

  const cloudHealth = await getJson(`${CLOUD_MCP}/health`);
  if (cloudHealth.ok) pass(`cloud MCP health ${cloudHealth.status}`);
  else fail("cloud MCP health", `HTTP ${cloudHealth.status}`);
  const mcpEval = evaluateCloudMcpHealth(cloudHealth.json, CLOUD_MCP);
  if (mcpEval.ok) {
    pass(`cloud MCP entrypoint ${mcpEval.mcpName}`);
    if (mcpEval.pulseMs > 0) pass(`cloud MCP tenantSchedulerPulseMs=${mcpEval.pulseMs}`);
    else fail("cloud MCP sleep mode", "health JSON missing cloud.tenantSchedulerPulseMs");
    if (mcpEval.lastPulseAt) pass(`cloud MCP lastTenantPulseAt ${mcpEval.lastPulseAt}`);
    else warn("cloud MCP pulse", "no lastTenantPulseAt yet on cloud-mcp /health");
  } else {
    fail("cloud MCP entrypoint", mcpEval.detail);
  }
} catch (error) {
  fail("fetch", error instanceof Error ? error.message : String(error));
}

if (failed === 0) {
  console.log("SLEEP-MODE VERIFY PASS");
} else {
  console.log(`SLEEP-MODE VERIFY FAIL (${failed})`);
  console.log(sleepModeRepairHintText());
}
process.exit(failed === 0 ? 0 : 1);