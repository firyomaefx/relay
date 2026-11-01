#!/usr/bin/env node
/**
 * Cloud-only MCP entry point.
 *
 * The existing owner MCP server (index.ts / http.ts) is untouched. This entry
 * point is additive: it starts only when RELAY_CLOUD_ENABLED is on, requires a
 * Relay customer API key, and currently exposes only an identity probe so Phase
 * 2 can add tenant-scoped tools without changing any existing tool.
 */
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadCloudConfig, CloudStore, TenantManager, CloudLedger, PriceTable, defaultPricePath, RateLimiter, loadRateConfig } from "@relay/cloud";
import { authenticateApiKey } from "@relay/cloud";
import { registerTools } from "./tools.js";
import { startHttpServer, type RunningHttpServer } from "./http.js";
import { createOAuthProvider } from "./oauth.js";
import { createCloudApi } from "./cloud-api.js";
import { CloudFinance } from "./cloud-finance.js";
import { AUTOREPLY_MIN_TOPUP_MILLI_USD, registerCloudAutoReplyTool } from "./cloud-autoreply.js";
import { prepareAccountConnect, registerCloudAccountsTool } from "./cloud-accounts.js";

function log(message: string): void {
  process.stderr.write(`[relay-cloud-mcp] ${message}\n`);
}

function customerFromRequest(store: CloudStore, req: import("node:http").IncomingMessage) {
  try {
    return authenticateApiKey(store, req);
  } catch {
    try {
      const token = new URL(req.url ?? "/", "http://relay.local").searchParams.get("token");
      return token ? store.resolveConnectToken(token) : null;
    } catch {
      return null;
    }
  }
}

export async function startCloudMcp(): Promise<RunningHttpServer> {
  const config = loadCloudConfig();
  if (!config.enabled) throw new Error("RELAY_CLOUD_ENABLED is not enabled.");
  const store = CloudStore.open(config.dbPath);
  store.ensureOwnerCustomer();
  const tenants = new TenantManager({ store, config, env: process.env, logger: log });
  const ledger = new CloudLedger(config.dbPath);
  const prices = PriceTable.load(defaultPricePath());
  const rateConfig = loadRateConfig();
  const limiter = new RateLimiter(config.dbPath);
  const finance = new CloudFinance({ store, ledger, prices, tenants, limiter, rateConfig });
  const handleExtra = createCloudApi({ store, tenants, config, limiter, rateConfig });
  const token = randomBytes(32).toString("base64url");
  const oauthSecret = createHash("sha256")
    .update(Buffer.concat([config.tokenKey ?? Buffer.alloc(32), Buffer.from("relay-cloud-oauth", "utf8")]))
    .digest("base64url");
  const cloudOAuth = createOAuthProvider({
    password: "",
    publicBaseUrl: process.env.RELAY_CLOUD_PUBLIC_URL?.trim() || "https://cloud-mcp.duitpoket.fun",
    secret: oauthSecret,
    credentialLabel: "Relay Cloud API key",
    authenticate: async (credential) => {
      try {
        const resolved = store.resolveApiKey(credential);
        return { subject: resolved.customer.id };
      } catch {
        return null;
      }
    },
  });

  const running = await startHttpServer({
    host: "127.0.0.1",
    port: config.mcpPort,
    dataDir: path.dirname(config.dbPath),
    token,
    oauthProvider: cloudOAuth,
    authorize: async (req) => {
      const identity = customerFromRequest(store, req);
      if (!identity) return false;
      limiter.check(identity.customer.id, "mcp", rateConfig.mcpPerMinute, 60_000);
      return true;
    },
    handleExtra,
    createServer: async (req) => {
      const identity = req ? customerFromRequest(store, req) : null;
      let customer = identity?.customer;
      let keyPrefix = identity?.key.prefix ?? null;
      if (!customer && req) {
        const subject = cloudOAuth.subject(req);
        if (subject) customer = store.getCustomer(subject) ?? undefined;
        keyPrefix = null;
      }
      if (!customer) throw new Error("Cloud customer authentication failed.");
      const relay = await tenants.get(customer);
      const server = new McpServer({ name: "relay-cloud", version: "0.1.0" });
      registerTools(server, {
        relay,
        ...finance.hooks(customer),
        beforeConnect: (platform, options) => prepareAccountConnect(customer, relay, ledger, platform, options),
      });
      registerCloudAutoReplyTool(server, { customer, relay, ledger });
      registerCloudAccountsTool(server, { customer, relay, ledger });
      server.registerTool(
        "relay_cloud_whoami",
        {
          description: "Return the authenticated Relay Cloud customer.",
          inputSchema: z.object({}),
        },
        async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                customerId: customer.id,
                displayName: customer.displayName,
                keyPrefix: keyPrefix,
              }),
            },
          ],
        }),
      );
      server.registerTool(
        "relay_balance",
        {
          description: "Show the authenticated Relay Cloud customer's balance, held funds and available balance.",
          inputSchema: z.object({}),
          annotations: { readOnlyHint: true },
        },
        async () => {
          const balance = finance.balance(customer.id);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ ...balance, currency: prices.list().currency, unit: prices.list().unit }),
              },
            ],
          };
        },
      );
      server.registerTool(
        "relay_usage",
        {
          description: "Show recent Relay Cloud ledger entries for the authenticated customer.",
          inputSchema: z.object({ limit: z.number().int().min(1).max(200).optional() }),
          annotations: { readOnlyHint: true },
        },
        async (args) => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                currency: prices.list().currency,
                unit: prices.list().unit,
                entries: finance.usage(customer.id, args.limit ?? 20),
              }),
            },
          ],
        }),
      );
      server.registerTool(
        "relay_prices",
        {
          description: "Show the Relay Cloud price table.",
          inputSchema: z.object({}),
          annotations: { readOnlyHint: true },
        },
        async () => ({
          content: [{ type: "text", text: JSON.stringify(prices.list()) }],
        }),
      );
      return server;
    },
    log,
  });

  log(`cloud MCP listening on ${running.url}`);
  const scheduler = setInterval(() => {
    void (async () => {
      for (const customer of store.listCustomers()) {
        if (customer.owner) continue; // The owner scheduler remains the console/MCP owner process.
        try {
          const relay = await tenants.get(customer);
          await relay.runDueJobs();
          const paidTopups = ledger.totalTopups(customer.id);
          const comments = await relay.commentsStatus();
          const threads = comments.find((entry) => entry.platform === "threads");
          if (
            paidTopups >= AUTOREPLY_MIN_TOPUP_MILLI_USD &&
            relay.getDeepSeekApiKey() &&
            relay.isThreadsAutoReplyEnabled() &&
            threads?.ready
          ) {
            await relay.runThreadsAutoReplyTick();
          }
          await finance.reconcile(customer, relay);
        } catch (error) {
          log(`cloud scheduler error for ${customer.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    })();
  }, 15000);
  return {
    ...running,
    close: async () => {
      clearInterval(scheduler);
      await running.close();
      await tenants.close();
      ledger.close();
      limiter.close();
      store.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startCloudMcp().catch((error) => {
    process.stderr.write(`[relay-cloud-mcp] failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}







