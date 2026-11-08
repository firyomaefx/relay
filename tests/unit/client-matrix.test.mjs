// REQ-009 to REQ-015, REQ-022, REQ-023
import assert from "node:assert/strict";
import test from "node:test";
import { CLIENT_MATRIX, autoClientIds, generateArtifact, getMatrixEntry } from "../../packages/connector/dist/index.js";

const URL = "https://cloud-mcp.duitpoket.fun/mcp";

test("matrix is complete, unique and has exactly three Auto clients", () => {
  const ids = CLIENT_MATRIX.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(autoClientIds().sort(), ["claude-code", "claude-desktop", "cursor"]);
  for (const id of ["codex", "vscode", "deepseek-harness", "grok", "grok-bot", "chatgpt", "n8n", "other"]) {
    assert.ok(getMatrixEntry(id), `missing ${id}`);
  }
  assert.equal(CLIENT_MATRIX.every((entry) => entry.tier !== "unsupported"), true);
});

test("guided/manual artifacts contain the URL and no secret patterns", () => {
  for (const entry of CLIENT_MATRIX.filter((item) => item.tier === "guided" || item.tier === "manual")) {
    const artifact = generateArtifact({ clientId: entry.id, mcpUrl: URL });
    assert.equal(artifact.clientId, entry.id);
    assert.match(artifact.body, /https:\/\/cloud-mcp\.duitpoket\.fun\/mcp/);
    assert.doesNotMatch(artifact.body, /\brcs_[A-Za-z0-9]|\brlc_[A-Za-z0-9]|Bearer\s/i);
  }
});

test("Auto clients have no manual artifact and unknown clients fail closed", () => {
  assert.throws(() => generateArtifact({ clientId: "claude-desktop", mcpUrl: URL }), /Auto/);
  assert.throws(() => generateArtifact({ clientId: "not-a-client", mcpUrl: URL }), /Unknown client/);
});
