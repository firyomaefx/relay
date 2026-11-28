#!/usr/bin/env node
const BASE = process.env.RELAY_PUBLIC_URL?.replace(/\/+$/, "") || "https://relay.duitpoket.fun";
const CLOUD = process.env.RELAY_CLOUD_MCP_URL?.replace(/\/+$/, "") || "https://cloud-mcp.duitpoket.fun";

const checks = [
  ["console", `${BASE}/`],
  ["pricing", `${BASE}/pricing`],
  ["connect", `${BASE}/connect`],
  ["contact", `${BASE}/contact`],
  ["login", `${BASE}/login`],
  ["health", `${BASE}/api/health`],
  ["prices", `${BASE}/api/pricing`],
  ["oauth-metadata", `${BASE}/.well-known/oauth-authorization-server`],
  ["cloud-health", `${CLOUD}/health`],
];

let failed = 0;
for (const [name, url] of checks) {
  try {
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15_000) });
    const ok = response.status >= 200 && response.status < 400;
    console.log(`${ok ? "PASS" : "FAIL"} ${name} ${response.status} ${url}`);
    if (!ok) failed += 1;
  } catch (error) {
    console.log(`FAIL ${name} ${error.message} ${url}`);
    failed += 1;
  }
}

try {
  const health = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(15_000) }).then((r) => r.json());
  if (!health?.payments) {
    console.log("FAIL health does not expose payment readiness");
    failed += 1;
  } else {
    console.log(`INFO payments ${JSON.stringify(health.payments)}`);
    if (health.payments.polarSandbox) console.log("WARN Polar sandbox is configured; public checkout must remain disabled");
    if (health.cloud?.enabled) {
      const pulse = health.cloud.tenantSchedulerPulseMs;
      console.log(`INFO cloud sleep mode pulseMs=${pulse} publicBase=${health.cloud.publicBaseConfigured ? "yes" : "NO"}`);
      if (!pulse || pulse <= 0) console.log("WARN RELAY_CLOUD_TENANT_SCHEDULER_MS is 0; customer schedulers may stop without console login");
      if (!health.cloud.publicBaseConfigured) console.log("WARN RELAY_PUBLIC_URL or RELAY_PUBLIC_BASE_URL unset; Brevo inbound webhooks may fail");
    }
  }
} catch (error) {
  console.log(`FAIL payment readiness ${error.message}`);
  failed += 1;
}

try {
  const response = await fetch(`${BASE}/api/polar/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(15_000),
  });
  const expected = response.status === 400 || response.status === 503;
  console.log(`${expected ? "PASS" : "FAIL"} polar webhook rejects unsigned payload ${response.status}`);
  if (!expected) failed += 1;
} catch (error) {
  console.log(`FAIL polar webhook probe ${error.message}`);
  failed += 1;
}

let sleepFailed = 0;
try {
  const { spawnSync } = await import("node:child_process");
  const probe = spawnSync(process.execPath, ["tools/verify-sleep-mode.mjs"], {
    cwd: new URL("..", import.meta.url).pathname,
    encoding: "utf8",
  });
  if (probe.stdout) process.stderr.write(probe.stdout);
  if (probe.stderr) process.stderr.write(probe.stderr);
  sleepFailed = probe.status === 0 ? 0 : 1;
} catch (error) {
  console.log(`FAIL sleep-mode verify ${error instanceof Error ? error.message : String(error)}`);
  sleepFailed = 1;
}
failed += sleepFailed;

if (failed > 0) console.log("HINT on the VM run: npm run go-live:cloud (tunnel + sleep-mode)");
console.log(failed === 0 ? "READINESS PASS" : `READINESS FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
