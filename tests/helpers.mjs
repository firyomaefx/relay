/**
 * Shared helpers for the Relay test suite.
 *
 * Everything here is plain ESM (no TypeScript, no test-runner imports) so both
 * `node --test tests/` and `npm run smoke` can use it.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const repoRoot = path.resolve(import.meta.dirname, "..");

/** Well-known 1x1 transparent PNG (67 bytes). */
export const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

export const MCP_TOOL_NAMES = [
  "relay_accounts",
  "relay_connect",
  "relay_disconnect",
  "relay_post",
  "relay_validate",
  "relay_preview",
  "relay_queue",
  "relay_cancel",
  "relay_history",
  "relay_threads_comments",
  "relay_threads_autoreply",
  "relay_threads_reply",
  "relay_comments_new",
  "relay_reply",
  "relay_article",
  "relay_article_validate",
  "relay_delete",
  "relay_limits",
  "relay_console",
];

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function makeTempDir(prefix = "relay-test-") {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function cleanupTempDir(dir) {
  if (!dir) return;
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/** ISO timestamp `ms` milliseconds in the future. */
export function isoIn(ms) {
  return new Date(Date.now() + ms).toISOString();
}

/**
 * Polls `predicate` until it returns a truthy value. No fixed sleeps for
 * readiness: callers always pass a deadline.
 */
export async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 100, label = "condition", onTimeout } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() <= deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  let message = `Timed out after ${timeoutMs}ms waiting for ${label}`;
  if (lastError) message += `\nLast error: ${lastError.message}`;
  if (onTimeout) {
    try {
      const extra = await onTimeout();
      if (extra) message += `\n${extra}`;
    } catch {
      // Diagnostics are best effort.
    }
  }
  throw new Error(message);
}

export function tinyPngBuffer() {
  return Buffer.from(TINY_PNG_BASE64, "base64");
}

export async function writeTinyPng(file) {
  await writeFile(file, tinyPngBuffer());
  return file;
}

export async function requireFile(file, hint = "") {
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
    return file;
  } catch {
    throw new Error(`Missing build artifact: ${file}. Run "npm run build" first.${hint ? `\n${hint}` : ""}`);
  }
}

export async function readJsonFile(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

/** Reads a JSON file, retrying because the server may be mid-rename. */
export async function readJsonFileRetry(file, { timeoutMs = 10000, intervalMs = 100 } = {}) {
  return waitFor(
    async () => {
      try {
        return await readJsonFile(file);
      } catch {
        return null;
      }
    },
    { timeoutMs, intervalMs, label: `readable JSON at ${file}` },
  );
}

export async function listFiles(dir) {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** Spawns `node <entry>` with stdout/stderr captured (bounded tails for failures). */
export function spawnNode(entry, { cwd = repoRoot, env = {}, args = [] } = {}) {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const captured = { stdout: "", stderr: "" };
  const MAX_CAPTURE = 512 * 1024;
  child.stdout?.on("data", (chunk) => {
    captured.stdout = (captured.stdout + chunk.toString()).slice(-MAX_CAPTURE);
  });
  child.stderr?.on("data", (chunk) => {
    captured.stderr = (captured.stderr + chunk.toString()).slice(-MAX_CAPTURE);
  });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));

  const proc = {
    child,
    captured,
    exited,
    get pid() {
      return child.pid;
    },
    get running() {
      return child.exitCode === null && child.signalCode === null;
    },
    tail(limit = 6000) {
      const text = `stdout tail:\n${captured.stdout}\nstderr tail:\n${captured.stderr}`;
      return text.length > limit ? text.slice(-limit) : text;
    },
  };
  return proc;
}

export async function stopChild(proc, { timeoutMs = 8000 } = {}) {
  const child = proc?.child ?? proc;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // Already gone.
  }
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    sleep(timeoutMs).then(() => false),
  ]);
  if (!exited) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(3000)]);
  }
}

/** Resolves true when nothing is listening on 127.0.0.1:port. */
export function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

