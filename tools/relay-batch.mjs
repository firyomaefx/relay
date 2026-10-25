#!/usr/bin/env node
/**
 * relay-batch — execute a content plan through the Relay HTTP API.
 *
 * Claude (expensive, e.g. Opus) writes a JSON content pack; DeepSeek, cron, or
 * a human runs this script. Publishing then costs zero LLM tokens.
 *
 * Usage:
 *   node tools/relay-batch.mjs content/plans/example-week.json --dry-run
 *   node tools/relay-batch.mjs content/plans/example-week.json
 *   node tools/relay-batch.mjs plan.json --base http://127.0.0.1:4317
 *
 * Plan shape (either a bare array or { name, items }):
 *   {
 *     "name": "week-2026-10-27",
 *     "items": [
 *       {
 *         "platforms": ["threads"],
 *         "text": "Post copy",
 *         "thread": ["optional second part"],
 *         "media": [{ "path": "C:/path/video.mp4", "kind": "video" }],
 *         "options": { "tiktok": { "tiktokMode": "draft" } },
 *         "scheduleAt": "2026-10-27T09:00:00+08:00"
 *       }
 *     ]
 *   }
 */
import { readFile } from "node:fs/promises";
import process from "node:process";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const baseFlag = args.indexOf("--base");
const base =
  (baseFlag >= 0 ? args[baseFlag + 1] : process.env.RELAY_CONSOLE_URL) || "http://127.0.0.1:4317";
const file = args.find((arg) => !arg.startsWith("--") && arg !== base);
if (!file) {
  console.error("Usage: node tools/relay-batch.mjs <plan.json> [--dry-run] [--base URL]");
  process.exit(2);
}

async function post(path, body) {
  const res = await fetch(`${base.replace(/\/+$/, "")}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { error: text.slice(0, 500) };
  }
  if (!res.ok) {
    throw new Error(json.error?.message ?? json.error ?? `HTTP ${res.status}`);
  }
  return json;
}

const raw = JSON.parse(await readFile(file, "utf8"));
const items = Array.isArray(raw) ? raw : raw.items;
if (!Array.isArray(items) || items.length === 0) {
  console.error(`No items found in ${file}. Expected an array or { "items": [...] }.`);
  process.exit(2);
}

const summary = { ok: 0, failed: 0, scheduled: 0, posts: [] };
for (const [index, item] of items.entries()) {
  const label = `#${index + 1} [${(item.platforms ?? []).join(",") || "?"}]`;
  try {
    const report = await post("/api/validate", { draft: item });
    if (report.ok === false || (Array.isArray(report.issues) && report.issues.length > 0)) {
      const issues = (report.issues ?? []).map((issue) => `${issue.code}: ${issue.message}`).join("; ");
      summary.failed += 1;
      summary.posts.push({ index: index + 1, ok: false, error: issues || "validation failed" });
      console.log(`${label} INVALID — ${issues}`);
      continue;
    }
    if (dryRun) {
      summary.ok += 1;
      summary.posts.push({ index: index + 1, ok: true, dryRun: true });
      console.log(`${label} valid (dry run)`);
      continue;
    }
    const result = await post("/api/posts", { draft: item });
    const row = (result.results ?? [])[0] ?? {};
    const scheduled = Boolean(result.scheduled);
    if (row.ok) {
      summary.ok += 1;
      if (scheduled) summary.scheduled += 1;
      summary.posts.push({
        index: index + 1,
        ok: true,
        platform: row.platform,
        postId: row.postId,
        scheduledFor: result.scheduledFor,
      });
      console.log(
        `${label} ${scheduled ? "scheduled" : "published"}${row.postId ? ` id=${row.postId}` : ""}${
          result.scheduledFor ? ` for ${result.scheduledFor}` : ""
        }`,
      );
    } else {
      summary.failed += 1;
      summary.posts.push({ index: index + 1, ok: false, error: row.error ?? "publish failed" });
      console.log(`${label} FAILED — ${row.error ?? "publish failed"}`);
    }
  } catch (error) {
    summary.failed += 1;
    summary.posts.push({ index: index + 1, ok: false, error: String(error.message ?? error) });
    console.log(`${label} ERROR — ${error.message ?? error}`);
  }
}

console.log(
  `\n${summary.ok} ok${dryRun ? " (dry run)" : ""}, ${summary.scheduled} scheduled, ${summary.failed} failed`,
);
// Let undici's keep-alive sockets close on their own; process.exit() here can trip
// a libuv assertion on Windows.
process.exitCode = summary.failed > 0 ? 1 : 0;
