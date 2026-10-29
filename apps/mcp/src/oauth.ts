/**
 * Minimal OAuth 2.0 authorization server for the Relay MCP endpoint.
 *
 * Claude's custom connectors require OAuth discovery + dynamic client
 * registration before they will attach to a remote MCP server. Relay's primary
 * auth remains the static bearer token; this module adds an OAuth path so cloud
 * agents can connect without putting the static token in a URL.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const ACCESS_TTL_SECONDS = 12 * 60 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const CODE_TTL_MS = 5 * 60 * 1000;

interface OAuthClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  issued_at: number;
}

interface AuthCode {
  code: string;
  clientId: string;
  subject: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: "S256" | "plain";
  scope: string;
  expiresAt: number;
}

interface TokenPayload {
  typ: "access" | "refresh";
  exp: number;
  client_id: string;
  sub: string;
}

export interface OAuthOptions {
  password: string;
  /** Optional custom credential check, used by the cloud server to map an API key to a customer. */
  authenticate?: (credential: string) => Promise<{ subject: string } | null>;
  credentialLabel?: string;
  /** Public origin, for example https://mcp.duitpoket.fun */
  publicBaseUrl?: string;
  /** Signing secret; defaults to the static MCP token. */
  secret: string;
}

export interface OAuthProvider {
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  authorized(req: IncomingMessage): boolean;
  subject(req: IncomingMessage): string | null;
  challenge(res: ServerResponse, baseUrl: string): void;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return character;
    }
  });
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function safeEqual(a: string, b: string): boolean {
  const left = digest(a);
  const right = digest(b);
  return timingSafeEqual(left, right);
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function readRawBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "no-store",
  });
  res.end(html);
}

function publicBase(req: IncomingMessage, override?: string): string {
  if (override?.trim()) return override.trim().replace(/\/+$/, "");
  const forwarded = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim();
  const proto = forwarded || "https";
  const host = req.headers.host ?? "127.0.0.1";
  return `${proto}://${host}`;
}

function appendQuery(uri: string, params: Record<string, string | undefined>): string {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }
  return url.toString();
}

function validRedirect(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol === "https:") return true;
    return parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1");
  } catch {
    return false;
  }
}

