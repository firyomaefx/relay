// REQ-003, REQ-021, REQ-027
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  fetchConnectSession,
  parseDeepLink,
  parseHandoffArgs,
  protocolCommands,
  startConsentServer,
} from "../../packages/connector/dist/index.js";

const SESSION = "cs_12345678-1234-1234-1234-123456789abc";
const TOKEN = "rcs_0123456789_abcdefghijklmnopqrstuvwxyz0123456789";

test("deep link and explicit args parse without exposing the token", () => {
  const link = `relay://connect?session=${SESSION}#token=${TOKEN}`;
  assert.deepEqual(parseDeepLink(link), { sessionId: SESSION, token: TOKEN });
  assert.deepEqual(parseHandoffArgs(["--session", SESSION, "--token", TOKEN]), { sessionId: SESSION, token: TOKEN });
  assert.equal(parseHandoffArgs(["--help"]), null);
  assert.throws(() => parseDeepLink("https://example.com"), /relay:\/\/connect/);
  assert.throws(() => parseDeepLink("relay://connect?session=bad#token=bad"), /session|token/i);
});

test("protocol commands target HKCU and quote the executable", () => {
  const commands = protocolCommands("C:\\Program Files\\Relay\\relay-connector.exe");
  assert.equal(commands.add.length, 3);
  assert.equal(commands.remove.length, 1);
  assert.match(commands.add[0].args.join(" "), /HKCU\\Software\\Classes\\relay/);
  assert.match(commands.add[2].args.join(" "), /"C:\\Program Files\\Relay\\relay-connector.exe" "%1"/);
});

test("session fetch sends the scoped bearer token", async () => {
  let seen = null;
  const view = await fetchConnectSession({
    apiBase: "https://relay.test",
    sessionId: SESSION,
    token: TOKEN,
    fetchImpl: async (url, init) => {
      seen = { url: String(url), auth: init?.headers?.authorization };
      return new Response(JSON.stringify({
        sessionId: SESSION,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        requestedClients: ["claude-desktop"],
        status: "pending",
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(seen.url, `https://relay.test/api/connect/session/${SESSION}`);
  assert.equal(seen.auth, `Bearer ${TOKEN}`);
  assert.deepEqual(view.requestedClients, ["claude-desktop"]);
});

test("consent server is loopback-only and does not render the token", async () => {
  const server = await startConsentServer({
    sessionId: SESSION,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    requestedClients: ["claude-desktop", "cursor"],
    status: "pending",
  });  try {
    const page = await fetch(server.url);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Relay Connector/);
    assert.equal(html.includes(TOKEN), false);
    const api = await fetch(`${server.url}api/session`);
    assert.equal(api.status, 200);
    assert.equal((await api.json()).sessionId, SESSION);

    const port = new URL(server.url).port;
    const rejected = await new Promise((resolve, reject) => {
      const request = http.request({ hostname: "127.0.0.1", port, path: "/", headers: { host: "evil.example" } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      request.on("error", reject);
      request.end();
    });
    assert.equal(rejected, 403);
  } finally {
    await server.close();
  }
});

test("consent install endpoint calls the Auto adapter and returns per-client state", async () => {
  let installed = 0;
  const adapter = {
    id: "claude-desktop",
    tier: "auto",
    detect: async () => ({ id: "claude-desktop", detected: true, path: "C:/tmp/config.json" }),
    plan: async () => [{ clientId: "claude-desktop", kind: "write-config", target: "C:/tmp/config.json" }],
    install: async () => { installed += 1; return { clientId: "claude-desktop", state: "connected", detail: "ok" }; },
    remove: async () => ({ clientId: "claude-desktop", state: "connected", detail: "removed" }),
  };
  const ctx = {
    appDataDir: "C:/tmp/appdata", localAppDataDir: "C:/tmp/local", homeDir: "C:/tmp/home",
    backupDir: "C:/tmp/backups", mcpUrl: "https://mcp.example/mcp", sessionToken: "",
    now: () => new Date(),
  };
  const server = await startConsentServer({
    sessionId: SESSION, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    requestedClients: ["claude-desktop"], status: "pending",
  }, { ctx, adapters: [adapter], apiBase: "https://relay.test", sessionToken: TOKEN, logger: () => {} });
  try {
    const clients = await (await fetch(`${server.url}api/clients`)).json();
    assert.equal(clients.clients[0].detected, true);
    const response = await fetch(`${server.url}api/install`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ clients: ["claude-desktop"] }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.results[0].state, "connected");
    assert.equal(installed, 1);
  } finally {
    await server.close();
  }
});
