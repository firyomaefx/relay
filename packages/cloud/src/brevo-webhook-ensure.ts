import type { Customer } from "./db.js";
import type { CloudLedger } from "./ledger.js";
import type { RelayService } from "@relay/core";

const ALERT_KIND = "brevo_webhook_ensure";

export function brevoWebhookEnsureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|false|no)$/i.test(env.RELAY_BREVO_WEBHOOK_ENSURE?.trim() ?? "true");
}

export function loadBrevoWebhookEnsureCooldownMs(env: NodeJS.ProcessEnv = process.env): number {
  const cooldown = Number(env.RELAY_BREVO_WEBHOOK_ENSURE_COOLDOWN_MS ?? String(24 * 60 * 60 * 1000));
  return Number.isFinite(cooldown) && cooldown > 0 ? cooldown : 24 * 60 * 60 * 1000;
}

/** Re-register Brevo inbound webhook when automation health would flag it missing (sleep mode). */
export async function maybeEnsureBrevoInboundWebhook(
  customer: Customer,
  relay: RelayService,
  ledger: CloudLedger,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ attempted: boolean; ok?: boolean; detail?: string }> {
  if (customer.owner || customer.status !== "active") return { attempted: false };
  if (!brevoWebhookEnsureEnabled(env)) return { attempted: false };

  const accounts = await relay.accounts();
  if (!accounts.some((entry) => entry.platform === "brevo")) return { attempted: false };

  const program = await relay.getEmailProgram();
  if (program.health?.webhookRegistered) return { attempted: false };

  const cooldownMs = loadBrevoWebhookEnsureCooldownMs(env);
  const last = ledger.lastBillingAlertAt(customer.id, ALERT_KIND);
  if (last) {
    const elapsed = Date.now() - Date.parse(last);
    if (Number.isFinite(elapsed) && elapsed < cooldownMs) return { attempted: false };
  }

  const result = await relay.ensureBrevoEmailAutomation();
  ledger.recordBillingAlert(customer.id, ALERT_KIND, new Date().toISOString());
  return { attempted: true, ok: result.ok, detail: result.detail };
}