/**
 * Relay console HTTP server.
 *
 * Serves the single-page console from ../public and a JSON API over the same
 * RelayService used by the MCP server. No framework, no external dependencies.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  errorMessage,
  isPlatformId,
  RelayError,
  type PlatformId,
  type PostRecord,
  type RelayService,
} from "@relay/core";
import { createRelay } from "@relay/platforms";
import { PriceTable, TenantManager, authenticateApiKey, defaultPricePath, loadCloudConfig, type CloudPrices, type Customer } from "@relay/cloud";
import { CLIENT_MATRIX, generateArtifact, type ClientId } from "@relay/connector";
import { openCloudAdmin, handleCloudAdmin, type CloudAdminDeps } from "./cloud-admin.js";
import { createConnectSession, lookupConnectSession, verifyConnectSession } from "./connect-session.js";
import { createCheckoutSession, loadStripeConfig, stripeReady, topupPlan, TOPUP_PLANS, verifyStripeSignature, type StripeBillingConfig } from "./billing.js";
import { centsToMilliUSD, createPolarCheckout, loadPolarConfig, verifyPolarWebhook, type PolarConfig, type PolarOrderPaidEvent } from "./polar.js";
import { sendEmail, waitlistConfirmationEmail } from "@relay/cloud";
import { SessionManager } from "./auth.js";
import {
  CustomerAuth,
  LoginThrottle,
  createInviteToken,
  hashCustomerPassword,
  hashInviteToken,
  verifyCustomerPassword,
} from "./customer-auth.js";
import { readConfig } from "./config.js";
import {
  asRecord,
  contentTypeFor,
  readJsonBody,
  readRawBody,
  redirect,
  resolveWithin,
  sendFile,
  sendJson,
} from "./http.js";

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_MEDIA_JSON_BYTES = 90 * 1024 * 1024;
const MAX_MEDIA_BYTES = 64 * 1024 * 1024;

/** Local console posts created after this point are settled against the owner ledger. */
const CONSOLE_BILLING_SINCE = "2026-11-11T14:20:00.000Z";

/** Charge newly recorded console posts once, idempotently, using the same list prices. */
function settleConsoleBilling(records: PostRecord[], cloudAdmin: CloudAdminDeps | undefined, config: CloudPrices | null, customerId?: string): void {
  if (!cloudAdmin || !config) return;
  const owner = customerId
    ? cloudAdmin.store.getCustomer(customerId)
    : cloudAdmin.store.ensureOwnerCustomer("Owner");
  if (!owner) return;
  const prices = PriceTable.fromConfig(config);
  const freeLimit = Number(config.free_allowance_milli_usd ?? 0);
  const excluded = new Set(config.free_excluded_platforms ?? []);
  const ordered = [...records].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  for (const record of ordered) {
    const createdAt = Date.parse(record.createdAt);
    if (!Number.isFinite(createdAt) || createdAt < Date.parse(CONSOLE_BILLING_SINCE)) continue;
    const succeeded = new Set(record.results.filter((entry) => entry.ok).map((entry) => entry.platform));
    if (succeeded.size === 0) continue;
    try {
      const quote = prices.quote(record.draft, record.draft.platforms ?? []);
      let freeRemaining = freeLimit > 0 ? cloudAdmin.ledger.freeRemaining(owner.id, freeLimit) : 0;
      let paid = 0;
      let free = 0;
      const successfulLines = quote.quotes.filter((line) => succeeded.has(line.platform));
      for (const line of successfulLines) {
        const freeAmount = freeLimit > 0 && !excluded.has(line.platform) ? Math.min(line.amount, freeRemaining) : 0;
        freeRemaining -= freeAmount;
        free += freeAmount;
        paid += line.amount - freeAmount;
      }
      if (paid === 0 && free === 0) continue;
      const reservation = cloudAdmin.ledger.reserve({
        customerId: owner.id,
        amount: paid,
        freeUnits: free,
        freeLimit,
        freeJson: JSON.stringify(quote.quotes),
        idempotencyKey: `console-post:${record.id}`,
        ttlMs: 24 * 60 * 60 * 1000,
      });
      if (reservation.status === "held") {
        const postId = record.results.find((entry) => entry.ok)?.postId;
        cloudAdmin.ledger.commit(reservation.id, paid, postId, free);
      }
    } catch {
      // Do not block history or a published post on billing reconciliation.
    }
  }
}

/** Add the list-price cost of each recorded draft without mutating history. */
function historyWithCost(records: PostRecord[], config: CloudPrices | null): Array<PostRecord & { cost?: { currency: string; total: number; parts: number; lines: Array<{ platform: string; parts: number; amount: number }> } }> {
  if (!config) return records;
  const prices = PriceTable.fromConfig(config);
  return records.map((record) => {
    try {
      const platforms = Array.isArray(record.draft?.platforms) ? record.draft.platforms : [];
      if (platforms.length === 0) return record;
      const quote = prices.quote(record.draft, platforms);
      return {
        ...record,
        cost: {
          currency: quote.currency,
          total: quote.total,
          parts: quote.quotes.reduce((sum, line) => sum + line.parts, 0),
          lines: quote.quotes.map((line) => ({ platform: line.platform, parts: line.parts, amount: line.amount })),
        },
      };
    } catch {
      return record;
    }
  });
}

function waitlistLimit(): number {
  const parsed = Number(process.env.RELAY_WAITLIST_LIMIT ?? "100");
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 100;
}

const STATIC_EXTENSIONS = new Set([
  ".html",
  ".css",
  ".js",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".ico",
  ".woff2",
  ".txt",
  ".webmanifest",
]);

// Public HTML pages served before the console session gate.
const PUBLIC_PAGES: Record<string, string> = {
  "/home": "landing.html",
  "/about": "about.html",
  "/about.html": "about.html",
  "/docs": "docs.html",
  "/docs.html": "docs.html",
  "/terms": "terms.html",
  "/terms.html": "terms.html",
  "/privacy": "privacy.html",
  "/privacy.html": "privacy.html",
  "/refund": "refund.html",
  "/refund.html": "refund.html",
  "/topup": "topup.html",
  "/topup.html": "topup.html",
};

// Only these file types are ever served publicly from the media folder.
const PUBLIC_MEDIA_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".mp4", ".mov"]);

const MEDIA_KINDS_BY_EXTENSION: Record<string, "image" | "video"> = {
  ".jpg": "image",
  ".jpeg": "image",
  ".png": "image",
  ".webp": "image",
  ".mp4": "video",
  ".m4v": "video",
  ".mov": "video",
  ".webm": "video",
};

export interface StartServerOptions {
  host?: string;
  port?: number;
  dataDir?: string;
  forceMock?: boolean;
  consoleUrl?: string;
  password?: string | null;
  env?: NodeJS.ProcessEnv;
  logger?: (message: string) => void;
  publicDir?: string;
}

export interface RunningServer {
  url: string;
  host: string;
  port: number;
  dataDir: string;
  mock: boolean;
  close(): Promise<void>;
}

type RequestSession =
  | { kind: "operator" }
  | { kind: "customer"; customer: Customer };

interface HandlerDeps {
  session: SessionManager;
  customerAuth: CustomerAuth;
  tenantManager?: TenantManager;
  logger: (message: string) => void;
  publicDir: string;
  relay: () => RelayService;
  cloudAdmin?: CloudAdminDeps;
  pricing: CloudPrices | null;
  contactFile?: string;
  billing?: StripeBillingConfig;
  polar?: PolarConfig;
}

const loginThrottle = new LoginThrottle();

async function resolveRequestSession(req: IncomingMessage, deps: HandlerDeps): Promise<RequestSession | null> {
  if (deps.session.enabled && deps.session.authenticated(req)) return { kind: "operator" };
  if (deps.customerAuth.enabled && deps.cloudAdmin) {
    const token = deps.customerAuth.sessionFromRequest(req);
    if (token) {
      const record = deps.cloudAdmin.store.getCustomerAuthById(token.customerId);
      if (
        record &&
        record.customer.status === "active" &&
        !record.customer.owner &&
        record.sessionVersion === token.sessionVersion
      ) {
        return { kind: "customer", customer: record.customer };
      }
    }
  }
  // Legacy installations with no auth configured keep the original open-console behaviour.
  if (!deps.session.enabled && !deps.customerAuth.enabled) return { kind: "operator" };
  return null;
}

