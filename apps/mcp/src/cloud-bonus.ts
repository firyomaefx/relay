/**
 * Owner-only bonus credit tools for the Relay Cloud MCP server.
 *
 * Registered only when the authenticated customer is the installation owner,
 * the same gate as the owner waitlist tools. A customer API key or ordinary
 * connect token never sees them. Bonus credit is written to the append-only
 * ledger as type "bonus". It is not a payment, so it never counts toward
 * top-up unlocks or account tiers, and it never touches Stripe.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CloudLedger, CloudStore, Customer } from "@relay/cloud";
import { RelayError } from "@relay/core";

/** Largest single grant, in US dollars. */
export const BONUS_MAX_USD = 100;

function json(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function usd(milli: number): number {
  return Math.round(milli) / 1000;
}

function toMilliUsd(amountUsd: number): number {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new RelayError("amount_usd must be a positive number.", "cloud_amount_invalid");
  }
  if (amountUsd > BONUS_MAX_USD) {
    throw new RelayError(`amount_usd is capped at ${BONUS_MAX_USD} per grant.`, "cloud_bonus_over_cap");
  }
  const milli = Math.round(amountUsd * 1000);
  if (Math.abs(amountUsd * 1000 - milli) > 1e-6 || milli < 1) {
    throw new RelayError("amount_usd can have at most 3 decimal places.", "cloud_amount_invalid");
  }
  return milli;
}

function parseDate(value: string | undefined, label: string, endOfDay: boolean): string | undefined {
  if (!value) return undefined;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = new Date(dateOnly ? `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z` : value);
  if (Number.isNaN(parsed.getTime())) throw new RelayError(`${label} is not a valid date.`, "cloud_bonus_bad_date");
  return parsed.toISOString();
}

export interface BonusDeps {
  store: CloudStore;
  ledger: CloudLedger;
}

export function grantBonusCredit(
  deps: BonusDeps,
  args: { customer_id: string; amount_usd: number; reason: string; idempotency_key?: string },
) {
  const customer = deps.store.getCustomer(args.customer_id);
  if (!customer) throw new RelayError("Unknown customer.", "cloud_customer_not_found", undefined, 404);
  const milli = toMilliUsd(args.amount_usd);
  const reason = args.reason.trim();
  if (!reason) throw new RelayError("A reason is required for a bonus grant.", "cloud_bonus_reason_required");
  const { entry, replayed } = deps.ledger.grantBonus({
    customerId: customer.id,
    amount: milli,
    reason,
    idempotencyKey: args.idempotency_key,
  });
  const balance = deps.ledger.balanceWithHold(customer.id);
  return {
    ok: true,
    replayed,
    entry_id: entry.id,
    entry: { id: entry.id, type: entry.type, customer_id: entry.customerId, amount_usd: usd(entry.amount), reason: entry.reason, created_at: entry.createdAt },
    customer: { id: customer.id, displayName: customer.displayName },
    balance_usd: usd(balance.balance),
    available_usd: usd(balance.available),
    held_usd: usd(balance.held),
    note: "Bonus credit is a ledger entry of type bonus. It is not a payment and does not count toward top-up unlocks.",
  };
}

export function listBonusGrants(
  deps: BonusDeps,
  args: { customer_id?: string; from?: string; to?: string; reason_contains?: string; limit?: number },
) {
  const result = deps.ledger.listBonusGrants({
    customerId: args.customer_id,
    from: parseDate(args.from, "from", false),
    to: parseDate(args.to, "to", true),
    reasonContains: args.reason_contains?.trim() || undefined,
    limit: args.limit,
  });
  const names = new Map<string, string>();
  for (const entry of result.entries) {
    if (!names.has(entry.customerId)) names.set(entry.customerId, deps.store.getCustomer(entry.customerId)?.displayName ?? "(deleted)");
  }
  const customers = new Set(result.entries.map((entry) => entry.customerId));
  return {
    count: result.count,
    total_usd: usd(result.totalAmount),
    shown: result.entries.length,
    grants: result.entries.map((entry) => ({
      entry_id: entry.id,
      customer_id: entry.customerId,
      customer: names.get(entry.customerId),
      amount_usd: usd(entry.amount),
      reason: entry.reason,
      created_at: entry.createdAt,
    })),
    distinct_customers_shown: customers.size,
  };
}

export function registerOwnerBonusTools(server: McpServer, deps: BonusDeps & { customer: Customer }): void {
  if (!deps.customer.owner) return;

  server.registerTool(
    "relay_grant_bonus_credit",
    {
      description:
        `Owner only: add bonus credit to a customer as an append-only ledger entry of type bonus (not a payment, no Stripe, never counts toward top-up unlocks). Amount is in US dollars, capped at ${BONUS_MAX_USD} per grant. A reason is required. Pass idempotency_key to make retries safe.`,
      inputSchema: z.object({
        customer_id: z.string().min(1).describe("Relay Cloud customer id, for example cus_..."),
        amount_usd: z.number().positive().max(BONUS_MAX_USD).describe("Bonus in US dollars, for example 5 or 25"),
        reason: z.string().min(1).max(500).describe("Why the credit is granted, for example 'founding deal: 9.90 top-up'"),
        idempotency_key: z.string().min(1).max(120).optional().describe("Same key twice returns the first entry instead of adding credit again"),
      }),
    },
    async (args) => json(grantBonusCredit(deps, args)),
  );

  server.registerTool(
    "relay_list_bonus_grants",
    {
      description:
        "Owner only: list bonus credit grants with customer, amount, reason, time and entry id. Returns count and total across all matches, so founding spots can be counted. Optional filters: customer_id, from/to (YYYY-MM-DD or ISO time), reason_contains.",
      inputSchema: z.object({
        customer_id: z.string().min(1).optional(),
        from: z.string().min(1).optional().describe("Start date, inclusive (YYYY-MM-DD or ISO time)"),
        to: z.string().min(1).optional().describe("End date, inclusive (YYYY-MM-DD or ISO time)"),
        reason_contains: z.string().min(1).max(200).optional().describe("Case-insensitive text the reason must contain"),
        limit: z.number().int().min(1).max(500).optional().describe("Max grants shown, default 100. Count and total always cover all matches."),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => json(listBonusGrants(deps, args)),
  );
}
