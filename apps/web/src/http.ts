/**
 * Tiny HTTP helpers for the Relay console: JSON responses, safe body reading,
 * static file serving and path confinement.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { RelayError } from "@relay/core";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function contentTypeFor(filePath: string): string {
  return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export function securityHeaders(): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
}

export function sendJson(
  res: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  if (res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(value), "utf8");
  res.writeHead(status, {
    ...securityHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.byteLength),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

export function sendHtml(res: ServerResponse, status: number, html: string): void {
  if (res.writableEnded) return;
  const body = Buffer.from(html, "utf8");
  res.writeHead(status, {
    ...securityHeaders(),
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": String(body.byteLength),
    "Cache-Control": "no-store",
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  });
  res.end(body);
}

export function redirect(res: ServerResponse, location: string): void {
  if (res.writableEnded) return;
  res.writeHead(302, {
    ...securityHeaders(),
    Location: location,
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
  });
  res.end(`Redirecting to ${location}`);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (!name) continue;
    const rawValue = part.slice(separator + 1).trim();
    let value = rawValue;
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

function tooLarge(maxBytes: number): RelayError {
  return new RelayError(
    `Request body is too large (limit ${Math.round(maxBytes / (1024 * 1024))} MB)`,
    "payload_too_large",
    undefined,
    413,
  );
}

export async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge(maxBytes);

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > maxBytes) throw tooLarge(maxBytes);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}

export async function readJsonBody(req: IncomingMessage, maxBytes = 2 * 1024 * 1024): Promise<unknown> {
  const raw = await readRawBody(req, maxBytes);
  if (raw.length === 0) return {};
  const text = raw.toString("utf8").replace(/^\uFEFF/, "").trim();
  if (text === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RelayError("Request body must be valid JSON", "invalid_json", undefined, 400);
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RelayError("Request body must be a JSON object", "body_invalid", undefined, 400);
  }
  return value as Record<string, unknown>;
}

/** Keeps a resolved path inside `root` and rejects segments that can escape it. */
export function resolveWithin(root: string, segments: readonly string[]): string | null {
  const resolvedRoot = path.resolve(root);
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") return null;
    if (segment.includes("\0") || /[\\/:]/.test(segment)) return null;
  }
  const target = segments.length === 0 ? resolvedRoot : path.resolve(resolvedRoot, ...segments);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) return null;
  return target;
}

interface SendFileOptions {
  headers?: Record<string, string>;
  cacheControl?: string;
  html?: boolean;
}

/** Streams a file. Resolves to false when the file does not exist. */
export async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  options: SendFileOptions = {},
): Promise<boolean> {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;

  const headers: Record<string, string> = {
    ...securityHeaders(),
    "Content-Type": contentTypeFor(filePath),
    "Content-Length": String(info.size),
    "Cache-Control": options.cacheControl ?? "no-store",
    ...options.headers,
  };
  if (options.html) headers["Content-Security-Policy"] = CONTENT_SECURITY_POLICY;
  res.writeHead(200, headers);
  if ((req.method ?? "GET").toUpperCase() === "HEAD") {
    res.end();
    return true;
  }
  try {
    await pipeline(createReadStream(filePath), res);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ERR_STREAM_PREMATURE_CLOSE" && code !== "ECONNRESET") throw error;
  }
  return true;
}
