// Traceability: REQ-016
/**
 * VM-local probes for console + cloud MCP sleep mode (127.0.0.1).
 * Used from /api/cloud/admin/deploy-health so operators see drift without SSH.
 */

import { evaluateCloudMcpHealth, evaluateConsoleSleepMode } from "./sleep-mode-eval.js";

export interface PlatformDeployHealth {
  ok: boolean;
  issues: string[];
  console: {
    url: string;
    reachable: boolean;
    gitSha: string | null;
    cloudEnabled: boolean | null;
    tenantSchedulerPulseMs: number | null;
    lastTenantPulseAt: string | null;
  };
  cloudMcp: {
    url: string;
    reachable: boolean;
    name: string | null;
    gitSha: string | null;
    tenantSchedulerPulseMs: number | null;
    lastTenantPulseAt: string | null;
  };
}

async function fetchHealthJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`non-JSON from ${url} (${response.status})`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return json as Record<string, unknown>;
}

export async function probePlatformDeployHealth(env: NodeJS.ProcessEnv = process.env): Promise<PlatformDeployHealth> {
  const consoleUrl = (env.RELAY_CONSOLE_HEALTH_URL ?? "http://127.0.0.1:4317/api/health").replace(/\/+$/, "");
  const cloudMcpUrl = (env.RELAY_CLOUD_MCP_HEALTH_URL ?? "http://127.0.0.1:4321/health").replace(/\/+$/, "");
  const issues: string[] = [];

  let consoleJson: Record<string, unknown> | null = null;
  let cloudJson: Record<string, unknown> | null = null;

  try {
    consoleJson = await fetchHealthJson(consoleUrl);
  } catch (error) {
    issues.push(`Console not reachable at ${consoleUrl}: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    cloudJson = await fetchHealthJson(cloudMcpUrl);
  } catch (error) {
    issues.push(
      `Cloud MCP not reachable at ${cloudMcpUrl}: ${error instanceof Error ? error.message : String(error)} (enable relay-cloud-mcp on port 4321)`,
    );
  }

  const consoleCloud = consoleJson?.cloud as Record<string, unknown> | undefined;
  const consoleEnabled = typeof consoleCloud?.enabled === "boolean" ? consoleCloud.enabled : null;
  const consoleGitSha = typeof consoleJson?.gitSha === "string" ? consoleJson.gitSha : null;
  const consolePulse = typeof consoleCloud?.tenantSchedulerPulseMs === "number" ? consoleCloud.tenantSchedulerPulseMs : null;

  if (consoleJson) {
    const consoleEval = evaluateConsoleSleepMode(consoleJson);
    if (!consoleEval.ok) issues.push(consoleEval.detail);
  }

  const mcpName = typeof cloudJson?.name === "string" ? cloudJson.name : null;
  const mcpCloud = cloudJson?.cloud as Record<string, unknown> | undefined;
  const mcpPulse = typeof mcpCloud?.tenantSchedulerPulseMs === "number" ? mcpCloud.tenantSchedulerPulseMs : null;
  const mcpGitSha = typeof cloudJson?.gitSha === "string" ? cloudJson.gitSha : null;

  if (cloudJson) {
    const mcpEval = evaluateCloudMcpHealth(cloudJson, cloudMcpUrl);
    if (!mcpEval.ok) issues.push(mcpEval.detail);
    else if (!(mcpEval.pulseMs && mcpEval.pulseMs > 0)) {
      issues.push("Cloud MCP missing tenantSchedulerPulseMs — set RELAY_CLOUD_TENANT_SCHEDULER_MS");
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    console: {
      url: consoleUrl,
      reachable: consoleJson != null,
      gitSha: consoleGitSha,
      cloudEnabled: consoleEnabled,
      tenantSchedulerPulseMs: consolePulse,
      lastTenantPulseAt: typeof consoleCloud?.lastTenantPulseAt === "string" ? consoleCloud.lastTenantPulseAt : null,
    },
    cloudMcp: {
      url: cloudMcpUrl,
      reachable: cloudJson != null,
      name: mcpName,
      gitSha: mcpGitSha,
      tenantSchedulerPulseMs: mcpPulse,
      lastTenantPulseAt: typeof mcpCloud?.lastTenantPulseAt === "string" ? mcpCloud.lastTenantPulseAt : null,
    },
  };
}