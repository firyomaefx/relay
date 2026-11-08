/** Short-lived connect-session API. No owner token is returned or logged. */
// REQ-002, REQ-003, REQ-030
import type { IncomingMessage, ServerResponse } from "node:http";
import { RelayError } from "@relay/core";
import type { CloudStore } from "@relay/cloud";
import { verifyMcp } from "@relay/connector";
import { asRecord, readJsonBody, sendJson } from "./http.js";

export interface ConnectSessionDeps {
  store: CloudStore;
}

function bearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    throw new RelayError("A scoped connect token is required.", "cloud_connect_session_token_missing", undefined, 401);
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token) throw new RelayError("A scoped connect token is required.", "cloud_connect_session_token_missing", undefined, 401);
  return token;
}

/** POST /api/connect/session — console-authenticated; creates one flow. */
export async function createConnectSession(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectSessionDeps,
): Promise<void> {
  const body = asRecord(await readJsonBody(req, 16 * 1024));
  const rawClients = body.clients;
  if (rawClients !== undefined && !Array.isArray(rawClients)) {
    throw new RelayError("clients must be an array.", "cloud_connect_clients_invalid", undefined, 400);
  }
  const clients = Array.isArray(rawClients)
    ? rawClients.filter((value): value is string => typeof value === "string")
    : [];
  const owner = deps.store.ensureOwnerCustomer("Owner");
  const session = deps.store.createConnectSession(owner.id, clients);
  const query = `session=${encodeURIComponent(session.id)}`;
  sendJson(res, 201, {
    sessionId: session.id,
    token: session.token,
    expiresAt: session.expiresAt,
    requestedClients: session.requestedClients,
    deepLink: `relay://connect?${query}#token=${encodeURIComponent(session.token)}`,
    manualCode: `${session.id}.${session.token}`,
  });
}

/** GET /api/connect/session/:id — Connector-authenticated; no console cookie. */
export async function lookupConnectSession(
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
  deps: ConnectSessionDeps,
): Promise<void> {
  const session = deps.store.getConnectSession(bearerToken(req), sessionId);
  sendJson(res, 200, {
    sessionId: session.id,
    expiresAt: session.expiresAt,
    requestedClients: session.requestedClients,
    status: session.status,
  });
}

/** POST /api/connect/verify — scoped-token auth; per-client initialize/tools/list. */
export async function verifyConnectSession(
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
  deps: ConnectSessionDeps & { mcpUrl: string },
): Promise<void> {
  const token = bearerToken(req);
  const session = deps.store.getConnectSession(token, sessionId);
  const body = asRecord(await readJsonBody(req, 16 * 1024));
  const rawClients = body.clients;
  if (rawClients !== undefined && !Array.isArray(rawClients)) {
    throw new RelayError("clients must be an array.", "cloud_connect_clients_invalid", undefined, 400);
  }
  const clients = Array.isArray(rawClients)
    ? rawClients.filter((value): value is string => typeof value === "string")
    : session.requestedClients;
  if (clients.length === 0) {
    throw new RelayError("No clients to verify.", "cloud_connect_clients_empty", undefined, 400);
  }

  const verificationToken = deps.store.createConnectToken(session.customerId, "connect-verification");
  let success: { protocolVersion: string; toolCount: number } | null = null;
  let failure = "";
  try {
    success = await verifyMcp(deps.mcpUrl, verificationToken.token);
  } catch (error) {
    failure = error instanceof Error ? error.message : "MCP verification failed.";
  } finally {
    deps.store.revokeConnectToken(verificationToken.id);
  }

  const checkedAt = new Date().toISOString();
  const results = clients.map((clientId) => {
    const result = success
      ? { sessionId, clientId, status: "connected" as const, detail: `MCP initialize + tools/list passed (${success.toolCount} tools).`, checkedAt }
      : { sessionId, clientId, status: "failed" as const, detail: failure, checkedAt };
    deps.store.saveConnectVerification(result);
    return result;
  });
  sendJson(res, 200, { results });
}
