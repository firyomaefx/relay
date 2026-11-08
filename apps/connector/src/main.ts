/** REQ-003, REQ-021, REQ-027: Relay Connector entry point. */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  autoAdapters,
  fetchConnectSession,
  getAutoAdapter,
  parseDeepLink,
  parseHandoffArgs,
  parseManageLink,
  registerProtocol,
  startConsentServer,
  startManageServer,
  unregisterProtocol,
  type AdapterContext,
} from "@relay/connector";

const API_BASE = process.env.RELAY_CONNECT_API_BASE?.trim() || "https://relay.duitpoket.fun";

function connectorContext(): AdapterContext {
  const localAppData = process.env.LOCALAPPDATA?.trim() || os.tmpdir();
  return {
    appDataDir: process.env.APPDATA?.trim() || path.join(os.homedir(), "AppData", "Roaming"),
    localAppDataDir: localAppData,
    homeDir: os.homedir(),
    backupDir: path.join(localAppData, "Relay", "backups"),
    mcpUrl: process.env.RELAY_CONNECT_MCP_URL?.trim() || "https://cloud-mcp.duitpoket.fun/mcp",
    sessionToken: "",
    now: () => new Date(),
  };
}

function openBrowser(url: string): void {
  const command = process.platform === "win32"
    ? { file: "cmd", args: ["/c", "start", "", url] }
    : process.platform === "darwin"
      ? { file: "open", args: [url] }
      : { file: "xdg-open", args: [url] };
  execFile(command.file, command.args, { windowsHide: true }, () => {
    // The printed URL is the fallback when no browser opens.
  });
}

function acquireSingleInstance(): string {
  const root = process.env.LOCALAPPDATA?.trim() || os.tmpdir();
  const dir = path.join(root, "Relay");
  mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, "connector.lock");
  try {
    const pid = Number(readFileSync(lock, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        throw new Error("Relay Connector is already running. Use the open window or close it first.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error)) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  writeFileSync(lock, String(process.pid), "utf8");
  return lock;
}

function releaseLock(lock: string): void {
  try {
    if (readFileSync(lock, "utf8").trim() === String(process.pid)) unlinkSync(lock);
  } catch {
    // Best effort.
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Relay Connector\n\n  relay://connect?session=...#token=...\n  relay://manage?action=disconnect&client=claude-desktop\n  --session <id> --token <token>\n  --register-protocol\n  --unregister-protocol\n  --no-open");
    return;
  }
  if (args.includes("--register-protocol")) {
    registerProtocol(process.env.RELAY_CONNECTOR_EXE?.trim() || process.execPath);
    console.log("relay:// protocol registered for the current user.");
    return;
  }
  if (args.includes("--unregister-protocol")) {
    unregisterProtocol();
    console.log("relay:// protocol registration removed.");
    return;
  }

  const manageLink = args.find((arg) => arg.startsWith("relay://manage"));
  if (manageLink) {
    const manage = parseManageLink(manageLink);
    const adapter = getAutoAdapter(manage.clientId);
    if (!adapter) throw new Error(`${manage.clientId} has no automatic manager.`);
    const lock = acquireSingleInstance();
    const server = await startManageServer({
      action: manage.action,
      adapter,
      ctx: { ...connectorContext(), sessionToken: "" },
    });
    const cleanup = () => {
      releaseLock(lock);
      void server.close();
    };
    process.once("SIGINT", () => { cleanup(); process.exit(0); });
    process.once("SIGTERM", () => { cleanup(); process.exit(0); });
    console.log(`Relay Connector: ${server.url}`);
    openBrowser(server.url);
    await new Promise<void>(() => {});
    return;
  }

  const link = args.find((arg) => arg.startsWith("relay://"));
  const handoff = link ? parseDeepLink(link) : parseHandoffArgs(args);
  if (!handoff) {
    throw new Error("No connect handoff found. Open the relay:// link from Relay, or pass --session and --token.");
  }

  const session = await fetchConnectSession({ apiBase: API_BASE, ...handoff });
  const lock = acquireSingleInstance();
  const ctx = connectorContext();
  const server = await startConsentServer(session, {
    ctx: { ...ctx, sessionToken: handoff.token },
    adapters: autoAdapters(),
    apiBase: API_BASE,
    sessionToken: handoff.token,
  });
  const cleanup = () => {
    releaseLock(lock);
    void server.close();
  };
  process.once("SIGINT", () => { cleanup(); process.exit(0); });
  process.once("SIGTERM", () => { cleanup(); process.exit(0); });

  console.log(`Relay Connector: ${server.url}`);
  console.log(`Session ${session.sessionId} expires ${session.expiresAt}.`);
  if (!args.includes("--no-open")) openBrowser(server.url);
  await new Promise<void>(() => {
    // Keep the local consent server alive until the user closes the process.
  });
}

main().catch((error: unknown) => {
  console.error(`Relay Connector: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