async function relayForSession(session: RequestSession, deps: HandlerDeps): Promise<RelayService> {
  if (session.kind === "operator") return deps.relay();
  if (!deps.cloudAdmin || !deps.tenantManager) {
    throw new RelayError("Customer sessions are not configured.", "customer_auth_unavailable", undefined, 503);
  }
  const record = deps.cloudAdmin.store.getCustomerAuthById(session.customer.id);
  if (!record || record.customer.status !== "active" || record.customer.owner) {
    throw new RelayError("This customer session is no longer valid.", "unauthorized", undefined, 401);
  }
  const relay = await deps.tenantManager.get(record.customer);
  // Customer consoles can schedule posts; the tenant owns its own scheduler lock.
  await relay.startScheduler().catch((error: unknown) => deps.logger(`tenant scheduler failed: ${errorMessage(error)}`));
  return relay;
}

function requireOperator(session: RequestSession | null): asserts session is { kind: "operator" } {
  if (!session || session.kind !== "operator") {
    throw new RelayError("Operator access required.", "operator_required", undefined, 403);
  }
}

function sendJsonWithCookies(
  res: ServerResponse,
  status: number,
  value: unknown,
  cookies: string[],
): void {
  if (cookies.length > 0) res.setHeader("Set-Cookie", cookies);
  sendJson(res, status, value);
}

function splitPath(pathname: string): string[] {
  const parts = pathname.split("/").filter((part) => part.length > 0);
  return parts.map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      throw new RelayError("Malformed URL", "bad_request", undefined, 400);
    }
  });
}

function requirePlatform(value: string | undefined): PlatformId {
  if (!value || !isPlatformId(value)) {
    throw new RelayError(`Unknown platform: ${value ?? ""}`, "platform_unknown", undefined, 404);
  }
  return value;
}

