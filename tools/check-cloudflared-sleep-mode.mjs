#!/usr/bin/env node
/**
 * On the prod VM: confirm cloudflared ingress routes cloud-mcp hostname to 4321.
 * Does not need network; reads local config only.
 */
import { readFileSync, existsSync } from "node:fs";

const configPath = process.env.CLOUDFLARED_CONFIG?.trim() || "/etc/cloudflared/config.yml";
const expectedHost = (process.env.RELAY_CLOUD_PUBLIC_URL ?? "https://cloud-mcp.duitpoket.fun")
  .replace(/^https?:\/\//, "")
  .replace(/\/+$/, "");
const expectedPort = process.env.RELAY_CLOUD_MCP_PORT?.trim() || "4321";

if (!existsSync(configPath)) {
  console.log(`SKIP cloudflared sleep-mode check — no file at ${configPath}`);
  process.exit(0);
}

const text = readFileSync(configPath, "utf8");
const lines = text.split(/\r?\n/);

let hostFound = false;
let portOk = false;
let pendingHost = null;

for (const raw of lines) {
  const line = raw.trim();
  const hostMatch = line.match(/^-\s*hostname:\s*(\S+)/) ?? line.match(/^hostname:\s*(\S+)/);
  if (hostMatch) {
    pendingHost = hostMatch[1];
    if (pendingHost === expectedHost || pendingHost.includes("cloud-mcp.")) hostFound = true;
    continue;
  }
  const svcMatch = line.match(/^service:\s*http:\/\/(?:127\.0\.0\.1|localhost):(\d+)/);
  if (svcMatch && pendingHost) {
    if ((pendingHost === expectedHost || pendingHost.includes("cloud-mcp.")) && svcMatch[1] === expectedPort) {
      portOk = true;
    }
    pendingHost = null;
  }
}

if (hostFound && portOk) {
  console.log(`PASS cloudflared routes cloud-mcp → 127.0.0.1:${expectedPort} (${configPath})`);
  process.exit(0);
}

console.error(`FAIL cloudflared sleep-mode — ${configPath} must include hostname ${expectedHost} → http://127.0.0.1:${expectedPort}`);
console.error("See deploy/cloudflared-config.yml.example");
process.exit(1);