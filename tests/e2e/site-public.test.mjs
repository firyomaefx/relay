// Public site: landing at /, docs, policy pages, assets, and self-serve Stripe top-up.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CloudStore } from "../../packages/cloud/dist/index.js";
import { cleanupTempDir, makeTempDir, startWebServer } from "../helpers.mjs";

const PASSWORD = "site-test-password";

async function get(baseUrl, pathname, headers = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, { headers, redirect: "manual" });
  return { status: response.status, type: response.headers.get("content-type") ?? "", text: await response.text(), location: response.headers.get("location") };
}

test("visitors get the landing page at /, the console stays behind login", async () => {
  const dir = await makeTempDir("relay-site-");
  const server = await startWebServer({ dataDir: dir, port: 45781, label: "site-landing", env: { RELAY_CONSOLE_PASSWORD: PASSWORD } });
  try {
    const home = await get(server.baseUrl, "/");
    assert.equal(home.status, 200);
    assert.match(home.text, /Schedule once\. Post everywhere\./);
    assert.match(home.text, /Write a post in your browser/);
    assert.match(home.text, /href="\/waitlist"/);
    assert.match(home.text, /href="\/login"/);
    assert.match(home.text, /href="\/contact"/);
    assert.match(home.text, /<meta property="og:image" content="https:\/\/relay\.duitpoket\.fun\/og\.png">/);
    assert.match(home.text, /CLOSING-LINE:START/);
    assert.match(home.text, /id="langSwitch"/);
    assert.doesNotMatch(home.text, /\bAPI\b|\bMCP\b|milliUSD/, "developer language stays off the seller landing page");

    for (const entry of ["/login", "/login.html"]) {
      const page = await get(server.baseUrl, entry);
      assert.equal(page.status, 200, entry);
      assert.match(page.text, /password/i, entry);
      assert.match(page.text, /customer-login\.js\?v=20261117admin/, entry);
    }
    for (const entry of ["/admin", "/admin/", "/admin/login"]) {
      const page = await get(server.baseUrl, entry);
      assert.equal(page.status, 200, entry);
      assert.match(page.text, /login\.js\?v=20261117admin/, entry);
    }
    for (const script of ["/login.js", "/customer-login.js"]) {
      const res = await fetch(`${server.baseUrl}${script}`);
      assert.equal(res.status, 200, script);
      assert.match(res.headers.get("cache-control") ?? "", /no-cache/, `${script} must revalidate`);
    }

    const signIn = await fetch(`${server.baseUrl}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(signIn.status, 200);
    const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0];
    const consolePage = await get(server.baseUrl, "/", { cookie });
    assert.equal(consolePage.status, 200);
    assert.match(consolePage.text, /<script src="\/app\.js/);
    assert.doesNotMatch(consolePage.text, /Pay only when the post goes up/);

    // Private API stays private.
    assert.equal((await get(server.baseUrl, "/api/state")).status, 401);
  } finally {
    await server.stop();
    await cleanupTempDir(dir);
  }
});

test("public pages and assets are served without a session and follow the copy rules", async () => {
  const dir = await makeTempDir("relay-site-pages-");
  const server = await startWebServer({ dataDir: dir, port: 45782, label: "site-pages", env: { RELAY_CONSOLE_PASSWORD: PASSWORD } });
  try {
    for (const page of ["/", "/docs", "/terms", "/privacy", "/refund", "/topup", "/billing/success", "/billing/cancel"]) {
      const res = await get(server.baseUrl, page);
      assert.equal(res.status, 200, page);
      assert.match(res.type, /text\/html/, page);
      assert.match(res.text, /<title>[^<]+<\/title>/, page);
      assert.match(res.text, /<meta name="description" content="[^"]+">/, page);
      assert.match(res.text, /name="viewport"/, page);
      assert.match(res.text, /href="\/favicon-32\.png"/, page);
      assert.match(res.text, /href="\/terms".*href="\/privacy".*href="\/refund".*href="\/contact"/s, page);
      assert.doesNotMatch(res.text, /[\u2013\u2014]/, `${page} has no en or em dashes`);
    }
    const docs = await get(server.baseUrl, "/docs");
    assert.match(docs.text, /https:\/\/cloud-mcp\.duitpoket\.fun\/mcp/);
    assert.match(docs.text, /relay_validate/);
    assert.match(docs.text, /schedule_at/);
    for (const asset of ["/og.png", "/favicon-16.png", "/favicon-32.png", "/favicon-512.png", "/apple-touch-icon.png"]) {
      const res = await fetch(`${server.baseUrl}${asset}`);
      assert.equal(res.status, 200, asset);
      assert.equal(res.headers.get("content-type"), "image/png", asset);
    }
    const pricing = await get(server.baseUrl, "/pricing");
    assert.equal(pricing.status, 200);
    assert.match(pricing.text, /Pay for posts that go out\. Nothing for posts that fail\./);
    assert.match(pricing.text, /RM10 of credit is about/);
    assert.match(pricing.text, /Charges are in US dollars\. RM figures are estimates/);
    assert.match(pricing.text, /id="langSwitch"/);
    const visiblePricing = pricing.text.replace(/<script[\s\S]*?<\/script>/gi, "");
    assert.doesNotMatch(visiblePricing, /\bAPI\b|\bMCP\b|milliUSD/, "developer language moved to /docs");
    assert.doesNotMatch(visiblePricing, /Rekalab/i, "no competitor price claims");

    const priceApi = await get(server.baseUrl, "/api/pricing");
    assert.equal(priceApi.status, 200);
    const priceJson = JSON.parse(priceApi.text);
    assert.equal(priceJson.currency, "USD");
    assert.equal(priceJson.display.currency, "MYR");
    assert.equal(priceJson.display.usdMyrRate, 4.7);
    assert.equal(priceJson.display.rateCheckedAt, "2026-11-12");
    assert.equal(priceJson.prices.linkedin.text, 20);
  } finally {
    await server.stop();
    await cleanupTempDir(dir);
  }
});

test("top-up checkout fails safely when Stripe keys are missing", async () => {
  const dir = await makeTempDir("relay-topup-off-");
  const dbPath = path.join(dir, "cloud.sqlite");
  const store = CloudStore.open(dbPath);
  const customer = store.createCustomer({ displayName: "No Stripe" });
  const key = store.createApiKey(customer.id).key;
  store.close();
  const server = await startWebServer({
    dataDir: path.join(dir, "owner"),
    port: 45783,
    label: "topup-off",
    env: {
      RELAY_CONSOLE_PASSWORD: PASSWORD,
      RELAY_CLOUD_ENABLED: "1",
      RELAY_CLOUD_TOKEN_KEY: Buffer.alloc(32, 41).toString("base64"),
      RELAY_CLOUD_DB: dbPath,
      RELAY_CLOUD_DATA_DIR: path.join(dir, "tenants"),
      RELAY_STRIPE_SECRET_KEY: "",
      STRIPE_SECRET_KEY: "",
    },
  });
  try {
    const options = await (await fetch(`${server.baseUrl}/api/billing/topup`)).json();
    assert.equal(options.available, false);
    assert.deepEqual(options.plans.map((plan) => plan.amountMilli), [9_900, 49_900]);
    const res = await fetch(`${server.baseUrl}/api/billing/topup`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ plan: "starter" }),
    });
    assert.equal(res.status, 503);
  } finally {
    await server.stop();
    await cleanupTempDir(dir);
  }
});

test("customer top-up creates a Stripe Checkout Session and the webhook credits it exactly once", async () => {
  const dir = await makeTempDir("relay-topup-");
  const dbPath = path.join(dir, "cloud.sqlite");
  const store = CloudStore.open(dbPath);
  const customer = store.createCustomer({ displayName: "Top-up Customer" });
  const key = store.createApiKey(customer.id).key;
  store.close();

  // Local stand-in for api.stripe.com: records the Checkout Session request.
  const requests = [];
  const stripe = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ url: req.url, auth: req.headers.authorization, body: new URLSearchParams(body) });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: `cs_test_${requests.length}`, url: `https://checkout.stripe.test/c/${requests.length}` }));
    });
  });
  await new Promise((resolve) => stripe.listen(0, "127.0.0.1", resolve));
  const stripePort = stripe.address().port;

  const server = await startWebServer({
    dataDir: path.join(dir, "owner"),
    port: 45784,
    label: "topup",
    env: {
      RELAY_CONSOLE_PASSWORD: PASSWORD,
      RELAY_CLOUD_ENABLED: "1",
      RELAY_CLOUD_TOKEN_KEY: Buffer.alloc(32, 43).toString("base64"),
      RELAY_CLOUD_DB: dbPath,
      RELAY_CLOUD_DATA_DIR: path.join(dir, "tenants"),
      RELAY_STRIPE_SECRET_KEY: "",
      RELAY_STRIPE_WEBHOOK_SECRET: "",
      STRIPE_SECRET_KEY: "sk_test_dummy",
      STRIPE_WEBHOOK_SECRET: "whsec_site_test",
      RELAY_STRIPE_API_BASE: `http://127.0.0.1:${stripePort}`,
    },
  });
  const post = (plan, auth) => fetch(`${server.baseUrl}/api/billing/topup`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify({ plan }),
  });
  const webhook = (event, secret = "whsec_site_test") => {
    const payload = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", secret).update(`${timestamp}.${payload}`, "utf8").digest("hex");
    return fetch(`${server.baseUrl}/api/stripe/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": `t=${timestamp},v1=${signature}` },
      body: payload,
    });
  };
  const payments = async () => {
    const check = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return Number(check.prepare("SELECT COUNT(*) AS n FROM payment_events WHERE customer_id = ?").get(customer.id).n);
    } finally {
      check.close();
    }
  };
  try {
    assert.equal((await (await fetch(`${server.baseUrl}/api/billing/topup`)).json()).available, true);
    assert.equal((await post("starter")).status, 401);
    assert.equal((await post("starter", "Bearer rly_not_a_real_key")).status, 401);
    assert.equal((await post("gold", `Bearer ${key}`)).status, 400);

    const starter = await post("starter", `Bearer ${key}`);
    assert.equal(starter.status, 200);
    assert.equal((await starter.json()).url, "https://checkout.stripe.test/c/1");
    const sent = requests[0];
    assert.equal(sent.url, "/v1/checkout/sessions");
    assert.equal(sent.auth, "Bearer sk_test_dummy");
    assert.equal(sent.body.get("mode"), "payment");
    assert.equal(sent.body.get("line_items[0][price_data][unit_amount]"), "990");
    assert.equal(sent.body.get("line_items[0][price_data][currency]"), "usd");
    assert.equal(sent.body.get("metadata[customer_id]"), customer.id);
    assert.equal(sent.body.get("metadata[amount_milli]"), "9900");
    assert.equal(sent.body.get("metadata[plan]"), "starter");
    assert.match(sent.body.get("success_url"), /\/billing\/success\?session_id=\{CHECKOUT_SESSION_ID\}$/);

    const scale = await post("scale", `Bearer ${key}`);
    assert.equal(scale.status, 200);
    assert.equal(requests[1].body.get("line_items[0][price_data][unit_amount]"), "4990");

    const paid = {
      id: "evt_site_1",
      type: "checkout.session.completed",
      data: { object: { id: "cs_test_1", payment_status: "paid", amount_total: 990, currency: "usd", metadata: { customer_id: customer.id, amount_milli: "9900" } } },
    };
    assert.equal((await webhook(paid)).status, 200);
    assert.equal((await webhook(paid)).status, 200, "replay is accepted");
    assert.equal(await payments(), 1, "replayed event credits once");

    // A tampered amount, an unpaid session and a bad signature never credit.
    const mismatch = { ...paid, id: "evt_site_2", data: { object: { ...paid.data.object, id: "cs_test_2", amount_total: 100 } } };
    assert.equal((await webhook(mismatch)).status, 200);
    const unpaid = { ...paid, id: "evt_site_3", data: { object: { ...paid.data.object, id: "cs_test_3", payment_status: "unpaid" } } };
    assert.equal((await webhook(unpaid)).status, 200);
    assert.equal((await webhook({ ...paid, id: "evt_site_4" }, "whsec_wrong")).status, 400);
    assert.equal(await payments(), 1);

    // Delayed payment methods credit on async_payment_succeeded.
    const asyncPaid = { id: "evt_site_5", type: "checkout.session.async_payment_succeeded", data: { object: { id: "cs_test_5", payment_status: "paid", amount_total: 4990, currency: "usd", metadata: { customer_id: customer.id, amount_milli: "49900" } } } };
    assert.equal((await webhook(asyncPaid)).status, 200);
    assert.equal(await payments(), 2);
  } finally {
    await server.stop();
    await new Promise((resolve) => stripe.close(resolve));
    await cleanupTempDir(dir);
  }
});
