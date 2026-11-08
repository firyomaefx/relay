// REQ-018
import assert from "node:assert/strict";
import test from "node:test";
import { parseManageLink, startManageServer } from "../../packages/connector/dist/index.js";

const ctx = {
  appDataDir: "C:/tmp/appdata",
  localAppDataDir: "C:/tmp/local",
  homeDir: "C:/tmp/home",
  backupDir: "C:/tmp/backups",
  mcpUrl: "https://mcp.example/mcp",
  sessionToken: "",
  now: () => new Date(),
};

test("manage links accept only known clients and actions", () => {
  assert.deepEqual(parseManageLink("relay://manage?action=disconnect&client=claude-desktop"), {
    action: "disconnect",
    clientId: "claude-desktop",
  });
  assert.throws(() => parseManageLink("relay://manage?action=delete&client=cursor"), /action/);
  assert.throws(() => parseManageLink("relay://manage?action=disconnect&client=unknown"), /client/);
  assert.throws(() => parseManageLink("relay://connect?session=x"), /manage/);
});

test("manage server requires explicit confirmation and calls remove", async () => {
  let removed = 0;
  const adapter = {
    id: "claude-desktop",
    tier: "auto",
    detect: async () => ({ id: "claude-desktop", detected: true }),
    plan: async () => [],
    install: async () => ({ clientId: "claude-desktop", state: "connected", detail: "ok" }),
    remove: async () => { removed += 1; return { clientId: "claude-desktop", state: "connected", detail: "Relay removed." }; },
  };
  const server = await startManageServer({ action: "disconnect", adapter, ctx });
  try {
    const page = await (await fetch(server.url)).text();
    assert.match(page, /Remove Relay from claude-desktop/);
    assert.equal(page.includes("rcs_"), false);

    const refused = await fetch(`${server.url}api/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: false }),
    });
    assert.equal(refused.status, 400);
    assert.equal(removed, 0);

    const accepted = await fetch(`${server.url}api/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).detail, "Relay removed.");
    assert.equal(removed, 1);
  } finally {
    await server.close();
  }
});
