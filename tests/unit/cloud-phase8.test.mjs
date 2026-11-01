import assert from "node:assert/strict";
import { access, mkdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CloudStore, RateLimiter, cleanupMedia, loadCloudConfig } from "../../packages/cloud/dist/index.js";
import { cleanupTempDir, makeTempDir } from "../helpers.mjs";

const TOKEN_KEY = Buffer.alloc(32, 37).toString("base64");

test("rate limits are per customer and per bucket", async () => {
  const dir = await makeTempDir("relay-rate-");
  const limiter = new RateLimiter(path.join(dir, "cloud.sqlite"));
  try {
    limiter.check("a", "mcp", 2, 60_000);
    limiter.check("a", "mcp", 2, 60_000);
    assert.throws(
      () => limiter.check("a", "mcp", 2, 60_000),
      (error) => error.code === "cloud_rate_limited" && error.statusCode === 429,
    );
    limiter.check("b", "mcp", 2, 60_000);
    limiter.check("a", "posts", 1, 60_000);
  } finally {
    limiter.close();
    await cleanupTempDir(dir);
  }
});

test("media cleanup is a dry run unless applied", async () => {
  const dir = await makeTempDir("relay-retention-");
  const dbPath = path.join(dir, "cloud.sqlite");
  const env = {
    RELAY_CLOUD_ENABLED: "1",
    RELAY_CLOUD_TOKEN_KEY: TOKEN_KEY,
    RELAY_CLOUD_DB: dbPath,
    RELAY_CLOUD_DATA_DIR: path.join(dir, "tenants"),
    RELAY_DATA_DIR: path.join(dir, "owner"),
  };
  const config = loadCloudConfig(env);
  const store = CloudStore.open(dbPath);
  const customer = store.createCustomer({ displayName: "Retention" });
  const dataDir = path.join(config.tenantDataRoot, customer.id);
  const mediaDir = path.join(dataDir, "media");
  await mkdir(mediaDir, { recursive: true });
  const oldFile = path.join(mediaDir, "old.jpg");
  const newFile = path.join(mediaDir, "new.jpg");
  await writeFile(oldFile, "old");
  await writeFile(newFile, "new");
  const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  await utimes(oldFile, oldDate, oldDate);
  store.getOrCreateCustomerData(customer.id, dataDir);
  try {
    const dry = await cleanupMedia(store, config, { days: 30, apply: false });
    assert.equal(dry[0].removed.includes(oldFile), true);
    await access(oldFile);

    const applied = await cleanupMedia(store, config, { days: 30, apply: true });
    assert.equal(applied[0].removed.includes(oldFile), true);
    await assert.rejects(() => access(oldFile));
    await access(newFile);
  } finally {
    store.close();
    await cleanupTempDir(dir);
  }
});