function createHandler(deps: HandlerDeps): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void handleRequest(req, res, deps).catch((error: unknown) => {
      if (res.writableEnded) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof RelayError) {
        sendJson(res, error.statusCode, {
          error: error.message,
          code: error.code,
          ...(error.details === undefined ? {} : { details: error.details }),
        });
        return;
      }
      deps.logger(`request failed: ${errorMessage(error)}`);
      sendJson(res, 500, { error: "Internal server error", code: "internal_error" });
    });
  };
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, deps: HandlerDeps): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const isGet = method === "GET" || method === "HEAD";
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");

  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://relay.local");
  } catch {
    throw new RelayError("Malformed request URL", "bad_request", undefined, 400);
  }
  const pathname = url.pathname;
  const segments = splitPath(pathname);
  const requestSession = await resolveRequestSession(req, deps);

  // The OAuth provider redirects the browser here; the signed state parameter is
  // the protection, so this route stays reachable without a console session.
  if (isGet && segments.length === 3 && segments[0] === "auth" && segments[1] === "callback") {
    const relay = requestSession ? await relayForSession(requestSession, deps) : null;
    if (!relay) {
      redirect(res, "/login");
      return;
    }
    await handleAuthCallback(res, segments[2], url, deps, relay);
    return;
  }

  // Polar sandbox/production webhook: raw body, Standard Webhooks signature, idempotent top-up.
  if (method === "POST" && segments.length === 3 && segments[0] === "api" && segments[1] === "polar" && segments[2] === "webhook") {
    if (!deps.polar?.webhookSecret || !deps.cloudAdmin) {
      throw new RelayError("Polar payments are not configured yet.", "polar_unavailable", undefined, 503);
    }
    const raw = await readRawBody(req, 1024 * 1024);
    if (!verifyPolarWebhook(raw, req.headers, deps.polar.webhookSecret)) {
      throw new RelayError("Invalid Polar signature.", "polar_signature_invalid", undefined, 400);
    }
    let event: PolarOrderPaidEvent;
    try {
      event = JSON.parse(raw.toString("utf8")) as PolarOrderPaidEvent;
    } catch {
      throw new RelayError("Invalid Polar payload.", "polar_payload_invalid", undefined, 400);
    }
    if (event.type === "order.paid" && event.data?.id) {
      const customerId = String(event.data.metadata?.customer_id ?? "");
      const amount = Number(event.data.metadata?.amount_milli) || centsToMilliUSD(Number(event.data.totalAmount));
      if (deps.cloudAdmin.store.getCustomer(customerId) && Number.isInteger(amount) && amount > 0) {
        deps.cloudAdmin.ledger.recordTopup({
          customerId,
          amount,
          currency: String(event.data.currency ?? deps.pricing?.currency ?? "USD").toUpperCase(),
          provider: "polar",
          reference: event.data.id,
          note: "Polar checkout",
        });
      }
    }
    sendJson(res, 200, { received: true });
    return;
  }

  // Stripe webhook: public, raw-body signature verification, idempotent top-up.
  if (method === "POST" && segments.length === 3 && segments[0] === "api" && segments[1] === "stripe" && segments[2] === "webhook") {
    if (!deps.billing?.webhookSecret || !deps.cloudAdmin) {
      throw new RelayError("Card payments are not configured yet.", "stripe_unavailable", undefined, 503);
    }
    const raw = await readRawBody(req, 1024 * 1024);
    const signature = req.headers["stripe-signature"];
    if (typeof signature !== "string" || !verifyStripeSignature(raw.toString("utf8"), signature, deps.billing.webhookSecret)) {
      throw new RelayError("Invalid Stripe signature.", "stripe_signature_invalid", undefined, 400);
    }
    let event: { type?: string; data?: { object?: Record<string, unknown> } };
    try {
      event = JSON.parse(raw.toString("utf8")) as typeof event;
    } catch {
      throw new RelayError("Invalid Stripe payload.", "stripe_payload_invalid", undefined, 400);
    }
    const session = event.data?.object as
      | { id?: string; payment_status?: string; amount_total?: number; currency?: string; metadata?: Record<string, string> }
      | undefined;
    const paidEvent = event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded";
    if (paidEvent && session?.id && session.payment_status === "paid") {
      const customerId = String(session.metadata?.customer_id ?? "");
      const amount = Number(session.metadata?.amount_milli ?? 0);
      // When Stripe reports the charged total, it must match the credit we are about to grant.
      const totalMatches = session.amount_total === undefined || session.amount_total === null || Number(session.amount_total) * 10 === amount;
      const currencyMatches = !session.currency || session.currency.toLowerCase() === deps.billing.currency;
      if (!totalMatches || !currencyMatches) {
        deps.logger(`stripe webhook: session ${session.id} amount or currency mismatch; not credited`);
      } else if (deps.cloudAdmin.store.getCustomer(customerId) && Number.isInteger(amount) && amount > 0) {
        deps.cloudAdmin.ledger.recordTopup({
          customerId,
          amount,
          currency: deps.pricing?.currency ?? "USD",
          provider: "stripe",
          reference: session.id,
          note: "Stripe checkout",
        });
      }
    }
    sendJson(res, 200, { received: true });
    return;
  }

  // Public endpoints: the login screen and the health probe need them.
  if (segments[0] === "api") {
    if (method === "POST" && segments.length === 2 && segments[1] === "contact") {
      const body = asRecord(await readJsonBody(req, 64 * 1024));
      const name = String(body.name ?? "").trim();
      const email = String(body.email ?? "").trim();
      const message = String(body.message ?? "").trim();
      if (!name || !email || !message || name.length > 120 || email.length > 200 || message.length > 4000 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new RelayError("Name, a valid email and a message are required.", "contact_invalid", undefined, 400);
      }
      if (!deps.contactFile) throw new RelayError("Contact requests are not configured.", "contact_unavailable", undefined, 503);
      await mkdir(path.dirname(deps.contactFile), { recursive: true });
      const record = { name, email, message, createdAt: new Date().toISOString(), ip: req.socket.remoteAddress ?? null };
      await appendFile(deps.contactFile, `${JSON.stringify(record)}\\n`, "utf8");
      const webhook = process.env.RELAY_CONTACT_WEBHOOK_URL?.trim();
      if (webhook) {
        void fetch(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `Relay contact request from ${name} <${email}>: ${message}` }), signal: AbortSignal.timeout(5000) })
          .catch((error: unknown) => deps.logger(`contact webhook failed: ${errorMessage(error)}`));
      }
      sendJson(res, 201, { ok: true });
      return;
    }
    if (segments.length === 2 && segments[1] === "waitlist") {
      if (!deps.cloudAdmin) throw new RelayError("Waitlist is not configured.", "waitlist_unavailable", undefined, 503);
      const limit = waitlistLimit();
      if (isGet) {
        const accepted = deps.cloudAdmin.store.waitlistAcceptedCount();
        sendJson(res, 200, {
          open: accepted < limit,
          accepted,
          limit,
          remaining: Math.max(0, limit - accepted),
          emailConfigured: Boolean(deps.cloudAdmin.email?.apiKey && deps.cloudAdmin.email.from),
        });
        return;
      }
      if (method !== "POST") throw new RelayError("Method not allowed.", "method_not_allowed", undefined, 405);
      const body = asRecord(await readJsonBody(req, 32 * 1024));
      // Bots fill hidden fields; humans leave this empty.
      if (String(body.website ?? "").trim()) {
        sendJson(res, 201, { ok: true, position: 0, duplicate: false, status: "pending" });
        return;
      }
      const accepted = deps.cloudAdmin.store.waitlistAcceptedCount();
      if (accepted >= limit) {
        throw new RelayError(
          "The first waitlist batch is full. Public access is opening next.",
          "waitlist_full",
          undefined,
          409,
        );
      }
      const platforms = Array.isArray(body.platforms)
        ? body.platforms.map((item) => String(item)).filter(Boolean).join(", ")
        : String(body.platforms ?? "");
      const result = deps.cloudAdmin.store.createWaitlistEntry({
        name: String(body.name ?? ""),
        email: String(body.email ?? ""),
        phone: String(body.phone ?? ""),
        platforms,
        volume: String(body.volume ?? ""),
        useCase: String(body.use_case ?? body.useCase ?? ""),
      });
      const webhook = process.env.RELAY_WAITLIST_WEBHOOK_URL?.trim();
      if (webhook && !result.duplicate) {
        void fetch(webhook, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: `Relay waitlist request from ${result.entry.name} <${result.entry.email}>: ${result.entry.useCase || "no note"}`,
          }),
          signal: AbortSignal.timeout(5000),
        }).catch((error: unknown) => deps.logger(`waitlist webhook failed: ${errorMessage(error)}`));
      }
      const position = deps.cloudAdmin.store.waitlistPosition(result.entry.id);
      const emailResult = result.duplicate
        ? { sent: false }
        : await sendEmail(deps.cloudAdmin.email, {
            ...waitlistConfirmationEmail({ name: result.entry.name, position }),
            to: result.entry.email,
          });
      sendJson(res, result.duplicate ? 200 : 201, {
        ok: true,
        position,
        duplicate: result.duplicate,
        status: result.entry.status,
        emailSent: emailResult.sent,
      });
      return;
    }
    // Self-serve card top-up for Relay Cloud customers. Authenticated by the
    // customer's own API key (never stored by the page), credited by the webhook.
    if (segments.length === 3 && segments[1] === "billing" && segments[2] === "topup") {
      const ready = stripeReady(deps.billing) && Boolean(deps.cloudAdmin);
      if (isGet) {
        sendJson(res, 200, {
          available: ready,
          currency: "USD",
          plans: Object.entries(TOPUP_PLANS).map(([id, plan]) => ({ id, amountMilli: plan.amountMilli, label: plan.label })),
        });
        return;
      }
      if (method !== "POST") throw new RelayError("Method not allowed.", "method_not_allowed", undefined, 405);
      if (!ready || !deps.billing || !deps.cloudAdmin) {
        throw new RelayError("Card payments are not configured yet.", "stripe_unavailable", undefined, 503);
      }
      const identity = authenticateApiKey(deps.cloudAdmin.store, req);
      const body = asRecord(await readJsonBody(req, 4 * 1024));
      const plan = topupPlan(body.plan);
      if (!plan) throw new RelayError("Choose the US$9.90 or US$49.90 top-up.", "stripe_plan_invalid", undefined, 400);
      let session: { id: string; url: string };
      try {
        session = await createCheckoutSession(deps.billing, {
          customerId: identity.customer.id,
          amount: plan.amountMilli,
          baseUrl: process.env.RELAY_PUBLIC_URL?.trim() || "https://relay.duitpoket.fun",
          productName: plan.label,
          plan: plan.id,
        });
      } catch (error) {
        deps.logger(`stripe checkout failed: ${errorMessage(error)}`);
        throw new RelayError("Could not start card checkout. Please try again shortly.", "stripe_checkout_failed", undefined, 502);
      }
      sendJson(res, 200, { id: session.id, url: session.url });
      return;
    }
    if (isGet && segments.length === 2 && segments[1] === "health") {
      sendJson(res, 200, {
        ok: true,
        status: "ok",
        name: "relay-web",
        version: "0.1.0",
        mock: deps.relay().isMockForced,
        payments: {
          stripeConfigured: Boolean(deps.billing?.webhookSecret),
          polarConfigured: Boolean(deps.polar?.accessToken && deps.polar?.productId),
          polarSandbox: Boolean(deps.polar?.apiBase.includes("sandbox")),
        },
        emailConfigured: Boolean(deps.cloudAdmin?.email?.apiKey && deps.cloudAdmin.email.from),
        uptimeSeconds: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
      });
      return;
    }
    if (isGet && segments.length === 2 && segments[1] === "pricing") {
      if (!deps.pricing) {
        throw new RelayError("Pricing is not configured", "pricing_unavailable", undefined, 503);
      }
      sendJson(res, 200, {
        currency: deps.pricing.currency,
        unit: deps.pricing.unit,
        freeAllowanceMilliUsd: deps.pricing.free_allowance_milli_usd ?? 0,
        freeAllowancePosts: deps.pricing.free_allowance_posts ?? 0,
        freeAllowanceUnits: deps.pricing.free_allowance_units ?? deps.pricing.free_allowance_posts ?? 0,
        freeExcludedPlatforms: deps.pricing.free_excluded_platforms ?? [],
        prices: deps.pricing.prices,
      });
      return;
    }
    if (method === "POST" && segments.length === 3 && segments[1] === "customer" && segments[2] === "login") {
      await handleCustomerLogin(req, res, deps);
      return;
    }
    if (method === "POST" && segments.length === 3 && segments[1] === "customer" && segments[2] === "accept-invite") {
      await handleAcceptCustomerInvite(req, res, deps);
      return;
    }
    if (method === "POST" && segments.length === 3 && segments[1] === "customer" && segments[2] === "logout") {
      await readJsonBody(req, MAX_JSON_BYTES).catch(() => undefined);
      sendJsonWithCookies(res, 200, { ok: true }, [
        deps.session.clearCookieHeader(),
        deps.customerAuth.clearCookieHeader(),
      ]);
      return;
    }
    if (method === "POST" && segments.length === 2 && segments[1] === "login") {
      await handleLogin(req, res, deps);
      return;
    }
    if (method === "POST" && segments.length === 2 && segments[1] === "logout") {
      await readJsonBody(req, MAX_JSON_BYTES).catch(() => undefined);
      sendJsonWithCookies(res, 200, { ok: true }, [
        deps.session.clearCookieHeader(),
        deps.customerAuth.clearCookieHeader(),
      ]);
      return;
    }
    if (isGet && segments.length === 2 && segments[1] === "session") {
      sendJson(res, 200, {
        protected: deps.session.enabled || deps.customerAuth.enabled,
        authenticated: requestSession !== null,
        role: requestSession?.kind ?? null,
        operatorEnabled: deps.session.enabled,
        customerEnabled: deps.customerAuth.enabled,
      });
      return;
    }
  }

  // Customer sign-in page.
  if (isGet && (pathname === "/login" || pathname === "/login.html")) {
    if (requestSession) {
      redirect(res, "/");
      return;
    }
    const served = await sendFile(req, res, path.join(deps.publicDir, "customer-login.html"), { html: true });
    if (!served) throw new RelayError("The customer login page is missing", "console_assets_missing", undefined, 500);
    return;
  }

  // Operator sign-in page.
  if (isGet && (pathname === "/admin" || pathname === "/admin/" || pathname === "/admin/login")) {
    if (requestSession?.kind === "operator") {
      redirect(res, "/");
      return;
    }
    const served = await sendFile(req, res, path.join(deps.publicDir, "login.html"), { html: true });
    if (!served) throw new RelayError("The operator login page is missing", "console_assets_missing", undefined, 500);
    return;
  }

  // Customer setup page (one-time invite token in the URL).
  if (isGet && (pathname === "/setup" || pathname === "/setup.html")) {
    const served = await sendFile(req, res, path.join(deps.publicDir, "setup.html"), { html: true });
    if (!served) throw new RelayError("The account setup page is missing", "console_assets_missing", undefined, 500);
    return;
  }

  // Public pricing page. It must work without a console session.
  if (isGet && (pathname === "/pricing" || pathname === "/pricing.html")) {
    let html: string;
    try {
      html = await readFile(path.join(deps.publicDir, "pricing.html"), "utf8");
    } catch {
      throw new RelayError("The pricing page is missing", "console_assets_missing", undefined, 500);
    }
    const seeded = JSON.stringify(deps.pricing ?? null).replace(/</g, "\\u003c");
    html = html.replace("__PRICE_DATA__", seeded);
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("content-length", Buffer.byteLength(html));
    res.end(html);
    return;
  }

  // Public connection guide. It must work without a console session.
  if (isGet && (pathname === "/connect" || pathname === "/connect.html")) {
    const served = await sendFile(req, res, path.join(deps.publicDir, "connect.html"), { html: true });
    if (!served) throw new RelayError("The connection guide is missing", "console_assets_missing", undefined, 500);
    return;
  }

  // Public Stripe return pages; no session required.
  if (isGet && (pathname === "/billing/success" || pathname === "/billing/success.html")) {
    const served = await sendFile(req, res, path.join(deps.publicDir, "billing-success.html"), { html: true });
    if (!served) throw new RelayError("The billing return page is missing", "console_assets_missing", undefined, 500);
    return;
  }
  if (isGet && (pathname === "/billing/cancel" || pathname === "/billing/cancel.html")) {
    const served = await sendFile(req, res, path.join(deps.publicDir, "billing-cancel.html"), { html: true });
    if (!served) throw new RelayError("The billing return page is missing", "console_assets_missing", undefined, 500);
    return;
  }

  // Public marketing, docs and policy pages. No console session needed.
  const publicPage = PUBLIC_PAGES[pathname];
  if (isGet && publicPage) {
    const served = await sendFile(req, res, path.join(deps.publicDir, publicPage), { html: true });
    if (!served) throw new RelayError("This page is missing", "console_assets_missing", undefined, 500);
    return;
  }

  // Public waitlist page for the first 100 customers.
  if (isGet && (pathname === "/waitlist" || pathname === "/waitlist.html")) {
    const served = await sendFile(req, res, path.join(deps.publicDir, "waitlist.html"), { html: true });
    if (!served) throw new RelayError("The waitlist page is missing", "console_assets_missing", undefined, 500);
    return;
  }

  // Public contact page for agency and access requests.
  if (isGet && (pathname === "/contact" || pathname === "/contact.html")) {
    const served = await sendFile(req, res, path.join(deps.publicDir, "contact.html"), { html: true });
    if (!served) throw new RelayError("The contact page is missing", "console_assets_missing", undefined, 500);
    return;
  }

  // Uploaded media is public by design: Threads and TikTok fetch it from a
  // public URL (a tunnel pointed at this server), so it must not require a session.
  if (isGet && segments.length === 2 && segments[0] === "media") {
    await serveMedia(req, res, segments[1], deps);
    return;
  }

  // The Connector authenticates this lookup with a one-time scoped token, not
  // the console cookie. It must stay reachable before the console session gate.
  // REQ-003, REQ-030
  if (isGet && segments.length === 4 && segments[0] === "api" && segments[1] === "connect" && segments[2] === "session") {
    if (!deps.cloudAdmin) {
      throw new RelayError("Cloud connections are not configured yet.", "cloud_unavailable", undefined, 503);
    }
    await lookupConnectSession(req, res, segments[3], { store: deps.cloudAdmin.store });
    return;
  }

  // The Connector authenticates verification with the scoped session token.
  // REQ-016, REQ-030
  if (method === "POST" && segments.length === 3 && segments[0] === "api" && segments[1] === "connect" && segments[2] === "verify") {
    if (!deps.cloudAdmin) {
      throw new RelayError("Cloud connections are not configured yet.", "cloud_unavailable", undefined, 503);
    }
    const body = asRecord(await readJsonBody(req, 16 * 1024));
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    if (!sessionId) throw new RelayError("sessionId is required.", "cloud_connect_session_required", undefined, 400);
    await verifyConnectSession(req, res, sessionId, {
      store: deps.cloudAdmin.store,
      mcpUrl: process.env.RELAY_CLOUD_MCP_URL?.trim() || publicMcpUrl(deps.relay()),
    });
    return;
  }

  // Everything else requires an operator or customer session.
  if ((deps.session.enabled || deps.customerAuth.enabled) && !requestSession) {
    // Visitors get the public landing page at /; signed-in users still get the console.
    if (isGet && (pathname === "/" || pathname === "/index.html")) {
      const served = await sendFile(req, res, path.join(deps.publicDir, "landing.html"), { html: true });
      if (!served) throw new RelayError("The landing page is missing", "console_assets_missing", undefined, 500);
      return;
    }
    if (pathname.startsWith("/api/")) {
      throw new RelayError("Sign in to the Relay console first", "unauthorized", undefined, 401);
    }
    if (isGet) {
      const assetServed = await serveStatic(req, res, segments, deps.publicDir, false);
      if (assetServed) return;
    }
    redirect(res, pathname.startsWith("/admin") ? "/admin" : "/login");
    return;
  }

  if (isGet && (pathname === "/" || pathname === "/index.html")) {
    const served = await sendFile(req, res, path.join(deps.publicDir, "index.html"), { html: true });
    if (!served) throw new RelayError("The console UI is missing", "console_assets_missing", undefined, 500);
    return;
  }

  if (segments[0] === "api") {
    const relay = requestSession ? await relayForSession(requestSession, deps) : null;
    if (!relay) throw new RelayError("Sign in to the Relay console first", "unauthorized", undefined, 401);
    await handleApi(req, res, method, segments, url, deps, requestSession!, relay);
    return;
  }

  if (isGet && (pathname === "/cloud-admin.html" || pathname === "/cloud-admin")) {
    requireOperator(requestSession);
  }

  if (isGet) {
    const served = await serveStatic(req, res, segments, deps.publicDir, true);
    if (served) return;
  }

  throw new RelayError("Not found", "not_found", undefined, 404);
}

