import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { AuthError, RelayError, errorMessage } from "@relay/core";
import type { AdapterContext, MediaItem, OAuthTokens } from "@relay/core";

/**
 * Small shared helpers for talking to the three providers.
 *
 * Every adapter receives its `fetch` from `AdapterContext`, so the same code
 * works against real provider APIs and against the injected fake fetch used by
 * the tests/verification scripts.
 */

export type JsonObject = Record<string, unknown>;

export function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function getString(object: JsonObject | undefined, key: string): string | undefined {
  return stringField(object?.[key]);
}

export function getNumber(object: JsonObject | undefined, key: string): number | undefined {
  const value = object?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Authorization header for bearer-token APIs. */
export function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** RFC 7617 basic auth, used by the X token endpoint. */
export function basicAuthorization(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`;
}

/** PKCE S256 challenge: base64url(sha256(verifier)), no padding. */
export function pkceChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

/**
 * TikTok deviates from RFC 7636: it expects the code challenge as lowercase
 * hex(sha256(verifier)), not base64url. Using the standard encoding makes the
 * token exchange fail with an opaque error.
 */
export function pkceChallengeHex(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("hex");
}

/** Builds an application/x-www-form-urlencoded body, dropping undefined values. */
export function formBody(fields: Record<string, string | undefined>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) body.set(key, value);
  }
  return body;
}

function parseBody(text: string): unknown {
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** True when a provider reports an error, including TikTok's HTTP-200 error envelope. */
export function hasProviderError(body: unknown): boolean {
  const object = asObject(body);
  if (!object) return false;
  if (typeof object.error === "string" && object.error.trim().length > 0) return true;
  const error = asObject(object.error);
  if (!error) return false;
  const code = error.code;
  if (code === undefined || code === null) {
    return Boolean(getString(error, "message") ?? getString(error, "type") ?? getString(error, "error"));
  }
  if (typeof code === "string" && (code.toLowerCase() === "ok" || code === "0")) return false;
  if (typeof code === "number" && code === 0) return false;
  return true;
}

/**
 * Extracts an actionable message from the many provider error shapes:
 * OAuth (`error`/`error_description`), X (`title`/`detail`), Meta
 * (`error.message`/`error.code`) and TikTok (`error.code`/`error.message`).
 */
export function providerMessage(body: unknown): string | undefined {
  const object = asObject(body);
  if (!object) return typeof body === "string" ? stringField(body.trim()) : undefined;

  const parts: string[] = [];
  const error = asObject(object.error);
  if (typeof object.error === "string" && object.error.trim().length > 0) {
    const description = getString(object, "error_description");
    parts.push(description ? `${object.error}: ${description}` : object.error);
  }
  if (error) {
    const message = getString(error, "message") ?? getString(error, "detail") ?? getString(error, "description");
    const code = error.code;
    const codeText = typeof code === "string" || typeof code === "number" ? String(code) : undefined;
    const codeSuffix = codeText && codeText.toLowerCase() !== "ok" && codeText !== "0" ? ` (${codeText})` : "";
    if (message) parts.push(`${message}${codeSuffix}`);
    else if (codeText && codeText.toLowerCase() !== "ok" && codeText !== "0") parts.push(codeText);
    // Include the rest of the provider error verbatim (Meta Graph and TikTok
    // both put actionable detail in fields beyond `message`/`code`).
    const extra = Object.entries(error)
      .filter(([key]) => !["message", "detail", "description", "code"].includes(key))
      .filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      .map(([key, value]) => `${key}=${String(value)}`);
    if (extra.length > 0) parts.push(extra.join(", "));
  }
  for (const entry of asArray(object.errors)) {
    const entryObject = asObject(entry);
    const message = getString(entryObject, "message") ?? getString(entryObject, "detail");
    if (message) {
      parts.push(message);
      break;
    }
  }
  const title = getString(object, "title");
  const detail = getString(object, "detail");
  if (title && detail) parts.push(`${title}: ${detail}`);
  else if (detail) parts.push(detail);
  else if (title) parts.push(title);
  for (const key of ["message", "error_description", "description"]) {
    const value = getString(object, key);
    if (value) {
      parts.push(value);
      break;
    }
  }
  const unique = [...new Set(parts.filter((part) => part.trim().length > 0))];
  return unique.length > 0 ? unique.join(": ") : undefined;
}

/** True when the failure is likely fixed by refreshing the access token. */
export function isAuthFailure(status: number, body: unknown): boolean {
  if (status === 401) return true;
  const error = asObject(asObject(body)?.error);
  if (!error) return false;
  const type = getString(error, "type");
  if (type && /oauth/i.test(type)) return true;
  const code = error.code;
  if (code === 190 || code === "190") return true;
  const codeText = typeof code === "string" ? code.toLowerCase() : undefined;
  if (!codeText) return false;
  return [
    "access_token_invalid",
    "access_token_expired",
    "invalid_access_token",
    "invalid_token",
    "token_expired",
    "auth_error",
  ].includes(codeText);
}

const PROVIDER_ERROR_FIELDS = [
  "message",
  "type",
  "code",
  "error_subcode",
  "error_user_title",
  "error_user_msg",
  "fbtrace_id",
  "log_id",
] as const;

/** Structured view of a Meta Graph / TikTok error object. */
export function providerErrorInfo(body: unknown): JsonObject | undefined {
  const error = asObject(asObject(body)?.error);
  if (!error) return undefined;
  const info: JsonObject = {};
  for (const field of PROVIDER_ERROR_FIELDS) {
    const value = error[field];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      if (typeof value === "string" && value.length === 0) continue;
      info[field] = value;
    }
  }
  return Object.keys(info).length > 0 ? info : undefined;
}

/** The provider-specific error code, when one is present. */
export function providerErrorCode(details: unknown): string | undefined {
  const code = asObject(asObject(details)?.provider)?.code;
  return typeof code === "string" || typeof code === "number" ? String(code) : undefined;
}

/** Recursively hides credentials so an error log can never leak a token. */
function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  const object = asObject(value);
  if (!object) return value;
  const redacted: JsonObject = {};
  for (const [key, entry] of Object.entries(object)) {
    redacted[key] = /token|secret|authorization|cookie|credential/i.test(key) ? "[redacted]" : redactSecrets(entry);
  }
  return redacted;
}

/**
 * Appends one JSON line per provider failure. Uses `<dataDir>/provider-errors.log`
 * when the context exposes a data directory, otherwise stderr. Tokens are never
 * written.
 */
function logProviderError(ctx: AdapterContext, label: string, status: number, body: unknown): void {
  const entry = {
    time: new Date().toISOString(),
    label,
    status,
    body: redactSecrets(body),
  };
  const line = JSON.stringify(entry);
  if (ctx.dataDir) {
    try {
      appendFileSync(join(ctx.dataDir, "provider-errors.log"), `${line}\n`, "utf8");
      return;
    } catch {
      // Fall through to stderr so the failure is still observable.
    }
  }
  console.error(line);
}

/**
 * Performs one provider request and normalizes failures:
 * - 401 (and token-specific error bodies) become `AuthError` so the core
 *   service refreshes the token and retries once; a 403 is a permission/policy
 *   failure and is not retried;
 * - everything else becomes a `RelayError` carrying the provider message.
 *
 * The parsed JSON body (or raw text) is returned on success.
 */
export async function providerFetch(
  ctx: AdapterContext,
  label: string,
  url: string,
  init: RequestInit = {},
): Promise<unknown> {
  let response: Response;
  try {
    response = await ctx.fetch(url, init);
  } catch (cause) {
    throw new RelayError(
      `${label} could not reach the provider: ${errorMessage(cause)}`,
      "provider_network_error",
      cause,
      502,
    );
  }

  let text = "";
  try {
    text = await response.text();
  } catch {
    text = "";
  }
  const body = parseBody(text);

  if (response.ok && !hasProviderError(body)) return body;

  logProviderError(ctx, label, response.status, body);
  const message = providerMessage(body) ?? (response.statusText || `HTTP ${response.status}`);
  const info = providerErrorInfo(body);
  const details = info ? { provider: info, body } : body;
  if (isAuthFailure(response.status, body)) throw new AuthError(`${label}: ${message}`, details);
  throw new RelayError(
    `${label}: ${message}`,
    "provider_error",
    details,
    response.status >= 400 && response.status < 500 ? response.status : 502,
  );
}

/** Normalizes the standard OAuth token response fields. */
export function oauthTokensFrom(json: unknown, now: Date): OAuthTokens {
  const object = asObject(json);
  const accessToken = getString(object, "access_token");
  if (!accessToken) {
    throw new RelayError("The provider did not return an access token", "provider_token_missing", json, 502);
  }
  const expiresIn = getNumber(object, "expires_in");
  return {
    accessToken,
    refreshToken: getString(object, "refresh_token"),
    expiresAt: expiresIn !== undefined ? new Date(now.getTime() + expiresIn * 1000).toISOString() : undefined,
    tokenType: getString(object, "token_type"),
    scope: getString(object, "scope"),
  };
}

/** Parses a scope string ("a b" or "a,b") and falls back to the requested scopes. */
export function scopesFrom(json: unknown, fallback: readonly string[]): string[] {
  const raw = getString(asObject(json), "scope");
  const parsed = raw ? raw.split(/[,\s]+/).filter((scope) => scope.length > 0) : [];
  return parsed.length > 0 ? parsed : [...fallback];
}

/**
 * Resolves the publicly reachable URL a URL-pull platform needs.
 * Throws a clear, actionable RelayError when none can be derived.
 */
export function publicMediaUrl(ctx: AdapterContext, item: MediaItem, platform: string): string {
  const url = ctx.mediaPublicUrl(item);
  if (!url) {
    throw new RelayError(
      `${platform} fetches media from a public URL. Set RELAY_PUBLIC_MEDIA_BASE_URL to a tunnel that serves this console, or pass media with a "url".`,
      "media_public_url_required",
    );
  }
  return url;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Splits a buffer into sequential chunks of at most `chunkSize` bytes. */
export function chunkBuffer(buffer: Buffer, chunkSize: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    chunks.push(buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length)));
  }
  return chunks;
}
