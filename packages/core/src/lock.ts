import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const LOCK_NAME = "scheduler.lock";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Only one Relay process may run the scheduler, otherwise a scheduled post would
 * be published twice. The console and the MCP server both try to take this lock.
 */
export async function acquireSchedulerLock(dataDir: string): Promise<boolean> {
  const file = path.join(dataDir, LOCK_NAME);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await writeFile(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), {
        encoding: "utf8",
        flag: "wx",
      });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: { pid?: number } | null = null;
      try {
        owner = JSON.parse(await readFile(file, "utf8")) as { pid?: number };
      } catch {
        owner = null;
      }
      if (owner?.pid && owner.pid !== process.pid && isProcessAlive(owner.pid)) return false;
      await unlink(file).catch(() => undefined);
    }
  }
  return false;
}

export async function releaseSchedulerLock(dataDir: string): Promise<void> {
  const file = path.join(dataDir, LOCK_NAME);
  try {
    const owner = JSON.parse(await readFile(file, "utf8")) as { pid?: number };
    if (!owner.pid || owner.pid === process.pid) await unlink(file);
  } catch {
    // Already released or unreadable; nothing to do.
  }
}

export async function schedulerLockOwner(dataDir: string): Promise<number | null> {
  try {
    const owner = JSON.parse(await readFile(path.join(dataDir, LOCK_NAME), "utf8")) as { pid?: number };
    return owner.pid ?? null;
  } catch {
    return null;
  }
}
