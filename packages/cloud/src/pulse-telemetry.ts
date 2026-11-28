export type PulseProcess = "console" | "cloud-mcp";

interface PulseSnapshot {
  at: string;
  tenantCount: number;
  tenantErrors: number;
}

const snapshots: Partial<Record<PulseProcess, PulseSnapshot>> = {};

/** Record the latest tenant scheduler pulse from console or cloud MCP. */
export function recordTenantSchedulerPulse(
  process: PulseProcess,
  result: { tenants: number; errors: number },
): void {
  snapshots[process] = {
    at: new Date().toISOString(),
    tenantCount: result.tenants,
    tenantErrors: result.errors,
  };
}

export function tenantSchedulerPulseStatus(process: PulseProcess): PulseSnapshot | null {
  return snapshots[process] ?? null;
}

export function isPulseStale(pulseMs: number, at: string | undefined, uptimeSeconds: number): boolean {
  if (!at) return uptimeSeconds > Math.max(120, (pulseMs * 2) / 1000);
  const ageMs = Date.now() - Date.parse(at);
  if (!Number.isFinite(ageMs)) return true;
  return ageMs > pulseMs * 2 + 30_000;
}