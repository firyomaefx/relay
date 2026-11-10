/**
 * Minimal OAuth 2.0 authorization server for the Relay MCP endpoint.
 *
 * Claude's custom connectors require OAuth discovery + dynamic client
 * registration before they will attach to a remote MCP server. Relay's primary
 * auth remains the static bearer token / customer API key; this module adds an
 * OAuth path so Claude (web, desktop and phone apps) can connect without the
 * key being put in a URL.
 *
 * Hardening in this module:
 * - dynamic registration only accepts a short allowlist of redirect URIs
 *   (Claude, ChatGPT, loopback for CLI tools), re-checked at authorize time;
 * - S256 PKCE is mandatory, "plain" and missing challenges are rejected;
 * - tokens carry the API key id and are re-validated on every request and on
 *   refresh, so a revoked key or disabled customer stops working at once;
 * - failed key attempts are rate limited per client IP;
 * - every HTML response refuses framing and is not cached.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const ACCESS_TTL_SECONDS = 12 * 60 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const CODE_TTL_MS = 5 * 60 * 1000;
const FAILURE_LIMIT = 8;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const REGISTER_LIMIT = 30;
const REGISTER_WINDOW_MS = 10 * 60 * 1000;
const MAX_REDIRECT_URIS = 5;
const MAX_CLIENT_NAME = 100;
const MAX_FIELD = 1024;

/** Exact redirect URIs accepted for hosted Claude surfaces and ChatGPT. */
export const OAUTH_FIXED_REDIRECT_URIS: readonly string[] = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
  "https://chatgpt.com/connector_platform_oauth_redirect",
];

/** ChatGPT's callback-specific redirect: https://chatgpt.com/connector/oauth/{callback_id} */
const CHATGPT_CALLBACK_PATTERN = /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/;

interface OAuthClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  issued_at: number;
}

export interface OAuthIdentity {
  subject: string;
  /** Id of the API key that was used to sign in, when there is one. */
  keyId?: string;
}

interface AuthCode {
  code: string;
  clientId: string;
  identity: OAuthIdentity;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  expiresAt: number;
}

interface TokenPayload {
  typ: "access" | "refresh";
  exp: number;
  client_id: string;
  sub: string;
  kid?: string;
}

/** Counts attempts per key (usually a client IP) inside a fixed window. */
export interface AttemptGate {
  blocked(key: string): boolean;
  record(key: string): void;
}

export interface OAuthOptions {
  password: string;
  /** Optional custom credential check, used by the cloud server to map an API key to a customer. */
  authenticate?: (credential: string) => Promise<OAuthIdentity | null>;
  /** Returns false when the identity is no longer allowed (revoked key, disabled customer). Runs on every token use. */
  validate?: (identity: OAuthIdentity) => boolean;
  /** Gate for failed credential attempts. Defaults to an in-memory gate. */
  failureGate?: AttemptGate;
  /** Extra exact https or loopback redirect URIs to accept. */
  extraRedirectUris?: readonly string[];
  credentialLabel?: string;
  /** Short help line shown under the credential field. */
  credentialHelp?: string;
  /** Public origin, for example https://mcp.duitpoket.fun */
  publicBaseUrl?: string;
  /** Signing secret; defaults to the static MCP token. */
  secret: string;
}

export interface OAuthProvider {
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  authorized(req: IncomingMessage): boolean;
  subject(req: IncomingMessage): string | null;
  identity(req: IncomingMessage): OAuthIdentity | null;
  challenge(res: ServerResponse, baseUrl: string): void;
}

export function createMemoryAttemptGate(limit: number, windowMs: number, now: () => number = Date.now): AttemptGate {
  const windows = new Map<string, { start: number; count: number }>();
  function current(key: string): { start: number; count: number } {
    const t = now();
    const found = windows.get(key);
    if (found && t - found.start < windowMs) return found;
    const fresh = { start: t, count: 0 };
    windows.set(key, fresh);
    if (windows.size > 5000) {
      for (const [k, v] of windows) if (t - v.start >= windowMs) windows.delete(k);
    }
    return fresh;
  }
  return {
    blocked: (key) => current(key).count >= limit,
    record: (key) => {
      current(key).count += 1;
    },
  };
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
  return timingSafeEqual(digest(a), digest(b));
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

/** Every HTML page from this module is a sign-in page, so none may be framed or cached. */
function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
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

function clientIp(req: IncomingMessage): string {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.trim()) return cf.trim().slice(0, 64);
  return req.socket.remoteAddress ?? "unknown";
}

