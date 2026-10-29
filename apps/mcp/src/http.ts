/**
 * Token-protected Streamable HTTP transport for the Relay MCP server.
 *
 * The stdio server is for local clients (Claude Desktop, Grok CLI, Cursor).
 * Grok Bot runs in the cloud and can only attach a public HTTPS MCP endpoint,
 * so this module exposes the same MCP tools over HTTP with a bearer token.
 *
 * Security:
 * - binds to loopback by default; publish it only through an HTTPS tunnel
 * - every /mcp request requires `Authorization: Bearer <token>`
 * - the token is generated once and stored in `.data/mcp-http-token`
 * - use a dedicated tunnel for this port; never expose the Relay console
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { errorMessage, RelayError } from "@relay/core";
import { createOAuthProvider, type OAuthProvider } from "./oauth.js";

const MAX_BODY_BYTES = 16 * 1024 * 1024;

export interface HttpServerOptions {
  host: string;
  port: number;
  dataDir: string;
  token?: string;
  oauth?: { password?: string; publicBaseUrl?: string };
  /** Optional prebuilt OAuth provider; cloud entry supplies a customer-aware one. */
  oauthProvider?: OAuthProvider;
  /** Optional additional auth layer for a cloud-only entry point. Existing
   *  callers omit it, preserving the owner bearer/OAuth behaviour exactly. */
  authorize?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  /** Optional cloud-only REST routes. Existing callers omit this. */
  handleExtra?: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;
  createServer: (req?: IncomingMessage) => McpServer | Promise<McpServer>;
  log: (message: string) => void;
}

export interface RunningHttpServer {
  url: string;
  token: string;
  close: () => Promise<void>;
}

async function resolveToken(options: HttpServerOptions): Promise<{ token: string; source: string }> {
  if (options.token?.trim()) return { token: options.token.trim(), source: "--token" };
  const envToken = process.env.RELAY_MCP_HTTP_TOKEN?.trim();
  if (envToken) return { token: envToken, source: "RELAY_MCP_HTTP_TOKEN" };
  const tokenFile = path.join(options.dataDir, "mcp-http-token");
  try {
    const saved = (await readFile(tokenFile, "utf8")).trim();
    if (saved) return { token: saved, source: tokenFile };
  } catch {
    // Generate below.
  }
  const generated = randomBytes(32).toString("base64url");
  await writeFile(tokenFile, generated, { mode: 0o600 });
  return { token: generated, source: tokenFile };
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string") return false;
  const expected = Buffer.from(`Bearer ${token}`, "utf8");
  const actual = Buffer.from(header, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("Request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

export async function startHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
  const { token, source } = await resolveToken(options);
  const url = `http://${options.host}:${options.port}/mcp`;
  const oauth: OAuthProvider = options.oauthProvider ?? createOAuthProvider({
    password: options.oauth?.password ?? "",
    publicBaseUrl: options.oauth?.publicBaseUrl,
    secret: token,
  });
  const publicBase = (req: IncomingMessage): string => {
    if (options.oauth?.publicBaseUrl?.trim()) return options.oauth.publicBaseUrl.trim().replace(/\/+$/, "");
    const forwarded = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim();
    return `${forwarded || "https"}://${req.headers.host ?? options.host}`;
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      options.log(`http error: ${errorMessage(error)}`);
      if (!res.headersSent) sendJson(res, 500, { error: "Internal server error" });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? options.host}`);

    if (requestUrl.pathname === "/health") {
      sendJson(res, 200, { ok: true, name: "relay-mcp-http", transport: "streamable-http" });
      return;
    }

    if (options.handleExtra && (await options.handleExtra(req, res, requestUrl))) {
      return;
    }

    if (await oauth.handle(req, res, requestUrl)) {
      return;
    }

    if (requestUrl.pathname !== "/mcp") {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    let cloudAuthorized = false;
    if (options.authorize) {
      try {
        cloudAuthorized = await options.authorize(req, res);
      } catch (error) {
        if (error instanceof RelayError && !res.headersSent) {
          sendJson(res, error.statusCode, { error: error.message, code: error.code, details: error.details });
          return;
        }
        throw error;
      }
    }
    if (!cloudAuthorized && !isAuthorized(req, token) && !oauth.authorized(req)) {
      oauth.challenge(res, publicBase(req));
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      sendJson(res, 405, { error: "Use POST for Streamable HTTP MCP" });
      return;
    }

    let body: unknown;
    try {
      body = await readBody(req);
    } catch (error) {
      sendJson(res, 400, { error: errorMessage(error) });
      return;
    }

    // Stateless mode: one transport/server per request. The Relay service is
    // shared, so all tools see the same accounts, queue and scheduler lock.
    const mcp = await options.createServer(req);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      try {
        await transport.close();
      } catch {
        // Transport may already be closed by the client.
      }
      try {
        await mcp.close();
      } catch {
        // Server may already be closed.
      }
    };

    res.on("close", () => {
      void close();
    });

    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      options.log(`mcp request failed: ${errorMessage(error)}`);
      if (!res.headersSent) {
        sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
      } else {
        res.end();
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  options.log(`HTTP MCP listening on ${url}`);
  options.log(`HTTP MCP bearer token source: ${source}`);

  return {
    url,
    token,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

