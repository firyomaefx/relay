import { RelayError } from "@relay/core";
import { issueCustomerInvite } from "./customer-invites.js";
import type { CloudStore, Customer, WaitlistEntry } from "./db.js";
import type { EmailConfig } from "./email.js";

export interface WaitlistInviteResult {
  entry: WaitlistEntry;
  customer: Customer;
  setupUrl: string;
  connectUrl: string;
  mcpUrl: string;
  emailSent: boolean;
  emailError?: string;
}

export function waitlistAutoApproveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes)$/i.test(env.RELAY_WAITLIST_AUTO_APPROVE?.trim() ?? "");
}

/** Create customer, connect token, setup invite, and mark waitlist row invited. */
export async function approveWaitlistAndInvite(
  store: CloudStore,
  email: EmailConfig | null | undefined,
  entryId: string,
  options: { waitlistLimit: number; publicBase: string; mcpBase: string },
): Promise<WaitlistInviteResult> {
  const entry = store.getWaitlist(entryId);
  if (!entry) throw new RelayError("Waitlist entry not found.", "waitlist_not_found", undefined, 404);
  if (entry.status === "rejected") throw new RelayError("Rejected entries cannot be approved.", "waitlist_rejected", undefined, 409);
  if (entry.status === "invited" || entry.status === "active") {
    throw new RelayError("This entry is already invited.", "waitlist_already_invited", undefined, 409);
  }
  const accepted = store.waitlistAcceptedCount();
  if (accepted >= options.waitlistLimit) {
    throw new RelayError(`The first batch is full (${options.waitlistLimit}).`, "waitlist_full", undefined, 409);
  }
  const customer = store.createCustomer({ displayName: entry.name, email: entry.email });
  const created = store.createConnectToken(customer.id, `Waitlist invite: ${entry.email}`);
  const invited = store.approveWaitlist(entryId, customer.id);
  const setup = await issueCustomerInvite(store, email, {
    customer: {
      id: customer.id,
      displayName: customer.displayName,
      email: customer.email,
      owner: false,
      status: customer.status,
    },
    purpose: "setup",
    publicBase: options.publicBase,
  });
  const connectUrl = `${options.publicBase}/connect?token=${encodeURIComponent(created.token)}`;
  return {
    entry: invited,
    customer,
    setupUrl: setup.url,
    connectUrl,
    mcpUrl: `${options.mcpBase}/mcp?token=${encodeURIComponent(created.token)}`,
    emailSent: setup.emailSent,
    emailError: setup.emailError,
  };
}