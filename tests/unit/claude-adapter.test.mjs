// REQ-006, REQ-019, REQ-024
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { claudeDesktopAdapter } from "../../packages/connector/dist/index.js";
import { cleanupTempDir, makeTempDir } from "../helpers.mjs";

async function fixture() {
  const root = await makeTempDir("relay-claude-adapter-");
  const appDataDir = path.join(root, "appdata");
  const configDir = path.join(appDataDir, "Claude");
  await mkdir(configDir, { recursive: true });
  const configPath = path.join(configDir, "claude_desktop_config.json");
  const ctx = {
    appDataDir,
    localAppDataDir: path.join(root, "local"),
    backupDir: path.join(root, "backups"),
    mcpUrl: "https://cloud-mcp.duitpoket.fun/mcp",
    sessionToken: "session-token",
    now: () => new Date("2026-11-07T00:00:00.000Z"),
  };
  return { root, configPath, ctx };
}

test("Claude adapter preserves other servers, backs up, and is idempotent", async () => {
  const { root, configPath, ctx } = await fixture();
  try {
    await writeFile(configPath, JSON.stringify({
      mcpServers: { existing: { command: "node", args: ["existing.js"] } },
      preferences: { theme: "dark" },
    }), "utf8");

    assert.equal((await claudeDesktopAdapter.detect(ctx)).detected, true);
    const installed = await claudeDesktopAdapter.install({ clientId: "claude-desktop", kind: "write-config", target: configPath }, ctx);
    assert.equal(installed.state, "connected");
    assert.equal(installed.restartRequired, true);
    assert.ok(installed.backupPath);

    const after = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(after.mcpServers.existing, { command: "node", args: ["existing.js"] });
    assert.equal(after.mcpServers.relay.url, ctx.mcpUrl);
    assert.deepEqual(after.preferences, { theme: "dark" });
    assert.equal((await readdir(ctx.backupDir)).length, 1);

    const again = await claudeDesktopAdapter.install({ clientId: "claude-desktop", kind: "write-config", target: configPath }, ctx);
    assert.equal(again.state, "connected");
    const twice = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(twice.mcpServers.relay.url, ctx.mcpUrl);
    assert.equal((await readdir(ctx.backupDir)).length, 2);
  } finally {
    await cleanupTempDir(root);
  }
});

test("Claude adapter removes only Relay", async () => {
  const { root, configPath, ctx } = await fixture();
  try {
    await writeFile(configPath, JSON.stringify({
      mcpServers: {
        existing: { command: "node" },
        relay: { url: ctx.mcpUrl },
      },
    }), "utf8");
    const removed = await claudeDesktopAdapter.remove(ctx);
    assert.equal(removed.state, "connected");
    const after = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(after.mcpServers, { existing: { command: "node" } });
  } finally {
    await cleanupTempDir(root);
  }
});

test("Claude adapter refuses malformed config and leaves it unchanged", async () => {
  const { root, configPath, ctx } = await fixture();
  try {
    const malformed = "{ not json";
    await writeFile(configPath, malformed, "utf8");
    await assert.rejects(
      () => claudeDesktopAdapter.install({ clientId: "claude-desktop", kind: "write-config", target: configPath }, ctx),
      /valid JSON/,
    );
    assert.equal(await readFile(configPath, "utf8"), malformed);
  } finally {
    await cleanupTempDir(root);
  }
});
