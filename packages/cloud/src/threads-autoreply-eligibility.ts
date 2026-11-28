import type { RelayService } from "@relay/core";
import type { CloudLedger } from "./ledger.js";
import type { Customer } from "./db.js";

/** Minimum single paid top-up before Cloud auto-reply can be enabled. */
export const AUTOREPLY_MIN_TOPUP_MILLI_USD = 9900;

export interface ThreadsAutoReplyEligibility {
  eligible: boolean;
  active: boolean;
  minimumTopupMilliUsd: number;
  paidTopupMilliUsd: number;
  keyConfigured: boolean;
  threadsConnected: boolean;
  threadsReady: boolean;
  missingScopes: string[];
  enabled: boolean;
  reason: string | null;
}

export async function assessThreadsAutoReply(
  customer: Customer,
  relay: RelayService,
  ledger: CloudLedger,
): Promise<ThreadsAutoReplyEligibility> {
  const paidTopupMilliUsd = ledger.largestTopup(customer.id);
  const keyConfigured = Boolean(relay.getDeepSeekApiKey());
  const enabled = relay.isThreadsAutoReplyEnabled();
  const reports = await relay.commentsStatus();
  const threads = reports.find((entry) => entry.platform === "threads");
  const threadsConnected = Boolean(threads?.connected);
  const threadsReady = Boolean(threads?.ready);
  const missingScopes = threads?.missing_scopes ?? [];
  const eligible = paidTopupMilliUsd >= AUTOREPLY_MIN_TOPUP_MILLI_USD && keyConfigured && threadsReady;
  let reason: string | null = null;
  if (paidTopupMilliUsd < AUTOREPLY_MIN_TOPUP_MILLI_USD) {
    reason = `Needs a single top-up of at least $${(AUTOREPLY_MIN_TOPUP_MILLI_USD / 1000).toFixed(2)} (largest paid: $${(paidTopupMilliUsd / 1000).toFixed(2)}).`;
  } else if (!keyConfigured) {
    reason = "Add a DeepSeek API key under Settings.";
  } else if (!threadsConnected) {
    reason = "Connect a Threads account.";
  } else if (!threadsReady) {
    reason = `Reconnect Threads with reply permissions${missingScopes.length ? `: ${missingScopes.join(", ")}` : "."}`;
  } else if (!enabled) {
    reason = "Threads auto-reply is eligible but disabled.";
  }
  return {
    eligible,
    active: eligible && enabled,
    minimumTopupMilliUsd: AUTOREPLY_MIN_TOPUP_MILLI_USD,
    paidTopupMilliUsd,
    keyConfigured,
    threadsConnected,
    threadsReady,
    missingScopes,
    enabled,
    reason,
  };
}

export function threadsAutoReplyAutoEnableEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|false|no)$/i.test(env.RELAY_THREADS_AUTOREPLY_AUTO_ENABLE?.trim() ?? "true");
}

/** Turn on auto-reply when paid top-up, Threads, and DeepSeek are ready (no manual enable step). */
export async function maybeAutoEnableThreadsAutoReply(
  customer: Customer,
  relay: RelayService,
  ledger: CloudLedger,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ enabled: boolean; reason?: string }> {
  if (customer.owner) return { enabled: false, reason: "owner" };
  if (!threadsAutoReplyAutoEnableEnabled(env)) return { enabled: false, reason: "auto_enable_off" };
  if (relay.isThreadsAutoReplyEnabled()) return { enabled: false, reason: "already_enabled" };
  const status = await assessThreadsAutoReply(customer, relay, ledger);
  if (!status.eligible) return { enabled: false, reason: status.reason ?? "not_eligible" };
  await relay.setThreadsAutoReplyEnabled(true);
  return { enabled: true };
}