/** Waits for a test port to become free (a previous aborted run may still hold it). */
async function waitForFreePort(port, { timeoutMs = 10000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await isPortFree(port)) return;
    await sleep(intervalMs);
  }
  throw new Error(
    `Test port 127.0.0.1:${port} is still in use by another process. ` +
      "Stop the process using it (or rerun once it exits) and try again.",
  );
}

/**
 * Starts `apps/web/dist/index.js` on `port` and waits until /api/health answers.
 * Throws with the server's stdout/stderr tail when it fails to start.
 */
export async function startWebServer({ dataDir, port, env = {}, label = `web:${port}`, healthTimeoutMs = 30000 } = {}) {
  const entry = path.join(repoRoot, "apps", "web", "dist", "index.js");
  await requireFile(entry, "The web console is not built yet.");
  await waitForFreePort(port);
  const proc = spawnNode(entry, {
    env: {
      RELAY_DATA_DIR: dataDir,
      RELAY_MOCK: "1",
      RELAY_HOST: "127.0.0.1",
      RELAY_PORT: String(port),
      ...env,
    },
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitFor(
      async () => {
        if (!proc.running) {
          throw new Error(`${label} exited before becoming ready (code ${proc.child.exitCode}).\n${proc.tail()}`);
        }
        try {
          const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2000) });
          return response.ok;
        } catch {
          return false;
        }
      },
      {
        timeoutMs: healthTimeoutMs,
        intervalMs: 150,
        label: `${label} /api/health at ${baseUrl}`,
        onTimeout: () => `--- ${label} output ---\n${proc.tail()}`,
      },
    );
  } catch (error) {
    await stopChild(proc);
    throw error;
  }

  return {
    child: proc.child,
    captured: proc.captured,
    baseUrl,
    dataDir,
    tail: proc.tail,
    exited: proc.exited,
    get running() {
      return proc.running;
    },
    get pid() {
      return proc.pid;
    },
    stop: () => stopChild(proc),
  };
}

/** Minimal JSON HTTP helper with a clear failure message (includes response body). */
export async function httpJson(baseUrl, pathname, { method = "GET", body, headers = {}, timeoutMs = 15000 } = {}) {
  const requestHeaders = { ...headers };
  const init = { method, headers: requestHeaders, signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) {
    requestHeaders["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(`${baseUrl}${pathname}`, init);
  } catch (error) {
    throw new Error(`HTTP ${method} ${pathname} failed: ${error.message}`);
  }
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, ok: response.ok, text, json, headers: response.headers };
}

export function requestSummary(res, limit = 1500) {
  const body = res.text.length > limit ? `${res.text.slice(0, limit)}...` : res.text;
  return `HTTP ${res.status} ${body}`;
}

/** Unwraps common response envelope shapes. */
export function unwrapJson(json) {
  if (json && typeof json === "object") {
    if (json.data !== undefined && (json.ok !== undefined || json.success !== undefined)) return json.data;
    if (json.state !== undefined) return json.state;
  }
  return json;
}

export function extractList(json, keys) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  for (const key of keys) {
    if (Array.isArray(json[key])) return json[key];
  }
  if (json.data !== undefined) return extractList(json.data, keys);
  if (json.state !== undefined) return extractList(json.state, keys);
  return [];
}

export function extractHistory(json) {
  return extractList(json, ["history", "posts", "records", "items"]);
}

export function extractQueue(json) {
  return extractList(json, ["queue", "jobs", "items"]);
}

export function extractReport(json) {
  const root = unwrapJson(json);
  if (!root || typeof root !== "object") return undefined;
  for (const key of ["report", "validation", "validationReport"]) {
    if (root[key] && typeof root[key] === "object") return root[key];
  }
  return root;
}

