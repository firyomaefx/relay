import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { CloudStore } from "../../packages/cloud/dist/index.js";
import { cleanupTempDir, makeTempDir, repoRoot, sleep, waitFor } from "../helpers.mjs";

const TOKEN_KEY = Buffer.alloc(32, 41).toString("base64");
const PORT = 44996;
const BASE = `http://127.0.0.1:${PORT}`;

test("cloud MCP supports OAuth discovery, registration and API-key authorization", async () => {
  const dir = await makeTempDir("relay-cloud-oauth-");
  const dbPath = path.join(dir, "cloud.sqlite");
  const store = CloudStore.open(dbPath);
  const customer = store.createCustomer({ displayName: "OAuth Customer" });
  const key = store.createApiKey(customer.id, "oauth");
  const connect = store.createConnectToken(customer.id, "one-click");
  store.close();

  const child = spawn(process.execPath, ["apps/mcp/dist/cloud-entry.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      RELAY_CLOUD_ENABLED: "1",
      RELAY_CLOUD_TOKEN_KEY: TOKEN_KEY,
      RELAY_CLOUD_DB: dbPath,
      RELAY_CLOUD_DATA_DIR: path.join(dir, "tenants"),
      RELAY_DATA_DIR: path.join(dir, "owner"),
      RELAY_CLOUD_MCP_PORT: String(PORT),
      RELAY_CLOUD_PUBLIC_URL: BASE,
      RELAY_MOCK: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitFor(async () => {
      try { return (await fetch(`${BASE}/health`)).ok; } catch { return false; }
    }, { label: "cloud MCP health" });

    const metadata = await fetch(`${BASE}/.well-known/oauth-protected-resource`);
    assert.equal(metadata.status, 200);
    const resource = await metadata.json();
    assert.equal(resource.resource, `${BASE}/mcp`);

    const registration = await fetch(`${BASE}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "test", redirect_uris: ["http://localhost:9876/callback"] }),
    });
    assert.equal(registration.status, 201);
    const client = await registration.json();
    assert.ok(client.client_id);

    const redirectUri = "http://localhost:9876/callback";
    const authorizeUrl = new URL(`${BASE}/authorize`);
    authorizeUrl.searchParams.set("client_id", client.client_id);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("state", "state-1");
    authorizeUrl.searchParams.set("code_challenge", "challenge");
    authorizeUrl.searchParams.set("code_challenge_method", "plain");
    const page = await fetch(authorizeUrl);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Relay Cloud API key/);

    const form = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      state: "state-1",
      code_challenge: "challenge",
      code_challenge_method: "plain",
      password: key.key,
    });
    const authorize = await fetch(`${BASE}/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
      redirect: "manual",
    });
    assert.equal(authorize.status, 302);
    const location = authorize.headers.get("location");
    assert.ok(location);
    const code = new URL(location).searchParams.get("code");
    assert.ok(code);

    const tokenResponse = await fetch(`${BASE}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_verifier: "challenge",
      }),
    });
    assert.equal(tokenResponse.status, 200);
    const tokens = await tokenResponse.json();
    assert.ok(tokens.access_token);

    const mcp = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } }),
    });
    assert.equal(mcp.status, 200);
    const body = await mcp.json();
    assert.equal(body.result.serverInfo.name, "relay-cloud");

    const direct = await fetch(`${BASE}/mcp?token=${encodeURIComponent(connect.token)}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "direct", version: "0" } } }),
    });
    assert.equal(direct.status, 200);
    const directBody = await direct.json();
    assert.equal(directBody.result.serverInfo.name, "relay-cloud");
  } finally {
    child.kill("SIGTERM");
    await sleep(300);
    await cleanupTempDir(dir);
  }
});


