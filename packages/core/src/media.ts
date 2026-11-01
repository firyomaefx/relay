import { readFile } from "node:fs/promises";
import path from "node:path";
import { RelayError } from "./errors.js";
import type { MediaBlob, MediaItem } from "./types.js";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

export const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
export const VIDEO_MIME_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm", "video/x-m4v"]);

export function extensionOf(value: string): string {
  try {
    const withoutQuery = value.split("?")[0] ?? value;
    return path.extname(withoutQuery).toLowerCase();
  } catch {
    return "";
  }
}

export function mimeTypeFromName(value: string): string | undefined {
  return MIME_BY_EXTENSION[extensionOf(value)];
}

export function resolveMediaPath(item: MediaItem): string {
  if (!item.path) throw new RelayError("Media item is missing a path", "media_path_missing");
  return path.isAbsolute(item.path) ? item.path : path.resolve(process.cwd(), item.path);
}

export interface MediaInspection {
  ok: boolean;
  src: string;
  size: number;
  mimeType?: string;
  kind?: "image" | "video";
  error?: string;
}

export async function inspectMedia(item: MediaItem): Promise<MediaInspection> {
  if (item.url) {
    const mimeType = mimeTypeFromName(item.url);
    const kind = mimeType ? (IMAGE_MIME_TYPES.has(mimeType) ? "image" : "video") : item.kind;
    return { ok: true, src: item.url, size: 0, mimeType, kind };
  }
  if (!item.path) {
    return { ok: false, src: "", size: 0, error: "Media item needs either a path or a url" };
  }
  const resolved = resolveMediaPath(item);
  try {
    const { stat } = await import("node:fs/promises");
    const info = await stat(resolved);
    if (!info.isFile()) return { ok: false, src: resolved, size: 0, error: `Not a file: ${resolved}` };
    const mimeType = mimeTypeFromName(resolved);
    return { ok: true, src: resolved, size: info.size, mimeType, kind: mimeType ? (IMAGE_MIME_TYPES.has(mimeType) ? "image" : "video") : undefined };
  } catch {
    return { ok: false, src: resolved, size: 0, error: `File not found: ${resolved}` };
  }
}

export async function readMediaBlob(item: MediaItem): Promise<MediaBlob> {
  if (!item.path) {
    throw new RelayError(
      "This platform needs a local file to upload, but the media item only has a URL",
      "media_file_required",
    );
  }
  const resolved = resolveMediaPath(item);
  const buffer = await readFile(resolved);
  const mimeType = mimeTypeFromName(resolved) ?? (item.kind === "video" ? "video/mp4" : "image/jpeg");
  return { buffer, mimeType, filename: path.basename(resolved) };
}

/** Builds a public URL for a media item when the console serves it from .data/media. */
export function mediaPublicUrl(item: MediaItem, baseUrl: string | null, mediaDir: string): string | null {
  if (item.url) return item.url;
  if (!item.path || !baseUrl) return null;
  const resolved = resolveMediaPath(item);
  const root = path.resolve(mediaDir);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep)) return null;
  const name = path.basename(resolved);
  return `${baseUrl.replace(/\/+$/, "")}/media/${encodeURIComponent(name)}`;
}

/** Reads width/height from PNG, JPEG or WebP bytes. Returns undefined when the header is not recognised. */
export function imageDimensions(buf: Buffer): { width: number; height: number } | undefined {
  try {
    if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i += 1;
          continue;
        }
        const marker = buf[i + 1]!;
        if (marker === 0xff) {
          i += 1;
          continue;
        }
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
          i += 2;
          continue;
        }
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
      return undefined;
    }
    if (buf.length >= 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
      const format = buf.toString("ascii", 12, 16);
      if (format === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (format === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (format === "VP8L") {
        const bits = buf.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
  } catch {
    // Truncated file: no dimensions.
  }
  return undefined;
}

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
