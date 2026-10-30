import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { cleanupTempDir, httpJson, makeTempDir, startWebServer } from "../helpers.mjs";

const PORT = 45740;

test("public pricing page and price API work without a console session", async () => {
  const dataDir = await makeTempDir("relay-pricing-");
  const server = await startWebServer({
    dataDir,
    port: PORT,
    label: "pricing",
    env: { RELAY_CONSOLE_PASSWORD: "pricing-test-password" },
  });
  try {
    const page = await fetch(`${server.baseUrl}/pricing`, { redirect: "manual" });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Relay Cloud/);
    assert.match(html, /Prices by platform/);

    const api = await httpJson(server.baseUrl, "/api/pricing");
    assert.equal(api.status, 200);
    assert.equal(api.json.currency, "USD");
    assert.equal(api.json.unit, "milliUSD");
    assert.equal(api.json.freeAllowanceMilliUsd, 500);
    assert.equal(api.json.freeAllowanceUnits, 0);
    assert.match(html, /\$0\.50 free credit/);
    assert.equal(api.json.prices.x.text, 20);

    const protectedState = await httpJson(server.baseUrl, "/api/state");
    assert.equal(protectedState.status, 401);

    const contactPage = await fetch(`${server.baseUrl}/contact`);
    assert.equal(contactPage.status, 200);
    const contact = await httpJson(server.baseUrl, "/api/contact", {
      method: "POST",
      body: { name: "Test", email: "test@example.com", message: "Agency inquiry" },
    });
    assert.equal(contact.status, 201);
    assert.equal(contact.json.ok, true);

    const connectPage = await fetch(`${server.baseUrl}/connect`);
    assert.equal(connectPage.status, 200);
    const connectHtml = await connectPage.text();
    assert.match(connectHtml, /Connect your agent/);
    assert.doesNotMatch(connectHtml, /mailto:/);

    const billingPage = await fetch(`${server.baseUrl}/billing/success`);
    assert.equal(billingPage.status, 200);
    assert.equal(billingPage.headers.get("x-content-type-options"), "nosniff");
    assert.ok(billingPage.headers.get("strict-transport-security"));
  } finally {
    await server.stop();
    await cleanupTempDir(dataDir);
  }
});