function appendQuery(uri: string, params: Record<string, string | undefined>): string {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }
  return url.toString();
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function parseUri(uri: string): URL | null {
  try {
    const parsed = new URL(uri);
    if (parsed.username || parsed.password || parsed.hash) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * True when `uri` may be registered as an OAuth redirect: the hosted Claude
 * callbacks, ChatGPT's callbacks, any loopback address (Claude Code, Codex),
 * or an exact extra URI the operator listed.
 */
export function isAllowedRedirectUri(uri: string, extra: readonly string[] = []): boolean {
  const parsed = parseUri(uri);
  if (!parsed) return false;
  if (parsed.protocol === "http:") return isLoopbackHost(parsed.hostname);
  if (parsed.protocol !== "https:") return false;
  const bare = `${parsed.origin}${parsed.pathname}`;
  if (!parsed.search && (OAUTH_FIXED_REDIRECT_URIS.includes(bare) || CHATGPT_CALLBACK_PATTERN.test(bare))) return true;
  return extra.some((entry) => {
    const allowed = parseUri(entry);
    return allowed !== null && allowed.protocol === "https:" && allowed.href === parsed.href;
  });
}

/**
 * True when `requested` is one of the registered URIs. Loopback URIs match
 * ignoring the port, as RFC 8252 section 7.3 requires for CLI clients.
 */
export function redirectMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  const want = parseUri(requested);
  if (!want || want.protocol !== "http:" || !isLoopbackHost(want.hostname)) return false;
  return registered.some((entry) => {
    const have = parseUri(entry);
    return (
      have !== null &&
      have.protocol === "http:" &&
      have.hostname === want.hostname &&
      have.pathname === want.pathname &&
      have.search === want.search
    );
  });
}

interface RedirectDescription {
  host: string;
  app: string;
}

function describeRedirect(uri: string): RedirectDescription {
  const parsed = parseUri(uri);
  if (!parsed) return { host: "unknown", app: "an app" };
  if (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)) {
    return { host: "this device (localhost)", app: "an app on this device, such as Claude Code or Codex" };
  }
  if (parsed.hostname === "claude.ai" || parsed.hostname === "claude.com") return { host: parsed.host, app: "Claude" };
  if (parsed.hostname === "chatgpt.com") return { host: parsed.host, app: "ChatGPT" };
  return { host: parsed.host, app: "an app" };
}

function isS256Challenge(value: string): boolean {
  return /^[A-Za-z0-9_-]{43,128}$/.test(value);
}

