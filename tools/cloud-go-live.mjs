#!/usr/bin/env node
/**
 * Operator gate before declaring sleep mode live (VM or laptop against prod URLs).
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(script) {
  const file = path.join(root, "tools", script);
  console.log(`\n=== ${script} ===\n`);
  return spawnSync(process.execPath, [file], { cwd: root, stdio: "inherit", env: process.env });
}

async function localConsoleReachable() {
  if (process.env.RELAY_GO_LIVE_SKIP_LOCAL === "1") return false;
  const url = (process.env.RELAY_CONSOLE_HEALTH_URL ?? "http://127.0.0.1:4317/api/health").replace(/\/+$/, "");
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
    return response.ok;
  } catch {
    return false;
  }
}

let failed = 0;

if (await localConsoleReachable()) {
  const local = run("verify-sleep-mode-local.mjs");
  if (local.status !== 0) failed += 1;
} else {
  console.log("\n=== verify-sleep-mode-local.mjs (skipped — no local console on 4317) ===\n");
}

const cf = run("check-cloudflared-sleep-mode.mjs");
if (cf.status !== 0 && cf.status !== null) {
  console.error("\ncloudflared check failed (skipped if config file missing on this host)\n");
  if (cf.status > 0) failed += 1;
}
const verify = run("verify-sleep-mode.mjs");
if (verify.status !== 0) failed += 1;

if (failed === 0) {
  console.log("\nCLOUD GO-LIVE: all checks passed\n");
  process.exit(0);
}
console.error(`\nCLOUD GO-LIVE: ${failed} check(s) failed — see docs/operations/rm4000-cloud-runbook.md\n`);
process.exit(1);