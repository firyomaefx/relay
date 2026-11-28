import type { CloudStore } from "./db.js";
import type { EmailConfig } from "./email.js";
import { approveWaitlistAndInvite, waitlistAutoApproveEnabled } from "./waitlist-onboarding.js";

export interface WaitlistAutoProcessResult {
  processed: number;
  errors: number;
}

/** Invite pending waitlist rows when under limit (retries failed signups, no daily admin). */
export async function processPendingWaitlistAutoApprovals(
  store: CloudStore,
  email: EmailConfig | null | undefined,
  options: {
    waitlistLimit: number;
    publicBase: string;
    mcpBase: string;
    maxPerRun?: number;
    env?: NodeJS.ProcessEnv;
  },
): Promise<WaitlistAutoProcessResult> {
  const env = options.env ?? process.env;
  if (!waitlistAutoApproveEnabled(env)) return { processed: 0, errors: 0 };
  const max = Math.min(Math.max(options.maxPerRun ?? 5, 1), 25);
  let processed = 0;
  let errors = 0;
  const accepted = store.waitlistAcceptedCount();
  if (accepted >= options.waitlistLimit) return { processed: 0, errors: 0 };

  const pending = store
    .listWaitlist()
    .filter((entry) => entry.status === "pending")
    .slice(0, max);

  for (const entry of pending) {
    if (store.waitlistAcceptedCount() >= options.waitlistLimit) break;
    try {
      await approveWaitlistAndInvite(store, email, entry.id, {
        waitlistLimit: options.waitlistLimit,
        publicBase: options.publicBase,
        mcpBase: options.mcpBase,
      });
      processed += 1;
    } catch {
      errors += 1;
    }
  }
  return { processed, errors };
}