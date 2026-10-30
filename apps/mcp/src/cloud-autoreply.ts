import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RelayService } from "@relay/core";
import type { CloudLedger, Customer } from "@relay/cloud";

/** Minimum lifetime paid top-up before Cloud auto-reply can be enabled. */
export const AUTOREPLY_MIN_TOPUP_MILLI_USD = 10000;

interface AutoReplyStatus {
  eligible: boolean;
  active: boolean;
  minimumTopupMilliUsd: number;
  paidTopupMilliUsd: number;
  keyConfigured: boolean;
  enabled: boolean;
  reason: string | null;
}

function status(customer: Customer, relay: RelayService, ledger: CloudLedger): AutoReplyStatus {
  const paidTopupMilliUsd = ledger.totalTopups(customer.id);
  const keyConfigured = Boolean(relay.getDeepSeekApiKey());
  const enabled = relay.isThreadsAutoReplyEnabled();
  const eligible = paidTopupMilliUsd >= AUTOREPLY_MIN_TOPUP_MILLI_USD && keyConfigured;
  let reason: string | null = null;
  if (paidTopupMilliUsd < AUTOREPLY_MIN_TOPUP_MILLI_USD) {
    reason = `Top up at least $${(AUTOREPLY_MIN_TOPUP_MILLI_USD / 1000).toFixed(2)} in paid credit before enabling auto-reply. Paid top-ups: $${(paidTopupMilliUsd / 1000).toFixed(2)}.`;
  } else if (!keyConfigured) {
    reason = "Add your DeepSeek API key before enabling auto-reply.";
  } else if (!enabled) {
    reason = "Auto-reply is configured but disabled. Call action=enable.";
  }
  return {
    eligible,
    active: eligible && enabled,
    minimumTopupMilliUsd: AUTOREPLY_MIN_TOPUP_MILLI_USD,
    paidTopupMilliUsd,
    keyConfigured,
    enabled,
    reason,
  };
}

function result(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/** Cloud-only auto-reply controls: status, DeepSeek key and gated on/off. */
export function registerCloudAutoReplyTool(
  server: McpServer,
  options: { customer: Customer; relay: RelayService; ledger: CloudLedger },
): void {
  const { customer, relay, ledger } = options;
  server.registerTool(
    "relay_cloud_autoreply",
    {
      title: "Cloud Threads auto-reply",
      description:
        "Manage Relay Cloud's automatic Threads replies. Auto-reply can be enabled only after at least $10.00 in lifetime paid top-ups and a valid DeepSeek API key. The key is encrypted per tenant and never returned. Actions: status, set_key, clear_key, enable, disable. Replies run only inside the 30-minute window after a Threads post; spam and hostile comments are never auto-replied.",
      inputSchema: z.object({
        action: z.enum(["status", "set_key", "clear_key", "enable", "disable"]),
        api_key: z.string().min(10).max(500).optional().describe("DeepSeek API key. Required for set_key; never returned."),
      }),
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        if (args.action === "set_key") {
          if (!args.api_key?.trim()) {
            return result({ ok: false, error: "api_key is required for set_key." }, true);
          }
          await relay.setDeepSeekApiKey(args.api_key.trim());
          return result({ ok: true, ...status(customer, relay, ledger) });
        }
        if (args.action === "clear_key") {
          await relay.setDeepSeekApiKey(null);
          await relay.setThreadsAutoReplyEnabled(false);
          return result({ ok: true, ...status(customer, relay, ledger) });
        }
        if (args.action === "disable") {
          const enabled = await relay.setThreadsAutoReplyEnabled(false);
          return result({ ok: true, ...status(customer, relay, ledger) });
        }
        if (args.action === "enable") {
          const current = status(customer, relay, ledger);
          if (current.paidTopupMilliUsd < current.minimumTopupMilliUsd) {
            return result({ ok: false, error: current.reason, ...current }, true);
          }
          if (!current.keyConfigured) {
            return result({ ok: false, error: current.reason, ...current }, true);
          }
          const enabled = await relay.setThreadsAutoReplyEnabled(true);
          return result({ ok: true, ...status(customer, relay, ledger) });
        }
        return result(status(customer, relay, ledger));
      } catch (error) {
        return result({ ok: false, error: error instanceof Error ? error.message : String(error) }, true);
      }
    },
  );
}

