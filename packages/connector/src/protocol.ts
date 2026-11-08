/** REQ-021, REQ-027: per-user relay:// registration; no admin writes. */
import { execFileSync } from "node:child_process";

export const PROTOCOL_KEY = "HKCU\\Software\\Classes\\relay";

export interface ProtocolCommands {
  add: Array<{ args: string[] }>;
  remove: Array<{ args: string[] }>;
}

export function protocolCommands(exePath: string): ProtocolCommands {
  if (!exePath.trim()) throw new Error("Executable path is required.");
  const command = `"${exePath}" "%1"`;
  return {
    add: [
      { args: ["add", PROTOCOL_KEY, "/ve", "/d", "URL:Relay Connect", "/f"] },
      { args: ["add", PROTOCOL_KEY, "/v", "URL Protocol", "/d", "", "/f"] },
      { args: ["add", `${PROTOCOL_KEY}\\shell\\open\\command`, "/ve", "/d", command, "/f"] },
    ],
    remove: [{ args: ["delete", PROTOCOL_KEY, "/f"] }],
  };
}

function run(args: string[]): void {
  try {
    execFileSync("reg.exe", args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  } catch (error) {
    const detail = (error as { stderr?: Buffer | string }).stderr;
    const message = detail ? String(detail).trim() : (error instanceof Error ? error.message : "reg.exe failed");
    throw new Error(`reg.exe failed: ${message}`);
  }
}

export function registerProtocol(exePath: string): void {
  if (process.platform !== "win32") throw new Error("relay:// registration is Windows-only.");
  for (const entry of protocolCommands(exePath).add) run(entry.args);
}

export function unregisterProtocol(): void {
  if (process.platform !== "win32") throw new Error("relay:// registration is Windows-only.");
  try {
    for (const entry of protocolCommands("relay-connector.exe").remove) run(entry.args);
  } catch {
    // Already absent is a successful unregister.
  }
}
