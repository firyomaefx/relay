import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { repoRoot } from "../helpers.mjs";

test("production price config grants $0.50 in free credit and excludes X", () => {
  const config = JSON.parse(readFileSync(path.join(repoRoot, "config/cloud-prices.json"), "utf8"));
  assert.equal(config.currency, "USD");
  assert.equal(config.unit, "milliUSD");
  assert.equal(config.free_allowance_milli_usd, 500);
  assert.deepEqual(config.free_excluded_platforms, ["x"]);
  assert.equal(config.free_allowance_units, undefined);
  assert.equal(config.prices.threads.text, 20);
  assert.equal(config.prices.threads.video, 40);
  assert.equal(config.prices.linkedin.text, 20);
  assert.equal(config.prices.linkedin.image, 20);
  assert.equal(config.prices.linkedin.video, 40);
});

