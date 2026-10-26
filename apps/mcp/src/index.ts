#!/usr/bin/env node
/**
 * Relay MCP server entry point.
 *
 * Speaks the Model Context Protocol over stdin/stdout. stdout is reserved for
 * JSON-RPC frames — every log line goes to stderr. On startup it opens the
 * Relay data directory, starts the single-writer scheduler (a lock makes sure
 * scheduled posts are published by exactly one Relay process), registers the
 * tools and waits for requests. SIGINT/SIGTERM shut down cleanly.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { errorMessage } from "@relay/core";
import type { RelayService } from "@relay/core";
import { createRelay, defaultConsoleUrl, defaultDataDir } from "@relay/platforms";
import path from "node:path";
import { registerTools } from "./tools.js";
import { startHttpServer, type RunningHttpServer } from "./http.js";

const SERVER_NAME = "relay";
const SERVER_VERSION = "0.1.0";

/** stdout belongs to JSON-RPC, so all diagnostics go to stderr. */
function log(message: string): void {
  process.stderr.write(`[relay-mcp] ${message}\n`);
}

const USAGE = `relay-mcp — Relay MCP server (stdio)

Publishes to X, Threads, TikTok, YouTube and Instagram through the Model Context Protocol.
This process speaks MCP over stdin/stdout; logs are written to stderr.

Usage:
  relay-mcp [options]

Options:
  --data-dir <path>     Relay state directory (default: $RELAY_DATA_DIR or <repo>/.data)
  --mock                Force simulated mode; no real API calls (same as RELAY_MOCK=1)
  --console-url <url>   Relay console URL used for live OAuth callbacks
                        (default: $RELAY_CONSOLE_URL or http://127.0.0.1:4317)
  --http                Serve MCP over token-protected Streamable HTTP instead of stdio
  --port <port>         HTTP port for --http (default: 4320)
  --host <host>         HTTP bind host for --http (default: 127.0.0.1)
  --token <token>       HTTP bearer token (default: $RELAY_MCP_HTTP_TOKEN or .data/mcp-http-token)
  --help, -h            Show this help and exit

Environment:
  RELAY_DATA_DIR, RELAY_MOCK=1, RELAY_CONSOLE_URL, RELAY_MCP_HTTP_TOKEN

Running without platform credentials is fully supported: accounts and posts are
simulated until credentials are configured (see relay_console for details).
`;

interface CliOptions {
  dataDir?: string;
  mock: boolean;
  consoleUrl?: string;
  http: boolean;
  host?: string;
  port?: number;
  token?: string;
  help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { mock: false, help: false, http: false };

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === undefined) continue;

    let flag = raw;
    let value: string | undefined;
    const equals = raw.indexOf("=");
    if (raw.startsWith("--") && equals !== -1) {
      flag = raw.slice(0, equals);
      value = raw.slice(equals + 1);
    }

    if (flag === "--help" || flag === "-h") {
      options.help = true;
      continue;
    }
    if (flag === "--mock") {
      options.mock = true;
      continue;
    }
    if (flag === "--http") {
      options.http = true;
      continue;
    }
    if (flag === "--data-dir" || flag === "--console-url" || flag === "--host" || flag === "--port" || flag === "--token") {
      if (value === undefined) {
        const next = argv[index + 1];
        if (next === undefined || next.startsWith("--")) {
          throw new Error(`${flag} requires a value`);
        }
        value = next;
        index += 1;
      }
      value = value.trim();
      if (!value) throw new Error(`${flag} requires a non-empty value`);
      if (flag === "--data-dir") options.dataDir = value;
      else if (flag === "--console-url") options.consoleUrl = value;
      else if (flag === "--host") options.host = value;
      else if (flag === "--token") options.token = value;
      else {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be an integer between 1 and 65535");
        options.port = port;
      }
      continue;
    }
    if (raw.startsWith("-")) throw new Error(`Unknown option: ${raw}`);
    throw new Error(`Unexpected argument: ${raw}`);
  }

  return options;
}

