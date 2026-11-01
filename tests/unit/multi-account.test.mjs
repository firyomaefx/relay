import assert from "node:assert/strict";
import test from "node:test";
import { createRelay } from "@relay/platforms";
import { cleanupTempDir, makeTempDir } from "../helpers.mjs";

test("multiple accounts per platform, explicit account targets and primary promotion", async () => {
  const dataDir = await makeTempDir("relay-multi-account-");
  let relay;
  try {
    relay = await createRelay({ dataDir, forceMock: true, env: {}, logger: () => {} });
    const first = await relay.beginConnect("x");
    assert.equal(first.mode, "connected");
    assert.equal(first.account.primaryForPlatform, true);

    const second = await relay.beginConnect("x", { accountId: "acct_second_x", label: "Agency X" });
    assert.equal(second.mode, "connected");
    assert.equal(second.account.id, "acct_second_x");
    assert.equal(second.account.primaryForPlatform, false);

    const accounts = await relay.accounts();
    assert.equal(accounts.filter((account) => account.platform === "x").length, 2);
    assert.equal(accounts.find((account) => account.id === "acct_second_x")?.label, "Agency X");

    const published = await relay.createPost({
      platforms: ["x"],
      accountIds: { x: "acct_second_x" },
      text: "post from the second X account",
    });
    assert.equal(published.results[0].ok, true);
    assert.equal(published.results[0].accountId, "acct_second_x");
    assert.equal(published.results[0].accountLabel, "Agency X");

    const primary = accounts.find((account) => account.primaryForPlatform);
    assert.ok(primary);
    await relay.disconnect("x", primary.id);
    const remaining = (await relay.accounts()).filter((account) => account.platform === "x");
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, "acct_second_x");
    assert.equal(remaining[0].primaryForPlatform, true);
  } finally {
    await relay?.close();
    await cleanupTempDir(dataDir);
  }
});
