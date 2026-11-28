import type { IncomingMessage, ServerResponse } from "node:http";
import { RelayError, errorMessage } from "@relay/core";
import {
  CloudLedger,
  CloudStore,
  PriceTable,
  defaultPricePath,
  effectiveFreeLimit,
  loadCloudConfig,
  probePlatformDeployHealth,
  summarizeAutomationHealth,
  type TenantManager,
} from "@relay/cloud";
import { createCheckoutSession, loadStripeConfig, type StripeBillingConfig } from "./billing.js";
import { createPolarCheckout, loadPolarConfig, type PolarConfig } from "./polar.js";
import {
  issueCustomerInvite,
  approveWaitlistAndInvite,
  loadEmailConfig,
  afterCustomerTopupCredit,
  type EmailConfig,
} from "@relay/cloud";

export interface CloudAdminDeps {
  store: CloudStore;
  ledger: CloudLedger;
  config: ReturnType<typeof loadCloudConfig>;
  pricing?: PriceTable;
  billing?: StripeBillingConfig;
  polar?: PolarConfig;
  email?: EmailConfig;
  tenants?: TenantManager;
  close(): Promise<void>;
}

function waitlistLimit(): number {
  const parsed = Number(process.env.RELAY_WAITLIST_LIMIT ?? "100");
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 100;
}

export function openCloudAdmin(env: NodeJS.ProcessEnv): CloudAdminDeps | null {
  const config = loadCloudConfig(env);
  if (!config.enabled) return null;
  const store = CloudStore.open(config.dbPath);
  const ledger = new CloudLedger(config.dbPath);
  let pricing: PriceTable | undefined;
  try {
    pricing = PriceTable.load(defaultPricePath(env));
  } catch {
    pricing = undefined;
  }
  return {
    store,
    ledger,
    config,
    pricing,
    billing: loadStripeConfig(env) ?? undefined,
    polar: loadPolarConfig(env) ?? undefined,
    email: loadEmailConfig(env) ?? undefined,
    close: async () => {
      ledger.close();
      store.close();
    },
  };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(text));
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as Buffer);
    size += buffer.length;
    if (size > 1024 * 1024) throw new RelayError("Body too large.", "cloud_body_too_large", undefined, 413);
    chunks.push(buffer);
  }
  if (size === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RelayError("JSON object required.", "cloud_body_invalid", undefined, 400);
  }
  return parsed as Record<string, unknown>;
}

function publicBaseUrl(): string {
  return (process.env.RELAY_PUBLIC_URL?.trim() || "https://relay.duitpoket.fun").replace(/\/+$/, "");
}

async function createCustomerSetupInvite(
  deps: CloudAdminDeps,
  customer: { id: string; displayName: string; email: string; owner?: boolean; status?: string },
): Promise<{ url: string; emailSent: boolean; emailError?: string }> {
  const delivery = await issueCustomerInvite(deps.store, deps.email, {
    customer: {
      id: customer.id,
      displayName: customer.displayName,
      email: customer.email,
      owner: Boolean(customer.owner),
      status: (customer.status as "active" | "disabled") ?? "active",
    },
    purpose: "setup",
    publicBase: publicBaseUrl(),
  });
  return { url: delivery.url, emailSent: delivery.emailSent, emailError: delivery.emailError };
}

async function createCustomerPasswordResetInvite(
  deps: CloudAdminDeps,
  customerId: string,
): Promise<{ url: string; emailSent: boolean; emailError?: string }> {
  const customer = deps.store.getCustomer(customerId);
  if (!customer) throw new RelayError("Customer not found.", "cloud_customer_not_found", undefined, 404);
  if (!customer.email) {
    throw new RelayError("This customer has no email. Add an email before sending a reset link.", "cloud_email_required", undefined, 409);
  }
  const delivery = await issueCustomerInvite(deps.store, deps.email, {
    customer,
    purpose: "reset",
    publicBase: publicBaseUrl(),
  });
  return { url: delivery.url, emailSent: delivery.emailSent, emailError: delivery.emailError };
}

