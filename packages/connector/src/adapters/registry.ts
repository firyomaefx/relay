/** REQ-005, REQ-017, REQ-018: Auto adapter registry. */
import type { ClientAdapter, ClientId } from "./types.js";
import { claudeDesktopAdapter } from "./claude-desktop.js";
import { cursorAdapter } from "./cursor.js";
import { claudeCodeAdapter } from "./claude-code.js";

const ADAPTERS: Partial<Record<ClientId, ClientAdapter>> = {
  "claude-desktop": claudeDesktopAdapter,
  cursor: cursorAdapter,
  "claude-code": claudeCodeAdapter,
};

export function getAutoAdapter(clientId: ClientId): ClientAdapter | undefined {
  return ADAPTERS[clientId];
}

export function autoAdapters(): ClientAdapter[] {
  return Object.values(ADAPTERS).filter((adapter): adapter is ClientAdapter => Boolean(adapter));
}
