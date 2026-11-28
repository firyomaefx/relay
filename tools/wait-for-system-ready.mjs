#!/usr/bin/env node
/**
 * Poll public sleep-mode verify until PASS or timeout (after VM deploy).
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const intervalMs = Number(process.env.RELAY_READY_POLL_MS ?? "30_000");
const maxAttempts = Number(process.env.RELAY_READY_MAX_ATTEMPTS ?? "40");

for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  const verify = spawnSync(process.execPath, [path.join(root, "tools", "verify-sleep-mode.mjs")], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
  });
  if (verify.stdout) process.stdout.write(verify.stdout);
  if (verify.stderr) process.stderr.write(verify.stderr);
  if (verify.status === 0) {
    console.log(`\nSYSTEM READY after ${attempt} attempt(s)\n`);
    process.exit(0);
  }
  if (attempt < maxAttempts) {
    console.log(`\nWaiting ${intervalMs / 1000}s (${attempt}/${maxAttempts})…\n`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

console.error(`\nSYSTEM READY NOT SEEN after ${maxAttempts} attempts\n`);
process.exit(1);