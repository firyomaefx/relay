// REQ-028: static accessibility contract for the seller-first console.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("Compose owns the hero while Home stays a dashboard", async () => {
  const html = await readFile(path.join(process.cwd(), "apps", "web", "public", "index.html"), "utf8");

  assert.match(html, /<h1 id="homeTitle" class="visually-hidden">Workspace<\/h1>/);
  assert.match(html, /<h2 class="display" id="composeTitle">Write it once\. Post it everywhere\.<\/h2>/);
  assert.match(html, /id="startWritingBtn"[^>]*data-start-writing/);
  assert.match(html, /<button class="ghost-btn" type="button" data-goto="queue">See calendar<\/button>/);
  const home = html.match(/<section[^>]*id="screen-home"[\s\S]*?<\/section>\s*<section[^>]*id="screen-compose"/)?.[0] ?? "";
  assert.doesNotMatch(home, /Write a post|hero-actions|Write it once/, "Home must not duplicate the composer hero");
  assert.match(html, /<button class="ghost-btn topbar-new" id="newPostBtn" type="button">New post<\/button>/);
  assert.match(html, /id="topbarLogoutBtn"[^>]*hidden/);
  assert.match(html, /id="topbarLogoutBtn"[\s\S]*?Sign out/);
  assert.doesNotMatch(html, /data-connect-relay/, "MCP setup no longer dominates the customer home");
  assert.doesNotMatch(html, /id="dashIntegrations"/, "MCP setup is kept in Settings and docs");
});

test("compose mode controls are real buttons and the advanced block starts hidden", async () => {
  const html = await readFile(path.join(process.cwd(), "apps", "web", "public", "index.html"), "utf8");
  const js = await readFile(path.join(process.cwd(), "apps", "web", "public", "app.js"), "utf8");

  assert.match(html, /data-compose-mode="simple" aria-pressed="true"/);
  assert.match(html, /data-compose-mode="advanced" aria-pressed="false"/);
  assert.match(html, /id="advancedOptions" hidden/);
  assert.match(html, /id="firstRunPanel" hidden/);
  assert.match(js, /window\.localStorage\.setItem\(composeModeStorageKey\(\)/);
  assert.match(js, /state\.role === "customer"\s*\?\s*"compose"\s*:\s*"home"/);
  assert.match(js, /handleAuthQuery[\s\S]*?setScreen\("compose"\)/);
});

test("setup and customer login land approved users in the composer", async () => {
  const setup = await readFile(path.join(process.cwd(), "apps", "web", "public", "setup.js"), "utf8");
  const login = await readFile(path.join(process.cwd(), "apps", "web", "public", "customer-login.js"), "utf8");

  assert.match(setup, /window\.location\.replace\("\/\?welcome=1#compose"\)/);
  assert.match(login, /window\.location\.replace\("\/#compose"\)/);
});

test("waitlist is a minimal, conversion-focused registration page", async () => {
  const html = await readFile(path.join(process.cwd(), "apps", "web", "public", "waitlist.html"), "utf8");
  const js = await readFile(path.join(process.cwd(), "apps", "web", "public", "waitlist.js"), "utf8");

  assert.match(html, /One post\./);
  assert.match(html, /A week of showing up\./);
  assert.match(html, /Manual or AI/);
  assert.match(html, /Content first/);
  assert.match(html, /ChatGPT/);
  assert.match(html, /Request early access/);
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.match(html, /id="name"[^>]*required/);
  assert.match(html, /id="email"[^>]*required/);
  assert.doesNotMatch(html, /How do you want to post\?/);
  assert.doesNotMatch(html, /name="phone"/);
  assert.match(js, /Sending…/);
  assert.match(js, /successCard/);
  assert.match(js, /batch === "next"/);
  assert.doesNotMatch(html, /\$0\.02|\$0\.04/);
  assert.match(html, /<noscript>/);
  const css = await readFile(path.join(process.cwd(), "apps", "web", "public", "waitlist.css"), "utf8");
  assert.ok(Buffer.byteLength(html) + Buffer.byteLength(css) <= 24 * 1024, "waitlist HTML + CSS stays under 24 KiB");
});
