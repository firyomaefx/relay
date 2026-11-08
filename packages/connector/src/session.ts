/** REQ-003, REQ-030: fetch the scoped session; never log or persist the token. */

export interface ConnectSessionView {
  sessionId: string;
  expiresAt: string;
  requestedClients: string[];
  status: string;
}

export interface FetchSessionOptions {
  apiBase: string;
  sessionId: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export async function fetchConnectSession(options: FetchSessionOptions): Promise<ConnectSessionView> {
  const base = options.apiBase.replace(/\/+$/, "");
  const response = await (options.fetchImpl ?? fetch)(
    `${base}/api/connect/session/${encodeURIComponent(options.sessionId)}`,
    {
      headers: { authorization: `Bearer ${options.token}` },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) throw new Error(`Session lookup failed (${response.status}).`);
  const value = (await response.json()) as Partial<ConnectSessionView>;
  if (
    typeof value.sessionId !== "string" ||
    typeof value.expiresAt !== "string" ||
    !Array.isArray(value.requestedClients) ||
    typeof value.status !== "string"
  ) {
    throw new Error("Session response was malformed.");
  }
  return {
    sessionId: value.sessionId,
    expiresAt: value.expiresAt,
    requestedClients: value.requestedClients.filter((item): item is string => typeof item === "string"),
    status: value.status,
  };
}
