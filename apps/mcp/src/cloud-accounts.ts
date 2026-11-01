import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Account, PlatformId, RelayService } from "@relay/core";
import { PLATFORM_IDS } from "@relay/core";
import type { CloudLedger, Customer } from "@relay/cloud";

export const ACCOUNT_TIERS = [
  { id: "starter", minimumTopupMilliUsd: 10_000, perPlatform: 3 },
  { id: "scale", minimumTopupMilliUsd: 50_000, perPlatform: 10 },
] as const;

export interface AccountTier {
  id: "locked" | "starter" | "scale";
  minimumTopupMilliUsd: number;
  perPlatform: number;
  nextTierMilliUsd: number | null;
}

export function accountTierFor(lifetimePaidMilliUsd: number): AccountTier {
  if (lifetimePaidMilliUsd >= 50_000) {
    return { id: "scale", minimumTopupMilliUsd: 50_000, perPlatform: 10, nextTierMilliUsd: null };
  }
  if (lifetimePaidMilliUsd >= 10_000) {
    return { id: "starter", minimumTopupMilliUsd: 10_000, perPlatform: 3, nextTierMilliUsd: 50_000 };
  }
  return { id: "locked", minimumTopupMilliUsd: 10_000, perPlatform: 0, nextTierMilliUsd: 10_000 };
}

export async function accountSummary(customer: Customer, relay: RelayService, ledger: CloudLedger) {
  const lifetimePaidMilliUsd = ledger.totalTopups(customer.id);
  const tier = accountTierFor(lifetimePaidMilliUsd);
  const accounts = await relay.accounts();
  const platforms = Object.fromEntries(
    PLATFORM_IDS.map((platform) => {
      const used = accounts.filter((account) => account.platform === platform).length;
      return [platform, { used, limit: tier.perPlatform, remaining: Math.max(0, tier.perPlatform - used) }];
    }),
  ) as Record<PlatformId, { used: number; limit: number; remaining: number }>;
  return { tier, lifetimePaidMilliUsd, accounts, platforms };
}

function result(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/** Prepare an account slot before OAuth. Returns the id to pass to beginConnect. */
export async function prepareAccountConnect(
  customer: Customer,
  relay: RelayService,
  ledger: CloudLedger,
  platform: PlatformId,
  options: { accountId?: string; label?: string },
): Promise<{ accountId: string }> {
  const summary = await accountSummary(customer, relay, ledger);
  const existing = options.accountId
    ? summary.accounts.find((account) => account.id === options.accountId)
    : undefined;
  if (existing) return { accountId: existing.id };
  const existingCount = summary.accounts.filter((account) => account.platform === platform).length;
  // The first account per platform is the backward-compatible baseline.
  // Additional slots are gated by the paid-top-up tier.
  if (existingCount === 0) return { accountId: options.accountId ?? `acct_${randomUUID()}` };
  if (summary.tier.perPlatform === 0) {
    throw new Error(
      `Top up at least $10.00 in paid credit to add another ${platform} account. Paid top-ups: $${(summary.lifetimePaidMilliUsd / 1000).toFixed(2)}.`,
    );
  }
  if (summary.platforms[platform].remaining <= 0) {
    throw new Error(
      `${platform} account limit reached (${summary.platforms[platform].used}/${summary.tier.perPlatform}). ` +
        `${summary.tier.nextTierMilliUsd ? `Top up to $${(summary.tier.nextTierMilliUsd / 1000).toFixed(2)} lifetime for ${accountTierFor(summary.tier.nextTierMilliUsd).perPlatform} per platform.` : "Disconnect an account first."}`,
    );
  }
  return { accountId: options.accountId ?? `acct_${randomUUID()}` };
}

export function registerCloudAccountsTool(
  server: McpServer,
  options: { customer: Customer; relay: RelayService; ledger: CloudLedger },
): void {
  const { customer, relay, ledger } = options;
  server.registerTool(
    "relay_cloud_accounts",
    {
      title: "Cloud account slots and limits",
      description:
        "Show or claim per-platform account slots. A one-time $10 lifetime paid top-up unlocks 3 accounts per platform; $50 unlocks 10 per platform. Free starter credit and free promotional credit do not count. Actions: status, claim.",
      inputSchema: z.object({
        action: z.enum(["status", "claim"]),
        platform: z.enum(["x", "threads", "tiktok", "youtube", "instagram", "linkedin"]).optional(),
        label: z.string().min(1).max(60).optional(),
      }),
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const summary = await accountSummary(customer, relay, ledger);
        if (args.action === "claim") {
          if (!args.platform) return result({ ok: false, error: "platform is required for claim." }, true);
          const claimed = await prepareAccountConnect(customer, relay, ledger, args.platform, { label: args.label });
          return result({ ok: true, accountId: claimed.accountId, label: args.label ?? `${args.platform} account`, ...summary });
        }
        return result(summary);
      } catch (error) {
        return result({ ok: false, error: error instanceof Error ? error.message : String(error) }, true);
      }
    },
  );
}


