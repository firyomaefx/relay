import { createHmac, timingSafeEqual } from "node:crypto";

export interface PolarConfig {
  accessToken: string;
  productId: string;
  webhookSecret: string;
  apiBase: string;
  successUrl: string;
  cancelUrl: string;
}

export function loadPolarConfig(env: NodeJS.ProcessEnv): PolarConfig | null {
  const accessToken = env.RELAY_POLAR_ACCESS_TOKEN?.trim();
  const productId = env.RELAY_POLAR_PRODUCT_ID?.trim();
  const webhookSecret = env.RELAY_POLAR_WEBHOOK_SECRET?.trim() ?? "";
  // Checkout without webhook verification could take money without crediting the ledger.
  if (!accessToken || !productId || !webhookSecret) return null;
  return {
    accessToken,
    productId,
    webhookSecret,
    apiBase: (env.RELAY_POLAR_API_BASE?.trim() || "https://api.polar.sh").replace(/\/+$/, ""),
    successUrl: env.RELAY_POLAR_SUCCESS_URL?.trim() || "https://relay.duitpoket.fun/billing/success",
    cancelUrl: env.RELAY_POLAR_CANCEL_URL?.trim() || "https://relay.duitpoket.fun/billing/cancel",
  };
}

export async function createPolarCheckout(
  config: PolarConfig,
  input: { customerId: string; amountMilli?: number },
): Promise<{ id: string; url: string }> {
  const body: Record<string, unknown> = {
    products: [config.productId],
    success_url: config.successUrl,
    cancel_url: config.cancelUrl,
    metadata: { customer_id: input.customerId, source: "relay-cloud" },
  };
  const response = await fetch(`${config.apiBase}/v1/checkouts/`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await response.json().catch(() => null)) as { id?: string; url?: string; detail?: unknown } | null;
  if (!response.ok || !data?.id || !data.url) {
    throw new Error(`Polar checkout failed (${response.status})`);
  }
  return { id: data.id, url: data.url };
}

function signatureParts(header: string): string[] {
  return header.split(" ").flatMap((part) => {
    const index = part.indexOf(",");
    return index > 0 && part.slice(0, index) === "v1" ? [part.slice(index + 1)] : [];
  });
}

/** Polar uses the Standard Webhooks scheme: id.timestamp.body, HMAC-SHA256, base64. */
export function verifyPolarWebhook(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
  nowMs = Date.now(),
  toleranceSeconds = 300,
): boolean {
  if (!secret || !secret.startsWith("whsec_")) return false;
  const id = headers["webhook-id"];
  const timestamp = headers["webhook-timestamp"];
  const signature = headers["webhook-signature"];
  if (typeof id !== "string" || typeof timestamp !== "string" || typeof signature !== "string") return false;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(Math.floor(nowMs / 1000) - seconds) > toleranceSeconds) return false;
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody.toString("utf8")}`, "utf8").digest();
  return signatureParts(signature).some((part) => {
    try {
      const provided = Buffer.from(part, "base64");
      return provided.length === expected.length && timingSafeEqual(provided, expected);
    } catch {
      return false;
    }
  });
}

export interface PolarOrderPaidEvent {
  type: "order.paid";
  data?: {
    id?: string;
    totalAmount?: number;
    currency?: string;
    metadata?: Record<string, string>;
    customer?: { email?: string };
  };
}

/** Convert cents to Relay milliUSD units. */
export function centsToMilliUSD(cents: number): number {
  if (!Number.isInteger(cents) || cents <= 0) throw new Error("Invalid Polar amount.");
  return cents * 10;
}

