/**
 * @relay/web entry point.
 *
 * `startServer()` is the programmatic API (used by tests and embedders).
 * Executing this file directly (`node dist/index.js`, or `npm run start -w
 * @relay/web`) boots the console and installs graceful shutdown.
 */
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMain, startServer } from "./server.js";

export { runMain, startServer };
export type { RunningServer, StartServerOptions } from "./server.js";

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(path.resolve(entry)) === realpathSync(self);
  } catch {
    return path.resolve(entry).toLowerCase() === self.toLowerCase();
  }
}

if (isDirectRun()) {
  void runMain();
}
