/**
 * Optional password protection for the console.
 *
 * A successful login receives an HMAC-signed, HttpOnly cookie. The signing key
 * is derived from the password, so restarts keep sessions valid and no extra
 * secret needs to be stored. Password comparisons are constant time.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { parseCookies } from "./http.js";

export const SESSION_COOKIE = "relay_console_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export class SessionManager {
  readonly enabled: boolean;
  private readonly password: string;
  private readonly key: Buffer;

  constructor(password: string | null | undefined) {
    this.password = password ?? "";
    this.enabled = this.password.length > 0;
    this.key = digest(`relay-console-session-key:${this.password}`);
  }

  /** Constant-time password check; always false when no password is configured. */
  verifyPassword(candidate: unknown): boolean {
    if (!this.enabled) return false;
    if (typeof candidate !== "string") return false;
    return timingSafeEqual(digest(candidate), digest(this.password));
  }

  issueToken(): string {
    const payload = Buffer.from(
      JSON.stringify({
        exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
        nonce: randomBytes(9).toString("base64url"),
      }),
      "utf8",
    ).toString("base64url");
    return `${payload}.${this.sign(payload)}`;
  }

  verifyToken(token: string | null | undefined): boolean {
    if (!this.enabled) return true;
    if (!token) return false;
    const separator = token.lastIndexOf(".");
    if (separator <= 0) return false;
    const payload = token.slice(0, separator);
    const provided = Buffer.from(token.slice(separator + 1), "utf8");
    const expected = Buffer.from(this.sign(payload), "utf8");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return false;
    try {
      const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
      return typeof parsed.exp === "number" && parsed.exp > Math.floor(Date.now() / 1000);
    } catch {
      return false;
    }
  }

  authenticated(req: IncomingMessage): boolean {
    if (!this.enabled) return true;
    return this.verifyToken(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  }

  cookieHeader(): string {
    return [
      `${SESSION_COOKIE}=${this.issueToken()}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${SESSION_TTL_SECONDS}`,
    ].join("; ");
  }

  clearCookieHeader(): string {
    return [
      `${SESSION_COOKIE}=`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      "Max-Age=0",
      "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    ].join("; ");
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.key).update(payload, "utf8").digest("base64url");
  }
}
