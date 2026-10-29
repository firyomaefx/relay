import type { IncomingMessage, ServerResponse } from "node:http";
import { RelayError, errorMessage } from "@relay/core";
import { CloudLedger, CloudStore, loadCloudConfig } from "@relay/cloud";

export interface CloudAdminDeps {
  store: CloudStore;
  ledger: CloudLedger;
  close(): Promise<void>;
}

export function openCloudAdmin(env: NodeJS.ProcessEnv): CloudAdminDeps | null {
  const config = loadCloudConfig(env);
  if (!config.enabled) return null;
  const store = CloudStore.open(config.dbPath);
  const ledger = new CloudLedger(config.dbPath);
  return {
    store,
    ledger,
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
