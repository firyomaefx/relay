import type { Customer } from "./db.js";
import type { CloudLedger } from "./ledger.js";
import type { TenantManager } from "./tenants.js";
import { maybeAutoEnableThreadsAutoReply } from "./threads-autoreply-eligibility.js";

/** After a successful payment credit, enable Threads auto-reply when eligibility is met. */
export async function afterCustomerTopupCredit(
  customer: Customer,
  tenants: TenantManager,
  ledger: CloudLedger,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (customer.owner) return;
  try {
    const relay = await tenants.get(customer);
    await maybeAutoEnableThreadsAutoReply(customer, relay, ledger, env);
  } catch {
    // Best effort: billing must not fail if tenant data is broken.
  }
}