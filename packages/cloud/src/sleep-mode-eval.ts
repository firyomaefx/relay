// Traceability: REQ-016
/** Shared sleep-mode health rules (console + cloud MCP). Used by deploy probes and CLI verify tools. */

export type SleepModeEval = { ok: true; pulseMs: number } | { ok: false; detail: string };

export type CloudMcpHealthEval =
  | { ok: true; mcpName: string; pulseMs: number | null; lastPulseAt: string | null }
  | { ok: false; mcpName: string | null; detail: string };

export function consoleSleepModeMissing(healthJson: Record<string, unknown> | null | undefined): boolean {
  const cloud = healthJson?.cloud as Record<string, unknown> | undefined;
  return !cloud || cloud.enabled === false;
}

export function evaluateConsoleSleepMode(healthJson: Record<string, unknown> | null | undefined): SleepModeEval {
  if (consoleSleepModeMissing(healthJson)) {
    const cloud = healthJson?.cloud as Record<string, unknown> | undefined;
    const enabledOff = cloud?.enabled === false;
    return {
      ok: false,
      detail: enabledOff
        ? "cloud.enabled is false — set RELAY_CLOUD_ENABLED=1 in /etc/relay/relay.env and restart relay-console"
        : "health JSON has no cloud block — deploy sleep-mode build with cloud admin enabled",
    };
  }
  const cloud = healthJson!.cloud as Record<string, unknown>;
  const pulseMs = cloud.tenantSchedulerPulseMs;
  if (!(typeof pulseMs === "number" && pulseMs > 0)) {
    return {
      ok: false,
      detail:
        "tenantSchedulerPulseMs missing or 0 — set RELAY_CLOUD_TENANT_SCHEDULER_MS in /etc/relay/relay.env",
    };
  }
  return { ok: true, pulseMs };
}

export function evaluateCloudMcpHealth(
  json: Record<string, unknown> | null | undefined,
  cloudMcpUrl: string,
  port = process.env.RELAY_CLOUD_MCP_PORT ?? "4321",
): CloudMcpHealthEval {
  const mcpName = typeof json?.name === "string" ? json.name : null;
  if (mcpName === "relay-cloud-mcp") {
    const mcpCloud = json?.cloud as Record<string, unknown> | undefined;
    const pulseMs = mcpCloud?.tenantSchedulerPulseMs;
    return {
      ok: true,
      mcpName,
      pulseMs: typeof pulseMs === "number" ? pulseMs : null,
      lastPulseAt: typeof mcpCloud?.lastTenantPulseAt === "string" ? mcpCloud.lastTenantPulseAt : null,
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