function buildInstructions(relay: RelayService, mock: boolean): string {
  return [
    "Relay is a self-hosted publishing server for X, Threads, TikTok, YouTube and Instagram. Use these tools to inspect connected accounts, connect platforms, validate drafts, publish or schedule posts, and review results.",
    `Console: ${relay.consoleUrl} (required to complete live OAuth sign-in). Data directory: ${relay.dataDir}.`,
    mock
      ? "This server runs in forced simulated mode (--mock / RELAY_MOCK=1): accounts and posts are simulated and no real API calls are made."
      : "Publishing is simulated for platforms without credentials; with credentials configured and mock mode off, posts go to the real APIs.",
    "Typical flow: relay_accounts -> relay_connect -> relay_validate -> relay_post. Pass a future schedule_at to relay_post to queue a post; relay_queue and relay_cancel manage scheduled jobs; relay_history shows what was published.",
    "Media can be a local file path (absolute paths are safest) or a public URL. Threads, Instagram and TikTok photo posts fetch media by URL; set RELAY_PUBLIC_MEDIA_BASE_URL so local files under the data directory get public URLs.",
    "Scheduled posts are published by whichever Relay process holds the scheduler lock (this MCP server or the Relay console), so keep one of them running.",
  ].join("\n\n");
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    log(`error: ${errorMessage(error)}`);
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }

  const env = process.env;
  const dataDir = options.dataDir ? path.resolve(options.dataDir) : defaultDataDir(env);
  const consoleUrl = options.consoleUrl ?? defaultConsoleUrl(env);
  const forcedMock = options.mock ? true : undefined;

  log(`starting Relay MCP server (${options.http ? "HTTP" : "stdio"}) — data dir: ${dataDir}`);
  log(`console URL: ${consoleUrl}; ${options.mock || env.RELAY_MOCK === "1" ? "mock mode forced" : "auto mode (live where credentials exist)"}`);

  const relay = await createRelay({
    dataDir,
    consoleUrl,
    forceMock: forcedMock,
    logger: (message) => log(message),
  });

  const scheduler = await relay.startScheduler();
  if (scheduler.ownedByThisProcess) {
    log(`scheduler running (interval ${scheduler.intervalMs} ms)`);
  } else {
    log("scheduler lock held by another Relay process; that process publishes scheduled posts");
  }

  const settings = await relay.getSettings();
  const createMcpServer = (): McpServer => {
    const mcp = new McpServer(
      { name: SERVER_NAME, version: SERVER_VERSION, title: "Relay" },
      { instructions: buildInstructions(relay, settings.mock) },
    );
    registerTools(mcp, { relay, entryPath: process.argv[1] });
    return mcp;
  };

  let stdioServer: McpServer | undefined;
  let httpServer: RunningHttpServer | undefined;

  let shuttingDown = false;
  const shutdown = async (reason: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down (${reason})`);
    try {
      if (httpServer) await httpServer.close();
    } catch (error) {
      log(`error stopping HTTP server: ${errorMessage(error)}`);
    }
    try {
      await relay.stopScheduler();
    } catch (error) {
      log(`error stopping scheduler: ${errorMessage(error)}`);
    }
    try {
      await relay.close();
    } catch (error) {
      log(`error closing Relay: ${errorMessage(error)}`);
    }
    try {
      if (stdioServer) await stdioServer.close();
    } catch (error) {
      log(`error closing MCP server: ${errorMessage(error)}`);
    }
    process.exit(exitCode);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("uncaughtException", (error) => {
    log(`uncaught exception: ${error.stack ?? error.message}`);
  });
  process.on("unhandledRejection", (reason) => {
    log(`unhandled rejection: ${errorMessage(reason)}`);
  });

  if (options.http) {
    httpServer = await startHttpServer({
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 4320,
      dataDir,
      token: options.token,
      oauth: {
        password: process.env.RELAY_CONSOLE_PASSWORD,
        publicBaseUrl: process.env.RELAY_MCP_PUBLIC_URL,
      },
      createServer: createMcpServer,
      log,
    });
    log(`ready — HTTP MCP at ${httpServer.url} (bearer token required); ${settings.platforms.filter((platform) => platform.live).length} live platform(s)`);
    return;
  }

  stdioServer = createMcpServer();
  // The client closes stdin when it disconnects; exit instead of lingering.
  process.stdin.on("end", () => {
    void shutdown("stdin closed");
  });
  process.stdin.on("close", () => {
    void shutdown("stdin closed");
  });

  const transport = new StdioServerTransport();
  await stdioServer.connect(transport);
  log(`ready — ${settings.mock ? "forced mock" : "auto mode"}; ${settings.platforms.filter((platform) => platform.live).length} live platform(s)`);
}

main().catch((error) => {
  log(`fatal: ${errorMessage(error)}`);
  process.exit(1);
});
