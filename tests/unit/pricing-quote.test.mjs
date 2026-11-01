import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { PriceTable } from "../../packages/cloud/dist/index.js";
import { repoRoot } from "../helpers.mjs";

const prices = PriceTable.load(path.join(repoRoot, "config/cloud-prices.json"));

test("pricing counts billable parts and platforms, not just the draft", () => {
  const single = prices.quote(
    { platforms: ["x"], text: "one text post" },
    ["x"],
  );
  assert.equal(single.quotes[0].parts, 1);
  assert.equal(single.quotes[0].amount, 20);
  assert.equal(single.total, 20);

  const five = prices.quote(
    { platforms: ["x", "threads", "tiktok", "youtube", "instagram"], thread: [{ text: "", media: [{ kind: "video", path: "v.mp4" }] }] },
    ["x", "threads", "tiktok", "youtube", "instagram"],
  );
  assert.equal(five.total, 200);

  const thread = prices.quote(
    {
      platforms: ["x", "threads"],
      thread: [{ text: "part one" }, { text: "part two" }, { text: "part three" }],
    },
    ["x", "threads"],
  );
  assert.equal(thread.quotes[0].parts, 3);
  assert.equal(thread.quotes[0].amount, 60);
  assert.equal(thread.quotes[0].breakdown.length, 3);
  assert.equal(thread.total, 120);
});

test("multi-platform pricing sums each platform's own part prices", () => {
  const quote = prices.quote(
    {
      platforms: ["threads", "instagram"],
      thread: [
        { text: "image part", media: [{ kind: "image", path: "a.png" }] },
        { text: "video part", media: [{ kind: "video", path: "b.mp4" }] },
      ],
    },
    ["threads", "instagram"],
  );
  assert.deepEqual(quote.quotes.map((entry) => entry.amount), [60, 60]);
  assert.equal(quote.total, 120);
  assert.deepEqual(quote.quotes[0].breakdown.map((part) => part.kind), ["image", "video"]);
});


