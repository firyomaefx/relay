/** REQ-006, REQ-007, REQ-008: adapter contract shared by all clients. */
export type ClientId = "claude-web" | "claude-desktop" | "cursor" | "claude-code" | "codex" | "vscode" | "deepseek-harness" | "grok" | "grok-bot" | "chatgpt" | "n8n" | "other";
export type ClientTier = "auto" | "guided" | "manual" | "unsupported";
export type TerminalState = "connected" | "guided" | "copied" | "not-installed" | "failed" | "unsupported";

export interface AdapterContext {
  appDataDir: string;
  localAppDataDir: string;
  homeDir: string;
  backupDir: string;
  mcpUrl: string;
  sessionToken: string;
  now: () => Date;
  runCommand?: (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface DetectedClient {
  id: ClientId;
  detected: boolean;
  path?: string;
  version?: string;
  reason?: string;
}

export interface PlannedAction {
  clientId: ClientId;
  kind: "write-config" | "run-cli" | "manual";
  target: string;
}

export interface AdapterResult {
  clientId: ClientId;
  state: TerminalState;
  detail: string;
  backupPath?: string;
  restartRequired?: boolean;
}

export interface ClientAdapter {
  readonly id: ClientId;
  readonly tier: ClientTier;
  detect(ctx: AdapterContext): Promise<DetectedClient>;
  plan(ctx: AdapterContext): Promise<PlannedAction[]>;
  install(action: PlannedAction, ctx: AdapterContext): Promise<AdapterResult>;
  remove(ctx: AdapterContext): Promise<AdapterResult>;
}
