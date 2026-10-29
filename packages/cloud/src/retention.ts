import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { CloudConfig } from "./config.js";
import type { CloudStore } from "./db.js";

export interface MediaCleanupResult {
  customerId: string;
  dataDir: string;
  scanned: number;
  removed: string[];
  failed: Array<{ path: string; error: string }>;
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

/** Dry-run by default; only --apply deletes files. */
export async function cleanupMedia(
  store: CloudStore,
  config: CloudConfig,
  options: { days: number; apply: boolean; includeOwner?: boolean },
): Promise<MediaCleanupResult[]> {
  const cutoff = Date.now() - Math.max(1, options.days) * 24 * 60 * 60 * 1000;
  const results: MediaCleanupResult[] = [];
  for (const customer of store.listCustomers()) {
    if (customer.owner && !options.includeOwner) continue;
    const dataDir = store.getCustomerData(customer.id) ?? (customer.owner ? config.ownerDataDir : path.join(config.tenantDataRoot, customer.id));
    const mediaDir = path.join(dataDir, "media");
    const result: MediaCleanupResult = { customerId: customer.id, dataDir, scanned: 0, removed: [], failed: [] };
    let files: string[] = [];
    try {
      files = await walk(mediaDir);
    } catch {
      results.push(result);
      continue;
    }
    for (const file of files) {
      result.scanned += 1;
      try {
        const info = await stat(file);
        if (info.mtimeMs < cutoff) {
          if (options.apply) await unlink(file);
          result.removed.push(file);
        }
      } catch (error) {
        result.failed.push({ path: file, error: error instanceof Error ? error.message : String(error) });
      }
    }
    results.push(result);
  }
  return results;
}
