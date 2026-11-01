import { createHmac, timingSafeEqual } from "node:crypto";

export interface StripeBillingConfig {
  secretKey: string;
  webhookSecret: string;
  currency: string;
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutSession {
  id: string;
  url: string;
}

export function loadStripeConfig(env: NodeJS.ProcessEnv): StripeBillingConfig | null {
  const secretKey = env.RELAY_STRIPE_SECRET_KEY?.trim();
  if (!secretKey) return null;
  return {
    secretKey,
    webhookSecret: env.RELAY_STRIPE_WEBHOOK_SECRET?.trim() ?? "",
    currency: (env.RELAY_STRIPE_CURRENCY?.trim() || "usd").toLowerCase(),
    successUrl: env.RELAY_STRIPE_SUCCESS_URL?.trim() || "https://relay.duitpoket.fun/billing/success?session_id={CHECKOUT_SESSION_ID}",
    cancelUrl: env.RELAY_STRIPE_CANCEL_URL?.trim() || "https://relay.duitpoket.fun/billing/cancel",
  };
}

/** 1,000 milliUSD = $1.00 = 100 cents, so 10 milliUSD = 1 cent. */
export function amountToCents(amount: number): number {
  if (!Number.isInteger(amount) || amount <= 0 || amount % 10 !== 0) {
    throw new Error("Top-up amount must be a positive multiple of 10 milliUSD.");
  }
  return amount / 10;
}

export async function createCheckoutSession(
  config: StripeBillingConfig,
  input: { customerId: string; amount: number; baseUrl: string },
): Promise<CheckoutSession> {
  const cents = amountToCents(input.amount);
  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("client_reference_id", input.customerId);
  form.set("success_url", config.successUrl);
  form.set("cancel_url", config.cancelUrl);
  form.set("line_items[0][quantity]", "1");
  form.set("line_items[0][price_data][currency]", config.currency);
  form.set("line_items[0][price_data][unit_amount]", String(cents));
  form.set("line_items[0][price_data][product_data][name]", "Relay Cloud credit");
  form.set("metadata[customer_id]", input.customerId);
  form.set("metadata[amount_milli]", String(input.amount));
  form.set("metadata[source]", "relay-cloud");
  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
      "idempotency-key": `relay-topup-${input.customerId}-${input.amount}-${Math.floor(Date.now() / 60000)}`,
    },
    body: form,
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => null)) as { id?: string; url?: string; error?: { message?: string } } | null;
  if (!response.ok || !body?.id || !body.url) {
    throw new Error(body?.error?.message || `Stripe checkout failed (${response.status})`);
  }
  return { id: body.id, url: body.url };
}

function parseSignatureHeader(header: string): { timestamp: number; signatures: string[] } | null {
  const values = header.split(",").map((part) => part.trim());
  const timestamp = Number(values.find((part) => part.startsWith("t="))?.slice(2));
  const signatures = values.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
  if (!Number.isFinite(timestamp) || signatures.length === 0) return null;
  return { timestamp, signatures };
}

export function verifyStripeSignature(payload: string, header: string, secret: string, nowMs = Date.now(), toleranceSeconds = 300): boolean {
  if (!secret) return false;
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - parsed.timestamp) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${parsed.timestamp}.${payload}`, "utf8").digest();
  return parsed.signatures.some((signature) => {
    try {
      const provided = Buffer.from(signature, "hex");
      return provided.length === expected.length && timingSafeEqual(provided, expected);
    } catch {
      return false;
    }
  });
}