export function createOAuthProvider(options: OAuthOptions): OAuthProvider {
  const codes = new Map<string, AuthCode>();
  const key = digest(`relay-oauth:${options.secret}`);
  const failureGate = options.failureGate ?? createMemoryAttemptGate(FAILURE_LIMIT, FAILURE_WINDOW_MS);
  const registerGate = createMemoryAttemptGate(REGISTER_LIMIT, REGISTER_WINDOW_MS);
  const extraRedirects = options.extraRedirectUris ?? (process.env.RELAY_OAUTH_EXTRA_REDIRECT_URIS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);

  function encodeClient(client: Omit<OAuthClient, "client_id">): string {
    const encoded = base64url(JSON.stringify({ client_name: client.client_name, redirect_uris: client.redirect_uris, issued_at: client.issued_at }));
    const signature = createHmac("sha256", key).update(`client:${encoded}`, "utf8").digest("base64url");
    return `relay_client_${encoded}.${signature}`;
  }

  /** Client ids are signed, self-describing blobs, so no registration table is needed. */
  function getClient(clientId: string): OAuthClient | undefined {
    if (!clientId.startsWith("relay_client_")) return undefined;
    const body = clientId.slice("relay_client_".length);
    const separator = body.lastIndexOf(".");
    if (separator <= 0) return undefined;
    const encoded = body.slice(0, separator);
    const provided = Buffer.from(body.slice(separator + 1), "utf8");
    const expected = Buffer.from(createHmac("sha256", key).update(`client:${encoded}`, "utf8").digest("base64url"), "utf8");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return undefined;
    try {
      const data = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Omit<OAuthClient, "client_id">;
      if (!Array.isArray(data.redirect_uris) || data.redirect_uris.length === 0) return undefined;
      return { client_id: clientId, ...data };
    } catch {
      return undefined;
    }
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

  function stillAllowed(identity: OAuthIdentity): boolean {
    return options.validate ? options.validate(identity) : true;
  }

  function issueTokens(clientId: string, scope: string, identity: OAuthIdentity): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000);
    const kid = identity.keyId ? { kid: identity.keyId } : {};
    return {
      access_token: sign({ typ: "access", exp: now + ACCESS_TTL_SECONDS, client_id: clientId, sub: identity.subject, ...kid }),
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SECONDS,
      refresh_token: sign({ typ: "refresh", exp: now + REFRESH_TTL_SECONDS, client_id: clientId, sub: identity.subject, ...kid }),
      scope,
    };
  }

  function sweepCodes(): void {
    const now = Date.now();
    for (const [code, entry] of codes) if (entry.expiresAt < now) codes.delete(code);
  }

  function authorizationMetadata(base: string) {
    return {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
      authorization_response_iss_parameter_supported: true,
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

  function loginPage(client: OAuthClient, redirectUri: string, params: Record<string, string>, error?: string): string {
    const hidden = Object.entries(params)
      .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`)
      .join("");
    const where = describeRedirect(redirectUri);
    const label = options.credentialLabel || "Relay console password";
    const help = options.credentialHelp ? `<p class="help">${escapeHtml(options.credentialHelp)}</p>` : "";
    const name = client.client_name?.trim() ? escapeHtml(client.client_name.trim().slice(0, MAX_CLIENT_NAME)) : "not given";
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex" />
<title>Approve connection - Relay Cloud</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#050506;color:#f3f3f5;font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:16px;-webkit-text-size-adjust:100%}
main{width:100%;max-width:440px;border:1px solid #2a2a30;border-radius:18px;padding:24px;background:#0b0b0e}
.eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8b7cff;margin:0 0 8px}
h1{font-size:22px;line-height:1.25;margin:0 0 10px}
p{color:#a6a6b0;margin:0 0 16px}
dl{margin:0 0 18px;padding:12px 14px;border:1px solid #2a2a30;border-radius:12px;background:#0f0f13;font-size:14px}
dt{color:#a6a6b0;font-size:12px;margin:0}
dd{margin:0 0 8px;color:#f3f3f5;word-break:break-word}
dd:last-child{margin-bottom:0}
label{display:block;font-size:14px;font-weight:600;margin-bottom:6px}
input[type=password]{width:100%;padding:14px 12px;border-radius:10px;border:1px solid #34343c;background:#111116;color:#fff;font:inherit;font-size:16px;min-height:48px}
.help{font-size:13px;margin:8px 0 0}
button{width:100%;min-height:48px;margin-top:16px;padding:12px;border:0;border-radius:10px;background:#8b7cff;color:#fff;font:inherit;font-weight:600;cursor:pointer}
.error{color:#ff6a7f;font-size:14px;margin:0 0 12px}
.fine{font-size:12px;margin:14px 0 0}
</style></head><body><main>
<p class="eyebrow">Relay Cloud</p>
<h1>Connect ${escapeHtml(where.app)} to your Relay account</h1>
<p>This lets it schedule posts and read your balance and accounts on your behalf. Only continue if you started this connection.</p>
<dl>
<dt>App name (given by the app)</dt><dd>${name}</dd>
<dt>You will be sent back to</dt><dd>${escapeHtml(where.host)}</dd>
</dl>
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/authorize" autocomplete="off">
${hidden}
<label for="credential">${escapeHtml(label)}</label>
<input id="credential" name="password" type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" required />
${help}
<button type="submit">Approve</button>
</form>
<p class="fine">You can disconnect any time from the Claude connectors page, or by revoking your key.</p>
</main></body></html>`;
  }

  async function handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = clientIp(req);
    if (registerGate.blocked(ip)) {
      sendJson(res, 429, { error: "temporarily_unavailable", error_description: "Too many registrations. Try again later." });
      return;
    }
    registerGate.record(ip);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readRawBody(req)) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: "invalid_client_metadata", error_description: "Body must be JSON" });
      return;
    }
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((value): value is string => typeof value === "string") : [];
    if (redirectUris.length === 0 || redirectUris.length > MAX_REDIRECT_URIS || redirectUris.some((uri) => !isAllowedRedirectUri(uri, extraRedirects))) {
      sendJson(res, 400, {
        error: "invalid_redirect_uri",
        error_description: "Redirect URI is not allowed. Accepted: Claude, ChatGPT and localhost callbacks.",
      });
      return;
    }
    const issuedAt = Math.floor(Date.now() / 1000);
    const clientName = typeof body.client_name === "string" ? body.client_name.slice(0, MAX_CLIENT_NAME) : undefined;
    const clientId = encodeClient({ client_name: clientName, redirect_uris: redirectUris, issued_at: issuedAt });
    sendJson(res, 201, {
      client_id: clientId,
      client_id_issued_at: issuedAt,
      client_name: clientName,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "mcp",
    });
  }

  /** Shared by GET and POST /authorize. Returns an error message, or the validated client. */
  function checkAuthorizeRequest(params: Record<string, string>): { client: OAuthClient } | { error: string } {
    const client = getClient(params.client_id ?? "");
    const redirectUri = params.redirect_uri ?? "";
    if (!client || !redirectMatches(client.redirect_uris, redirectUri)) return { error: "Unknown client or redirect URI." };
    // Old signed client ids may carry a redirect that is no longer allowed.
    if (!isAllowedRedirectUri(redirectUri, extraRedirects)) return { error: "This redirect URI is not allowed." };
    if (params.response_type !== undefined && params.response_type !== "code") return { error: "Only the code flow is supported." };
    if (!isS256Challenge(params.code_challenge ?? "") || params.code_challenge_method !== "S256") {
      return { error: "A PKCE S256 code challenge is required." };
    }
    for (const value of Object.values(params)) if (value.length > MAX_FIELD) return { error: "Request is too large." };
    return { client };
  }

  function authorizeParams(source: URLSearchParams): Record<string, string> {
    const read = (name: string) => source.get(name) ?? "";
    return {
      client_id: read("client_id"),
      redirect_uri: read("redirect_uri"),
      response_type: read("response_type") || "code",
      state: read("state"),
      code_challenge: read("code_challenge"),
      code_challenge_method: read("code_challenge_method"),
      scope: read("scope") || "mcp",
      resource: read("resource"),
    };
  }

  async function handleAuthorizeGet(res: ServerResponse, url: URL): Promise<void> {
    const params = authorizeParams(url.searchParams);
    const checked = checkAuthorizeRequest(params);
    if ("error" in checked) {
      sendHtml(res, 400, `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Relay Cloud</title><body style="font:16px system-ui;padding:24px"><h1>Invalid authorization request</h1><p>${escapeHtml(checked.error)}</p></body>`);
      return;
    }
    sendHtml(res, 200, loginPage(checked.client, params.redirect_uri!, params));
  }

  async function handleAuthorizePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw: string;
    try {
      raw = await readRawBody(req);
    } catch {
      sendHtml(res, 413, "<h1>Request too large</h1>");
      return;
    }
    const form = new URLSearchParams(raw);
    const params = authorizeParams(form);
    const credential = form.get("password") ?? "";
    const checked = checkAuthorizeRequest(params);
    if ("error" in checked) {
      sendHtml(res, 400, `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Relay Cloud</title><body style="font:16px system-ui;padding:24px"><h1>Invalid authorization request</h1><p>${escapeHtml(checked.error)}</p></body>`);
      return;
    }
    const base = publicBase(req, options.publicBaseUrl);
    const ip = clientIp(req);
    if (failureGate.blocked(ip)) {
      res.setHeader("Retry-After", String(Math.ceil(FAILURE_WINDOW_MS / 1000)));
      sendHtml(res, 429, loginPage(checked.client, params.redirect_uri!, params, "Too many wrong attempts. Wait 15 minutes and try again."));
      return;
    }
    let identity: OAuthIdentity | null = null;
    if (options.authenticate) {
      identity = await options.authenticate(credential);
    } else if (options.password && safeEqual(credential, options.password)) {
      identity = { subject: "owner" };
    }
    if (!identity || !stillAllowed(identity)) {
      failureGate.record(ip);
      const message = options.authenticate ? "That Relay Cloud API key was not accepted." : "Incorrect Relay console password.";
      sendHtml(res, 401, loginPage(checked.client, params.redirect_uri!, params, message));
      return;
    }
    sweepCodes();
    const code = `relay_code_${randomBytes(24).toString("base64url")}`;
    codes.set(code, {
      code,
      clientId: params.client_id!,
      identity,
      redirectUri: params.redirect_uri!,
      codeChallenge: params.code_challenge!,
      scope: params.scope || "mcp",
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    const redirect = appendQuery(params.redirect_uri!, { code, state: params.state, iss: base });
    res.writeHead(302, { Location: redirect, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" });
    res.end();
  }

  async function handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw: string;
    try {
      raw = await readRawBody(req);
    } catch {
      sendJson(res, 413, { error: "invalid_request", error_description: "Request body too large" });
      return;
    }
    const form = new URLSearchParams(raw);
    const grantType = form.get("grant_type");
    if (grantType === "refresh_token") {
      const payload = verify(form.get("refresh_token") ?? "", "refresh");
      if (!payload || !stillAllowed({ subject: payload.sub, ...(payload.kid ? { keyId: payload.kid } : {}) })) {
        sendJson(res, 400, { error: "invalid_grant", error_description: "Refresh token is invalid, expired or revoked" });
        return;
      }
      sendJson(res, 200, issueTokens(payload.client_id, "mcp", { subject: payload.sub, ...(payload.kid ? { keyId: payload.kid } : {}) }));
      return;
    }
    if (grantType !== "authorization_code") {
      sendJson(res, 400, { error: "unsupported_grant_type" });
      return;
    }
    sweepCodes();
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
    const verifier = form.get("code_verifier") ?? "";
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !safeEqual(base64url(createHash("sha256").update(verifier, "utf8").digest()), entry.codeChallenge)) {
      sendJson(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
      return;
    }
    if (!stillAllowed(entry.identity)) {
      sendJson(res, 400, { error: "invalid_grant", error_description: "This sign-in is no longer allowed" });
      return;
    }
    sendJson(res, 200, issueTokens(entry.clientId, entry.scope, entry.identity));
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
      await handleAuthorizeGet(res, url);
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

  /** The signed-in identity behind a Bearer access token, or null when absent, expired or no longer allowed. */
  function identity(req: IncomingMessage): OAuthIdentity | null {
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
    const payload = verify(header.slice("Bearer ".length).trim(), "access");
    if (!payload) return null;
    const found: OAuthIdentity = { subject: payload.sub, ...(payload.kid ? { keyId: payload.kid } : {}) };
    return stillAllowed(found) ? found : null;
  }

  function subject(req: IncomingMessage): string | null {
    return identity(req)?.subject ?? null;
  }

  function authorized(req: IncomingMessage): boolean {
    return identity(req) !== null;
  }

  function challenge(res: ServerResponse, base: string): void {
    res.setHeader("WWW-Authenticate", `Bearer realm="relay-mcp", resource_metadata="${base}/.well-known/oauth-protected-resource"`);
  }

  return { handle, authorized, subject, identity, challenge };
}
