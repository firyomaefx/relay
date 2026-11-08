// REQ-016
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { verifyMcp } from "../../packages/connector/dist/index.js";

async function fakeMcp(toolCount) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const payload = JSON.parse(body);
      requests.push({ method: payload.method, auth: req.headers.authorization, session: req.headers["mcp-session-id"] });
      if (req.headers.authorization !== "Bearer rlc_test") {
        res.writeHead(401).end("unauthorized");
        return;
      }
      if (payload.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { protocolVersion: "2025-06-18" } }));
        return;
      }
      if (payload.method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }
      if (payload.method === "tools/list") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { tools: Array.from({ length: toolCount }, (_, i) => ({ name: `tool_${i}` })) } }));
        return;
      }
      res.writeHead(400).end("bad method");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return { url: `http://127.0.0.1:${port}/mcp`, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("verifyMcp completes initialize, initialized notification and tools/list", async () => {
  const fake = await fakeMcp(2);
  try {
    const result = await verifyMcp(fake.url, "rlc_test");
    assert.deepEqual(result, { protocolVersion: "2025-06-18", toolCount: 2 });
    assert.deepEqual(fake.requests.map((request) => request.method), ["initialize", "notifications/initialized", "tools/list"]);
    assert.equal(fake.requests[0].auth, "Bearer rlc_test");
    assert.equal(fake.requests[2].session, "sess-1");
  } finally {
    await fake.close();
  }
});

test("verifyMcp fails closed when tools are empty or auth is rejected", async () => {
  const fake = await fakeMcp(0);
  try {
    await assert.rejects(() => verifyMcp(fake.url, "rlc_test"), /no tools/);
    await assert.rejects(() => verifyMcp(fake.url, "rlc_wrong"), /HTTP 401/);
  } finally {
    await fake.close();
  }
});
