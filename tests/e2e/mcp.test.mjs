/**
 * End-to-end test for the MCP server: spawns `node apps/mcp/dist/index.js` over
 * stdio with a temporary data directory, performs the initialize handshake, lists
 * the tools and drives the whole mock publishing flow (connect, post, history,
 * schedule + wait for the scheduler).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MCP_TOOL_NAMES,
  callTool,
  cleanupTempDir,
  isoIn,
  makeTempDir,
  startMcpClient,
  toolResultDescription,
  waitFor,
} from "../helpers.mjs";

test(
  "MCP stdio server exposes the Relay tools and completes the mock publish flow",
  { timeout: 180000 },
  async () => {
    const dataDir = await makeTempDir("relay-mcp-e2e-");
    let mcp;
    try {
      mcp = await startMcpClient({ dataDir });
      const { client } = mcp;

      // --- tools/list: every promised tool must be registered -----------------
      const listed = await client.listTools();
      const toolNames = listed.tools.map((tool) => tool.name);
      for (const expected of MCP_TOOL_NAMES) {
        assert.ok(
          toolNames.includes(expected),
          `tools/list is missing ${expected}; got: ${toolNames.join(", ")}`,
        );
      }
      for (const tool of listed.tools) {
        assert.equal(typeof tool.name, "string");
        assert.ok(tool.inputSchema && typeof tool.inputSchema === "object", `${tool.name} has no input schema`);
      }

      // --- relay_accounts: starts empty ---------------------------------------
      const accountsBefore = await callTool(client, "relay_accounts");
      assert.equal(accountsBefore.isError, false, toolResultDescription(accountsBefore));
      assert.ok(Array.isArray(accountsBefore.payload.accounts), "relay_accounts payload must include accounts");
      assert.equal(accountsBefore.payload.mock, true, "RELAY_MOCK=1 must force simulated mode");
      assert.deepEqual(accountsBefore.payload.accounts, []);

      // --- relay_connect (mock X account) -------------------------------------
      const connect = await callTool(client, "relay_connect", { platform: "x" });
      assert.equal(connect.isError, false, toolResultDescription(connect));
      assert.equal(connect.payload.mode, "connected");
      assert.equal(connect.payload.account.platform, "x");
      assert.equal(connect.payload.account.mode, "mock");
      assert.equal(connect.payload.account.handle, "relay_demo");

      const accountsAfter = await callTool(client, "relay_accounts");
      assert.equal(accountsAfter.isError, false, toolResultDescription(accountsAfter));
      assert.ok(
        accountsAfter.payload.accounts.some(
          (account) => account.platform === "x" && account.handle === "relay_demo" && account.mode === "mock",
        ),
        `relay_accounts should list the connected mock X account: ${JSON.stringify(accountsAfter.payload.accounts)}`,
      );

      // --- relay_preview: read-only per-platform variants -----------------------
      const preview = await callTool(client, "relay_preview", {
        platforms: ["x", "instagram"],
        text: "word ".repeat(700).trim(),
      });
      assert.equal(preview.isError, false, toolResultDescription(preview));
      assert.equal(preview.payload.platforms.length, 2);
      assert.ok(preview.payload.platforms.find((entry) => entry.platform === "x").parts.length > 1);
      assert.equal((await callTool(client, "relay_history", { limit: 5 })).payload.records.length, 0);

      // --- relay_post: publish immediately ------------------------------------
      const text = `Hello from the MCP e2e test ${Date.now()}`;
      const post = await callTool(client, "relay_post", { platforms: ["x"], text });
      assert.equal(post.isError, false, toolResultDescription(post));
      assert.equal(post.payload.scheduled, false);
      assert.equal(post.payload.results.length, 1);
      assert.equal(post.payload.results[0].platform, "x");
      assert.equal(post.payload.results[0].ok, true);
      assert.equal(post.payload.results[0].mode, "mock");

      // --- relay_history: shows the published record --------------------------
      const history = await callTool(client, "relay_history", { limit: 20 });
      assert.equal(history.isError, false, toolResultDescription(history));
      const historyRecords = history.payload.records;
      assert.ok(Array.isArray(historyRecords), "relay_history payload must include records");
      const record = historyRecords.find((entry) => entry.draft?.text === text);
      assert.ok(record, `history should contain the published post; got: ${JSON.stringify(historyRecords)}`);
      assert.equal(record.results[0].ok, true);
      assert.equal(record.results[0].mode, "mock");

      // --- schedule a post ~1.5s ahead and wait for the MCP scheduler ---------
      const scheduledText = `Scheduled from the MCP e2e test ${Date.now()}`;
      const scheduleAt = isoIn(2000);
      const scheduled = await callTool(client, "relay_post", {
        platforms: ["x"],
        text: scheduledText,
        schedule_at: scheduleAt,
      });
      assert.equal(scheduled.isError, false, toolResultDescription(scheduled));
      assert.equal(scheduled.payload.scheduled, true, "relay_post must queue a future schedule_at");
      assert.ok(scheduled.payload.jobId, "a scheduled post must return a jobId");
      assert.equal(scheduled.payload.scheduleAt, new Date(scheduleAt).toISOString());

      const published = await waitFor(
        async () => {
          const response = await callTool(client, "relay_history", { limit: 50 });
          if (response.isError) throw new Error(`relay_history failed: ${toolResultDescription(response)}`);
          const found = (response.payload.records ?? []).find((entry) => entry.draft?.text === scheduledText);
          return found ?? null;
        },
        {
          timeoutMs: 30000,
          intervalMs: 500,
          label: "the MCP scheduler to publish the scheduled post",
          onTimeout: () => `--- MCP server stderr ---\n${mcp.tail()}`,
        },
      );
      assert.equal(published.results[0].ok, true);
      assert.equal(published.results[0].mode, "mock");
      assert.ok(published.scheduledFor, "the scheduled record must remember its schedule time");

      // --- relay_queue: the job is done, exactly one history record -----------
      const queue = await callTool(client, "relay_queue");
      assert.equal(queue.isError, false, toolResultDescription(queue));
      const job = (queue.payload.jobs ?? []).find((entry) => entry.id === scheduled.payload.jobId);
      assert.ok(job, `relay_queue should list job ${scheduled.payload.jobId}`);
      assert.equal(job.status, "done");
      assert.equal(job.attempts, 1);

      const historyAfter = await callTool(client, "relay_history", { limit: 50 });
      const matching = (historyAfter.payload.records ?? []).filter((entry) => entry.draft?.text === scheduledText);
      assert.equal(matching.length, 1, "the scheduled post must be published exactly once");
    } finally {
      await mcp?.close();
      await cleanupTempDir(dataDir);
    }
  },
);