function publicMcpUrl(relay: RelayService): string {
  return relay.consoleUrl.includes("//relay.")
    ? "https://cloud-mcp.duitpoket.fun/mcp"
    : "https://cloud-mcp.duitpoket.fun/mcp";
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  segments: string[],
  url: URL,
  deps: HandlerDeps,
  session: RequestSession,
  relay: RelayService,
): Promise<void> {
  const operator = session.kind === "operator";
  const billingCustomerId = operator
    ? deps.cloudAdmin?.store.ensureOwnerCustomer("Owner").id
    : session.customer.id;
  // REQ-001, REQ-022, REQ-023
  if (segments[1] === "connect" && segments[2] === "clients" && segments.length === 3) {
    if (method !== "GET") throw new RelayError("Method not allowed.", "method_not_allowed", undefined, 405);
    sendJson(res, 200, { clients: CLIENT_MATRIX, mcpUrl: publicMcpUrl(relay) });
    return;
  }

  // REQ-009 to REQ-015
  if (segments[1] === "connect" && segments[2] === "artifact" && segments.length === 4) {
    if (method !== "GET") throw new RelayError("Method not allowed.", "method_not_allowed", undefined, 405);
    const clientId = decodeURIComponent(segments[3] ?? "") as ClientId;
    try {
      sendJson(res, 200, generateArtifact({ clientId, mcpUrl: publicMcpUrl(relay) }));
    } catch (error) {
      throw new RelayError(errorMessage(error), "connect_artifact_unavailable", undefined, 404);
    }
    return;
  }

  // REQ-017: console-authenticated read of the Connector's stored result.
  if (segments[1] === "connect" && segments[2] === "status" && segments.length === 4) {
    if (method !== "GET") throw new RelayError("Method not allowed.", "method_not_allowed", undefined, 405);
    if (!deps.cloudAdmin) throw new RelayError("Cloud connections are not configured yet.", "cloud_unavailable", undefined, 503);
    sendJson(res, 200, { results: deps.cloudAdmin.store.listConnectVerifications(decodeURIComponent(segments[3] ?? "")) });
    return;
  }

  // REQ-002
  if (segments[1] === "connect" && segments[2] === "session" && segments.length === 3) {
    if (method !== "POST") throw new RelayError("Method not allowed.", "method_not_allowed", undefined, 405);
    if (!deps.cloudAdmin) {
      throw new RelayError("Cloud connections are not configured yet.", "cloud_unavailable", undefined, 503);
    }
    await createConnectSession(req, res, { store: deps.cloudAdmin.store });
    return;
  }

  if (segments[1] === "billing" && segments[2] === "stripe-checkout") {
    if (method !== "POST") throw new RelayError("Method not allowed.", "method_not_allowed", undefined, 405);
    if (!deps.billing?.webhookSecret || !deps.cloudAdmin) {
      throw new RelayError("Card payments are not configured yet.", "stripe_unavailable", undefined, 503);
    }
    const body = asRecord(await readJsonBody(req, 16 * 1024));
    const amount = Number(body.amount);
    if (!Number.isInteger(amount) || amount < 100 || amount > 50_000) {
      throw new RelayError("Top-ups must be between $1.00 and $500.00.", "stripe_amount_invalid", undefined, 400);
    }
    if (!billingCustomerId) throw new RelayError("Cloud billing is not configured.", "cloud_unavailable", undefined, 503);
    const session = await createCheckoutSession(deps.billing, {
      customerId: billingCustomerId,
      amount: amount * 10,
      baseUrl: process.env.RELAY_PUBLIC_URL?.trim() || "https://relay.duitpoket.fun",
    });
    sendJson(res, 200, { id: session.id, url: session.url });
    return;
  }

  if (segments[1] === "billing" && segments[2] === "polar-checkout") {
    if (method !== "POST") throw new RelayError("Method not allowed.", "method_not_allowed", undefined, 405);
    if (!deps.polar || !deps.cloudAdmin) {
      throw new RelayError("Polar payments are not configured yet.", "polar_unavailable", undefined, 503);
    }
    const body = asRecord(await readJsonBody(req, 16 * 1024));
    const amount = Number(body.amount);
    const productId = deps.polar.products[String(amount)];
    if (!Number.isInteger(amount) || !productId) {
      throw new RelayError("Choose an available top-up amount.", "polar_amount_invalid", undefined, 400);
    }
    if (!billingCustomerId) throw new RelayError("Cloud billing is not configured.", "cloud_unavailable", undefined, 503);
    const session = await createPolarCheckout(deps.polar, {
      customerId: billingCustomerId,
      productId,
      amountMilli: amount * 10,
    });
    sendJson(res, 200, { id: session.id, url: session.url });
    return;
  }

  if (segments[1] === "cloud" && segments[2] === "me" && segments.length === 3 && method === "GET") {
    if (!deps.cloudAdmin || !billingCustomerId) throw new RelayError("Cloud billing is not configured.", "cloud_unavailable", undefined, 503);
    const balance = deps.cloudAdmin.ledger.balanceWithHold(billingCustomerId);
    const freeLimit = deps.pricing?.free_allowance_milli_usd ?? 0;
    const freeRemaining = freeLimit > 0 ? deps.cloudAdmin.ledger.freeRemaining(billingCustomerId, freeLimit) : 0;
    sendJson(res, 200, {
      customer: { id: billingCustomerId },
      balance,
      freeCredit: freeLimit > 0 ? { limit: freeLimit, remaining: freeRemaining, currency: "USD" } : null,
      totalAvailable: balance.available + freeRemaining,
    });
    return;
  }

  if (segments[1] === "cloud" && segments[2] === "billing" && segments.length === 3 && method === "GET") {
    if (!deps.cloudAdmin || !billingCustomerId) throw new RelayError("Cloud billing is not configured.", "cloud_unavailable", undefined, 503);
    const customer = deps.cloudAdmin.store.getCustomer(billingCustomerId);
    if (!customer) throw new RelayError("Customer not found.", "cloud_customer_not_found", undefined, 404);
    const freeLimit = deps.pricing?.free_allowance_milli_usd ?? 0;
    const freeCredit = freeLimit > 0
      ? { limit: freeLimit, remaining: deps.cloudAdmin.ledger.freeRemaining(customer.id, freeLimit), currency: "USD" }
      : null;
    const balance = deps.cloudAdmin.ledger.balanceWithHold(customer.id);
    sendJson(res, 200, {
      customer: { id: customer.id, displayName: customer.displayName },
      balance,
      freeCredit,
      totalAvailable: balance.available + (freeCredit?.remaining ?? 0),
      payments: deps.cloudAdmin.ledger.listPayments(customer.id, 20),
      providers: { stripe: Boolean(deps.billing), polar: Boolean(deps.polar) },
      polarAmounts: Object.keys(deps.polar?.products ?? {}).map(Number).sort((a, b) => a - b),
      stripeAmounts: deps.billing?.webhookSecret ? [990, 2490, 4990] : [],
    });
    return;
  }

  if (segments[1] === "cloud" && segments[2] === "profile") {
    if (!deps.cloudAdmin) throw new RelayError("Cloud profile is not configured.", "cloud_unavailable", undefined, 503);
    const owner = operator
      ? deps.cloudAdmin.store.ensureOwnerCustomer("Relay Cloud")
      : session.customer;
    const profilePayload = () => {
      const current = deps.cloudAdmin!.store.getCustomer(owner.id) ?? owner;
      return {
        customer: {
          id: current.id,
          displayName: current.displayName,
          email: current.email,
          phone: current.phone,
        },
        keys: deps.cloudAdmin!.store.listApiKeys(current.id)
          .filter((key) => key.status === "active")
          .map((key) => ({ id: key.id, prefix: key.prefix, label: key.label, createdAt: key.createdAt, lastUsedAt: key.lastUsedAt })),
      };
    };
    if (method === "GET" && segments.length === 3) {
      sendJson(res, 200, profilePayload());
      return;
    }
    if (method === "POST" && segments.length === 3) {
      const body = asRecord(await readJsonBody(req, 16 * 1024));
      const email = typeof body.email === "string" ? body.email.trim() : "";
      const phone = typeof body.phone === "string" ? body.phone.trim() : "";
      if (!email || !phone) {
        throw new RelayError("Add your email and phone before saving the profile.", "cloud_profile_incomplete", undefined, 400);
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new RelayError("Enter a valid email address.", "cloud_email_invalid", undefined, 400);
      }
      if (phone.replace(/\D/g, "").length < 6) {
        throw new RelayError("Enter a valid phone number.", "cloud_phone_invalid", undefined, 400);
      }
      deps.cloudAdmin.store.updateCustomerProfile(owner.id, { email, phone });
      sendJson(res, 200, profilePayload());
      return;
    }
    if (method === "POST" && segments.length === 4 && segments[3] === "api-key") {
      const current = deps.cloudAdmin.store.getCustomer(owner.id);
      if (!current?.email || !current.phone) {
        throw new RelayError(
          "Add your email and phone in Profile & API key, then save, before generating an API key.",
          "cloud_profile_incomplete",
          undefined,
          400,
        );
      }
      const created = deps.cloudAdmin.store.createApiKey(owner.id, "Console profile");
      sendJson(res, 201, {
        ...profilePayload(),
        key: created.key,
        prefix: created.prefix,
        keyId: created.id,
      });
      return;
    }
    throw new RelayError("Not found", "not_found", undefined, 404);
  }
  if (segments[1] === "cloud" && segments[2] === "admin") {
    requireOperator(session);
    await handleCloudAdmin(req, res, segments, url, deps.cloudAdmin);
    return;
  }
  const resource = segments[1] ?? "";

  if (segments.length === 2) {
    if (method === "GET" && resource === "state") {
      const [settings, accounts, queue, history, credentials, scheduler] = await Promise.all([
        relay.getSettings(),
        relay.accounts(),
        relay.listQueue(),
        relay.history(50),
        Promise.resolve(relay.credentialInfos()),
        relay.schedulerStatus(),
      ]);
      settleConsoleBilling(history, deps.cloudAdmin, deps.pricing, session.kind === "customer" ? session.customer.id : undefined);
      sendJson(res, 200, {
        role: session.kind,
        settings: { ...settings, passwordProtected: deps.session.enabled, ...(operator ? {} : { dataDir: "" }) },
        accounts,
        queue,
        history: historyWithCost(history, deps.pricing),
        credentials,
        scheduler,
        limits: relay.platformLimits(),
      });
      return;
    }
    if (method === "GET" && resource === "limits") {
      sendJson(res, 200, { limits: relay.platformLimits() });
      return;
    }
    if (method === "GET" && resource === "queue") {
      sendJson(res, 200, { queue: await relay.listQueue() });
      return;
    }
    if (method === "GET" && resource === "history") {
      const raw = url.searchParams.get("limit");
      const limit = raw !== null && /^\d+$/.test(raw) ? Number(raw) : 50;
      const records = await relay.history(limit);
      settleConsoleBilling(records, deps.cloudAdmin, deps.pricing, session.kind === "customer" ? session.customer.id : undefined);
      sendJson(res, 200, { history: historyWithCost(records, deps.pricing) });
      return;
    }
    if (method === "POST" && resource === "posts") {
      await handleCreatePost(req, res, relay, deps, session);
      return;
    }
    if (method === "POST" && resource === "validate") {
      const body = asRecord(await readJsonBody(req, MAX_JSON_BYTES));
      const draftValue = Object.prototype.hasOwnProperty.call(body, "draft") ? body.draft : body;
      const report = await relay.validate(relay.parseDraftFromJson(draftValue));
      sendJson(res, 200, report);
      return;
    }
    if (method === "POST" && resource === "preview") {
      const body = asRecord(await readJsonBody(req, MAX_JSON_BYTES));
      const draftValue = Object.prototype.hasOwnProperty.call(body, "draft") ? body.draft : body;
      const preview = await relay.preview(relay.parseDraftFromJson(draftValue));
      sendJson(res, 200, preview);
      return;
    }
    if (method === "POST" && resource === "media") {
      await handleMediaUpload(req, res, relay);
      return;
    }
  }

  // Authenticated MCP connection details. The token is never served without a
  // valid console session, and the page asks before revealing it.
  if (segments.length === 3 && resource === "mcp" && segments[2] === "token" && method === "GET") {
    const tokenFile = path.join(relay.dataDir, "mcp-http-token");
    let token = "";
    try {
      token = (await readFile(tokenFile, "utf8")).trim();
    } catch {
      throw new RelayError("MCP HTTP token is not available. Start the Relay MCP HTTP service first.", "mcp_token_missing", undefined, 404);
    }
    if (!token) throw new RelayError("MCP HTTP token is empty.", "mcp_token_missing", undefined, 404);
    const mcpUrl = relay.consoleUrl.includes("//relay.")
      ? "https://cloud-mcp.duitpoket.fun/mcp"
      : "https://cloud-mcp.duitpoket.fun/mcp";
    sendJson(res, 200, { token, url: mcpUrl });
    return;
  }

  // Local Threads auto-reply log: posted replies, flagged comments and windows.
  if (
    segments.length === 4 &&
    resource === "threads" &&
    segments[2] === "autoreply" &&
    segments[3] === "log" &&
    method === "GET"
  ) {
    sendJson(res, 200, await relay.threadsAutoReplyLog());
    return;
  }

  // Settings flag for the local auto-reply feature.
  if (segments.length === 3 && resource === "threads" && segments[2] === "autoreply" && method === "POST") {
    const body = asRecord(await readJsonBody(req, MAX_JSON_BYTES));
    if (typeof body.enabled !== "boolean") {
      throw new RelayError("enabled must be a boolean.", "threads_autoreply_enabled_invalid", undefined, 400);
    }
    const enabled = await relay.setThreadsAutoReplyEnabled(body.enabled);
    sendJson(res, 200, { ok: true, enabled });
    return;
  }

  // Save or clear the DeepSeek API key. Encrypted at rest.
  if (segments.length === 3 && resource === "settings" && segments[2] === "deepseek" && method === "POST") {
    requireOperator(session);
    const body = asRecord(await readJsonBody(req, MAX_JSON_BYTES));
    const key = typeof body.apiKey === "string" ? body.apiKey : null;
    if (key !== null && key.trim().length < 10) {
      throw new RelayError("Enter a valid DeepSeek API key.", "deepseek_api_key_invalid", undefined, 400);
    }
    const configured = await relay.setDeepSeekApiKey(key);
    sendJson(res, 200, { ok: true, configured });
    return;
  }

  // Live DeepSeek key check. Never returns the key.
  if (segments.length === 4 && resource === "settings" && segments[2] === "deepseek" && segments[3] === "test" && method === "POST") {
    requireOperator(session);
    sendJson(res, 200, await relay.testDeepSeekKey());
    return;
  }

  // READ-ONLY Threads comments endpoint. It never posts replies or publishes.
  if (segments.length === 3 && resource === "threads" && segments[2] === "comments" && method === "GET") {
    const rawLimit = url.searchParams.get("limit_posts");
    const limitPosts = rawLimit === null ? 10 : Number(rawLimit);
    if (!Number.isInteger(limitPosts) || limitPosts < 1 || limitPosts > 50) {
      throw new RelayError("limit_posts must be an integer from 1 to 50.", "limit_posts_invalid", undefined, 400);
    }
    sendJson(res, 200, await relay.readThreadsComments(limitPosts));
    return;
  }

  // EXPLICIT-ONLY Threads reply endpoint. A reply is posted only when this
  // route is called with a comment id and text; no scheduler or automatic path
  // ever invokes it.
  if (segments.length === 3 && resource === "threads" && segments[2] === "reply" && method === "POST") {
    const body = asRecord(await readJsonBody(req, MAX_JSON_BYTES));
    const commentId = typeof body.comment_id === "string" ? body.comment_id.trim() : "";
    if (!commentId) {
      throw new RelayError(
        "comment_id is required: pass the id of the Threads comment to reply to.",
        "threads_reply_comment_id_invalid",
        undefined,
        400,
      );
    }
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) {
      throw new RelayError("text is required and must not be empty.", "threads_reply_text_required", undefined, 400);
    }
    const length = Array.from(text).length;
    if (length > 500) {
      throw new RelayError(
        `Threads replies allow at most 500 characters; this reply has ${length}.`,
        "threads_reply_text_too_long",
        { maxLength: 500, length },
        400,
      );
    }
    const result = await relay.replyToThreadsComment(commentId, text);
    sendJson(res, 200, {
      id: result.id,
      ...(result.permalink ? { permalink: result.permalink } : {}),
    });
    return;
  }

  if (segments.length === 3 && resource === "connect" && method === "POST") {
    const platform = requirePlatform(segments[2]);
    const body = asRecord(await readJsonBody(req, MAX_JSON_BYTES));
    const redirectBase = typeof body.redirectBase === "string" && body.redirectBase.trim() ? body.redirectBase.trim() : undefined;
    const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : undefined;
    const requestedId = typeof body.accountId === "string" && body.accountId.trim() ? body.accountId.trim() : undefined;
    const accountId = requestedId ?? (body.addAccount === true ? `acct_${randomUUID()}` : undefined);
    const result = await relay.beginConnect(platform, {
      ...(redirectBase ? { redirectBase } : {}),
      ...(label ? { label } : {}),
      ...(accountId ? { accountId } : {}),
    });
    sendJson(res, 200, result);
    return;
  }

  if (segments.length === 3 && resource === "disconnect" && method === "POST") {
    const platform = requirePlatform(segments[2]);
    const body = asRecord(await readJsonBody(req, MAX_JSON_BYTES).catch(() => ({})));
    const accountId = typeof body.accountId === "string" && body.accountId.trim() ? body.accountId.trim() : undefined;
    const removed = await relay.disconnect(platform, accountId);
    sendJson(res, 200, { ok: true, removed });
    return;
  }

  if (segments.length === 4 && resource === "queue" && segments[3] === "cancel" && method === "POST") {
    const id = segments[2];
    await readJsonBody(req, MAX_JSON_BYTES).catch(() => undefined);
    const jobs = await relay.listQueue();
    if (!jobs.some((job) => job.id === id)) {
      throw new RelayError("No queued job with that id", "job_not_found", undefined, 404);
    }
    const canceled = await relay.cancelJob(id);
    sendJson(res, 200, { ok: true, canceled });
    return;
  }

  if (segments.length === 3 && resource === "credentials" && method === "PUT") {
    requireOperator(session);
    const platform = requirePlatform(segments[2]);
    const body = asRecord(await readJsonBody(req, MAX_JSON_BYTES));
    const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
    const clientSecret = typeof body.clientSecret === "string" ? body.clientSecret.trim() : "";
    await relay.saveCredentials(platform, { clientId, clientSecret });
    sendJson(res, 200, { ok: true, credentials: relay.credentialInfos() });
    return;
  }

  if (segments.length === 3 && resource === "credentials" && method === "DELETE") {
    requireOperator(session);
    const platform = requirePlatform(segments[2]);
    await readJsonBody(req, MAX_JSON_BYTES).catch(() => undefined);
    await relay.removeCredentials(platform);
    sendJson(res, 200, { ok: true, credentials: relay.credentialInfos() });
    return;
  }

  throw new RelayError("Not found", "not_found", undefined, 404);
}

