import type { IncomingMessage } from "node:http";
import { RelayError } from "@relay/core";
import type { CloudStore } from "./db.js";

export function apiKeyFromRequest(req: IncomingMessage): string | null {
  const explicit = req.headers["x-relay-api-key"];
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match) return null;
  const token = match[1]!.trim();
  // The owner bearer token is handled by the existing MCP HTTP layer. Only
  // Relay customer keys are considered here.
  return token.startsWith("rly_") ? token : null;
}

export function authenticateApiKey(store: CloudStore, req: IncomingMessage) {
  const raw = apiKeyFromRequest(req);
  if (!raw) {
    throw new RelayError("Missing Relay API key. Send Authorization: Bearer rly_... or X-Relay-Api-Key.", "cloud_api_key_missing", undefined, 401);
  }
  return store.resolveApiKey(raw);
}
