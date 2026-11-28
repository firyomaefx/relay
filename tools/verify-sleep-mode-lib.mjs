/**
 * Shared checks for tools/verify-sleep-mode.mjs (unit-tested without hitting prod).
 */
export {
  consoleSleepModeMissing,
  evaluateCloudMcpHealth,
  evaluateConsoleSleepMode,
} from "../packages/cloud/dist/sleep-mode-eval.js";

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

/** Printed when public sleep-mode verify fails — deliberate repair, not blind deploy. */
export function sleepModeRepairHintLines() {
  return [
    "Next: docs/operations/operator-handoff.md steps 0–4 (relay-cloud-mcp :4321, cloudflared, relay.env)",
    "Repair is paused by default: docs/operations/vm-repair-pause.md",
    "When ready: VM_REPAIR_RUN=1 sudo bash deploy/vm-system-ready.sh (or clear RELAY_VM_REPAIR_PAUSED=0)",
    "Then: npm run verify:system-ready",
  ];
}

export function sleepModeRepairHintText() {
  return sleepModeRepairHintLines().join("\n      ");
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
    ...sleepModeRepairHintLines(),
  ].join("\n");
  const html = `<p>Public sleep-mode verification failed.</p>
<pre style="white-space:pre-wrap;font-size:13px;background:#f5f4ef;padding:12px;border-radius:8px">${escapeHtml(body)}</pre>
<p>See <code>docs/operations/vm-repair-pause.md</code> and <code>docs/operations/operator-handoff.md</code>.</p>`;
  return { subject, text, html };
}