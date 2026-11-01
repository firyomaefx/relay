import type { IncomingMessage, ServerResponse } from "node:http";
import { PLATFORM_IDS, RelayError, isPlatformId, type PlatformId } from "@relay/core";
import { authenticateApiKey } from "@relay/cloud";
import type { CloudConfig, CloudStore, TenantManager, RateLimiter, CloudRateConfig } from "@relay/cloud";

const MAX_BODY_BYTES = 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
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
    if (size > MAX_BODY_BYTES) throw new RelayError("Request body too large.", "cloud_body_too_large", undefined, 413);
    chunks.push(buffer);
  }
  if (size === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RelayError("JSON object body required.", "cloud_body_invalid", undefined, 400);
  }
  return parsed as Record<string, unknown>;
}

function platformFromPath(value: string | undefined): PlatformId {
  if (!value || !isPlatformId(value)) {
    throw new RelayError(`Unknown platform: ${value ?? ""}`, "cloud_platform_invalid", undefined, 400);
  }
  return value;
}

export interface CloudApiOptions {
  store: CloudStore;
  tenants: TenantManager;
  config: CloudConfig;
  limiter?: RateLimiter;
  rateConfig?: CloudRateConfig;
}

/** Cloud-only REST surface for customer credentials and OAuth. */
export function createCloudApi(options: CloudApiOptions) {
  const { store, tenants, config } = options;

  async function authenticated(req: IncomingMessage, res: ServerResponse) {
    try {
      return authenticateApiKey(store, req);
    } catch (error) {
      sendJson(res, error instanceof RelayError ? error.statusCode : 401, {
        error: error instanceof Error ? error.message : "Unauthorized",
      });
      return null;
    }
  }

  async function relayFor(identity: ReturnType<typeof authenticateApiKey>) {
    return tenants.get(identity.customer);
  }

  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith("/cloud/")) return false;
    const method = req.method ?? "GET";
    const parts = url.pathname.split("/").filter(Boolean);

    try {
      // Provider redirect target. No API key is available here; the state is
      // one-time and maps to exactly one customer.
      if (method === "GET" && parts.length === 5 && parts[1] === "oauth" && parts[2] === "auth" && parts[3] === "callback") {
        const platform = platformFromPath(parts[4]);
        const state = url.searchParams.get("state") ?? "";
        const mapped = store.consumeOauthState(state);
        if (!mapped || mapped.platform !== platform) {
          throw new RelayError("OAuth state is invalid or already used.", "cloud_oauth_state_invalid", undefined, 400);
        }
        const customer = store.getCustomer(mapped.customerId);
        if (!customer) throw new RelayError("Customer not found.", "cloud_customer_not_found", undefined, 404);
        const relay = await tenants.get(customer);
        const code = url.searchParams.get("code") ?? "";
        let account;
        try {
          account = await relay.completeConnect(platform, { code, state });
        } catch (error) {
          store.setCustomerAccount(customer.id, platform, "needs_reconnect", null);
          throw error;
        }
        await tenants.recordMappings(customer, relay);
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(`<h1>${platform} connected</h1><p>@${account.handle} is ready. You can close this tab.</p>`);
        return true;
      }

      const identity = await authenticated(req, res);
      if (!identity) return true;
      options.limiter?.check(identity.customer.id, "api", options.rateConfig?.mcpPerMinute ?? 120, 60_000);
      const relay = await relayFor(identity);

      if (method === "GET" && parts.length === 2) {
        const accounts = await relay.accounts();
        const credentials = relay.credentialInfos();
        await tenants.recordMappings(identity.customer, relay);
        const storedStates = new Map(store.listCustomerAccounts(identity.customer.id).map((entry) => [entry.platform, entry.status]));
        sendJson(res, 200, {
          customer: { id: identity.customer.id, displayName: identity.customer.displayName },
          platforms: PLATFORM_IDS.map((platform) => ({
            platform,
            credentials: credentials.find((entry) => entry.platform === platform) ?? { configured: false },
            account: accounts.find((entry) => entry.platform === platform) ?? null,
            status: accounts.some((entry) => entry.platform === platform)
              ? "ready"
              : storedStates.get(platform) === "needs_reconnect"
                ? "needs_reconnect"
                : "not_connected",
          })),
        });
        return true;
      }

      if (parts.length === 3 && parts[1] === "credentials") {
        const platform = platformFromPath(parts[2]);
        if (method === "PUT") {
          const body = await readJson(req);
          await relay.saveCredentials(platform, {
            clientId: String(body.clientId ?? ""),
            clientSecret: String(body.clientSecret ?? ""),
            extra: body.extra && typeof body.extra === "object" ? (body.extra as Record<string, string>) : undefined,
          });
          sendJson(res, 200, { ok: true, platform, credentials: relay.credentialInfos().find((entry) => entry.platform === platform) });
          return true;
        }
        if (method === "DELETE") {
          await relay.removeCredentials(platform);
          sendJson(res, 200, { ok: true, platform });
          return true;
        }
      }

      if (parts.length === 3 && parts[1] === "connect" && method === "POST") {
        const platform = platformFromPath(parts[2]);
        const credentials = relay.credentialInfos().find((entry) => entry.platform === platform);
        if (!credentials?.configured) {
          throw new RelayError(`Add ${platform} app credentials first.`, "cloud_credentials_missing", undefined, 400);
        }
        const result = await relay.beginConnect(platform, { redirectBase: `${config.oauthBase}/cloud/oauth` });
        if (result.mode === "connected") {
          await tenants.recordMappings(identity.customer, relay);
          sendJson(res, 200, { ok: true, platform, mode: "connected", account: result.account });
          return true;
        }
        const state = new URL(result.url).searchParams.get("state");
        if (!state) throw new RelayError("OAuth state missing from provider URL.", "cloud_oauth_state_missing", undefined, 502);
        store.saveOauthState(state, identity.customer.id, platform);
        sendJson(res, 200, { ok: true, platform, mode: "redirect", url: result.url });
        return true;
      }

      if (parts.length === 3 && parts[1] === "disconnect" && method === "POST") {
        const platform = platformFromPath(parts[2]);
        const existed = await relay.disconnect(platform);
        await tenants.recordMappings(identity.customer, relay);
        sendJson(res, 200, { ok: true, platform, disconnected: existed });
        return true;
      }

      sendJson(res, 404, { error: "Cloud route not found." });
      return true;
    } catch (error) {
      const status = error instanceof RelayError ? error.statusCode : 500;
      sendJson(res, status, { error: error instanceof Error ? error.message : "Cloud API error" });
      return true;
    }
  };
}



