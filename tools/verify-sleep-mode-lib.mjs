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

/** Operator alert when scheduled public verify fails (GitHub sleep monitor). */
export function formatSleepDriftOperatorAlert(verifyOutput) {
  const body = verifyOutput.trim();
  const subject = "[Relay] Production sleep mode verify FAILED";
  const text = [
    "Public sleep-mode verification failed.",
    "",
    body,
    "",
    "VM checklist: docs/operations/operator-handoff.md",
    "Quick: npm run verify-sleep-mode-local on the VM, then go-live:cloud.",
  ].join("\n");
  const html = `<p>Public sleep-mode verification failed.</p>
<pre style="white-space:pre-wrap;font-size:13px;background:#f5f4ef;padding:12px;border-radius:8px">${escapeHtml(body)}</pre>
<p>See <code>docs/operations/operator-handoff.md</code> on the deploy branch.</p>`;
  return { subject, text, html };
}