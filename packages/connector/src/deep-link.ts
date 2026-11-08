/** REQ-003: parse the one-click relay:// handoff without logging the token. */
import type { ClientId } from "./adapters/types.js";

export interface ConnectorHandoff {
  sessionId: string;
  token: string;
}

export interface ManageHandoff {
  action: "disconnect" | "repair";
  clientId: ClientId;
}

const CONNECT_SESSION_ID = /^cs_[A-Za-z0-9-]{8,80}$/;
const CONNECT_TOKEN = /^rcs_[0-9a-f]{10}_[A-Za-z0-9_-]{20,200}$/;
const CLIENT_IDS = new Set<ClientId>([
  "claude-desktop", "cursor", "claude-code", "codex", "vscode", "deepseek-harness",
  "grok", "grok-bot", "chatgpt", "n8n", "other",
]);

export function parseDeepLink(input: string): ConnectorHandoff {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Invalid relay:// link.");
  }
  if (url.protocol !== "relay:" || url.hostname !== "connect") {
    throw new Error("Not a relay://connect link.");
  }
  const sessionId = url.searchParams.get("session") ?? "";
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  const token = fragment.get("token") ?? "";
  if (!CONNECT_SESSION_ID.test(sessionId)) throw new Error("Invalid connect session id.");
  if (!CONNECT_TOKEN.test(token)) throw new Error("Invalid connect token.");
  return { sessionId, token };
}

export function parseHandoffArgs(args: string[]): ConnectorHandoff | null {
  const sessionIndex = args.indexOf("--session");
  const tokenIndex = args.indexOf("--token");
  if (sessionIndex < 0 || tokenIndex < 0) return null;
  const sessionId = args[sessionIndex + 1] ?? "";
  const token = args[tokenIndex + 1] ?? "";
  if (!CONNECT_SESSION_ID.test(sessionId)) throw new Error("Invalid --session value.");
  if (!CONNECT_TOKEN.test(token)) throw new Error("Invalid --token value.");
  return { sessionId, token };
}

/** REQ-018: local remove/repair handoff; no scoped token is needed. */
export function parseManageLink(input: string): ManageHandoff {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Invalid relay:// link.");
  }
  if (url.protocol !== "relay:" || url.hostname !== "manage") {
    throw new Error("Not a relay://manage link.");
  }
  const action = url.searchParams.get("action");
  const clientId = url.searchParams.get("client") ?? "";
  if (action !== "disconnect" && action !== "repair") throw new Error("Invalid manage action.");
  if (!CLIENT_IDS.has(clientId as ClientId)) throw new Error("Invalid manage client.");
  return { action, clientId: clientId as ClientId };
}