export function createOAuthProvider(options: OAuthOptions): OAuthProvider {
  const clients = new Map<string, OAuthClient>();
  const codes = new Map<string, AuthCode>();
  const key = digest(`relay-oauth:${options.secret}`);

  function encodeClient(client: OAuthClient): string {
    const encoded = base64url(JSON.stringify({ client_name: client.client_name, redirect_uris: client.redirect_uris, issued_at: client.issued_at }));
    const signature = createHmac("sha256", key).update(`client:${encoded}`, "utf8").digest("base64url");
    return `relay_client_${encoded}.${signature}`;
  }

  function decodeClient(clientId: string): OAuthClient | null {
    if (!clientId.startsWith("relay_client_")) return null;
    const body = clientId.slice("relay_client_".length);
    const separator = body.lastIndexOf(".");
    if (separator <= 0) return null;
    const encoded = body.slice(0, separator);
    const provided = Buffer.from(body.slice(separator + 1), "utf8");
    const expected = Buffer.from(createHmac("sha256", key).update(`client:${encoded}`, "utf8").digest("base64url"), "utf8");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
    try {
      const data = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Omit<OAuthClient, "client_id">;
      if (!Array.isArray(data.redirect_uris) || data.redirect_uris.length === 0) return null;
      return { client_id: clientId, ...data };
    } catch {
      return null;
    }
  }

  function getClient(clientId: string): OAuthClient | undefined {
    return clients.get(clientId) ?? decodeClient(clientId) ?? undefined;
  }

  function sign(payload: TokenPayload): string {
    const encoded = base64url(JSON.stringify(payload));
    const signature = createHmac("sha256", key).update(encoded, "utf8").digest("base64url");
    return `${encoded}.${signature}`;
  }

  function verify(token: string, type: "access" | "refresh"): TokenPayload | null {
    const separator = token.lastIndexOf(".");
    if (separator <= 0) return null;
    const encoded = token.slice(0, separator);
    const provided = Buffer.from(token.slice(separator + 1), "utf8");
    const expected = Buffer.from(createHmac("sha256", key).update(encoded, "utf8").digest("base64url"), "utf8");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
    try {
      const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as TokenPayload;
      if (payload.typ !== type || payload.exp <= Math.floor(Date.now() / 1000) || !payload.client_id || !payload.sub) return null;
      return payload;
    } catch {
      return null;
    }
  }

  function issueTokens(clientId: string, scope: string, subject: string): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000);
    return {
      access_token: sign({ typ: "access", exp: now + ACCESS_TTL_SECONDS, client_id: clientId, sub: subject }),
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SECONDS,
      refresh_token: sign({ typ: "refresh", exp: now + REFRESH_TTL_SECONDS, client_id: clientId, sub: subject }),
      scope,
    };
  }

  function authorizationMetadata(base: string) {
    return {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256", "plain"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    };
  }

  function protectedResourceMetadata(base: string) {
    return {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp"],
    };
  }

  function loginPage(base: string, params: Record<string, string>, error?: string): string {
    const hidden = Object.entries(params)
      .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}" />`)
      .join("");
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Relay · Authorize</title>
<style>
body{margin:0;background:#050506;color:#f3f3f5;font:15px/1.5 system-ui,Segoe UI,sans-serif;min-height:100vh;display:grid;place-items:center}
main{width:min(420px,calc(100vw - 32px));border:1px solid #2a2a30;border-radius:18px;padding:28px;background:#0b0b0e}
h1{font-size:22px;margin:0 0 8px}p{color:#a6a6b0;margin:0 0 18px}
label{display:block;font-size:12px;color:#a6a6b0;margin-bottom:6px}
input[type=password]{width:100%;box-sizing:border-box;padding:11px 12px;border-radius:9px;border:1px solid #34343c;background:#111116;color:#fff;font:inherit}
button{width:100%;margin-top:14px;padding:11px 12px;border:0;border-radius:9px;background:#8b7cff;color:#fff;font:inherit;font-weight:600;cursor:pointer}
.error{color:#ff6a7f;font-size:13px;margin:0 0 12px}code{color:#8b7cff}
</style></head><body><main>
<p style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#8b7cff">Relay Cloud</p>
<h1>Authorize this connector</h1>
<p>Claude is asking to connect to <code>${escapeHtml(base)}</code>. Enter your Relay Cloud API key to approve access.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/authorize">
${hidden}
<label for="password">${escapeHtml(options.credentialLabel || "Relay console password")}</label>
<input id="password" name="password" type="password" autocomplete="off" required autofocus />
<button type="submit">Authorize Relay</button>
</form>
</main></body></html>`;
  }

  async function handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readRawBody(req)) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: "invalid_client_metadata", error_description: "Body must be JSON" });
      return;
    }
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((value): value is string => typeof value === "string") : [];
    if (redirectUris.length === 0 || redirectUris.some((uri) => !validRedirect(uri))) {
      sendJson(res, 400, { error: "invalid_redirect_uri", error_description: "Provide at least one https or loopback redirect_uri" });
      return;
    }
    const clientId = "";
    const client: OAuthClient = {
      client_id: "",
      client_name: typeof body.client_name === "string" ? body.client_name : undefined,
      redirect_uris: redirectUris,
      issued_at: Math.floor(Date.now() / 1000),
    };
    client.client_id = encodeClient(client);
    clients.set(client.client_id, client);
    sendJson(res, 201, {
      client_id: client.client_id,
      client_id_issued_at: client.issued_at,
      client_name: client.client_name,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "mcp",
    });
  }

  async function handleAuthorizeGet(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const clientId = url.searchParams.get("client_id") ?? "";
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    const responseType = url.searchParams.get("response_type") ?? "";
    const client = getClient(clientId);
    if (!client || !client.redirect_uris.includes(redirectUri) || responseType !== "code") {
      sendHtml(res, 400, "<h1>Invalid authorization request</h1><p>Unknown client or redirect URI.</p>");
      return;
    }
    sendHtml(res, 200, loginPage(publicBase(req, options.publicBaseUrl), {
      client_id: client.client_id,
      redirect_uri: redirectUri,
      state: url.searchParams.get("state") ?? "",
      code_challenge: url.searchParams.get("code_challenge") ?? "",
      code_challenge_method: url.searchParams.get("code_challenge_method") ?? "",
      scope: url.searchParams.get("scope") ?? "mcp",
      resource: url.searchParams.get("resource") ?? "",
    }));
  }

  async function handleAuthorizePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = new URLSearchParams(await readRawBody(req));
    const params = Object.fromEntries(form.entries());
    const clientId = params.client_id ?? "";
    const redirectUri = params.redirect_uri ?? "";
    const client = getClient(clientId);
    if (!client || !client.redirect_uris.includes(redirectUri)) {
      sendHtml(res, 400, "<h1>Invalid authorization request</h1>");
      return;
    }
    const { password: _password, ...safeParams } = params;
    let subject = "owner";
    if (options.authenticate) {
      const result = await options.authenticate(params.password ?? "");
      if (!result) {
        sendHtml(res, 401, loginPage(publicBase(req, options.publicBaseUrl), safeParams, "Invalid Relay Cloud API key."));
        return;
      }
      subject = result.subject;
    } else if (!options.password || !safeEqual(params.password ?? "", options.password)) {
      sendHtml(res, 401, loginPage(publicBase(req, options.publicBaseUrl), safeParams, "Incorrect Relay console password."));
      return;
    }
    const code = `relay_code_${randomBytes(24).toString("base64url")}`;
    codes.set(code, {
      code,
      clientId,
      subject,
      redirectUri,
      codeChallenge: params.code_challenge || undefined,
      codeChallengeMethod: params.code_challenge_method === "plain" ? "plain" : "S256",
      scope: params.scope || "mcp",
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    const redirect = appendQuery(redirectUri, { code, state: params.state });
    res.writeHead(302, { Location: redirect, "Cache-Control": "no-store" });
    res.end();
  }

  async function handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = new URLSearchParams(await readRawBody(req));
    const grantType = form.get("grant_type");
    if (grantType === "refresh_token") {
      const payload = verify(form.get("refresh_token") ?? "", "refresh");
      if (!payload) {
        sendJson(res, 400, { error: "invalid_grant", error_description: "Refresh token is invalid or expired" });
        return;
      }
      sendJson(res, 200, issueTokens(payload.client_id, "mcp", payload.sub));
      return;
    }
    if (grantType !== "authorization_code") {
      sendJson(res, 400, { error: "unsupported_grant_type" });
      return;
    }
    const code = form.get("code") ?? "";
    const entry = codes.get(code);
    if (!entry) {
      sendJson(res, 400, { error: "invalid_grant", error_description: "Code is invalid or already used" });
      return;
    }
    codes.delete(code);
    if (entry.expiresAt < Date.now() || form.get("client_id") !== entry.clientId || form.get("redirect_uri") !== entry.redirectUri) {
      sendJson(res, 400, { error: "invalid_grant", error_description: "Code, client or redirect does not match" });
      return;
    }
    if (entry.codeChallenge) {
      const verifier = form.get("code_verifier") ?? "";
      const expected = entry.codeChallengeMethod === "plain"
        ? verifier
        : base64url(createHash("sha256").update(verifier, "utf8").digest());
      if (!safeEqual(expected, entry.codeChallenge)) {
        sendJson(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
        return;
      }
    }
    sendJson(res, 200, issueTokens(entry.clientId, entry.scope, entry.subject));
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const base = publicBase(req, options.publicBaseUrl);
    const pathname = url.pathname;

    if (pathname === "/.well-known/oauth-authorization-server" || pathname.startsWith("/.well-known/oauth-authorization-server/")) {
      sendJson(res, 200, authorizationMetadata(base));
      return true;
    }
    if (pathname === "/.well-known/oauth-protected-resource" || pathname.startsWith("/.well-known/oauth-protected-resource/")) {
      sendJson(res, 200, protectedResourceMetadata(base));
      return true;
    }
    if (pathname === "/.well-known/openid-configuration") {
      sendJson(res, 200, authorizationMetadata(base));
      return true;
    }
    if (pathname === "/register" && req.method === "POST") {
      await handleRegister(req, res);
      return true;
    }
    if (pathname === "/authorize" && req.method === "GET") {
      await handleAuthorizeGet(req, res, url);
      return true;
    }
    if (pathname === "/authorize" && req.method === "POST") {
      await handleAuthorizePost(req, res);
      return true;
    }
    if (pathname === "/token" && req.method === "POST") {
      await handleToken(req, res);
      return true;
    }
    return false;
  }

  function subject(req: IncomingMessage): string | null {
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
    const token = header.slice("Bearer ".length).trim();
    return verify(token, "access")?.sub ?? null;
  }

  function authorized(req: IncomingMessage): boolean {
    return subject(req) !== null;
  }

  function challenge(res: ServerResponse, base: string): void {
    res.setHeader("WWW-Authenticate", `Bearer realm="relay-mcp", resource_metadata="${base}/.well-known/oauth-protected-resource"`);
  }

  return { handle, authorized, subject, challenge };
}







