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

console.log(failed === 0 ? "READINESS PASS" : `READINESS FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
