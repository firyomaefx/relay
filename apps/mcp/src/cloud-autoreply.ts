import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RelayService } from "@relay/core";
import {
  assessThreadsAutoReply,
  AUTOREPLY_MIN_TOPUP_MILLI_USD,
  maybeAutoEnableThreadsAutoReply,
  type Customer,
  type CloudLedger,
} from "@relay/cloud";

export { AUTOREPLY_MIN_TOPUP_MILLI_USD };

async function status(customer: Customer, relay: RelayService, ledger: CloudLedger) {
  const assessed = await assessThreadsAutoReply(customer, relay, ledger);
  if (
    assessed.eligible &&
    !assessed.enabled &&
    assessed.paidTopupMilliUsd >= assessed.minimumTopupMilliUsd
  ) {
    return {
      ...assessed,
      reason: "Auto-reply is configured but disabled. Call action=enable.",
    };
  }
  if (assessed.paidTopupMilliUsd < assessed.minimumTopupMilliUsd) {
    return {
      ...assessed,
      reason: `Make a single top-up of at least $${(AUTOREPLY_MIN_TOPUP_MILLI_USD / 1000).toFixed(2)} before enabling auto-reply. Largest paid top-up: $${(assessed.paidTopupMilliUsd / 1000).toFixed(2)}.`,
    };
  }
  return assessed;
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
        "Manage Relay Cloud's automatic Threads replies. Auto-reply can be enabled only after a single paid top-up of at least $9.90, a valid DeepSeek API key, and a connected Threads account with threads_read_replies plus threads_manage_replies. The key is encrypted per tenant and never returned. Actions: status, set_key, clear_key, enable, disable. Replies run only inside the 30-minute window after a Threads post; spam and hostile comments are never auto-replied.",
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
          await maybeAutoEnableThreadsAutoReply(customer, relay, ledger);
          return result({ ok: true, ...(await status(customer, relay, ledger)) });
        }
        if (args.action === "clear_key") {
          await relay.setDeepSeekApiKey(null);
          await relay.setThreadsAutoReplyEnabled(false);
          return result({ ok: true, ...(await status(customer, relay, ledger)) });
        }
        if (args.action === "disable") {
          await relay.setThreadsAutoReplyEnabled(false);
          return result({ ok: true, ...(await status(customer, relay, ledger)) });
        }
        if (args.action === "enable") {
          const current = await status(customer, relay, ledger);
          if (current.paidTopupMilliUsd < current.minimumTopupMilliUsd) {
            return result({ ok: false, error: current.reason, ...current }, true);
          }
          if (!current.keyConfigured) {
            return result({ ok: false, error: current.reason, ...current }, true);
          }
          if (!current.threadsConnected || !current.threadsReady) {
            return result({ ok: false, error: current.reason, ...current }, true);
          }
          await relay.setThreadsAutoReplyEnabled(true);
          return result({ ok: true, ...(await status(customer, relay, ledger)) });
        }
        return result(await status(customer, relay, ledger));
      } catch (error) {
        return result({ ok: false, error: error instanceof Error ? error.message : String(error) }, true);
      }
    },
  );
}

