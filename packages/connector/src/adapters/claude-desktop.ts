/** REQ-006, REQ-019, REQ-024: Claude Desktop JSON adapter. */
import { access } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson, backupFile, readJsonObject } from "../backup.js";
import type { AdapterContext, AdapterResult, ClientAdapter, DetectedClient, PlannedAction } from "./types.js";

function configPath(ctx: AdapterContext): string {
  return path.join(ctx.appDataDir, "Claude", "claude_desktop_config.json");
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
    throw new Error("Claude Desktop mcpServers must be a JSON object; refusing to overwrite.");
  }
  return current as Record<string, unknown>;
}

export const claudeDesktopAdapter: ClientAdapter = {
  id: "claude-desktop",
  tier: "auto",

  async detect(ctx: AdapterContext): Promise<DetectedClient> {
    const file = configPath(ctx);
    const detected = await exists(file);
    return detected
      ? { id: "claude-desktop", detected: true, path: file }
      : { id: "claude-desktop", detected: false, reason: "Claude Desktop config not found." };
  },

  async plan(ctx: AdapterContext): Promise<PlannedAction[]> {
    return [{ clientId: "claude-desktop", kind: "write-config", target: configPath(ctx) }];
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
      return {
        clientId: "claude-desktop",
        state: "connected",
        detail: "Relay added to Claude Desktop. Restart Claude Desktop to load it.",
        ...(backup ? { backupPath: backup.backupPath } : {}),
        restartRequired: true,
      };
    } catch (error) {
      if (backup) {
        const { restoreBackup } = await import("../backup.js");
        await restoreBackup(backup);
      }
      throw error;
    }
  },

  async remove(ctx: AdapterContext): Promise<AdapterResult> {
    const file = configPath(ctx);
    if (!(await exists(file))) {
      return { clientId: "claude-desktop", state: "not-installed", detail: "Claude Desktop config not found." };
    }
    const config = await readJsonObject(file);
    const currentServers = servers(config);
    if (!("relay" in currentServers)) {
      return { clientId: "claude-desktop", state: "failed", detail: "Relay is not configured in Claude Desktop." };
    }
    const backup = await backupFile(file, ctx.backupDir);
    delete currentServers.relay;
    config.mcpServers = currentServers;
    await atomicWriteJson(file, config);
    return { clientId: "claude-desktop", state: "connected", detail: "Relay removed from Claude Desktop.", backupPath: backup.backupPath, restartRequired: true };
  },
};