async function handleCreatePost(req: IncomingMessage, res: ServerResponse, relay: RelayService, deps: Parameters<typeof createHandler>[0], session: RequestSession): Promise<void> {
  const body = asRecord(await readJsonBody(req, MAX_JSON_BYTES));
  const draftValue = Object.prototype.hasOwnProperty.call(body, "draft") ? body.draft : body;
  const draft = relay.parseDraftFromJson(draftValue);
  const force = body.force === true;
  const result = await relay.createPost(draft, { force });
  if (!result.scheduled && result.recordId) {
    settleConsoleBilling(await relay.history(5), deps.cloudAdmin, deps.pricing, session.kind === "customer" ? session.customer.id : undefined);
  }
  // Validation failures are a domain outcome, not a transport error: the client
  // renders `report.issues` and `results` directly. Only malformed JSON is a 400.
  sendJson(res, 200, result);
}

async function handleMediaUpload(req: IncomingMessage, res: ServerResponse, relay: RelayService): Promise<void> {
  const body = asRecord(await readJsonBody(req, MAX_MEDIA_JSON_BYTES));
  const filename = typeof body.filename === "string" ? body.filename.trim() : "";
  const encoded = typeof body.dataBase64 === "string" ? body.dataBase64 : "";
  if (!filename) throw new RelayError("A filename is required", "filename_required", undefined, 400);
  if (!encoded) throw new RelayError("File data (dataBase64) is required", "file_data_required", undefined, 400);

  const cleaned = encoded.replace(/^data:[^;,]+;base64,/i, "").replace(/\s+/g, "");
  if (cleaned.length === 0) throw new RelayError("File data is empty", "file_empty", undefined, 400);
  if (cleaned.length % 4 === 1) throw new RelayError("File data is not valid base64", "file_invalid", undefined, 400);

  const buffer = Buffer.from(cleaned, "base64");
  if (buffer.length === 0) throw new RelayError("File data is empty", "file_empty", undefined, 400);
  if (buffer.length > MAX_MEDIA_BYTES) {
    throw new RelayError(
      `Uploads are limited to ${Math.round(MAX_MEDIA_BYTES / (1024 * 1024))} MB in the console`,
      "file_too_large",
      undefined,
      413,
    );
  }

  const baseName = path.basename(filename).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.\-]+/, "");
  const extension = path.extname(baseName).toLowerCase();
  const kind = MEDIA_KINDS_BY_EXTENSION[extension];
  if (!kind) {
    throw new RelayError(
      `Unsupported media type "${extension || "(none)"}". Use JPG, PNG, WebP, MP4, MOV or WebM.`,
      "media_type_unsupported",
      undefined,
      400,
    );
  }
  const stem = path.basename(baseName, extension).slice(0, 60) || "upload";
  const name = `${Date.now().toString(36)}-${randomBytes(5).toString("hex")}-${stem}${extension}`;
  const filePath = path.join(path.resolve(relay.mediaDir), name);

  await mkdir(relay.mediaDir, { recursive: true });
  await writeFile(filePath, buffer, { flag: "wx" });

  sendJson(res, 200, {
    path: filePath,
    url: `/media/${encodeURIComponent(name)}`,
    filename: name,
    name,
    kind,
    size: buffer.length,
    mimeType: contentTypeFor(filePath),
  });
}

