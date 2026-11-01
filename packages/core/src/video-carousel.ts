import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { MediaItem } from "./types.js";
import { RelayError } from "./errors.js";

const run = promisify(execFile);

function missingBinary(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

/**
 * Turn a video into a small set of still frames for TikTok/Instagram photo
 * carousels. Requires ffmpeg and ffprobe on the Relay host.
 */
export async function extractVideoCarousel(
  item: MediaItem,
  mediaDir: string,
  count = 6,
): Promise<MediaItem[]> {
  const source = item.path ? path.resolve(item.path) : item.url;
  if (!source) {
    throw new RelayError("A video path or URL is required to build a carousel.", "video_carousel_source_missing", undefined, 400);
  }
  const frames = Math.max(2, Math.min(10, Math.floor(count)));
  let durationSeconds = 0;
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      source,
    ]);
    durationSeconds = Number(stdout.trim());
  } catch (error) {
    if (missingBinary(error)) {
      throw new RelayError("ffmpeg is required for video carousels. Install ffmpeg on the Relay host.", "ffmpeg_missing", undefined, 500);
    }
    throw new RelayError(`Could not read the video duration: ${error instanceof Error ? error.message : String(error)}`, "video_probe_failed", undefined, 400);
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new RelayError("The video has no readable duration.", "video_duration_invalid", undefined, 400);
  }

  const folder = path.join(mediaDir, "carousel");
  await mkdir(folder, { recursive: true });
  let cacheKey = source;
  if (item.path) {
    try {
      const info = await stat(source);
      cacheKey = `${source}:${info.size}:${info.mtimeMs}`;
    } catch {
      // ffmpeg will produce the useful error.
    }
  }
  const stem = createHash("sha256").update(`${cacheKey}:${frames}`).digest("hex").slice(0, 16);
  const out: MediaItem[] = [];
  for (let index = 0; index < frames; index += 1) {
    const target = path.join(folder, `${stem}-${index + 1}.jpg`);
    const timestamp = Math.max(0, Math.min(durationSeconds - 0.05, durationSeconds * ((index + 0.5) / frames)));
    try {
      await run("ffmpeg", [
        "-y",
        "-ss", timestamp.toFixed(3),
        "-i", source,
        "-frames:v", "1",
        "-q:v", "2",
        target,
      ]);
    } catch (error) {
      if (missingBinary(error)) {
        throw new RelayError("ffmpeg is required for video carousels. Install ffmpeg on the Relay host.", "ffmpeg_missing", undefined, 500);
      }
      throw new RelayError(`Could not extract carousel frame ${index + 1}: ${error instanceof Error ? error.message : String(error)}`, "video_frame_failed", undefined, 500);
    }
    out.push({ path: target, kind: "image" });
  }
  return out;
}