/** Admin-only manual top-up interface. Existing console session already guards these routes. */
export async function handleCloudAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  url: URL,
  deps: CloudAdminDeps | undefined,
): Promise<void> {
  if (!deps) {
    send(res, 404, { error: "Cloud mode is disabled." });
    return;
  }
  const method = (req.method ?? "GET").toUpperCase();
  const resource = segments[3] ?? "";
  try {
    if (method === "GET" && resource === "deploy-health") {
      const probe = await probePlatformDeployHealth(process.env);
      send(res, 200, probe);
      return;
    }

    if (method === "GET" && resource === "automation-health") {
      if (!deps.tenants) {
        send(res, 503, { error: "Tenant manager is not available." });
        return;
      }
      const summary = await summarizeAutomationHealth(deps.store, deps.ledger, deps.tenants);
      send(res, 200, {
        tenantSchedulerPulseMs: summary.tenantSchedulerPulseMs,
        issueCount: summary.issueCount,
        customers: summary.customers,
      });
      return;
    }

    if (method === "GET" && resource === "revenue-summary") {
      const since = url.searchParams.get("since")?.trim()
        || process.env.RELAY_REVENUE_GOAL_SINCE?.trim()
        || "2026-01-01T00:00:00.000Z";
      const goalMyr = Number(process.env.RELAY_REVENUE_GOAL_MYR ?? "4000");
      const goalDeadline = process.env.RELAY_REVENUE_GOAL_DEADLINE?.trim() || "2026-12-31";
      const rate = deps.pricing?.list().usd_myr_rate ?? null;
      const currency = deps.pricing?.list().display_currency ?? "MYR";
      const revenue = deps.ledger.operatorPaymentRevenue({ since });
      const estimatedMyr = rate && rate > 0 ? (revenue.totalMilliUsd / 1000) * rate : null;
      send(res, 200, {
        since: revenue.since ?? since,
        goal: { amountMyr: goalMyr, deadline: goalDeadline, currency },
        succeededCount: revenue.succeededCount,
        totalMilliUsd: revenue.totalMilliUsd,
        estimatedMyr,
        usdMyrRate: rate,
        progressPercent: estimatedMyr != null && goalMyr > 0 ? Math.min(100, (estimatedMyr / goalMyr) * 100) : null,
      });
      return;
    }

    if (method === "GET" && resource === "billing") {
      const owner = deps.store.ensureOwnerCustomer("Owner");
      const baseFreeLimit = deps.pricing?.list().free_allowance_milli_usd ?? 0;
      const freeLimit = effectiveFreeLimit(deps.ledger, owner, baseFreeLimit);
      const freeCredit = freeLimit > 0
        ? { limit: freeLimit, remaining: deps.ledger.freeRemaining(owner.id, freeLimit), currency: "USD" }
        : null;
      const balance = deps.ledger.balanceWithHold(owner.id);
      send(res, 200, {
        customer: { id: owner.id, displayName: owner.displayName },
        balance,
        freeCredit,
        totalAvailable: balance.available + (freeCredit?.remaining ?? 0),
        payments: deps.ledger.listPayments(owner.id, 20),
        providers: {
          stripe: Boolean(deps.billing),
          polar: Boolean(deps.polar),
        },
        polarAmounts: Object.keys(deps.polar?.products ?? {}).map(Number).sort((a, b) => a - b),
        stripeAmounts: deps.billing?.webhookSecret ? [990, 2490, 4990] : [],
      });
      return;
    }

    if (method === "GET" && resource === "me") {
      const owner = deps.store.ensureOwnerCustomer("Owner");
      const baseFreeLimit = deps.pricing?.list().free_allowance_milli_usd ?? 0;
      const freeLimit = effectiveFreeLimit(deps.ledger, owner, baseFreeLimit);
      send(res, 200, {
        customer: { id: owner.id, displayName: owner.displayName },
        balance: deps.ledger.balanceWithHold(owner.id),
        freeCredit: freeLimit > 0
          ? { limit: freeLimit, remaining: deps.ledger.freeRemaining(owner.id, freeLimit), currency: "USD" }
          : null,
      });
      return;
    }

    if (method === "POST" && resource === "customers" && segments[4] && segments[5] === "password-reset") {
      const customerId = segments[4];
      if (!deps.store.getCustomer(customerId)) throw new RelayError("Customer not found.", "cloud_customer_not_found", undefined, 404);
      const reset = await createCustomerPasswordResetInvite(deps, customerId);
      send(res, 201, {
        ok: true,
        customerId,
        setupUrl: reset.url,
        resetUrl: reset.url,
        emailSent: reset.emailSent,
        emailError: reset.emailSent ? undefined : reset.emailError,
      });
      return;
    }

    if (method === "GET" && resource === "customers" && segments[4]) {
      const customer = deps.store.getCustomer(segments[4]);
      if (!customer) throw new RelayError("Customer not found.", "cloud_customer_not_found", undefined, 404);
      const auth = deps.store.getCustomerAuthById(customer.id);
      send(res, 200, {
        customer: { ...customer, ...deps.ledger.balanceWithHold(customer.id) },
        hasPassword: Boolean(auth?.passwordHash),
        accounts: deps.store.listCustomerAccounts(customer.id),
        payments: deps.ledger.listPayments(customer.id, 20),
        usage: deps.ledger.entries(customer.id, 20),
      });
      return;
    }

    if (method === "GET" && resource === "customers") {
      const customers = deps.store.listCustomers().map((customer) => ({
        ...customer,
        ...deps.ledger.balanceWithHold(customer.id),
      }));
      send(res, 200, { customers });
      return;
    }

    if (method === "GET" && resource === "payments") {
      const customerId = url.searchParams.get("customer") ?? "";
      if (!customerId) throw new RelayError("Customer is required.", "cloud_customer_required", undefined, 400);
      const payments = deps.ledger.listPayments(customerId, Number(url.searchParams.get("limit") ?? "20"));
      send(res, 200, { customerId, payments });
      return;
    }

    if (method === "GET" && resource === "waitlist") {
      const status = url.searchParams.get("status")?.trim() || undefined;
      const allowed = status && ["pending", "invited", "active", "rejected"].includes(status) ? status : undefined;
      send(res, 200, {
        entries: deps.store.listWaitlist(allowed),
        counts: deps.store.waitlistStatusCounts(),
        accepted: deps.store.waitlistAcceptedCount(),
        limit: waitlistLimit(),
      });
      return;
    }

    if (method === "POST" && resource === "waitlist" && segments[4] && segments[5]) {
      const id = segments[4];
      const action = segments[5];
      const entry = deps.store.getWaitlist(id);
      if (!entry) throw new RelayError("Waitlist entry not found.", "waitlist_not_found", undefined, 404);
      if (action === "reject") {
        const body = await readJson(req);
        const rejected = deps.store.rejectWaitlist(id, String(body.note ?? ""));
        send(res, 200, { ok: true, entry: rejected });
        return;
      }
      if (action === "invite") {
        if (entry.status === "rejected" || entry.status === "pending") {
          throw new RelayError("Approve this entry before creating an invite.", "waitlist_not_invited", undefined, 409);
        }
        if (!entry.customerId) {
          throw new RelayError("This entry has no customer yet.", "waitlist_customer_missing", undefined, 409);
        }
        const customer = deps.store.getCustomer(entry.customerId);
        if (!customer) throw new RelayError("This entry has no customer yet.", "waitlist_customer_missing", undefined, 409);
        if (!customer.email && entry.email) deps.store.updateCustomerProfile(customer.id, { email: entry.email });
        const setup = await createCustomerSetupInvite(deps, deps.store.getCustomer(customer.id) ?? customer);
        send(res, 201, {
          ok: true,
          entry,
          setupUrl: setup.url,
          emailSent: setup.emailSent,
          emailError: setup.emailSent ? undefined : setup.emailError,
        });
        return;
      }
      if (action !== "approve") throw new RelayError("Unknown waitlist action.", "waitlist_action_invalid", undefined, 400);
      if (entry.status === "rejected") throw new RelayError("Rejected entries cannot be approved.", "waitlist_rejected", undefined, 409);
      if (entry.status === "invited" || entry.status === "active") {
        throw new RelayError("This entry is already invited. Create a new invite link instead.", "waitlist_already_invited", undefined, 409);
      }
      const limit = waitlistLimit();
      const publicBase = (process.env.RELAY_PUBLIC_URL?.trim() || "https://relay.duitpoket.fun").replace(/\/+$/, "");
      const mcpBase = process.env.RELAY_CLOUD_PUBLIC_MCP_URL?.trim() || "https://cloud-mcp.duitpoket.fun";
      const invited = await approveWaitlistAndInvite(deps.store, deps.email, id, {
        waitlistLimit: limit,
        publicBase,
        mcpBase,
      });
      send(res, 201, {
        ok: true,
        entry: invited.entry,
        customer: { id: invited.customer.id, displayName: invited.customer.displayName },
        setupUrl: invited.setupUrl,
        connectUrl: invited.connectUrl,
        mcpUrl: invited.mcpUrl,
        emailSent: invited.emailSent,
        emailError: invited.emailSent ? undefined : invited.emailError,
      });
      return;
    }

    if (method === "POST" && resource === "connect-token") {
      const body = await readJson(req);
      const customerId = String(body.customerId ?? "").trim();
      const created = deps.store.createConnectToken(customerId, String(body.label ?? "MCP connection"));
      const mcpBase = process.env.RELAY_CLOUD_PUBLIC_MCP_URL?.trim() || "https://cloud-mcp.duitpoket.fun/mcp";
      send(res, 201, {
        token: { id: created.id, prefix: created.prefix, label: created.label, createdAt: created.createdAt },
        url: `${mcpBase}?token=${encodeURIComponent(created.token)}`,
        connectUrl: `https://relay.duitpoket.fun/connect?token=${encodeURIComponent(created.token)}`,
      });
      return;
    }

    if (method === "POST" && resource === "checkout") {
      if (!deps.billing) throw new RelayError("Card payments are not configured yet.", "stripe_unavailable", undefined, 503);
      const body = await readJson(req);
      const customerId = String(body.customerId ?? "").trim();
      const amount = Number(body.amount);
      if (!deps.store.getCustomer(customerId)) throw new RelayError("Customer not found.", "cloud_customer_not_found", undefined, 404);
      try {
        const session = await createCheckoutSession(deps.billing, { customerId, amount, baseUrl: process.env.RELAY_PUBLIC_URL?.trim() || "https://relay.duitpoket.fun" });
        send(res, 200, { url: session.url, id: session.id });
      } catch (error) {
        throw new RelayError(errorMessage(error), "stripe_checkout_failed", undefined, 502);
      }
      return;
    }

    if (method === "POST" && resource === "polar-checkout") {
      if (!deps.polar) throw new RelayError("Polar payments are not configured yet.", "polar_unavailable", undefined, 503);
      const body = await readJson(req);
      const customerId = String(body.customerId ?? "").trim();
      if (!deps.store.getCustomer(customerId)) throw new RelayError("Customer not found.", "cloud_customer_not_found", undefined, 404);
      try {
        const session = await createPolarCheckout(deps.polar, { customerId });
        send(res, 200, { url: session.url, id: session.id });
      } catch (error) {
        throw new RelayError(errorMessage(error), "polar_checkout_failed", undefined, 502);
      }
      return;
    }

    if (method === "POST" && resource === "topup") {
      const body = await readJson(req);
      const customerId = String(body.customerId ?? "").trim();
      const amount = Number(body.amount);
      const reference = String(body.reference ?? "").trim();
      const note = String(body.note ?? "").trim();
      const customer = deps.store.getCustomer(customerId);
      if (!customer) throw new RelayError("Customer not found.", "cloud_customer_not_found", undefined, 404);
      const result = deps.ledger.recordTopup({
        customerId,
        amount,
        reference,
        note,
        currency: "MYR",
        provider: "manual",
      });
      if (!result.paymentReplayed && deps.tenants) {
        void afterCustomerTopupCredit(customer, deps.tenants, deps.ledger).catch(() => undefined);
      }
      send(res, 200, {
        ...result,
        balance: deps.ledger.balanceWithHold(customerId),
        customer: { id: customer.id, displayName: customer.displayName },
      });
      return;
    }

    send(res, 404, { error: "Cloud admin route not found." });
  } catch (error) {
    const status = error instanceof RelayError ? error.statusCode : 500;
    send(res, status, { error: errorMessage(error), code: error instanceof RelayError ? error.code : "cloud_admin_error" });
  }
}




