// REQ-020, REQ-019
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { backupFile, logConnectorEvent, redact, restoreBackup } from "../../packages/connector/dist/index.js";
import { cleanupTempDir, makeTempDir } from "../helpers.mjs";

test("redaction removes tokens and bearer values but keeps the state", () => {
  const dirty = "failed rcs_0123456789_abcdef rlc_0123456789_secret rly_abc Bearer abc.def token=supersecret";
  const clean = redact(dirty);
  assert.equal(/rcs_[A-Za-z0-9]|rlc_[A-Za-z0-9]|rly_[A-Za-z0-9]|Bearer\s+abc|supersecret/.test(clean), false);
  assert.match(clean, /failed/);
  assert.match(clean, /\[redacted\]/);

  const lines = [];
  logConnectorEvent((line) => lines.push(line), {
    clientId: "claude-desktop",
    state: "failed",
    detail: "write failed for rcs_0123456789_abcdef",
  });
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.client, "claude-desktop");
  assert.equal(parsed.state, "failed");
  assert.equal(lines[0].includes("rcs_0123456789"), false);
});

test("restoreBackup returns the config to its original bytes", async () => {
  const root = await makeTempDir("relay-redact-");
  try {
    const file = path.join(root, "config.json");
    const original = '{"mcpServers":{"existing":{"url":"https://example.test"}}}\n';
    await writeFile(file, original, "utf8");
    const backup = await backupFile(file, path.join(root, "backups"));
    await writeFile(file, '{"broken":true}\n', "utf8");
    await restoreBackup(backup);
    assert.equal(await readFile(file, "utf8"), original);
  } finally {
    await cleanupTempDir(root);
  }
});