function clientKey(req: IncomingMessage): string {
  return req.socket.remoteAddress?.trim() || "unknown";
}

async function handleCustomerLogin(req: IncomingMessage, res: ServerResponse, deps: HandlerDeps): Promise<void> {
  if (!deps.customerAuth.enabled || !deps.cloudAdmin) {
    throw new RelayError("Customer sign-in is not enabled.", "customer_auth_unavailable", undefined, 503);
  }
  const body = asRecord(await readJsonBody(req, MAX_JSON_BYTES));
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const throttleKey = `customer:${clientKey(req)}:${email}`;
  loginThrottle.check(throttleKey);
  const record = email ? deps.cloudAdmin.store.getCustomerAuthByEmail(email) : null;
  const valid = record && record.customer.status === "active" && !record.customer.owner && record.passwordHash
    ? await verifyCustomerPassword(password, record.passwordHash)
    : false;
  if (!record || !valid) {
    throw new RelayError("Email or password is incorrect.", "invalid_credentials", undefined, 401);
  }
  loginThrottle.clear(throttleKey);
  sendJsonWithCookies(
    res,
    200,
    { ok: true, role: "customer" },
    [
      deps.customerAuth.cookieHeader({ customerId: record.customer.id, sessionVersion: record.sessionVersion }),
      deps.session.clearCookieHeader(),
    ],
  );
}

