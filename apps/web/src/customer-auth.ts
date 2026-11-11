/**
 * Customer authentication for the Relay console.
 *
 * Separate from the operator SessionManager: different cookie and different
 * signing secret, so a customer session can never satisfy the operator gate.
 */
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { parseCookies } from "./http.js";


export const CUSTOMER_SESSION_COOKIE = "relay_customer_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12;
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface CustomerSession {
  customerId: string;
  sessionVersion: number;
  exp: number;
}

function scryptAsync(password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived as Buffer);
    });
  });
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export async function hashCustomerPassword(password: string): Promise<string> {
  if (password.length < 10) throw new Error("Password must be at least 10 characters.");
  const salt = randomBytes(16);
  const derived = (await scryptAsync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })) as Buffer;
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${base64url(salt)}$${base64url(derived)}`;
}

export async function verifyCustomerPassword(password: string, stored: string): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const salt = Buffer.from(parts[4]!, "base64url");
  const expected = Buffer.from(parts[5]!, "base64url");
  const actual = (await scryptAsync(password, salt, expected.length, { N: n, r, p })) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createInviteToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: createHash("sha256").update(token, "utf8").digest("hex") };
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Fixed-window attempt limiter; enough to stop trivial password spraying. */
export class LoginThrottle {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly max = 8, private readonly windowMs = 15 * 60 * 1000) {}

  check(key: string): void {
    const now = Date.now();
    const current = this.attempts.get(key);
    if (!current || current.resetAt <= now) {
      this.attempts.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    if (current.count >= this.max) {
      const error = new Error("Too many sign-in attempts. Try again later.");
      (error as Error & { code?: string }).code = "login_rate_limited";
      throw error;
    }
    current.count += 1;
  }

  clear(key: string): void {
    this.attempts.delete(key);
  }
}

export class CustomerAuth {
  readonly enabled: boolean;
  private readonly key: Buffer;
  private readonly secure: boolean;

  constructor(secret: string | null | undefined, options: { secure?: boolean } = {}) {
    const value = secret?.trim() ?? "";
    this.enabled = value.length >= 32;
    this.key = digest(`relay-customer-session-key:${value}`);
    this.secure = options.secure ?? true;
  }

  issueToken(input: { customerId: string; sessionVersion: number }): string {
    const payload = base64url(
      Buffer.from(
        JSON.stringify({
          v: 1,
          sub: input.customerId,
          sv: input.sessionVersion,
          exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
          nonce: randomBytes(9).toString("base64url"),
        }),
        "utf8",
      ),
    );
    return `${payload}.${this.sign(payload)}`;
  }

  verifyToken(token: string | null | undefined): CustomerSession | null {
    if (!this.enabled || !token) return null;
    const separator = token.lastIndexOf(".");
    if (separator <= 0) return null;
    const payload = token.slice(0, separator);
    const provided = Buffer.from(token.slice(separator + 1), "utf8");
    const expected = Buffer.from(this.sign(payload), "utf8");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
    try {
      const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
        v?: unknown; sub?: unknown; sv?: unknown; exp?: unknown;
      };
      if (parsed.v !== 1 || typeof parsed.sub !== "string" || typeof parsed.sv !== "number") return null;
      if (typeof parsed.exp !== "number" || parsed.exp <= Math.floor(Date.now() / 1000)) return null;
      return { customerId: parsed.sub, sessionVersion: parsed.sv, exp: parsed.exp };
    } catch {
      return null;
    }
  }

  sessionFromRequest(req: IncomingMessage): CustomerSession | null {
    return this.verifyToken(parseCookies(req.headers.cookie)[CUSTOMER_SESSION_COOKIE]);
  }

  cookieHeader(input: { customerId: string; sessionVersion: number }): string {
    return [
      `${CUSTOMER_SESSION_COOKIE}=${this.issueToken(input)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${SESSION_TTL_SECONDS}`,
      ...(this.secure ? ["Secure"] : []),
    ].join("; ");
  }

  clearCookieHeader(): string {
    return [
      `${CUSTOMER_SESSION_COOKIE}=`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      "Max-Age=0",
      "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
      ...(this.secure ? ["Secure"] : []),
    ].join("; ");
  }

  inviteTtlMs(): number {
    return INVITE_TTL_MS;
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.key).update(payload, "utf8").digest("base64url");
  }
}
