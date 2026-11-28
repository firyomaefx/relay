import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { CloudStore, processPendingWaitlistAutoApprovals } from "../../packages/cloud/dist/index.js";
import { cleanupTempDir, makeTempDir } from "../helpers.mjs";

test("processPendingWaitlistAutoApprovals invites pending rows under limit", async () => {
  const dir = await makeTempDir("relay-wl-auto-");
  const dbPath = path.join(dir, "cloud.sqlite");
  const store = CloudStore.open(dbPath);
  const entry = store.createWaitlistEntry({
    name: "Backlog User",
    email: "backlog@example.com",
    phone: "",
    platforms: "threads",
    volume: "low",
    useCase: "test",
  });
  assert.equal(entry.entry.status, "pending");

  const result = await processPendingWaitlistAutoApprovals(store, null, {
    waitlistLimit: 10,
    publicBase: "https://relay.test",
    mcpBase: "https://cloud-mcp.test/mcp",
    env: { RELAY_WAITLIST_AUTO_APPROVE: "1" },
  });

  assert.equal(result.processed, 1);
  assert.equal(result.errors, 0);
  const updated = store.getWaitlist(entry.entry.id);
  assert.equal(updated.status, "invited");
  store.close();
  await cleanupTempDir(dir);
});

test("processPendingWaitlistAutoApprovals is a no-op when auto-approve is off", async () => {
  const dir = await makeTempDir("relay-wl-auto-off-");
  const store = CloudStore.open(path.join(dir, "cloud.sqlite"));
  store.createWaitlistEntry({
    name: "Still Pending",
    email: "pending@example.com",
    phone: "",
    platforms: "",
    volume: "",
    useCase: "",
  });
  const result = await processPendingWaitlistAutoApprovals(store, null, {
    waitlistLimit: 10,
    publicBase: "https://relay.test",
    mcpBase: "https://cloud-mcp.test/mcp",
    env: { RELAY_WAITLIST_AUTO_APPROVE: "0" },
  });
  assert.equal(result.processed, 0);
  store.close();
  await cleanupTempDir(dir);
});