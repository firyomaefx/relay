import type { CloudStore } from "./db.js";
import type { CloudLedger } from "./ledger.js";
import { customerOnboardingTopupNudgeEmail, loadEmailConfig, sendEmail, type EmailConfig } from "./email.js";
import { AUTOREPLY_MIN_TOPUP_MILLI_USD } from "./threads-autoreply-eligibility.js";

export interface OnboardingNudgeConfig {
  minAccountAgeMs: number;
  cooldownMs: number;
  enabled: boolean;
}

export function loadOnboardingNudgeConfig(env: NodeJS.ProcessEnv = process.env): OnboardingNudgeConfig {
  const ageDays = Number(env.RELAY_ONBOARDING_TOPUP_NUDGE_DAYS ?? "3");
  const cooldownDays = Number(env.RELAY_ONBOARDING_TOPUP_NUDGE_COOLDOWN_DAYS ?? "14");
  const enabled = !/^(0|false|no)$/i.test(env.RELAY_ONBOARDING_TOPUP_NUDGE?.trim() ?? "true");
  const minAccountAgeMs =
    Number.isFinite(ageDays) && ageDays > 0 ? ageDays * 24 * 60 * 60 * 1000 : 3 * 24 * 60 * 60 * 1000;
  const cooldownMs =
    Number.isFinite(cooldownDays) && cooldownDays > 0 ? cooldownDays * 24 * 60 * 60 * 1000 : 14 * 24 * 60 * 60 * 1000;
  return { minAccountAgeMs, cooldownMs, enabled };
}

function publicConsoleUrl(): string {
  return (process.env.RELAY_PUBLIC_URL?.trim() || "https://relay.duitpoket.fun").replace(/\/+$/, "");
}

/** Remind new customers to top up so Threads auto-reply and paid automation unlock. */
export async function runOnboardingTopupNudges(
  store: CloudStore,
  ledger: CloudLedger,
  emailConfig: EmailConfig | null | undefined = loadEmailConfig(process.env),
  config: OnboardingNudgeConfig = loadOnboardingNudgeConfig(),
): Promise<{ sent: number; skipped: number }> {
  if (!config.enabled || !emailConfig) return { sent: 0, skipped: 0 };
  let sent = 0;
  let skipped = 0;
  const now = Date.now();
  const topupUrl = `${publicConsoleUrl()}/topup`;
  for (const customer of store.listCustomers()) {
    if (customer.owner || customer.status !== "active" || !customer.email?.trim()) {
      skipped += 1;
      continue;
    }
    const age = now - Date.parse(customer.createdAt);
    if (!Number.isFinite(age) || age < config.minAccountAgeMs) {
      skipped += 1;
      continue;
    }
    if (ledger.largestTopup(customer.id) >= AUTOREPLY_MIN_TOPUP_MILLI_USD) {
      skipped += 1;
      continue;
    }
    const last = ledger.lastBillingAlertAt(customer.id, "onboarding_topup_nudge");
    if (last) {
      const elapsed = now - Date.parse(last);
      if (Number.isFinite(elapsed) && elapsed < config.cooldownMs) {
        skipped += 1;
        continue;
      }
    }
    const message = customerOnboardingTopupNudgeEmail({
      name: customer.displayName,
      topupUrl,
      minimumUsd: AUTOREPLY_MIN_TOPUP_MILLI_USD / 1000,
    });
    const result = await sendEmail(emailConfig, { ...message, to: customer.email });
    if (result.sent) {
      ledger.recordBillingAlert(customer.id, "onboarding_topup_nudge", new Date().toISOString());
      sent += 1;
    } else {
      skipped += 1;
    }
  }
  return { sent, skipped };
}