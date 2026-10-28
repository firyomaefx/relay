#!/usr/bin/env node
/**
 * Cloud-only MCP entry point.
 *
 * The existing owner MCP server (index.ts / http.ts) is untouched. This entry
 * point is additive: it starts only when RELAY_CLOUD_ENABLED is on, requires a
 * Relay customer API key, and currently exposes only an identity probe so Phase
 * 2 can add tenant-scoped tools without changing any existing tool.
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadCloudConfig, CloudStore, TenantManager } from "@relay/cloud";
import { authenticateApiKey } from "@relay/cloud";
import { registerTools } from "./tools.js";
import { startHttpServer, type RunningHttpServer } from "./http.js";

function log(message: string): void {
  process.stderr.write(`[relay-cloud-mcp] ${message}\n`);
}

function customerFromRequest(store: CloudStore, req: import("node:http").IncomingMessage) {
  try {
    return authenticateApiKey(store, req);
  } catch {
    return null;
  }
}

export async function startCloudMcp(): Promise<RunningHttpServer> {
  const config = loadCloudConfig();
  if (!config.enabled) throw new Error("RELAY_CLOUD_ENABLED is not enabled.");
  const store = CloudStore.open(config.dbPath);
  const tenants = new TenantManager({ store, config, env: process.env, logger: log });
  const token = randomBytes(32).toString("base64url");

  const running = await startHttpServer({
    host: "127.0.0.1",
    port: config.mcpPort,
    dataDir: path.dirname(config.dbPath),
    token,
    authorize: async (req) => Boolean(customerFromRequest(store, req)),
    createServer: async (req) => {
      const identity = req ? customerFromRequest(store, req) : null;
      if (!identity) throw new Error("Cloud customer authentication failed.");
      const relay = await tenants.get(identity.customer);
      const server = new McpServer({ name: "relay-cloud", version: "0.1.0" });
      registerTools(server, { relay });
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
                customerId: identity.customer.id,
                displayName: identity.customer.displayName,
                keyPrefix: identity.key.prefix,
              }),
            },
          ],
        }),
      );
      return server;
    },
    log,
  });

  log(`cloud MCP listening on ${running.url}`);
  return {
    ...running,
    close: async () => {
      await running.close();
      await tenants.close();
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
