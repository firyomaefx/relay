// Traceability: REQ-016
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import test from "node:test";
import { CloudStore } from "../../packages/cloud/dist/index.js";
import { cleanupTempDir, makeTempDir, repoRoot, sleep, waitFor } from "../helpers.mjs";

const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const FORM = { "content-type": "application/x-www-form-urlencoded" };

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function startServer(port, dir, store) {
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["apps/mcp/dist/cloud-entry.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      RELAY_CLOUD_ENABLED: "1",
      RELAY_CLOUD_TOKEN_KEY: Buffer.alloc(32, 53).toString("base64"),
      RELAY_CLOUD_DB: path.join(dir, "cloud.sqlite"),
      RELAY_CLOUD_DATA_DIR: path.join(dir, "tenants"),
      RELAY_DATA_DIR: path.join(dir, "owner"),
      RELAY_CLOUD_MCP_PORT: String(port),
      RELAY_CLOUD_PUBLIC_URL: base,
      RELAY_MOCK: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitFor(async () => {
    try { return (await fetch(`${base}/health`)).ok; } catch { return false; }
  }, { label: "cloud MCP health" });
  return { base, child };
}

async function register(base, redirectUris) {
  return fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: redirectUris }),
  });
}

function authorizeUrl(base, clientId, redirectUri, extra = {}) {
  const url = new URL(`${base}/authorize`);
  const params = { client_id: clientId, redirect_uri: redirectUri, response_type: "code", state: "s1", ...extra };
  for (const [name, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(name, value);
  return url;
}

async function signIn(base, clientId, redirectUri, key, challenge) {
  const response = await fetch(`${base}/authorize`, {
    method: "POST",
    headers: FORM,
    body: new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      state: "s1",
      code_challenge: challenge,
      code_challenge_method: "S256",
      password: key,
    }),
    redirect: "manual",
  });
  return response;
}

async function mcpCall(base, accessToken, method, id = 1) {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } : {} }),
  });
}

async function fullFlow(base, key) {
  const registration = await register(base, [CLAUDE_CALLBACK]);
  assert.equal(registration.status, 201);
  const { client_id: clientId } = await registration.json();
  const { verifier, challenge } = pkce();
  const authorize = await signIn(base, clientId, CLAUDE_CALLBACK, key, challenge);
  assert.equal(authorize.status, 302);
  const location = new URL(authorize.headers.get("location"));
  assert.equal(location.origin + location.pathname, CLAUDE_CALLBACK);
  assert.equal(location.searchParams.get("state"), "s1");
  assert.equal(location.searchParams.get("iss"), base);
  const token = await fetch(`${base}/token`, {
    method: "POST",
    headers: FORM,
    body: new URLSearchParams({ grant_type: "authorization_code", code: location.searchParams.get("code"), client_id: clientId, redirect_uri: CLAUDE_CALLBACK, code_verifier: verifier }),
  });
  assert.equal(token.status, 200);
  return { clientId, tokens: await token.json() };
}

