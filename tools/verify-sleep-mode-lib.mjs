/**
 * Shared checks for tools/verify-sleep-mode.mjs (unit-tested without hitting prod).
 */

export function evaluateCloudMcpHealth(json, cloudMcpUrl, port = process.env.RELAY_CLOUD_MCP_PORT ?? "4321") {
  const mcpName = json?.name;
  if (mcpName === "relay-cloud-mcp") {
    const pulseMs = json?.cloud?.tenantSchedulerPulseMs;
    return {
      ok: true,
      mcpName,
      pulseMs: typeof pulseMs === "number" ? pulseMs : null,
      lastPulseAt: json?.cloud?.lastTenantPulseAt ?? null,
    };
  }
  if (mcpName === "relay-mcp-http") {
    return {
      ok: false,
      mcpName,
      detail: `${cloudMcpUrl}/health is owner relay-mcp, not cloud-entry — enable relay-cloud-mcp.service and point the tunnel to port ${port}`,
    };
  }
  return {
    ok: false,
    mcpName,
    detail: `unexpected health name ${mcpName ?? "(missing)"} — deploy apps/mcp/dist/cloud-entry.js`,
  };
}

export function consoleSleepModeMissing(healthJson) {
  return !healthJson?.cloud || healthJson.cloud.enabled === false;
}

/** Localhost / VM checks before public URL verify (same semantics as tools/verify-sleep-mode.mjs). */
function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char] ?? char));
}

/** Operator alert when scheduled public verify fails (GitHub sleep monitor). */
export function formatSleepDriftOperatorAlert(verifyOutput) {
  const body = verifyOutput.trim();
  const subject = "[Relay] Production sleep mode verify FAILED";
  const text = [
    "Public sleep-mode verification failed.",
    "",
    body,
    "",
    "VM checklist: docs/operations/operator-handoff.md",
    "Quick: npm run verify:sleep-mode-local on the VM, then go-live:cloud.",
  ].join("\n");
  const html = `<p>Public sleep-mode verification failed.</p>
<pre style="white-space:pre-wrap;font-size:13px;background:#f5f4ef;padding:12px;border-radius:8px">${escapeHtml(body)}</pre>
<p>See <code>docs/operations/operator-handoff.md</code> on the deploy branch.</p>`;
  return { subject, text, html };
}

export function evaluateConsoleSleepMode(healthJson) {
  if (consoleSleepModeMissing(healthJson)) {
    const enabledOff = healthJson?.cloud?.enabled === false;
    return {
      ok: false,
      detail: enabledOff
        ? "cloud.enabled is false — set RELAY_CLOUD_ENABLED=1 in /etc/relay/relay.env and restart relay-console"
        : "health JSON has no cloud block — deploy sleep-mode build with cloud admin enabled",
    };
  }
  const cloud = healthJson.cloud;
  const pulseMs = cloud.tenantSchedulerPulseMs;
  if (!(typeof pulseMs === "number" && pulseMs > 0)) {
    return {
      ok: false,
      detail: "tenantSchedulerPulseMs missing or 0 — set RELAY_CLOUD_TENANT_SCHEDULER_MS in /etc/relay/relay.env",
    };
  }
  return { ok: true, pulseMs };
}