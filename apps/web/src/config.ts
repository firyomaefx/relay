/**
 * Console configuration. Everything is optional: the console boots in simulated
 * mode with a local data directory when no environment variables are set.
 */
import { defaultDataDir } from "@relay/platforms";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4317;

export interface ConsoleConfig {
  host: string;
  port: number;
  dataDir: string;
  /** `null` means "derive it from the address the server actually listens on". */
  consoleUrl: string | null;
  forceMock: boolean;
  password: string | null;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT;
  const value = raw.trim();
  if (value === "") return DEFAULT_PORT;
  if (!/^\d+$/.test(value)) {
    throw new Error(`RELAY_PORT must be a whole number between 0 and 65535 (received "${raw}")`);
  }
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`RELAY_PORT must be a whole number between 0 and 65535 (received "${raw}")`);
  }
  return port;
}

function truthy(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/** Reads the console's environment. Pure: no process state is touched here. */
export function readConfig(env: NodeJS.ProcessEnv = process.env): ConsoleConfig {
  const host = env.RELAY_HOST?.trim() || DEFAULT_HOST;
  const configuredUrl = env.RELAY_CONSOLE_URL?.trim();
  const password = env.RELAY_CONSOLE_PASSWORD?.trim();
  return {
    host,
    port: parsePort(env.RELAY_PORT),
    dataDir: defaultDataDir(env),
    consoleUrl: configuredUrl ? configuredUrl.replace(/\/+$/, "") : null,
    forceMock: truthy(env.RELAY_MOCK),
    password: password ? password : null,
  };
}
