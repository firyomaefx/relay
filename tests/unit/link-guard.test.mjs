/**
 * Unit tests for the blocked-link guard (RELAY_BLOCKED_LINKS*), used to keep
 * affiliate shop links out of posts during a reputation phase.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { findBlockedLink, parseLinkGuard } from "@relay/core";
import { createRelay } from "@relay/platforms";
import { cleanupTempDir, makeTempDir } from "../helpers.mjs";

const dirs = [];
const relays = [];

async function relayWith(env, now = () => new Date("2026-10-26T12:00:00Z")) {
  const dataDir = await makeTempDir("relay-linkguard-");
  dirs.push(dataDir);
  const relay = await createRelay({ dataDir, forceMock: true, env, logger: () => {}, now });
  relays.push(relay);
  return relay;
}

after(async () => {
  for (const relay of relays) await relay?.close();
  for (const dir of dirs) await cleanupTempDir(dir);
});

const GUARD_ENV = {
  RELAY_BLOCKED_LINKS: "s.shopee.com.my, shope.ee",
  RELAY_BLOCKED_LINKS_UNTIL: "2026-12-01T00:00:00+08:00",
  RELAY_BLOCKED_LINKS_PLATFORMS: "threads,instagram,tiktok,youtube",
};

test("parseLinkGuard reads patterns, end date and platforms", () => {
  const guard = parseLinkGuard(GUARD_ENV);
  assert.deepEqual(guard.patterns, ["s.shopee.com.my", "shope.ee"]);
  assert.equal(guard.until, Date.parse("2026-12-01T00:00:00+08:00"));
  assert.deepEqual(guard.platforms, ["threads", "instagram", "tiktok", "youtube"]);
  assert.equal(parseLinkGuard({}), undefined);
  assert.equal(parseLinkGuard({ RELAY_BLOCKED_LINKS: " , " }), undefined);
});

test("findBlockedLink respects platform list and end date", () => {
  const guard = parseLinkGuard(GUARD_ENV);
  const text = "Beli sini https://S.Shopee.com.my/3LRqg4BPQf";
  const before = Date.parse("2026-11-30T23:59:00+08:00");
  const afterEnd = Date.parse("2026-12-01T00:00:00+08:00");
  assert.equal(findBlockedLink(text, guard, "threads", before), "s.shopee.com.my");
  assert.equal(findBlockedLink(text, guard, "x", before), null, "x is not in the platform list");
  assert.equal(findBlockedLink(text, guard, "threads", afterEnd), null, "guard ends at the end date");
  assert.equal(findBlockedLink("tiada link", guard, "threads", before), null);
});

test("validate rejects a Threads thread part with a shop link while the guard is on", async () => {
  const relay = await relayWith(GUARD_ENV);
  const report = await relay.validate({
    platforms: ["threads"],
    thread: [{ text: "Tisu murah hari ni." }, { text: "Link: https://s.shopee.com.my/3LRqg4BPQf" }],
  });
  assert.equal(report.ok, false);
  const issue = report.issues.find((entry) => entry.code === "link_blocked");
  assert.ok(issue, `expected link_blocked, got ${JSON.stringify(report.issues)}`);
  assert.equal(issue.platform, "threads");
  assert.equal(issue.part, 1);
});

test("validate allows the same text on X and after the end date", async () => {
  const relay = await relayWith(GUARD_ENV);
  const onX = await relay.validate({ platforms: ["x"], text: "https://s.shopee.com.my/abc" });
  assert.ok(!onX.issues.some((entry) => entry.code === "link_blocked"), JSON.stringify(onX.issues));

  const later = await relayWith(GUARD_ENV, () => new Date("2026-12-02T00:00:00+08:00"));
  const report = await later.validate({ platforms: ["threads"], text: "https://s.shopee.com.my/abc" });
  assert.ok(!report.issues.some((entry) => entry.code === "link_blocked"), JSON.stringify(report.issues));
});

test("no guard configured means no link checks", async () => {
  const relay = await relayWith({});
  const report = await relay.validate({ platforms: ["threads"], text: "https://s.shopee.com.my/abc" });
  assert.equal(report.ok, true, JSON.stringify(report.issues));
});
