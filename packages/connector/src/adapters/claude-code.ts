/** REQ-008: Claude Code adapter using its supported CLI, not its config file. */
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AdapterContext, AdapterResult, ClientAdapter, DetectedClient, PlannedAction } from "./types.js";

const execFileAsync = promisify(execFile);

function configPath(ctx: AdapterContext): string {
  return path.join(ctx.homeDir, ".claude.json");
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function run(ctx: AdapterContext, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  if (ctx.runCommand) return ctx.runCommand("claude", args);
  try {
    const result = await execFileAsync("claude", args, { windowsHide: true, timeout: 20_000 });
    return { code: 0, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: String(failure.stdout ?? ""),
      stderr: String(failure.stderr ?? failure.message ?? ""),
    };
  }
}

export const claudeCodeAdapter: ClientAdapter = {
  id: "claude-code",
  tier: "auto",

  async detect(ctx: AdapterContext): Promise<DetectedClient> {
    const file = configPath(ctx);
    if (await exists(file)) return { id: "claude-code", detected: true, path: file };
    const cli = await run(ctx, ["--version"]);
    return cli.code === 0
      ? { id: "claude-code", detected: true, reason: "Claude Code CLI is installed." }
      : { id: "claude-code", detected: false, reason: "Claude Code config and CLI not found." };
  },

  async plan(): Promise<PlannedAction[]> {
    return [{ clientId: "claude-code", kind: "run-cli", target: "claude mcp add" }];
  },

  async install(_action: PlannedAction, ctx: AdapterContext): Promise<AdapterResult> {
    const result = await run(ctx, ["mcp", "add", "--transport", "http", "--scope", "user", "relay", ctx.mcpUrl]);
    if (result.code !== 0) {
      return { clientId: "claude-code", state: "failed", detail: result.stderr.trim() || `claude mcp add failed (${result.code}).` };
    }
    return { clientId: "claude-code", state: "connected", detail: "Relay added to Claude Code." };
  },

  async remove(ctx: AdapterContext): Promise<AdapterResult> {
    const result = await run(ctx, ["mcp", "remove", "relay", "--scope", "user"]);
    if (result.code !== 0) {
      return { clientId: "claude-code", state: "failed", detail: result.stderr.trim() || `claude mcp remove failed (${result.code}).` };
    }
    return { clientId: "claude-code", state: "connected", detail: "Relay removed from Claude Code." };
  },
};
