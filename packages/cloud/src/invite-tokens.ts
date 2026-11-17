import { createHash, randomBytes } from "node:crypto";

export function createInviteToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: createHash("sha256").update(token, "utf8").digest("hex") };
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export const SETUP_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const RESET_INVITE_TTL_MS = 24 * 60 * 60 * 1000;