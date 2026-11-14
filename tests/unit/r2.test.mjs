import assert from "node:assert/strict";
import { test } from "node:test";
import { r2MediaConfig, r2PublicMediaUrl } from "../../apps/web/dist/r2.js";

test("R2 media config is optional and builds the public URL", () => {
  const previous = { ...process.env };
  try {
    delete process.env.RELAY_R2_ENDPOINT;
    delete process.env.RELAY_R2_ACCESS_KEY_ID;
    delete process.env.RELAY_R2_SECRET_ACCESS_KEY;
    assert.equal(r2MediaConfig(), null);

    process.env.RELAY_R2_ENDPOINT = "https://account.r2.cloudflarestorage.com/";
    process.env.RELAY_R2_ACCESS_KEY_ID = "key";
    process.env.RELAY_R2_SECRET_ACCESS_KEY = "secret";
    process.env.RELAY_R2_BUCKET = "relay-media";
    process.env.RELAY_R2_PUBLIC_BASE_URL = "https://media.example.test/";
    process.env.RELAY_R2_MEDIA_PREFIX = "media/";
    const config = r2MediaConfig();
    assert.ok(config);
    assert.equal(config.endpoint, "https://account.r2.cloudflarestorage.com");
    assert.equal(config.bucket, "relay-media");
    assert.equal(r2PublicMediaUrl(config, "file name.png"), "https://media.example.test/media/file%20name.png");
  } finally {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("RELAY_R2_")) delete process.env[key];
    }
    Object.assign(process.env, previous);
  }
});
