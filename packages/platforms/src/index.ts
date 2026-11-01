import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RelayService } from "@relay/core";
import type { PlatformAdapter, ReplyGenerator } from "@relay/core";
import { XAdapter } from "./adapters/x.js";
import { ThreadsAdapter } from "./adapters/threads.js";
import { TikTokAdapter } from "./adapters/tiktok.js";
import { YouTubeAdapter } from "./adapters/youtube.js";
import { InstagramAdapter } from "./adapters/instagram.js";
import { LinkedInAdapter } from "./adapters/linkedin.js";

export { XAdapter, ThreadsAdapter, TikTokAdapter, YouTubeAdapter, InstagramAdapter, LinkedInAdapter };
export { isAuthFailure } from "./adapters/http.js";
export { mockProfile, mockPublish, mockScopes, requireMediaUrl } from "./mock.js";

export interface CreateAdaptersOptions {
  env?: NodeJS.ProcessEnv;
  forceMock?: boolean;
}

export function createAdapters(_options: CreateAdaptersOptions = {}): PlatformAdapter[] {
  return [new XAdapter(), new ThreadsAdapter(), new TikTokAdapter(), new YouTubeAdapter(), new InstagramAdapter(), new LinkedInAdapter()];
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function parseEnvFile(text: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

/**
 * Loads `<repo>/.env` for keys that are not already in the process environment.
 * Both the console and the MCP server call this through the shared factory, so
 * `npm run start` and a directly-spawned MCP server see the same configuration.
 * Explicitly exported environment variables always win.
 */
export function loadDotEnv(file = path.join(repoRoot, ".env")): void {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const [key, value] of Object.entries(parseEnvFile(text))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.RELAY_DATA_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(repoRoot, ".data");
}

export function defaultConsoleUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.RELAY_CONSOLE_URL?.trim() || "http://127.0.0.1:4317").replace(/\/+$/, "");
}

export interface CreateRelayOptions {
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  forceMock?: boolean;
  consoleUrl?: string;
  publicMediaBaseUrl?: string | null;
  logger?: (message: string) => void;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  replyGenerator?: ReplyGenerator;
  autoReplyPollIntervalMs?: number;
  autoReplyWindowMs?: number;
  /** Test hook: override the composed adapters (all five platforms still required). */
  adapters?: PlatformAdapter[];
}

/** Composes the platform adapters and the core service. This is the entry point
 * used by both apps/mcp and apps/web. */
export async function createRelay(options: CreateRelayOptions = {}): Promise<RelayService> {
  const env = options.env ?? process.env;
  const forceMock = options.forceMock ?? env.RELAY_MOCK === "1";
  const adapters = options.adapters ?? createAdapters({ env, forceMock });
  return RelayService.open({
    dataDir: options.dataDir ?? defaultDataDir(env),
    adapters,
    env,
    consoleUrl: options.consoleUrl ?? defaultConsoleUrl(env),
    publicMediaBaseUrl: options.publicMediaBaseUrl,
    forceMock,
    logger: options.logger,
    fetchImpl: options.fetchImpl,
    now: options.now,
    replyGenerator: options.replyGenerator,
    autoReplyPollIntervalMs: options.autoReplyPollIntervalMs,
    autoReplyWindowMs: options.autoReplyWindowMs,
  });
}

