import assert from "node:assert/strict";
import test from "node:test";
import { createRelay } from "@relay/platforms";
import { cleanupTempDir, makeTempDir } from "../helpers.mjs";

test("LinkedIn connects and publishes in mock mode with a 3,000 character limit", async () => {
  const dataDir = await makeTempDir("relay-linkedin-");
  let relay;
  try {
    relay = await createRelay({ dataDir, forceMock: true, env: {}, logger: () => {} });
    const connected = await relay.beginConnect("linkedin", { label: "My LinkedIn" });
    assert.equal(connected.mode, "connected");
    assert.equal(connected.account.platform, "linkedin");
    assert.equal(connected.account.label, "My LinkedIn");

    const tooLong = await relay.validate({ platforms: ["linkedin"], text: "x".repeat(3001) });
    assert.equal(tooLong.ok, false);
    assert.ok(tooLong.issues.some((issue) => issue.code === "text_too_long"));

    const report = await relay.validate({ platforms: ["linkedin"], text: "x".repeat(3000) });
    assert.equal(report.ok, true, JSON.stringify(report.issues));

    const published = await relay.createPost({ platforms: ["linkedin"], text: "Hello from Relay" });
    assert.equal(published.results[0].ok, true);
    assert.equal(published.results[0].platform, "linkedin");
    assert.equal(published.results[0].accountLabel, "My LinkedIn");

    const thread = await relay.validate({
      platforms: ["linkedin"],
      thread: [{ text: "one" }, { text: "two" }],
    });
    assert.equal(thread.ok, false);
  } finally {
    await relay?.close();
    await cleanupTempDir(dataDir);
  }
});
