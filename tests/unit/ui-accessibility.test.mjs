// REQ-028: static accessibility contract for the Connect dashboard.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("Connect entry, status and client actions are keyboard-addressable and announced", async () => {
  const html = await readFile(path.join(process.cwd(), "apps", "web", "public", "index.html"), "utf8");
  const js = await readFile(path.join(process.cwd(), "apps", "web", "public", "app.js"), "utf8");

  assert.match(html, /<button class="primary-btn" type="button" data-connect-relay>Connect Relay<\/button>/);
  assert.match(js, /id="connectRelayStatus" role="status" aria-live="polite"/);
  assert.match(js, /id="connectClientMatrix" aria-live="polite"/);
  assert.match(js, /<button class="ghost-btn small" type="button" data-copy-artifact=/);
  assert.match(js, /<button class="ghost-btn small" type="button" data-manage-client=/);
  assert.match(js, /<a class="ghost-btn" href="https:\/\/relay\.duitpoket\.fun\/connect"/);
  assert.equal((js.match(/<div[^>]+data-connect-relay/g) ?? []).length, 0, "primary action must be a button, not a div");
});
