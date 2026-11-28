import type { CloudStore, Customer } from "./db.js";
import { customerWelcomeEmail, sendEmail, type EmailConfig } from "./email.js";
import type { TenantManager } from "./tenants.js";

export interface CustomerOnboardingBootstrapResult {
  emailSeeded: boolean;
  schedulerStarted: boolean;
  connectUrl?: string;
  welcomeSent: boolean;
}

/** After password setup: seed email library, start scheduler, ensure MCP connect link, optional welcome. */
export async function bootstrapCustomerAfterSetup(
  customer: Customer,
  tenants: TenantManager,
  store: CloudStore,
  emailConfig: EmailConfig | null | undefined,
  options: { publicBase: string; sendWelcome?: boolean },
): Promise<CustomerOnboardingBootstrapResult> {
  const publicBase = options.publicBase.replace(/\/+$/, "");
  let emailSeeded = false;
  let schedulerStarted = false;
  let connectUrl: string | undefined;
  let welcomeSent = false;

  const relay = await tenants.get(customer);
  const seeded = await relay.ensureOnboardingEmailDefaults();
  emailSeeded = seeded.seeded;
  const scheduler = await relay.startScheduler();
  schedulerStarted = scheduler.running;
  void relay.ensureBrevoEmailAutomation().catch(() => undefined);

  for (const existing of store.listConnectTokens(customer.id)) {
    if (existing.status === "active") store.revokeConnectToken(existing.id);
  }
  const created = store.createConnectToken(customer.id, `Post-setup MCP ${customer.displayName}`);
  connectUrl = `${publicBase}/connect?token=${encodeURIComponent(created.token)}`;

  if (options.sendWelcome !== false && customer.email && emailConfig) {
    const result = await sendEmail(emailConfig, {
      ...customerWelcomeEmail({
        name: customer.displayName,
        consoleUrl: publicBase,
        connectUrl,
        topupUrl: `${publicBase}/topup`,
      }),
      to: customer.email,
    });
    welcomeSent = result.sent;
  }

  return { emailSeeded, schedulerStarted, connectUrl, welcomeSent };
}