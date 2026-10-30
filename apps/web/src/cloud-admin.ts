import type { IncomingMessage, ServerResponse } from "node:http";
import { RelayError, errorMessage } from "@relay/core";
import { CloudLedger, CloudStore, PriceTable, defaultPricePath, loadCloudConfig } from "@relay/cloud";
import { createCheckoutSession, loadStripeConfig, type StripeBillingConfig } from "./billing.js";
import { createPolarCheckout, loadPolarConfig, type PolarConfig } from "./polar.js";

export interface CloudAdminDeps {
  store: CloudStore;
  ledger: CloudLedger;
  pricing?: PriceTable;
  billing?: StripeBillingConfig;
  polar?: PolarConfig;
  close(): Promise<void>;
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
    pricing,
    billing: loadStripeConfig(env) ?? undefined,
    polar: loadPolarConfig(env) ?? undefined,
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
    if (method === "GET" && resource === "billing") {
      const owner = deps.store.ensureOwnerCustomer("Owner");
      const freeLimit = deps.pricing?.list().free_allowance_milli_usd ?? 0;
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
      });
      return;
    }

    if (method === "GET" && resource === "me") {
      const owner = deps.store.ensureOwnerCustomer("Owner");
      const freeLimit = deps.pricing?.list().free_allowance_milli_usd ?? 0;
      send(res, 200, {
        customer: { id: owner.id, displayName: owner.displayName },
        balance: deps.ledger.balanceWithHold(owner.id),
        freeCredit: freeLimit > 0
          ? { limit: freeLimit, remaining: deps.ledger.freeRemaining(owner.id, freeLimit), currency: "USD" }
          : null,
      });
      return;
    }

    if (method === "GET" && resource === "customers" && segments[4]) {
      const customer = deps.store.getCustomer(segments[4]);
      if (!customer) throw new RelayError("Customer not found.", "cloud_customer_not_found", undefined, 404);
      send(res, 200, {
        customer: { ...customer, ...deps.ledger.balanceWithHold(customer.id) },
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