test("OAuth: callback allowlist, S256 only, consent page, full Claude flow", async () => {
  const dir = await makeTempDir("relay-oauth-hard-");
  const store = CloudStore.open(path.join(dir, "cloud.sqlite"));
  const customer = store.createCustomer({ displayName: "Hardening Customer" });
  const key = store.createApiKey(customer.id, "hardening");
  store.close();
  const { base, child } = await startServer(45011, dir);
  try {
    const metadata = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
    assert.equal(metadata.authorization_response_iss_parameter_supported, true);

    // Registration: only allowlisted callbacks.
    assert.equal((await register(base, ["https://evil.example/cb"])).status, 400);
    assert.equal((await register(base, [CLAUDE_CALLBACK, "https://evil.example/cb"])).status, 400);
    assert.equal((await register(base, ["http://localhost:3118/callback"])).status, 201);
    assert.equal((await register(base, ["https://chatgpt.com/connector_platform_oauth_redirect"])).status, 201);

    const { clientId } = await (async () => {
      const response = await register(base, [CLAUDE_CALLBACK]);
      const body = await response.json();
      return { clientId: body.client_id };
    })();
    const { challenge } = pkce();

    // Authorize: S256 is mandatory.
    assert.equal((await fetch(authorizeUrl(base, clientId, CLAUDE_CALLBACK))).status, 400, "no challenge");
    assert.equal((await fetch(authorizeUrl(base, clientId, CLAUDE_CALLBACK, { code_challenge: challenge }))).status, 400, "no method");
    assert.equal((await fetch(authorizeUrl(base, clientId, CLAUDE_CALLBACK, { code_challenge: challenge, code_challenge_method: "plain" }))).status, 400, "plain");
    assert.equal((await fetch(authorizeUrl(base, clientId, "https://evil.example/cb", { code_challenge: challenge, code_challenge_method: "S256" }))).status, 400, "unregistered redirect");

    // Consent page: names the callback host, labels the field, refuses framing.
    const page = await fetch(authorizeUrl(base, clientId, CLAUDE_CALLBACK, { code_challenge: challenge, code_challenge_method: "S256" }));
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.match(page.headers.get("cache-control"), /no-store/);
    const html = await page.text();
    assert.match(html, /Relay Cloud API key/);
    assert.match(html, /claude\.ai/);
    assert.match(html, /Connect Claude to your Relay account/);
    assert.match(html, /width=device-width/);
    assert.match(html, /rly_/);

    // A plain-PKCE POST is refused as well.
    const plainPost = await fetch(`${base}/authorize`, {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams({ client_id: clientId, redirect_uri: CLAUDE_CALLBACK, response_type: "code", code_challenge: challenge, code_challenge_method: "plain", password: key.key }),
      redirect: "manual",
    });
    assert.equal(plainPost.status, 400);

    // Full flow through to tools/list.
    const { tokens } = await fullFlow(base, key.key);
    const init = await mcpCall(base, tokens.access_token, "initialize");
    assert.equal(init.status, 200);
    const list = await mcpCall(base, tokens.access_token, "tools/list", 2);
    assert.equal(list.status, 200);
    const names = (await list.json()).result.tools.map((tool) => tool.name);
    assert.ok(names.includes("relay_post"));
    assert.ok(names.includes("relay_balance"));

    // PKCE verifier must match.
    const reg = await (await register(base, [CLAUDE_CALLBACK])).json();
    const good = pkce();
    const auth = await signIn(base, reg.client_id, CLAUDE_CALLBACK, key.key, good.challenge);
    const bad = await fetch(`${base}/token`, {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams({ grant_type: "authorization_code", code: new URL(auth.headers.get("location")).searchParams.get("code"), client_id: reg.client_id, redirect_uri: CLAUDE_CALLBACK, code_verifier: pkce().verifier }),
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, "invalid_grant");
  } finally {
    child.kill("SIGTERM");
    await sleep(300);
    await cleanupTempDir(dir);
  }
});

test("OAuth: revoking the key or disabling the customer stops access and refresh at once", async () => {
  const dir = await makeTempDir("relay-oauth-revoke-");
  const dbPath = path.join(dir, "cloud.sqlite");
  const store = CloudStore.open(dbPath);
  const revokedCustomer = store.createCustomer({ displayName: "Revoked Key" });
  const revokedKey = store.createApiKey(revokedCustomer.id, "will-be-revoked");
  const otherKey = store.createApiKey(revokedCustomer.id, "stays-active");
  const disabledCustomer = store.createCustomer({ displayName: "Disabled Customer" });
  const disabledKey = store.createApiKey(disabledCustomer.id, "disabled");
  store.close();
  const { base, child } = await startServer(45012, dir);
  try {
    const a = await fullFlow(base, revokedKey.key);
    const b = await fullFlow(base, otherKey.key);
    const c = await fullFlow(base, disabledKey.key);
    for (const flow of [a, b, c]) assert.equal((await mcpCall(base, flow.tokens.access_token, "initialize")).status, 200);

    const writer = CloudStore.open(dbPath);
    writer.revokeApiKey(revokedKey.id);
    writer.close();
    const raw = new DatabaseSync(dbPath);
    raw.prepare("UPDATE customers SET status = 'disabled' WHERE id = ?").run(disabledCustomer.id);
    raw.close();

    // Revoked key: access and refresh both fail. A second key of the same customer is unaffected.
    assert.equal((await mcpCall(base, a.tokens.access_token, "initialize")).status, 401);
    const refreshA = await fetch(`${base}/token`, { method: "POST", headers: FORM, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: a.tokens.refresh_token, client_id: a.clientId }) });
    assert.equal(refreshA.status, 400);
    assert.equal((await refreshA.json()).error, "invalid_grant");
    assert.equal((await mcpCall(base, b.tokens.access_token, "initialize")).status, 200);
    const refreshB = await fetch(`${base}/token`, { method: "POST", headers: FORM, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: b.tokens.refresh_token, client_id: b.clientId }) });
    assert.equal(refreshB.status, 200);
    assert.ok((await refreshB.json()).access_token);

    // Disabled customer: same.
    assert.equal((await mcpCall(base, c.tokens.access_token, "initialize")).status, 401);
    const refreshC = await fetch(`${base}/token`, { method: "POST", headers: FORM, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: c.tokens.refresh_token, client_id: c.clientId }) });
    assert.equal(refreshC.status, 400);

    // The revoked key cannot sign in again either.
    const reg = await (await register(base, [CLAUDE_CALLBACK])).json();
    const again = await signIn(base, reg.client_id, CLAUDE_CALLBACK, revokedKey.key, pkce().challenge);
    assert.equal(again.status, 401);
  } finally {
    child.kill("SIGTERM");
    await sleep(300);
    await cleanupTempDir(dir);
  }
});

test("OAuth: failed key attempts are rate limited per IP, a good key from another IP still works", async () => {
  const dir = await makeTempDir("relay-oauth-rate-");
  const store = CloudStore.open(path.join(dir, "cloud.sqlite"));
  const customer = store.createCustomer({ displayName: "Rate Customer" });
  const key = store.createApiKey(customer.id, "rate");
  store.close();
  const { base, child } = await startServer(45013, dir);
  try {
    const reg = await (await register(base, [CLAUDE_CALLBACK])).json();
    const { challenge } = pkce();
    const attempt = (secret, ip) => fetch(`${base}/authorize`, {
      method: "POST",
      headers: { ...FORM, "cf-connecting-ip": ip },
      body: new URLSearchParams({ client_id: reg.client_id, redirect_uri: CLAUDE_CALLBACK, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", password: secret }),
      redirect: "manual",
    });
    for (let i = 0; i < 8; i += 1) assert.equal((await attempt("rly_wrong_key", "203.0.113.7")).status, 401, `attempt ${i + 1}`);
    // The ninth try is blocked, even with the right key.
    const blocked = await attempt(key.key, "203.0.113.7");
    assert.equal(blocked.status, 429);
    assert.ok(blocked.headers.get("retry-after"));
    assert.match(await blocked.text(), /Too many wrong attempts/);
    // Another network is not affected.
    assert.equal((await attempt(key.key, "203.0.113.99")).status, 302);
  } finally {
    child.kill("SIGTERM");
    await sleep(300);
    await cleanupTempDir(dir);
  }
});
