/** REQ-019, REQ-024: backup and atomic JSON writes for client configs. */
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface BackupResult {
  originalPath: string;
  backupPath: string;
  createdAt: string;
}

export async function backupFile(originalPath: string, backupDir: string): Promise<BackupResult> {
  await mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `${path.basename(originalPath)}.${stamp}.bak`);
  await copyFile(originalPath, backupPath);
  return { originalPath, backupPath, createdAt: new Date().toISOString() };
}

export async function readJsonObject(file: string): Promise<Record<string, unknown>> {
  const raw = await readFile(file, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Client config is not valid JSON; refusing to overwrite it.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Client config must be a JSON object; refusing to overwrite it.");
  }
  return value as Record<string, unknown>;
}

export async function atomicWriteJson(file: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

export async function restoreBackup(backup: BackupResult): Promise<void> {
  await copyFile(backup.backupPath, backup.originalPath);
}
