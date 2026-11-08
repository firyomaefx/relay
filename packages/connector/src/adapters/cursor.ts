/** REQ-007, REQ-019, REQ-024: Cursor global MCP config adapter. */
import { access } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson, backupFile, readJsonObject, restoreBackup } from "../backup.js";
import type { AdapterContext, AdapterResult, ClientAdapter, DetectedClient, PlannedAction } from "./types.js";

function configPath(ctx: AdapterContext): string {
  return path.join(ctx.homeDir, ".cursor", "mcp.json");
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function servers(config: Record<string, unknown>): Record<string, unknown> {
  const current = config.mcpServers;
  if (current === undefined) return {};
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    throw new Error("Cursor mcpServers must be a JSON object; refusing to overwrite.");
  }
  return current as Record<string, unknown>;
}

export const cursorAdapter: ClientAdapter = {
  id: "cursor",
  tier: "auto",

  async detect(ctx: AdapterContext): Promise<DetectedClient> {
    const file = configPath(ctx);
    return (await exists(file))
      ? { id: "cursor", detected: true, path: file }
      : { id: "cursor", detected: false, reason: "Cursor MCP config not found." };
  },

  async plan(ctx: AdapterContext): Promise<PlannedAction[]> {
    return [{ clientId: "cursor", kind: "write-config", target: configPath(ctx) }];
  },

  async install(_action: PlannedAction, ctx: AdapterContext): Promise<AdapterResult> {
    const file = configPath(ctx);
    const config = (await exists(file)) ? await readJsonObject(file) : {};
    const currentServers = servers(config);
    const backup = (await exists(file)) ? await backupFile(file, ctx.backupDir) : undefined;
    try {
      currentServers.relay = { url: ctx.mcpUrl };
      config.mcpServers = currentServers;
      await atomicWriteJson(file, config);
      return { clientId: "cursor", state: "connected", detail: "Relay added to Cursor. Reload Cursor to load it.", ...(backup ? { backupPath: backup.backupPath } : {}), restartRequired: true };
    } catch (error) {
      if (backup) await restoreBackup(backup);
      throw error;
    }
  },

  async remove(ctx: AdapterContext): Promise<AdapterResult> {
    const file = configPath(ctx);
    if (!(await exists(file))) return { clientId: "cursor", state: "not-installed", detail: "Cursor MCP config not found." };
    const config = await readJsonObject(file);
    const currentServers = servers(config);
    if (!("relay" in currentServers)) return { clientId: "cursor", state: "failed", detail: "Relay is not configured in Cursor." };
    const backup = await backupFile(file, ctx.backupDir);
    delete currentServers.relay;
    config.mcpServers = currentServers;
    await atomicWriteJson(file, config);
    return { clientId: "cursor", state: "connected", detail: "Relay removed from Cursor.", backupPath: backup.backupPath, restartRequired: true };
  },
};
