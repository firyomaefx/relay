import path from "node:path";
import { RelayError } from "@relay/core";

export interface CloudConfig {
  enabled: boolean;
  dbPath: string;
  tokenKey: Buffer | null;
  mcpPort: number;
  tenantDataRoot: string;
  ownerDataDir: string;
  oauthBase: string;
}

function parseTokenKey(raw: string): Buffer {
  const value = raw.trim();
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(value)) key = Buffer.from(value, "hex");
  else key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new RelayError(
      "RELAY_CLOUD_TOKEN_KEY must be exactly 32 bytes encoded as base64 or 64 hex characters.",
      "cloud_token_key_invalid",
      undefined,
      500,
    );
  }
  return key;
}

/** Cloud mode is entirely additive: false/unset returns disabled config. */
export function loadCloudConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig {
  const enabled = /^(1|true|yes)$/i.test(env.RELAY_CLOUD_ENABLED?.trim() ?? "");
  if (!enabled) return { enabled: false, dbPath: "", tokenKey: null, mcpPort: 0, tenantDataRoot: "", ownerDataDir: "", oauthBase: "" };
  const rawKey = env.RELAY_CLOUD_TOKEN_KEY?.trim() ?? "";
  if (!rawKey) {
    throw new RelayError(
      "RELAY_CLOUD_ENABLED is set but RELAY_CLOUD_TOKEN_KEY is missing. Cloud mode refused to start.",
      "cloud_token_key_missing",
      undefined,
      500,
    );
  }
  const base = env.RELAY_DATA_DIR?.trim() || ".data";
  const ownerDataDir = path.resolve(base);
  const tenantDataRoot = path.resolve(env.RELAY_CLOUD_DATA_DIR?.trim() || path.join(base, "cloud", "tenants"));
  const dbPath = path.resolve(env.RELAY_CLOUD_DB?.trim() || path.join(base, "cloud.sqlite"));
  const port = Number(env.RELAY_CLOUD_MCP_PORT ?? "4321");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RelayError("RELAY_CLOUD_MCP_PORT must be a valid TCP port.", "cloud_port_invalid", undefined, 500);
  }
  const oauthBase = (env.RELAY_CLOUD_OAUTH_BASE?.trim() || env.RELAY_CONSOLE_URL?.trim() || "https://relay.duitpoket.fun").replace(/\/+$/, "");
  return { enabled: true, dbPath, tokenKey: parseTokenKey(rawKey), mcpPort: port, tenantDataRoot, ownerDataDir, oauthBase };
}
