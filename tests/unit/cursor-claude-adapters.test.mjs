// REQ-007, REQ-008, REQ-019, REQ-024
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { claudeCodeAdapter, cursorAdapter } from "../../packages/connector/dist/index.js";
import { cleanupTempDir, makeTempDir } from "../helpers.mjs";

async function fixture() {
  const root = await makeTempDir("relay-cursor-adapter-");
  const homeDir = path.join(root, "home");
  await mkdir(path.join(homeDir, ".cursor"), { recursive: true });
  const ctx = {
    appDataDir: path.join(root, "appdata"),
    localAppDataDir: path.join(root, "local"),
    homeDir,
    backupDir: path.join(root, "backups"),
    mcpUrl: "https://cloud-mcp.duitpoket.fun/mcp",
    sessionToken: "session-token",
    now: () => new Date("2026-11-07T00:00:00.000Z"),
  };
  return { root, homeDir, ctx };
}

test("Cursor adapter preserves other servers, backs up and removes only Relay", async () => {
  const { root, homeDir, ctx } = await fixture();
  try {
    const file = path.join(homeDir, ".cursor", "mcp.json");
    await writeFile(file, JSON.stringify({ mcpServers: { existing: { url: "https://example.test/mcp" } } }), "utf8");
    assert.equal((await cursorAdapter.detect(ctx)).detected, true);
    const installed = await cursorAdapter.install({ clientId: "cursor", kind: "write-config", target: file }, ctx);
    assert.equal(installed.state, "connected");
    const after = JSON.parse(await readFile(file, "utf8"));
    assert.equal(after.mcpServers.relay.url, ctx.mcpUrl);
    assert.equal(after.mcpServers.existing.url, "https://example.test/mcp");
    assert.equal((await readdir(ctx.backupDir)).length, 1);

    const removed = await cursorAdapter.remove(ctx);
    assert.equal(removed.state, "connected");
    const final = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(final.mcpServers, { existing: { url: "https://example.test/mcp" } });
  } finally {
    await cleanupTempDir(root);
  }
});

test("Claude Code adapter uses the supported CLI with scoped arguments", async () => {
  const { root, homeDir, ctx } = await fixture();
  try {
    await writeFile(path.join(homeDir, ".claude.json"), "{}", "utf8");
    const calls = [];
    const fake = { ...ctx, runCommand: async (file, args) => { calls.push({ file, args }); return { code: 0, stdout: "", stderr: "" }; } };
    assert.equal((await claudeCodeAdapter.detect(fake)).detected, true);
    const installed = await claudeCodeAdapter.install({ clientId: "claude-code", kind: "run-cli", target: "claude" }, fake);
    assert.equal(installed.state, "connected");
    assert.deepEqual(calls[0], { file: "claude", args: ["mcp", "add", "--transport", "http", "--scope", "user", "relay", ctx.mcpUrl] });

    const removed = await claudeCodeAdapter.remove(fake);
    assert.equal(removed.state, "connected");
    assert.deepEqual(calls[1], { file: "claude", args: ["mcp", "remove", "relay", "--scope", "user"] });

    const failed = { ...ctx, runCommand: async () => ({ code: 2, stdout: "", stderr: "not logged in" }) };
    const result = await claudeCodeAdapter.install({ clientId: "claude-code", kind: "run-cli", target: "claude" }, failed);
    assert.equal(result.state, "failed");
    assert.match(result.detail, /not logged in/);
  } finally {
    await cleanupTempDir(root);
  }
});
