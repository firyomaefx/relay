import type { CloudLedger } from "./ledger.js";
import type { CloudStore } from "./db.js";
import type { TenantManager } from "./tenants.js";
import { loadEmailConfig, operatorAutomationDigestEmail, operatorRevenueDigestEmail, sendEmail, type EmailConfig } from "./email.js";
import { summarizeAutomationHealth } from "./automation-health.js";
import type { PriceTable } from "./pricing.js";

const OPERATOR_ALERT_ID = "operator";

export type OperatorNotifyHost = "console" | "cloud-mcp";

/** When both console and cloud-mcp pulse, avoid duplicate operator email attempts. */
export function operatorNotifyHostAllowed(
  env: NodeJS.ProcessEnv,
  host: OperatorNotifyHost,
): boolean {
  const leader = (env.RELAY_OPERATOR_NOTIFY_LEADER ?? "both").trim().toLowerCase();
  if (!leader || leader === "both") return true;
  return leader === host;
}

export function loadOperatorAlertConfig(env: NodeJS.ProcessEnv = process.env): {
  email: string | null;
  cooldownMs: number;
  enabled: boolean;
} {
  const email = env.RELAY_OPERATOR_ALERT_EMAIL?.trim() || null;
  const cooldown = Number(env.RELAY_OPERATOR_ALERT_COOLDOWN_MS ?? String(24 * 60 * 60 * 1000));
  const enabled = !/^(0|false|no)$/i.test(env.RELAY_OPERATOR_ALERT_EMAIL_ENABLED?.trim() ?? "true");
  return {
    email,
    enabled: enabled && Boolean(email),
    cooldownMs: Number.isFinite(cooldown) && cooldown > 0 ? cooldown : 24 * 60 * 60 * 1000,
  };
}

/** Email operator when tenant automation checks fail (daily cooldown). */
export async function maybeSendOperatorAutomationDigest(
  store: CloudStore,
  ledger: CloudLedger,
  tenants: TenantManager,
  emailConfig: EmailConfig | null | undefined = loadEmailConfig(process.env),
  env: NodeJS.ProcessEnv = process.env,
  host: OperatorNotifyHost = "console",
): Promise<{ sent: boolean; reason?: string; issueCount?: number }> {
  if (!operatorNotifyHostAllowed(env, host)) return { sent: false, reason: "not_leader" };
  const config = loadOperatorAlertConfig(env);
  if (!config.enabled || !config.email) return { sent: false, reason: "disabled" };
  if (!emailConfig) return { sent: false, reason: "not_configured" };
  const summary = await summarizeAutomationHealth(store, ledger, tenants);
  if (summary.issueCount === 0) return { sent: false, reason: "no_issues", issueCount: 0 };
  const last = ledger.lastBillingAlertAt(OPERATOR_ALERT_ID, "automation_digest");
  if (last) {
    const elapsed = Date.now() - Date.parse(last);
    if (Number.isFinite(elapsed) && elapsed < config.cooldownMs) return { sent: false, reason: "cooldown", issueCount: summary.issueCount };
  }
  const lines = summary.customers.flatMap((row) =>
    row.issues.map((issue) => `${row.displayName}: ${issue}`),
  );
  const adminUrl = (env.RELAY_PUBLIC_URL?.trim() || "https://relay.duitpoket.fun").replace(/\/+$/, "") + "/cloud-admin";
  const message = operatorAutomationDigestEmail({ issues: lines, adminUrl, issueCount: summary.issueCount });
  const result = await sendEmail(emailConfig, { ...message, to: config.email });
  if (result.sent) ledger.recordBillingAlert(OPERATOR_ALERT_ID, "automation_digest", new Date().toISOString());
  return result.sent
    ? { sent: true, issueCount: summary.issueCount }
  : { sent: false, reason: result.error ?? result.skipped ?? "send_failed", issueCount: summary.issueCount };
}

export function loadOperatorRevenueDigestConfig(env: NodeJS.ProcessEnv = process.env): {
  email: string | null;
  cooldownMs: number;
  enabled: boolean;
} {
  const email = env.RELAY_OPERATOR_ALERT_EMAIL?.trim() || null;
  const cooldown = Number(env.RELAY_OPERATOR_REVENUE_DIGEST_COOLDOWN_MS ?? String(7 * 24 * 60 * 60 * 1000));
  const enabled = !/^(0|false|no)$/i.test(env.RELAY_OPERATOR_REVENUE_DIGEST?.trim() ?? "true");
  return {
    email,
    enabled: enabled && Boolean(email),
    cooldownMs: Number.isFinite(cooldown) && cooldown > 0 ? cooldown : 7 * 24 * 60 * 60 * 1000,
  };
}

/** Weekly RM goal progress (and automation issue count) without opening /cloud-admin. */
export async function maybeSendOperatorRevenueDigest(
  store: CloudStore,
  ledger: CloudLedger,
  tenants: TenantManager,
  emailConfig: EmailConfig | null | undefined,
  pricing: PriceTable | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  host: OperatorNotifyHost = "console",
): Promise<{ sent: boolean; reason?: string }> {
  if (!operatorNotifyHostAllowed(env, host)) return { sent: false, reason: "not_leader" };
  const config = loadOperatorRevenueDigestConfig(env);
  if (!config.enabled || !config.email) return { sent: false, reason: "disabled" };
  if (!emailConfig) return { sent: false, reason: "not_configured" };
  const last = ledger.lastBillingAlertAt(OPERATOR_ALERT_ID, "revenue_digest");
  if (last) {
    const elapsed = Date.now() - Date.parse(last);
    if (Number.isFinite(elapsed) && elapsed < config.cooldownMs) return { sent: false, reason: "cooldown" };
  }
  const since = env.RELAY_REVENUE_GOAL_SINCE?.trim() || "2026-01-01T00:00:00.000Z";
  const goalMyr = Number(env.RELAY_REVENUE_GOAL_MYR ?? "4000");
  const goalDeadline = env.RELAY_REVENUE_GOAL_DEADLINE?.trim() || "2026-12-31";
  const revenue = ledger.operatorPaymentRevenue({ since });
  const rate = pricing?.list().usd_myr_rate ?? null;
  const estimatedMyr = rate && rate > 0 ? (revenue.totalMilliUsd / 1000) * rate : null;
  const progressPercent =
    estimatedMyr != null && goalMyr > 0 ? Math.min(100, (estimatedMyr / goalMyr) * 100) : null;
  const health = await summarizeAutomationHealth(store, ledger, tenants);
  const sampleIssues = health.customers.flatMap((row) => row.issues).slice(0, 8);
  const adminUrl = (env.RELAY_PUBLIC_URL?.trim() || "https://relay.duitpoket.fun").replace(/\/+$/, "") + "/cloud-admin";
  const message = operatorRevenueDigestEmail({
    adminUrl,
    goalMyr,
    goalDeadline,
    totalUsd: revenue.totalMilliUsd / 1000,
    estimatedMyr,
    progressPercent,
    paymentCount: revenue.succeededCount,
    since,
    automationIssueCount: health.issueCount,
    sampleIssues,
  });
  const result = await sendEmail(emailConfig, { ...message, to: config.email });
  if (result.sent) ledger.recordBillingAlert(OPERATOR_ALERT_ID, "revenue_digest", new Date().toISOString());
  return result.sent ? { sent: true } : { sent: false, reason: result.error ?? result.skipped ?? "send_failed" };
}