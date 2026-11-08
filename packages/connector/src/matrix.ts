/** REQ-022, REQ-023: one source of truth for client tier and support. */
import type { ClientId, ClientTier } from "./adapters/types.js";

export interface MatrixEntry {
  id: ClientId;
  displayName: string;
  tier: ClientTier;
  mechanism: string;
  officialUrl: string;
  reason?: string;
}

export const CLIENT_MATRIX: readonly MatrixEntry[] = [
  { id: "claude-desktop", displayName: "Claude Desktop", tier: "auto", mechanism: "Claude Desktop MCP config", officialUrl: "https://www.anthropic.com/engineering/desktop-extensions" },
  { id: "cursor", displayName: "Cursor", tier: "auto", mechanism: "Cursor global mcp.json", officialUrl: "https://cursor.com/docs/mcp" },
  { id: "claude-code", displayName: "Claude Code", tier: "auto", mechanism: "claude mcp add --transport http", officialUrl: "https://code.claude.com/docs/en/mcp" },
  { id: "codex", displayName: "Codex", tier: "guided", mechanism: "Codex config.toml MCP entry", officialUrl: "https://developers.openai.com/codex/mcp" },
  { id: "vscode", displayName: "VS Code", tier: "guided", mechanism: "VS Code mcp.json servers entry", officialUrl: "https://code.visualstudio.com/docs/agents/reference/mcp-configuration" },
  { id: "deepseek-harness", displayName: "DeepSeek Harness", tier: "guided", mechanism: "Harness MCP settings via generated JSON", officialUrl: "", reason: "No stable public local MCP path; use the generated settings/prompt." },
  { id: "grok", displayName: "Grok CLI", tier: "guided", mechanism: "grok mcp add --transport http", officialUrl: "https://docs.x.ai/build/features/mcp-servers" },
  { id: "grok-bot", displayName: "Grok Bot", tier: "manual", mechanism: "No local MCP config verified; use Grok CLI or connectors", officialUrl: "https://docs.x.ai/grok/connectors", reason: "The desktop app does not expose the CLI MCP config." },
  { id: "chatgpt", displayName: "ChatGPT", tier: "manual", mechanism: "Remote custom MCP connector; workspace admin may be required", officialUrl: "https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt" },
  { id: "n8n", displayName: "n8n", tier: "manual", mechanism: "MCP Client Tool node", officialUrl: "https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolmcp" },
  { id: "other", displayName: "Other CLI/Desktop", tier: "manual", mechanism: "Generated prompt/config", officialUrl: "", reason: "No single standard install path." },
] as const;

export function getMatrixEntry(id: ClientId): MatrixEntry | undefined {
  return CLIENT_MATRIX.find((entry) => entry.id === id);
}

export function autoClientIds(): ClientId[] {
  return CLIENT_MATRIX.filter((entry) => entry.tier === "auto").map((entry) => entry.id);
}
