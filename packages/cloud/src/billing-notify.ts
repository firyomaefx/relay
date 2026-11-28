import type { Customer, CloudStore } from "./db.js";
import type { CloudLedger } from "./ledger.js";
import { customerLowBalanceEmail, customerTopupReceiptEmail, loadEmailConfig, sendEmail, type EmailConfig } from "./email.js";

export interface BillingNotifyConfig {
  lowBalanceMilliUsd: number;
  cooldownMs: number;
  topupReceipts: boolean;
}

export function loadBillingNotifyConfig(env: NodeJS.ProcessEnv = process.env): BillingNotifyConfig {
  const low = Number(env.RELAY_LOW_BALANCE_MILLI_USD ?? "1000");
  const cooldown = Number(env.RELAY_LOW_BALANCE_EMAIL_COOLDOWN_MS ?? String(7 * 24 * 60 * 60 * 1000));
  const topupReceipts = !/^(0|false|no)$/i.test(env.RELAY_TOPUP_RECEIPT_EMAIL?.trim() ?? "true");
  return {
    lowBalanceMilliUsd: Number.isFinite(low) && low >= 0 ? low : 1000,
    cooldownMs: Number.isFinite(cooldown) && cooldown > 0 ? cooldown : 7 * 24 * 60 * 60 * 1000,
    topupReceipts,
  };
}

function publicConsoleUrl(): string {
  return (process.env.RELAY_PUBLIC_URL?.trim() || "https://relay.duitpoket.fun").replace(/\/+$/, "");
}

/** Nudge customers to top up before automation stalls (cooldown per customer). */
export async function maybeSendLowBalanceEmail(
  ledger: CloudLedger,
  emailConfig: EmailConfig | null | undefined,
  customer: Customer,
  availableMilliUsd: number,
  config: BillingNotifyConfig = loadBillingNotifyConfig(),
): Promise<{ sent: boolean; reason?: string }> {
  if (customer.owner) return { sent: false, reason: "owner" };
  const email = customer.email?.trim();
  if (!email) return { sent: false, reason: "no_email" };
  if (!emailConfig) return { sent: false, reason: "not_configured" };
  if (availableMilliUsd > config.lowBalanceMilliUsd) return { sent: false, reason: "above_threshold" };
  const last = ledger.lastBillingAlertAt(customer.id, "low_balance");
  if (last) {
    const elapsed = Date.now() - Date.parse(last);
    if (Number.isFinite(elapsed) && elapsed < config.cooldownMs) return { sent: false, reason: "cooldown" };
  }
  const message = customerLowBalanceEmail({
    name: customer.displayName,
    availableMilliUsd,
    topupUrl: `${publicConsoleUrl()}/topup`,
  });
  const result = await sendEmail(emailConfig, { ...message, to: email });
  if (result.sent) ledger.recordBillingAlert(customer.id, "low_balance", new Date().toISOString());
  return result.sent ? { sent: true } : { sent: false, reason: result.error ?? result.skipped ?? "send_failed" };
}

export async function maybeSendTopupReceiptEmail(
  emailConfig: EmailConfig | null | undefined,
  customer: Customer,
  amountMilliUsd: number,
  provider: string,
  config: BillingNotifyConfig = loadBillingNotifyConfig(),
): Promise<{ sent: boolean; reason?: string }> {
  if (!config.topupReceipts) return { sent: false, reason: "disabled" };
  if (customer.owner || provider === "manual") return { sent: false, reason: "skipped" };
  const email = customer.email?.trim();
  if (!email) return { sent: false, reason: "no_email" };
  if (!emailConfig) return { sent: false, reason: "not_configured" };
  const message = customerTopupReceiptEmail({
    name: customer.displayName,
    amountMilliUsd,
    provider,
    consoleUrl: publicConsoleUrl(),
  });
  const result = await sendEmail(emailConfig, { ...message, to: email });
  return result.sent ? { sent: true } : { sent: false, reason: result.error ?? result.skipped ?? "send_failed" };
}

/** Periodic pass from console or cloud MCP after reconcile. */
export async function runLowBalanceChecksForActiveCustomers(
  store: CloudStore,
  ledger: CloudLedger,
  emailConfig: EmailConfig | null | undefined,
  freeAllowanceMilliUsd: number,
  config: BillingNotifyConfig = loadBillingNotifyConfig(),
): Promise<void> {
  for (const customer of store.listCustomers()) {
    if (customer.owner || customer.status !== "active") continue;
    const { available } = ledger.balanceWithHold(customer.id);
    const free = freeAllowanceMilliUsd > 0 ? ledger.freeRemaining(customer.id, freeAllowanceMilliUsd) : 0;
    await maybeSendLowBalanceEmail(ledger, emailConfig, customer, available + free, config).catch(() => undefined);
  }
}