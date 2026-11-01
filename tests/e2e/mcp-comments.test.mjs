/**
 * MCP end-to-end test for relay_comments_new and relay_reply.
 * The server runs in forced mock mode: no real API is called and nothing is posted.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { callTool, cleanupTempDir, makeTempDir, startMcpClient, toolResultDescription } from "../helpers.mjs";

test("MCP comment tools: listed, validated, deduped and mock-safe", { timeout: 120000 }, async () => {
  const dataDir = await makeTempDir("relay-mcp-comments-");
  let mcp;
  try {
    mcp = await startMcpClient({ dataDir });
    const { client } = mcp;
    const listed = (await client.listTools()).tools;
    const names = listed.map((t) => t.name);
    for (const name of ["relay_comments_new", "relay_reply"]) assert.ok(names.includes(name), `missing ${name}`);
    const replyTool = listed.find((t) => t.name === "relay_reply");
    for (const key of ["platform", "comment_id", "text", "post_id", "dry_run"]) assert.ok(replyTool.inputSchema.properties[key], `relay_reply lacks ${key}`);
    const newTool = listed.find((t) => t.name === "relay_comments_new");
    for (const key of ["platform", "since_hours", "limit", "mark_seen"]) assert.ok(newTool.inputSchema.properties[key], `relay_comments_new lacks ${key}`);

    // Nothing connected: platforms report not_connected, no crash.
    const none = await callTool(client, "relay_comments_new", {});
    assert.equal(none.isError, false, toolResultDescription(none));
    assert.equal(none.payload.comments.length, 0);
    assert.deepEqual(none.payload.platforms.map((p) => p.status), ["not_connected", "not_connected", "not_connected"]);

    for (const platform of ["threads", "instagram", "youtube"]) await callTool(client, "relay_connect", { platform });

    const accounts = await callTool(client, "relay_accounts");
    assert.equal(accounts.payload.comments.length, 3);
    assert.ok(accounts.payload.comments.every((c) => c.ready === true), "mock accounts carry the comment scopes");

    const peek = await callTool(client, "relay_comments_new", { platform: "instagram", since_hours: 24, limit: 5, mark_seen: false });
    assert.equal(peek.isError, false, toolResultDescription(peek));
    assert.equal(peek.payload.mark_seen, false);
    assert.equal(peek.payload.limit, 5);
    assert.equal(peek.payload.since_hours, 24);

    const badWindow = await client.callTool({ name: "relay_comments_new", arguments: { since_hours: 500 } }).catch((e) => ({ isError: true, error: e }));
    assert.equal(badWindow.isError, true, "since_hours above 168 is rejected");

    const dry = await callTool(client, "relay_reply", { platform: "youtube", comment_id: "c1", text: "Terima kasih sudi singgah.", dry_run: true });
    assert.equal(dry.isError, false, toolResultDescription(dry));
    assert.equal(dry.payload.dry_run, true);
    assert.equal(dry.payload.would_send, true);

    const sent = await callTool(client, "relay_reply", { platform: "instagram", comment_id: "c2", text: "Sama-sama." });
    assert.equal(sent.isError, false, toolResultDescription(sent));
    assert.equal(sent.payload.mock, true);
    assert.equal(sent.payload.dry_run, false);

    const again = await callTool(client, "relay_reply", { platform: "instagram", comment_id: "c2", text: "Sama-sama lagi." });
    assert.equal(again.isError, true);
    assert.equal(again.payload.code, "comment_already_replied");

    const tooLong = await callTool(client, "relay_reply", { platform: "threads", comment_id: "c3", text: "x".repeat(501) });
    assert.equal(tooLong.isError, true);
    assert.equal(tooLong.payload.code, "comment_text_too_long");

    const wrongPlatform = await client.callTool({ name: "relay_reply", arguments: { platform: "tiktok", comment_id: "c4", text: "hi" } }).catch((e) => ({ isError: true, error: e }));
    assert.equal(wrongPlatform.isError, true);
  } finally {
    if (mcp) await mcp.close();
    await cleanupTempDir(dataDir);
  }
});
