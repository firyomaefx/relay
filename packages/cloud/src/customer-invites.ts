import type { CloudStore, Customer, CustomerInvitePurpose } from "./db.js";
import { customerPasswordResetEmail, customerSetupEmail, sendEmail, type EmailConfig } from "./email.js";
import { RESET_INVITE_TTL_MS, SETUP_INVITE_TTL_MS, createInviteToken } from "./invite-tokens.js";
import { RelayError } from "@relay/core";

export interface CustomerInviteDelivery {
  url: string;
  token: string;
  emailSent: boolean;
  emailError?: string;
}

export function invitePathForPurpose(purpose: CustomerInvitePurpose): string {
  return purpose === "setup" ? "/setup" : "/reset-password";
}

export async function issueCustomerInvite(
  store: CloudStore,
  emailConfig: EmailConfig | null | undefined,
  input: {
    customer: Pick<Customer, "id" | "displayName" | "email" | "owner" | "status">;
    purpose: CustomerInvitePurpose;
    publicBase: string;
    sendEmail?: boolean;
  },
): Promise<CustomerInviteDelivery> {
  if (input.customer.owner) {
    throw new RelayError("Owner accounts do not use customer passwords.", "cloud_owner_password", undefined, 409);
  }
  if (input.customer.status !== "active") {
    throw new RelayError("Customer is disabled.", "cloud_customer_disabled", undefined, 409);
  }
  const { token, tokenHash } = createInviteToken();
  const ttl = input.purpose === "setup" ? SETUP_INVITE_TTL_MS : RESET_INVITE_TTL_MS;
  store.createCustomerInvite(input.customer.id, tokenHash, ttl, input.purpose);
  const base = input.publicBase.replace(/\/+$/, "");
  const url = `${base}${invitePathForPurpose(input.purpose)}?token=${encodeURIComponent(token)}`;
  let emailSent = false;
  let emailError: string | undefined;
  const shouldSend = input.sendEmail !== false;
  if (shouldSend && input.customer.email) {
    const template = input.purpose === "setup"
      ? customerSetupEmail({ name: input.customer.displayName, setupUrl: url })
      : customerPasswordResetEmail({ name: input.customer.displayName, resetUrl: url });
    const emailResult = await sendEmail(emailConfig, { ...template, to: input.customer.email });
    emailSent = emailResult.sent;
    emailError = emailResult.sent ? undefined : emailResult.error ?? emailResult.skipped;
  } else if (shouldSend && !input.customer.email) {
    emailError = "customer_has_no_email";
  }
  return { url, token, emailSent, emailError };
}