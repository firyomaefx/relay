/** REQ-009–015: one copyable artifact per Guided/Manual client. */
import type { ClientId } from "./adapters/types.js";
import { getMatrixEntry } from "./matrix.js";

export interface GenerateInput {
  clientId: ClientId;
  mcpUrl: string;
}

export interface GeneratedArtifact {
  clientId: ClientId;
  kind: "config" | "prompt" | "steps";
  title: string;
  body: string;
}

export function generateArtifact(input: GenerateInput): GeneratedArtifact {
  const entry = getMatrixEntry(input.clientId);
  if (!entry) throw new Error(`Unknown client: ${input.clientId}`);
  if (entry.tier === "auto") throw new Error(`${entry.displayName} is Auto; no manual artifact is needed.`);
  if (entry.tier === "unsupported") throw new Error(`${entry.displayName} is unsupported: ${entry.reason ?? "no path"}.`);

  switch (input.clientId) {
    case "claude-web":
      return {
        clientId: input.clientId,
        kind: "steps",
        title: "Claude (web and phone app) - add a custom connector once",
        body: `1. On claude.ai (a phone browser works), open Customize, then Connectors, then Add custom connector.\n2. Name it Relay Cloud, paste this URL and leave the OAuth fields empty:\n\n${input.mcpUrl}\n\n3. Tap Connect, paste your Relay Cloud API key once, and approve.\n4. In the Claude iPhone or Android app, tap +, then Connectors, and turn Relay Cloud on.\n\nFaster: open https://relay.duitpoket.fun/connect and tap Add to Claude. The phone apps can use the connector but cannot add it. Free Claude plans allow one custom connector.`,
      };
    case "codex":
      return {
        clientId: input.clientId,
        kind: "config",
        title: "Codex — add Relay to config.toml",
        body: `Open %USERPROFILE%\\.codex\\config.toml and add:\n\n[mcp_servers.relay]\nurl = "${input.mcpUrl}"\n\nSave, open Codex, then ask it to list Relay tools.`,
      };
    case "vscode":
      return {
        clientId: input.clientId,
        kind: "config",
        title: "VS Code — add Relay to mcp.json",
        body: `Open the Command Palette → "MCP: Open User Configuration" (or .vscode/mcp.json) and add:\n\n{\n  "servers": {\n    "relay": { "type": "http", "url": "${input.mcpUrl}" }\n  }\n}\n\nSave, start the server, and verify Relay tools appear.`,
      };
    case "deepseek-harness":
      return {
        clientId: input.clientId,
        kind: "config",
        title: "DeepSeek Harness — add Relay MCP server",
        body: `Open DeepSeek Harness MCP settings and add a remote HTTP server named "relay" with URL:\n\n${input.mcpUrl}\n\nSave, restart the session if needed, then verify Relay tools are listed.`,
      };
    case "grok":
      return {
        clientId: input.clientId,
        kind: "prompt",
        title: "Grok CLI — one command",
        body: `Run:\n\ngrok mcp add --transport http relay ${input.mcpUrl}\n\nThen restart Grok CLI and ask it to list Relay tools.`,
      };
    case "grok-bot":
      return {
        clientId: input.clientId,
        kind: "steps",
        title: "Grok Bot — use the Grok CLI path",
        body: `Grok Bot desktop does not expose a local MCP config. Use the Grok CLI instead:\n\ngrok mcp add --transport http relay ${input.mcpUrl}\n\nIf you must stay in Grok Bot, use its connector settings and add the Relay remote MCP URL:\n${input.mcpUrl}`,
      };
    case "chatgpt":
      return {
        clientId: input.clientId,
        kind: "steps",
        title: "ChatGPT — add a custom MCP connector",
        body: `In ChatGPT, open Settings → Connectors (developer mode may be required by your workspace). Add a custom MCP server with URL:\n\n${input.mcpUrl}\n\nIf your plan or workspace cannot add custom MCP servers, Relay cannot be connected in ChatGPT; use Claude Desktop, Cursor, or Claude Code instead.`,
      };
    case "n8n":
      return {
        clientId: input.clientId,
        kind: "steps",
        title: "n8n — MCP Client Tool",
        body: `Add an "MCP Client Tool" node to your workflow. Set the server URL to:\n\n${input.mcpUrl}\n\nChoose the tools you need, save, and run a test. No local install is required.`,
      };
    default:
      return {
        clientId: input.clientId,
        kind: "prompt",
        title: "Other CLI/Desktop — add a remote MCP server",
        body: `Add a remote MCP server named "relay" with URL:\n\n${input.mcpUrl}\n\nIf your client supports JSON config, add it under its MCP servers object. Authenticate in the client if prompted; do not paste an owner token into the prompt or config.`,
      };
  }
}