/** Finds a platform entry in a /api/state-like payload (array or keyed object). */
export function platformEntry(json, platform) {
  const root = unwrapJson(json) ?? json;
  const candidates = [root?.platforms, root?.settings?.platforms, json?.platforms, json?.state?.platforms];
  for (const platforms of candidates) {
    if (Array.isArray(platforms)) {
      const found = platforms.find((entry) => entry?.platform === platform);
      if (found) return found;
    } else if (platforms && typeof platforms === "object" && platforms[platform]) {
      return platforms[platform];
    }
  }
  return undefined;
}

/** Waits for the server to report `connected` for a platform. */
export async function waitForConnected(server, platform, { timeoutMs = 15000 } = {}) {
  return waitFor(
    async () => {
      const res = await httpJson(server.baseUrl, "/api/state");
      if (!res.ok) throw new Error(`GET /api/state -> ${requestSummary(res)}`);
      const entry = platformEntry(res.json, platform);
      return entry?.connected ? entry : null;
    },
    { timeoutMs, intervalMs: 200, label: `${platform} to be connected`, onTimeout: () => server.tail() },
  );
}

export async function waitForDisconnected(server, platform, { timeoutMs = 15000 } = {}) {
  return waitFor(
    async () => {
      const res = await httpJson(server.baseUrl, "/api/state");
      if (!res.ok) throw new Error(`GET /api/state -> ${requestSummary(res)}`);
      const entry = platformEntry(res.json, platform);
      return entry && entry.connected === false ? entry : null;
    },
    { timeoutMs, intervalMs: 200, label: `${platform} to be disconnected`, onTimeout: () => server.tail() },
  );
}

/** Reads the scheduler lock file and returns its parsed owner. */
export async function readSchedulerLock(dataDir) {
  try {
    return JSON.parse(await readFile(path.join(dataDir, "scheduler.lock"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Starts the MCP server over stdio with the official SDK client.
 * Returns the client plus a `tail()` of the server's stderr for diagnostics.
 */
export async function startMcpClient({ dataDir, env = {} } = {}) {
  const entry = path.join(repoRoot, "apps", "mcp", "dist", "index.js");
  await requireFile(entry, "The MCP server is not built yet.");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: repoRoot,
    env: { RELAY_DATA_DIR: dataDir, RELAY_MOCK: "1", ...env },
    stderr: "pipe",
  });
  const stderrChunks = [];
  transport.stderr?.on("data", (chunk) => stderrChunks.push(chunk.toString()));
  const tail = (limit = 6000) => {
    const text = stderrChunks.join("");
    return text.length > limit ? text.slice(-limit) : text;
  };

  const client = new Client({ name: "relay-e2e-client", version: "1.0.0" });
  try {
    await client.connect(transport);
  } catch (error) {
    throw new Error(`MCP initialize handshake failed: ${error.message}\nstderr tail:\n${tail()}`);
  }

  const close = async () => {
    try {
      await client.close();
    } catch {
      // Best effort.
    }
    try {
      await transport.close();
    } catch {
      // Best effort.
    }
    const pid = transport.pid;
    if (pid) {
      try {
        process.kill(pid, 0);
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  };

  return { client, transport, close, tail };
}

export function collectToolText(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  return parts
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

export function toolPayload(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = collectToolText(result);
  return parseEmbeddedJson(text) ?? text;
}

/**
 * MCP tools return "<human summary>\n\n<pretty JSON>", so extract the JSON
 * payload from the text when it is not the whole message.
 */
export function parseEmbeddedJson(text) {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to the embedded payload.
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** Calls an MCP tool and normalizes errors into a helpful message. */
export async function callTool(client, name, args = {}) {
  let result;
  try {
    result = await client.callTool({ name, arguments: args });
  } catch (error) {
    throw new Error(`MCP tool ${name} failed: ${error.message}`);
  }
  const text = collectToolText(result);
  const payload = toolPayload(result);
  return { ...result, text, payload, isError: Boolean(result?.isError) };
}

export function toolResultDescription(result) {
  if (!result) return "<no result>";
  return `isError=${result.isError}\ntext:\n${result.text}`;
}
