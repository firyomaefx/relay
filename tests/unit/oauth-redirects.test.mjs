// Traceability: REQ-016
import assert from "node:assert/strict";
import test from "node:test";
import {
  OAUTH_FIXED_REDIRECT_URIS,
  createMemoryAttemptGate,
  isAllowedRedirectUri,
  redirectMatches,
} from "../../apps/mcp/dist/oauth.js";

test("registration accepts Claude, ChatGPT and loopback callbacks", () => {
  for (const uri of [
    "https://claude.ai/api/mcp/auth_callback",
    "https://claude.com/api/mcp/auth_callback",
    "https://chatgpt.com/connector_platform_oauth_redirect",
    "https://chatgpt.com/connector/oauth/abc123_DEF-456",
    "http://localhost:3118/callback",
    "http://127.0.0.1:54321/callback",
    "http://[::1]:8080/callback",
    "http://localhost/callback",
  ]) {
    assert.equal(isAllowedRedirectUri(uri), true, uri);
  }
  assert.equal(OAUTH_FIXED_REDIRECT_URIS.length, 3);
});

test("registration refuses every other callback", () => {
  for (const uri of [
    "https://evil.example/callback",
    "https://claude.ai/other/path",
    "https://claude.ai/api/mcp/auth_callback?x=1",
    "https://claude.ai.evil.example/api/mcp/auth_callback",
    "https://evil.example/https://claude.ai/api/mcp/auth_callback",
    "https://chatgpt.com/connector/oauth/",
    "https://chatgpt.com/connector/oauth/a/b",
    "http://claude.ai/api/mcp/auth_callback",
    "http://evil.example:3000/callback",
    "http://localhost.evil.example/callback",
    "https://user:pw@claude.ai/api/mcp/auth_callback",
    "https://claude.ai/api/mcp/auth_callback#frag",
    "javascript:alert(1)",
    "cursor://anysphere.cursor-retrieval/oauth/callback",
    "not a url",
    "",
  ]) {
    assert.equal(isAllowedRedirectUri(uri), false, uri);
  }
});

test("an operator can allow one extra exact https callback", () => {
  const extra = ["https://app.example.com/oauth/callback"];
  assert.equal(isAllowedRedirectUri("https://app.example.com/oauth/callback", extra), true);
  assert.equal(isAllowedRedirectUri("https://app.example.com/oauth/other", extra), false);
  assert.equal(isAllowedRedirectUri("http://app.example.com/oauth/callback", extra), false);
});

test("loopback callbacks match ignoring the port, other callbacks match exactly", () => {
  const registered = ["http://localhost:3118/callback", "https://claude.ai/api/mcp/auth_callback"];
  assert.equal(redirectMatches(registered, "http://localhost:3118/callback"), true);
  assert.equal(redirectMatches(registered, "http://localhost:60001/callback"), true);
  assert.equal(redirectMatches(registered, "http://127.0.0.1:3118/callback"), false);
  assert.equal(redirectMatches(registered, "http://localhost:3118/other"), false);
  assert.equal(redirectMatches(registered, "https://claude.ai/api/mcp/auth_callback"), true);
  assert.equal(redirectMatches(registered, "https://claude.ai/api/mcp/auth_callback/"), false);
  assert.equal(redirectMatches(["https://claude.ai/api/mcp/auth_callback"], "http://localhost:1/callback"), false);
});

test("attempt gate blocks after the limit and opens again when the window ends", () => {
  let now = 1_000_000;
  const gate = createMemoryAttemptGate(3, 60_000, () => now);
  assert.equal(gate.blocked("1.2.3.4"), false);
  gate.record("1.2.3.4");
  gate.record("1.2.3.4");
  assert.equal(gate.blocked("1.2.3.4"), false);
  gate.record("1.2.3.4");
  assert.equal(gate.blocked("1.2.3.4"), true);
  assert.equal(gate.blocked("5.6.7.8"), false);
  now += 60_001;
  assert.equal(gate.blocked("1.2.3.4"), false);
});
