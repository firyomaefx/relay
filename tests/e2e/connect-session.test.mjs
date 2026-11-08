// REQ-002, REQ-003, REQ-030
import assert from "node:assert/strict";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { cleanupTempDir, httpJson, makeTempDir, requestSummary, startWebServer } from "../helpers.mjs";

const PORT = 45761;

async function fakeMcp() {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const payload = JSON.parse(body);
      if (!String(req.headers.authorization ?? "").startsWith("Bearer rlc_")) {
        res.writeHead(401).end("unauthorized");
        return;
      }
      if (payload.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { protocolVersion: "2025-06-18" } }));
      } else if (payload.method === "notifications/initialized") {
        res.writeHead(202).end();
      } else if (payload.method === "tools/list") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { tools: [{ name: "relay_post" }] } }));
      } else {
        res.writeHead(400).end("bad method");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("connect session API creates a scoped session and authenticates the Connector", async () => {
  const dir = await makeTempDir("relay-connect-session-web-");
  const dbPath = path.join(dir, "cloud.sqlite");
  const mcp = await fakeMcp();
  const server = await startWebServer({
    dataDir: path.join(dir, "owner"),
    port: PORT,
    label: "connect-session-web",
    env: {
      RELAY_CLOUD_ENABLED: "1",
      RELAY_CLOUD_TOKEN_KEY: Buffer.alloc(32, 41).toString("base64"),
      RELAY_CLOUD_DB: dbPath,
      RELAY_CLOUD_DATA_DIR: path.join(dir, "tenants"),
      RELAY_CLOUD_MCP_URL: mcp.url,
      RELAY_CONSOLE_PASSWORD: "test-password",
    },
  });

  try {
    const unauthorized = await httpJson(server.baseUrl, "/api/connect/session", {
      method: "POST",
      body: { clients: ["claude-desktop"] },
    });
    assert.equal(unauthorized.status, 401, requestSummary(unauthorized));

    const login = await httpJson(server.baseUrl, "/api/login", {
      method: "POST",
      body: { password: "test-password" },
    });
    assert.equal(login.status, 200, requestSummary(login));
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie, "login must set a console cookie");

    const created = await httpJson(server.baseUrl, "/api/connect/session", {
      method: "POST",
      headers: { cookie },
      body: { clients: ["claude-desktop", "cursor"] },
    });
    assert.equal(created.status, 201, requestSummary(created));
    assert.match(created.json.sessionId, /^cs_/);
    assert.match(created.json.token, /^rcs_/);
    assert.match(created.json.deepLink, /^relay:\/\/connect\?session=/);
    assert.equal(created.json.requestedClients.includes("claude-desktop"), true);
    assert.equal(new Date(created.json.expiresAt).getTime() > Date.now(), true);

    const lookup = await httpJson(server.baseUrl, `/api/connect/session/${created.json.sessionId}`, {
      headers: { authorization: `Bearer ${created.json.token}` },
    });
    assert.equal(lookup.status, 200, requestSummary(lookup));
    assert.equal(lookup.json.sessionId, created.json.sessionId);
    assert.equal(lookup.json.status, "pending");

    const noToken = await httpJson(server.baseUrl, `/api/connect/session/${created.json.sessionId}`);
    assert.equal(noToken.status, 401, requestSummary(noToken));

    const wrongToken = await httpJson(server.baseUrl, `/api/connect/session/${created.json.sessionId}`, {
      headers: { authorization: "Bearer rcs_wrong_token" },
    });
    assert.equal(wrongToken.status, 401, requestSummary(wrongToken));

    const badBody = await httpJson(server.baseUrl, "/api/connect/session", {
      method: "POST",
      headers: { cookie },
      body: { clients: "not-an-array" },
    });
    assert.equal(badBody.status, 400, requestSummary(badBody));

    const noClients = await httpJson(server.baseUrl, "/api/connect/clients");
    assert.equal(noClients.status, 401, requestSummary(noClients));

    const clients = await httpJson(server.baseUrl, "/api/connect/clients", { headers: { cookie } });
    assert.equal(clients.status, 200, requestSummary(clients));
    assert.equal(clients.json.clients.length, 11);
    assert.equal(clients.json.clients.filter((entry) => entry.tier === "auto").length, 3);
    assert.match(clients.json.mcpUrl, /\/mcp$/);

    const artifact = await httpJson(server.baseUrl, "/api/connect/artifact/codex", { headers: { cookie } });
    assert.equal(artifact.status, 200, requestSummary(artifact));
    assert.match(artifact.json.body, /\[mcp_servers\.relay\]/);
    assert.equal(artifact.json.body.includes("rcs_"), false);
    assert.equal(artifact.json.body.includes("rlc_"), false);

    const autoArtifact = await httpJson(server.baseUrl, "/api/connect/artifact/claude-desktop", { headers: { cookie } });
    assert.equal(autoArtifact.status, 404, requestSummary(autoArtifact));

    const verified = await httpJson(server.baseUrl, "/api/connect/verify", {
      method: "POST",
      headers: { authorization: `Bearer ${created.json.token}` },
      body: { sessionId: created.json.sessionId, clients: ["claude-desktop", "cursor"] },
    });
    assert.equal(verified.status, 200, requestSummary(verified));
    assert.equal(verified.json.results.length, 2);
    assert.equal(verified.json.results.every((result) => result.status === "connected"), true);
    assert.match(verified.json.results[0].detail, /tools\/list passed/);

    const status = await httpJson(server.baseUrl, `/api/connect/status/${created.json.sessionId}`, { headers: { cookie } });
    assert.equal(status.status, 200, requestSummary(status));
    assert.equal(status.json.results.length, 2);
    assert.equal(status.json.results.every((result) => result.status === "connected"), true);

    const noVerifyToken = await httpJson(server.baseUrl, "/api/connect/verify", {
      method: "POST",
      body: { sessionId: created.json.sessionId, clients: ["claude-desktop"] },
    });
    assert.equal(noVerifyToken.status, 401, requestSummary(noVerifyToken));
  } finally {
    await server.stop();
    await mcp.close();
    await cleanupTempDir(dir);
  }
});