async function handleAcceptCustomerInvite(req: IncomingMessage, res: ServerResponse, deps: HandlerDeps): Promise<void> {
  if (!deps.customerAuth.enabled || !deps.cloudAdmin) {
    throw new RelayError("Customer sign-in is not enabled.", "customer_auth_unavailable", undefined, 503);
  }
  const body = asRecord(await readJsonBody(req, MAX_JSON_BYTES));
  const token = String(body.token ?? "").trim();
  const password = String(body.password ?? "");
  if (!token || password.length < 10) {
    throw new RelayError("Choose a password with at least 10 characters.", "password_invalid", undefined, 400);
  }
  const record = deps.cloudAdmin.store.consumeCustomerInvite(hashInviteToken(token));
  if (!record || record.customer.status !== "active" || record.customer.owner) {
    throw new RelayError("This setup link is invalid or has expired.", "invite_invalid", undefined, 400);
  }
  const updated = deps.cloudAdmin.store.setCustomerPassword(record.customer.id, await hashCustomerPassword(password));
  sendJsonWithCookies(
    res,
    200,
    { ok: true, role: "customer" },
    [
      deps.customerAuth.cookieHeader({ customerId: updated.customer.id, sessionVersion: updated.sessionVersion }),
      deps.session.clearCookieHeader(),
    ],
  );
}

