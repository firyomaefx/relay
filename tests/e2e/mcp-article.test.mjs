/**
 * MCP end-to-end test for relay_article_validate, relay_article and relay_delete.
 * The server runs in forced mock mode, so nothing is posted, deleted or pinned
 * on any real account.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { callTool, cleanupTempDir, isoIn, makeTempDir, startMcpClient, toolResultDescription, writeTinyPng } from "../helpers.mjs";

test("MCP article + delete tools work end to end in mock mode", { timeout: 120000 }, async () => {
  const dataDir = await makeTempDir("relay-mcp-article-");
  let mcp;
  try {
    mcp = await startMcpClient({ dataDir });
    const { client } = mcp;
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of ["relay_article", "relay_article_validate", "relay_delete"]) assert.ok(names.includes(name), `missing ${name}`);

    await callTool(client, "relay_connect", { platform: "x" });
    await callTool(client, "relay_connect", { platform: "tiktok" });

    const body = [{ heading: "Setup", paragraphs: ["First paragraph.", "Second one."] }];

    const invalid = await callTool(client, "relay_article_validate", { title: "", body });
    assert.equal(invalid.isError, false);
    assert.equal(invalid.payload.ok, false);
    assert.equal(invalid.payload.issues[0].code, "article_title_required");

    const valid = await callTool(client, "relay_article_validate", { title: "Mock article", body_markdown: "# Hi\n\nSome text here." });
    assert.equal(valid.payload.ok, true, toolResultDescription(valid));

    const rejected = await callTool(client, "relay_article", { title: "x".repeat(120), body });
    assert.equal(rejected.isError, true);

    // schedule, see it in the queue, remove it
    const scheduled = await callTool(client, "relay_article", { title: "Queued article", body, schedule_at: isoIn(3_600_000) });
    assert.equal(scheduled.isError, false, toolResultDescription(scheduled));
    assert.equal(scheduled.payload.scheduled, true);
    const queue = await callTool(client, "relay_queue");
    const job = queue.payload.jobs.find((j) => j.id === scheduled.payload.jobId);
    assert.equal(job.kind, "article");
    assert.equal(job.status, "pending");
    const removed = await callTool(client, "relay_delete", { job_id: scheduled.payload.jobId });
    assert.equal(removed.isError, false, toolResultDescription(removed));
    assert.equal(removed.payload.removed, true);
    const queueAfter = await callTool(client, "relay_queue");
    assert.equal(queueAfter.payload.jobs.some((j) => j.id === scheduled.payload.jobId), false);

    // publish now (simulated), find it in history
    const now = await callTool(client, "relay_article", { title: "Published article", body });
    assert.equal(now.isError, false, toolResultDescription(now));
    assert.equal(now.payload.results[0].mode, "mock");
    const history = await callTool(client, "relay_history", { limit: 5 });
    const record = history.payload.records.find((r) => r.kind === "article");
    assert.ok(record, "article must appear in history");
    const postId = record.results[0].postId;

    // delete: wrong inputs, preview, confirm, unsupported
    const none = await callTool(client, "relay_delete", {});
    assert.equal(none.isError, true);
    const both = await callTool(client, "relay_delete", { job_id: "job_x", record_id: record.id });
    assert.equal(both.isError, true);

    const preview = await callTool(client, "relay_delete", { record_id: record.id });
    assert.equal(preview.isError, false);
    assert.equal(preview.payload.confirmed, false);
    assert.equal(preview.payload.targets[0].postId, postId);
    const stillThere = await callTool(client, "relay_delete", { record_id: record.id });
    assert.equal(stillThere.payload.targets.length, 1, "preview must not delete anything");

    const confirmed = await callTool(client, "relay_delete", { platform: "x", post_id: postId, confirm: true });
    assert.equal(confirmed.isError, false, toolResultDescription(confirmed));
    assert.equal(confirmed.payload.outcomes[0].status, "deleted");
    assert.equal(confirmed.payload.outcomes[0].mock, true);

    const gone = await callTool(client, "relay_delete", { record_id: record.id, confirm: true });
    assert.match(gone.text, /Nothing left to delete/);

    const unsupported = await callTool(client, "relay_delete", { platform: "tiktok", post_id: "99", confirm: true });
    assert.equal(unsupported.isError, true);
    assert.equal(unsupported.payload.outcomes[0].status, "unsupported");
    assert.match(unsupported.payload.outcomes[0].error, /Unsupported/);
  } finally {
    await mcp?.close();
    await cleanupTempDir(dataDir);
  }
});

test("MCP article tools accept inline body images (schema, validate, simulated publish, errors)", { timeout: 120000 }, async () => {
  const dataDir = await makeTempDir("relay-mcp-article-img-");
  let mcp;
  try {
    const a = path.join(dataDir, "flow.png");
    await writeTinyPng(a);
    mcp = await startMcpClient({ dataDir });
    const { client } = mcp;

    const tools = (await client.listTools()).tools;
    for (const name of ["relay_article", "relay_article_validate"]) {
      const schema = tools.find((t) => t.name === name).inputSchema;
      const item = schema.properties.body.items;
      assert.ok(item.properties.image, `${name}: body items must accept image`);
      assert.deepEqual(Object.keys(item.properties.image.properties).sort(), ["altText", "caption", "path"]);
      assert.deepEqual(item.properties.image.required, ["path"]);
      assert.equal(item.required === undefined || !item.required.includes("paragraphs"), true, "paragraphs must be optional");
    }

    await callTool(client, "relay_connect", { platform: "x" });
    const body = [{ paragraphs: ["First.", "Second."] }, { image: { path: a, altText: "Flow", caption: "The flow" } }, { paragraphs: ["Third."] }];

    const valid = await callTool(client, "relay_article_validate", { title: "With image", body });
    assert.equal(valid.isError, false);
    assert.equal(valid.payload.ok, true, toolResultDescription(valid));
    assert.equal(valid.payload.stats.images, 1);
    assert.equal(valid.payload.stats.imageFiles[0].path, a);
    assert.equal(valid.payload.stats.imageFiles[0].mimeType, "image/png");
    assert.deepEqual(valid.payload.normalized.blocks.map((b) => b.type), ["unstyled", "unstyled", "atomic", "unstyled"]);
    assert.equal(valid.payload.normalized.blocks[2].image.caption, "The flow");
    assert.match(valid.text, /1 inline image/);

    const md = await callTool(client, "relay_article_validate", { title: "Md image", body_markdown: `Text.\n\n![alt](${a})\n\nMore.` });
    assert.equal(md.payload.ok, true, toolResultDescription(md));
    assert.equal(md.payload.stats.images, 1);

    const withCover = await callTool(client, "relay_article_validate", { title: "Both", body, cover: { path: a } });
    assert.equal(withCover.payload.ok, true, toolResultDescription(withCover));

    const missing = await callTool(client, "relay_article_validate", { title: "Bad", body: [{ paragraphs: ["x"] }, { image: { path: path.join(dataDir, "nope.png") } }] });
    assert.equal(missing.payload.ok, false);
    assert.equal(missing.payload.issues[0].code, "article_image_unreadable");

    const wrongType = path.join(dataDir, "pic.gif");
    await writeFile(wrongType, "GIF89a");
    const rejected = await callTool(client, "relay_article", { title: "Bad type", body: [{ paragraphs: ["x"] }, { image: { path: wrongType } }] });
    assert.equal(rejected.isError, true);
    assert.match(rejected.text, /article_image_type_unsupported|not supported/);

    // old shape still works untouched
    const old = await callTool(client, "relay_article_validate", { title: "Old", body: [{ heading: "H", paragraphs: ["P."] }] });
    assert.equal(old.payload.ok, true);
    assert.equal("images" in old.payload.stats, false);

    // simulated publish with inline image (mock mode: no network, nothing on X)
    const made = await callTool(client, "relay_article", { title: "Published with image", body, cover: { path: a } });
    assert.equal(made.isError, false, toolResultDescription(made));
    assert.equal(made.payload.results[0].mode, "mock");
    assert.equal(made.payload.stats.images, 1);
  } finally {
    await mcp?.close();
    await cleanupTempDir(dataDir);
  }
});