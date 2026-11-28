#!/usr/bin/env node
/**
 * Runs public verify-sleep-mode; emails RELAY_OPERATOR_ALERT_EMAIL on failure when Brevo/Resend is configured.
 * Used by .github/workflows/production-sleep-monitor.yml (set repo secrets for alerts).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatSleepDriftOperatorAlert } from "./verify-sleep-mode-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cloudPkg = path.join(root, "packages", "cloud", "dist", "index.js");

const verify = spawnSync(process.execPath, [path.join(root, "tools", "verify-sleep-mode.mjs")], {
  cwd: root,
  env: process.env,
  encoding: "utf8",
});

const output = `${verify.stdout ?? ""}${verify.stderr ?? ""}`.trim();
if (output) process.stdout.write(`${verify.stdout ?? ""}${verify.stderr ?? ""}`);

if (verify.status === 0) {
  process.exit(0);
}

const operatorEmail = process.env.RELAY_OPERATOR_ALERT_EMAIL?.trim();
if (!operatorEmail) {
  console.error("\n(no RELAY_OPERATOR_ALERT_EMAIL — skip operator alert email)\n");
  process.exit(verify.status ?? 1);
}

let loadEmailConfig;
let sendEmail;
try {
  ({ loadEmailConfig, sendEmail } = await import(cloudPkg));
} catch (error) {
  console.error(`WARN could not load @relay/cloud for alert email: ${error instanceof Error ? error.message : error}`);
  process.exit(verify.status ?? 1);
}

const emailConfig = loadEmailConfig(process.env);
if (!emailConfig) {
  console.error("\n(email not configured — set RELAY_EMAIL_FROM + RELAY_BREVO_API_KEY or RELAY_RESEND_API_KEY)\n");
  process.exit(verify.status ?? 1);
}

const message = formatSleepDriftOperatorAlert(output || "verify-sleep-mode exited with no output");
const result = await sendEmail(emailConfig, { ...message, to: operatorEmail });
if (result.sent) console.log(`operator alert sent to ${operatorEmail}`);
else console.error(`operator alert not sent: ${result.error ?? result.skipped ?? "unknown"}`);

process.exit(verify.status ?? 1);