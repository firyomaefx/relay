/**
 * Owner-only waitlist controls for the Relay Cloud MCP server.
 *
 * These tools are registered only when the authenticated customer is the
 * installation owner. A customer API key or ordinary connect token can never
 * list, approve or reject waitlist requests.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CloudStore,
  issueCustomerInvite,
  loadEmailConfig,
  sendEmail,
  waitlistInviteEmail,
  type Customer,
} from "@relay/cloud";
import { RelayError } from "@relay/core";

function waitlistLimit(): number {
  const parsed = Number(process.env.RELAY_WAITLIST_LIMIT ?? "100");
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 100;
}

function publicBase(): string {
  return (process.env.RELAY_PUBLIC_URL?.trim() || "https://relay.duitpoket.fun").replace(/\/+$/, "");
}

function mcpBase(): string {
  return process.env.RELAY_CLOUD_PUBLIC_MCP_URL?.trim() || "https://cloud-mcp.duitpoket.fun/mcp";
}

function json(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export function registerOwnerWaitlistTools(
  server: McpServer,
  deps: { store: CloudStore; customer: Customer },
): void {
  if (!deps.customer.owner) return;

  server.registerTool(
    "relay_waitlist_list",
    {
      title: "List waitlist requests (owner)",
      description: "Owner only: list waitlist requests, optionally filtered by pending, invited, active or rejected.",
      inputSchema: z.object({
        status: z.enum(["pending", "invited", "active", "rejected"]).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const entries = deps.store.listWaitlist(args.status);
      return json({
        entries,
        counts: deps.store.waitlistStatusCounts(),
        accepted: deps.store.waitlistAcceptedCount(),
        limit: waitlistLimit(),
      });
    },
  );

  server.registerTool(
    "relay_waitlist_approve",
    {
      title: "Approve waitlist request (owner)",
      description:
        "Owner only: approve a pending waitlist request. Creates the customer, creates a private connect token, sends the invite email when configured, and returns the private connect URL.",
      inputSchema: z.object({ id: z.string().min(1).describe("Waitlist entry id, for example wl_...") }),
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      const entry = deps.store.getWaitlist(args.id);
      if (!entry) throw new RelayError("Waitlist entry not found.", "waitlist_not_found", undefined, 404);
      if (entry.status === "rejected") throw new RelayError("Rejected entries cannot be approved.", "waitlist_rejected", undefined, 409);
      if (entry.status === "invited" || entry.status === "active") {
        throw new RelayError("This entry is already invited.", "waitlist_already_invited", undefined, 409);
      }
      const accepted = deps.store.waitlistAcceptedCount();
      const limit = waitlistLimit();
      if (accepted >= limit) {
        throw new RelayError(`The first batch is full (${limit}). Raise RELAY_WAITLIST_LIMIT to approve more.`, "waitlist_full", undefined, 409);
      }
      const customer = deps.store.createCustomer({ displayName: entry.name, email: entry.email });
      const created = deps.store.createConnectToken(customer.id, `Waitlist invite: ${entry.email}`);
      const invited = deps.store.approveWaitlist(entry.id, customer.id);
      const connectUrl = `${publicBase()}/connect?token=${encodeURIComponent(created.token)}`;
      const emailConfig = loadEmailConfig(process.env);
      const setup = await issueCustomerInvite(deps.store, emailConfig, {
        customer,
        purpose: "setup",
        publicBase: publicBase(),
      });
      const emailResult = setup.emailSent
        ? { sent: true as const }
        : await sendEmail(emailConfig, {
            ...waitlistInviteEmail({ name: entry.name, connectUrl }),
            to: entry.email,
          });
      return json({
        ok: true,
        entry: invited,
        customer: { id: customer.id, displayName: customer.displayName },
        connectUrl,
        setupUrl: setup.url,
        mcpUrl: `${mcpBase()}?token=${encodeURIComponent(created.token)}`,
        emailSent: setup.emailSent || emailResult.sent,
        emailError: setup.emailSent
          ? undefined
          : setup.emailError ?? (emailResult.sent ? undefined : emailResult.error),
      });
    },
  );

  server.registerTool(
    "relay_waitlist_reject",
    {
      title: "Reject waitlist request (owner)",
      description: "Owner only: reject a pending waitlist request with an optional internal note.",
      inputSchema: z.object({
        id: z.string().min(1),
        note: z.string().max(500).optional(),
      }),
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async (args) => {
      const entry = deps.store.getWaitlist(args.id);
      if (!entry) throw new RelayError("Waitlist entry not found.", "waitlist_not_found", undefined, 404);
      return json({ ok: true, entry: deps.store.rejectWaitlist(args.id, args.note ?? "") });
    },
  );
}
