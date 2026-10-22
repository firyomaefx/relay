#!/usr/bin/env node
/**
 * youtube-max-upload — keep uploading videos to YouTube until the daily API
 * quota is exhausted, then stop.
 *
 * YouTube does not expose a "quota remaining" endpoint, so the only reliable
 * signal is the API's quotaExceeded error. This tool uploads one video per
 * request and stops on that error.
 *
 * Usage:
 *   node tools/youtube-max-upload.mjs --dir C:\videos --dry-run
 *   node tools/youtube-max-upload.mjs --dir C:\videos --privacy public
 *   node tools/youtube-max-upload.mjs --dir C:\videos --limit 3 --title-prefix "Duit Poket "
 *
 * Notes:
 *   - Files are uploaded in name order.
 *   - Each file becomes its own video: title = filename (or title prefix +
 *     filename), description = title.
 *   - Quota resets at midnight Pacific Time (America/Los_Angeles).
 *   - A failed upload that is not quota-related is logged and skipped; the run
 *     continues so a single bad file cannot stop the batch.
 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".mkv", ".m4v"]);
const args = process.argv.slice(2);

function flagValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const base = (flagValue("--base") ?? process.env.RELAY_CONSOLE_URL ?? "http://127.0.0.1:4317").replace(/\/+$/, "");
const dirArg = flagValue("--dir");
const dir = dirArg ?? "content/youtube";
const dryRun = args.includes("--dry-run");
const recursive = args.includes("--recursive");
const privacy = flagValue("--privacy") ?? "public";
const titlePrefix = flagValue("--title-prefix") ?? "";
const limitRaw = flagValue("--limit");
const limit = limitRaw ? Number.parseInt(limitRaw, 10) : Number.POSITIVE_INFINITY;

if (!["public", "unlisted", "private"].includes(privacy)) {
  console.error("--privacy must be public, unlisted or private");
  process.exit(2);
}

async function listVideos(root) {
  const out = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (recursive) out.push(...(await listVideos(full)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    const info = await stat(full);
    out.push({ path: full, size: info.size, name: entry.name });
  }
  return out;
}

async function post(route, body) {
  const response = await fetch(`${base}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { error: text.slice(0, 500), code: `http_${response.status}` };
  }
  return { ok: response.ok, status: response.status, json };
}

function isQuotaError(text) {
  return /youtube_quota_exceeded|quotaExceeded|quota exceeded|exceeded your[^.]*quota|dailyLimitExceeded/i.test(
    String(text ?? ""),
  );
}

let videos;
try {
  videos = (await listVideos(dir)).sort((a, b) => a.name.localeCompare(b.name));
} catch (error) {
  console.error(`Cannot read video directory "${dir}": ${error.message}`);
  process.exit(2);
}
videos = videos.slice(0, limit);

if (videos.length === 0) {
  console.error(`No video files (.mp4/.mov/.webm/.mkv/.m4v) found in ${dir}`);
  process.exit(2);
}

console.log(`YouTube max upload — ${videos.length} video(s) from ${dir}`);
console.log(`Base: ${base} · privacy: ${privacy}${dryRun ? " · DRY RUN" : ""}\n`);

const summary = { uploaded: 0, failed: 0, quotaStopped: false, uploads: [] };
let index = 0;

for (const video of videos) {
  index += 1;
  const title = `${titlePrefix}${path.basename(video.name, path.extname(video.name))}`.slice(0, 100);
  const label = `#${index} ${video.name} (${(video.size / (1024 * 1024)).toFixed(1)} MB)`;

  if (dryRun) {
    console.log(`${label} -> would upload as "${title}"`);
    summary.uploads.push({ file: video.name, title, dryRun: true });
    continue;
  }

  const draft = {
    platforms: ["youtube"],
    text: title,
    media: [{ path: video.path, kind: "video" }],
    options: { youtube: { youtubePrivacy: privacy, youtubeTitle: title, youtubeDescription: title } },
  };

  const validation = await post("/api/validate", { draft });
  if (!validation.json?.ok) {
    const issues = (validation.json?.issues ?? []).map((issue) => `${issue.code}: ${issue.message}`).join("; ");
    console.log(`${label} INVALID — ${issues || "validation failed"}`);
    summary.failed += 1;
    summary.uploads.push({ file: video.name, ok: false, error: issues || "validation failed" });
    continue;
  }

  const result = await post("/api/posts", { draft, force: true });
  const row = (result.json?.results ?? [])[0] ?? {};
  const errorText = `${row.error ?? ""} ${result.json?.error ?? ""}`;

  if (row.ok) {
    summary.uploaded += 1;
    summary.uploads.push({ file: video.name, ok: true, videoId: row.postId, url: row.url });
    console.log(`${label} uploaded${row.postId ? ` id=${row.postId}` : ""}`);
    continue;
  }

  if (result.status === 429 || isQuotaError(errorText)) {
    summary.quotaStopped = true;
    summary.uploads.push({ file: video.name, ok: false, quota: true, error: errorText.trim() });
    console.log(`${label} QUOTA FULL — stopping (YouTube quota resets at midnight Pacific Time).`);
    break;
  }

  summary.failed += 1;
  summary.uploads.push({ file: video.name, ok: false, error: errorText.trim() || "publish failed" });
  console.log(`${label} FAILED — ${errorText.trim() || "publish failed"}`);

  // Auth/permission failures are not file-specific; stop instead of hammering.
  if (result.status === 401 || result.status === 403) {
    console.log("Stopping: YouTube rejected the request (auth/permission). Reconnect YouTube or check scopes.");
    break;
  }
}

console.log(
  `\n${summary.uploaded} uploaded, ${summary.failed} failed${summary.quotaStopped ? ", stopped on quota" : ""}`,
);
process.exitCode = summary.failed > 0 && !summary.quotaStopped ? 1 : 0;