async function handleLogin(req: IncomingMessage, res: ServerResponse, deps: HandlerDeps): Promise<void> {
  const body = asRecord(await readJsonBody(req, MAX_JSON_BYTES));
  if (!deps.session.enabled) {
    sendJsonWithCookies(res, 200, { ok: true, protected: false, authenticated: true, role: "operator" }, [
      deps.customerAuth.clearCookieHeader(),
    ]);
    return;
  }
  if (!deps.session.verifyPassword(body.password)) {
    throw new RelayError("Incorrect password", "invalid_password", undefined, 401);
  }
  sendJsonWithCookies(res, 200, { ok: true, protected: true, authenticated: true, role: "operator" }, [
    deps.session.cookieHeader(),
    deps.customerAuth.clearCookieHeader(),
  ]);
}

async function handleAuthCallback(
  res: ServerResponse,
  platformSegment: string,
  url: URL,
  deps: HandlerDeps,
  relay: RelayService,
): Promise<void> {
  const logAuth = async (message: string): Promise<void> => {
    try {
      await appendFile(path.join(process.cwd(), ".data", "auth-debug.log"), `${new Date().toISOString()} ${message}\n`);
    } catch {
      // Debug logging must never break the callback.
    }
  };
  let platform: PlatformId;
  try {
    platform = requirePlatform(platformSegment);
  } catch {
    redirect(res, "/?error=unknown_platform");
    return;
  }

  const providerError = url.searchParams.get("error");
  if (providerError) {
    const description = url.searchParams.get("error_description") ?? providerError;
    redirect(res, `/?error=${encodeURIComponent(description)}`);
    return;
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    redirect(res, `/?error=${encodeURIComponent("The provider did not return a code and state. Start the sign-in again.")}`);
    return;
  }

  try {
    await logAuth(`start platform=${platform} code=${Boolean(code)} state=${state.slice(0, 6)}`);
    await relay.completeConnect(platform, { code, state });
    await logAuth(`success platform=${platform}`);
    redirect(res, `/?connected=${platform}`);
  } catch (error) {
    await logAuth(`error platform=${platform} message=${errorMessage(error)} stack=${(error as Error)?.stack ?? ""}`);
    redirect(res, `/?error=${encodeURIComponent(errorMessage(error))}`);
  }
}

async function serveMedia(req: IncomingMessage, res: ServerResponse, name: string, deps: HandlerDeps): Promise<void> {
  const mediaDir = path.resolve(deps.relay().mediaDir);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/.test(name) || name.includes("..") || !PUBLIC_MEDIA_EXTENSIONS.has(path.extname(name).toLowerCase())) {
    throw new RelayError("Media not found", "media_not_found", undefined, 404);
  }
  const filePath = path.join(mediaDir, name);
  if (!filePath.startsWith(mediaDir + path.sep)) {
    throw new RelayError("Media not found", "media_not_found", undefined, 404);
  }
  const served = await sendFile(req, res, filePath, { cacheControl: "public, max-age=3600" });
  if (!served) throw new RelayError("Media not found", "media_not_found", undefined, 404);
}

async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  publicDir: string,
  allowHtml: boolean,
): Promise<boolean> {
  if (segments.length === 0) return false;
  const filePath = resolveWithin(publicDir, segments);
  if (!filePath) return false;
  const extension = path.extname(filePath).toLowerCase();
  if (!STATIC_EXTENSIONS.has(extension)) return false;
  if (!allowHtml && extension === ".html") return false;
  return sendFile(req, res, filePath, { html: extension === ".html" });
}

function normalizeDisplayHost(host: string): string {
  if (host === "" || host === "0.0.0.0" || host === "::" || host === "::0") return "127.0.0.1";
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

/**
 * Starts the Relay console. The returned `close` stops the HTTP listener, the
 * scheduler and the Relay service (scheduler lock included).
 */
export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const env = options.env ?? process.env;
  const config = readConfig(env);
  const host = options.host ?? config.host;
  const requestedPort = options.port ?? config.port;
  const dataDirOption = options.dataDir ?? config.dataDir;
  const forceMock = options.forceMock ?? config.forceMock;
  const password = options.password !== undefined ? options.password : config.password;
  const logger = options.logger ?? ((message: string) => console.log(`[relay] ${message}`));
  const publicDir =
    options.publicDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
  const session = new SessionManager(password);
  const secureCookies = /^https:/i.test(env.RELAY_PUBLIC_URL?.trim() ?? "") || env.NODE_ENV === "production";
  const customerAuth = new CustomerAuth(env.RELAY_CUSTOMER_SESSION_SECRET, { secure: secureCookies });
  if (!customerAuth.enabled) logger("customer auth disabled: RELAY_CUSTOMER_SESSION_SECRET missing or shorter than 32 chars");
  const billing = loadStripeConfig(env);
  const polar = loadPolarConfig(env);
  let cloudAdmin: CloudAdminDeps | null = null;
  let pricing: CloudPrices | null = null;
  try {
    pricing = PriceTable.load(defaultPricePath(env)).list();
  } catch (error) {
    logger(`pricing page disabled: ${errorMessage(error)}`);
  }
  try {
    cloudAdmin = openCloudAdmin(env);
  } catch (error) {
    logger(`cloud admin disabled: ${errorMessage(error)}`);
  }
  let relay: RelayService | null = null;
  let tenantManager: TenantManager | undefined;
  if (cloudAdmin) {
    tenantManager = new TenantManager({
      store: cloudAdmin.store,
      config: cloudAdmin.config,
      env,
      forceMock,
      consoleUrl: options.consoleUrl ?? config.consoleUrl ?? env.RELAY_CONSOLE_URL?.trim() ?? "https://relay.duitpoket.fun",
      logger,
      credentials: () => relay?.credentialValues() ?? {},
    });
  }
  const server = createServer(
    createHandler({
      session,
      customerAuth,
      tenantManager,
      logger,
      publicDir,
      cloudAdmin: cloudAdmin ?? undefined,
      pricing,
      contactFile: path.join(path.resolve(dataDirOption), "contact-requests.ndjson"),
      billing: billing ?? undefined,
      polar: polar ?? undefined,
      relay: () => {
        if (!relay) throw new RelayError("The console is still starting", "not_ready", undefined, 503);
        return relay;
      },
    }),
  );

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(requestedPort, host);
  });

  const address = server.address();
  const actualPort = address && typeof address === "object" ? address.port : requestedPort;
  const url = `http://${normalizeDisplayHost(host)}:${actualPort}`;

  const closeHttp = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
        else resolve();
      });
      server.closeIdleConnections?.();
      const timer = setTimeout(() => server.closeAllConnections?.(), 250);
      timer.unref?.();
    });

  let closePromise: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (!closePromise) {
      closePromise = (async () => {
        await closeHttp();
        if (relay) {
          const active = relay;
          relay = null;
          await active.stopScheduler();
          await active.close();
        }
        if (tenantManager) {
          const activeTenants = tenantManager;
          tenantManager = undefined;
          await activeTenants.close();
        }
        if (cloudAdmin) {
          const activeCloud = cloudAdmin;
          cloudAdmin = null;
          await activeCloud.close();
        }
      })();
    }
    return closePromise;
  };

  try {
    relay = await createRelay({
      dataDir: dataDirOption,
      forceMock,
      consoleUrl: options.consoleUrl ?? config.consoleUrl ?? url,
      env,
      logger,
    });
    await relay.startScheduler();
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }

  return {
    url,
    host,
    port: actualPort,
    dataDir: relay.dataDir,
    mock: relay.isMockForced,
    close,
  };
}

/** CLI entry point: starts the console and installs graceful shutdown. */
export async function runMain(): Promise<void> {
  let running: RunningServer;
  try {
    running = await startServer();
  } catch (error) {
    console.error(`Relay console failed to start: ${errorMessage(error)}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Relay console listening on ${running.url}`);
  console.log(
    running.mock
      ? "  mode: simulated (RELAY_MOCK=1). Nothing is sent to a real platform."
      : "  mode: live-capable. Platforms connect for real once credentials are configured.",
  );
  console.log(`  data: ${running.dataDir}`);
  console.log("  set RELAY_CONSOLE_URL to the public URL of this console before connecting real accounts.");

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down the Relay console.`);
    void running
      .close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error(`Shutdown failed: ${errorMessage(error)}`);
        process.exit(1);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}









