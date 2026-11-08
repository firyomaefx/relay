/** REQ-016, REQ-030: minimal MCP initialize + tools/list verifier. */
export interface VerificationSuccess {
  protocolVersion: string;
  toolCount: number;
}

interface JsonRpcResponse {
  result?: { protocolVersion?: string; tools?: unknown[] };
  error?: { message?: string };
}

function parseBody(body: string, contentType: string): JsonRpcResponse {
  if (contentType.includes("text/event-stream")) {
    const lines = body.split(/\r?\n/).filter((line) => line.startsWith("data:"));
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(lines[index]!.slice("data:".length).trim()) as JsonRpcResponse;
      } catch {
        // Try the previous event.
      }
    }
    throw new Error("MCP server returned no JSON event.");
  }
  return JSON.parse(body) as JsonRpcResponse;
}

async function rpc(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  sessionId: string | null,
  payload: Record<string, unknown>,
): Promise<{ response: Response; body: JsonRpcResponse }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const response = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`MCP server returned HTTP ${response.status}.`);
  const text = await response.text();
  if (!text) return { response, body: {} };
  return { response, body: parseBody(text, response.headers.get("content-type") ?? "") };
}

export async function verifyMcp(
  mcpUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VerificationSuccess> {
  if (!mcpUrl) throw new Error("MCP URL is not configured.");
  if (!token) throw new Error("Verification credential is missing.");
  const init = await rpc(fetchImpl, mcpUrl, token, null, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "relay-verifier", version: "0.1.0" } },
  });
  if (init.body.error) throw new Error(init.body.error.message ?? "MCP initialize failed.");
  const sessionId = init.response.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("MCP server did not return a session id.");

  await rpc(fetchImpl, mcpUrl, token, sessionId, { jsonrpc: "2.0", method: "notifications/initialized" });
  const tools = await rpc(fetchImpl, mcpUrl, token, sessionId, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  if (tools.body.error) throw new Error(tools.body.error.message ?? "MCP tools/list failed.");
  const count = tools.body.result?.tools?.length ?? 0;
  if (count < 1) throw new Error("MCP server returned no tools.");
  return { protocolVersion: init.body.result?.protocolVersion ?? "unknown", toolCount: count };
}
