import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { RelayError } from "./errors.js";
import { emptyCommentsState, type CommentsState } from "./comments.js";
import type { EncryptedBlob } from "./secret-box.js";
import type { Account, PlatformId, PostRecord, QueueJob, ThreadsAutoReplyState } from "./types.js";

export interface StoredAccount {
  account: Account;
  secret: EncryptedBlob | null;
}

export interface PendingAuth {
  platform: PlatformId;
  accountId?: string;
  label?: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: string;
}

export interface DbData {
  version: number;
  /** One primary account per platform, kept for backward compatibility. */
  accounts: Partial<Record<PlatformId, StoredAccount>>;
  /** Additional accounts keyed by account id. */
  extraAccounts: Record<string, StoredAccount>;
  posts: PostRecord[];
  queue: QueueJob[];
  oauth: Record<string, PendingAuth>;
  threadsAutoReply: ThreadsAutoReplyState;
  /** Seen / replied comment ids for relay_comments_new and relay_reply. */
  comments: CommentsState;
  /** Encrypted DeepSeek API key saved from the console. */
  deepseekSecret?: EncryptedBlob | null;
}

export function emptyThreadsAutoReplyState(): ThreadsAutoReplyState {
  return {
    enabled: true,
    replies: [],
    flagged: [],
    windows: [],
    seenPostIds: [],
  };
}

function emptyDb(): DbData {
  return { version: 3, accounts: {}, extraAccounts: {}, posts: [], queue: [], oauth: {}, threadsAutoReply: emptyThreadsAutoReplyState(), comments: emptyCommentsState(), deepseekSecret: null };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Small JSON document store with atomic writes. A lock file guards against two
 * Relay processes (console and MCP server) writing at the same time, and every
 * mutation re-reads the file so both processes see each other's changes.
 */
export class JsonStore {
  private data: DbData;
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(private readonly file: string, data: DbData) {
    this.data = data;
  }

  static async open(file: string): Promise<JsonStore> {
    await mkdir(path.dirname(file), { recursive: true });
    let data: DbData;
    try {
      const raw = await readFile(file, "utf8");
      data = normalize(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      data = emptyDb();
      await writeFile(file, JSON.stringify(data, null, 2), "utf8");
    }
    return new JsonStore(file, data);
  }

  read<T>(fn: (db: DbData) => T): T {
    return fn(this.data);
  }

  /** Re-reads the document from disk. Call before read paths that must observe
   * writes made by another Relay process (console and MCP share one data dir). */
  async refresh(): Promise<void> {
    const run = this.chain.then(async () => {
      this.data = await this.reload();
    });
    this.chain = run.catch(() => undefined);
    await run;
  }

  /** Applies a synchronous mutation and persists the whole document. */
  async mutate<T>(fn: (db: DbData) => T): Promise<T> {
    const run = this.chain.then(async () => {
      return this.withLock(async () => {
        this.data = await this.reload();
        const result = fn(this.data);
        await this.persist();
        return result;
      });
    });
    this.chain = run.catch(() => undefined);
    return run as Promise<T>;
  }

  private async reload(): Promise<DbData> {
    try {
      return normalize(await readFile(this.file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.data;
      throw error;
    }
  }

  private async persist(): Promise<void> {
    const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2), "utf8");
    await rename(tmp, this.file);
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockPath = `${this.file}.lock`;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        handle = await open(lockPath, "wx");
        break;
      } catch (error) {
        // On Windows a competing unlink can make an existing lock report EPERM
        // or EACCES instead of EEXIST; all three mean "try again shortly".
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") throw error;
        try {
          const info = await stat(lockPath);
          if (Date.now() - info.mtimeMs > 5000) {
            await unlink(lockPath).catch(() => undefined);
            continue;
          }
        } catch {
          // Lock vanished between attempts; retry immediately.
        }
        await sleep(20);
      }
    }
    if (!handle) {
      throw new RelayError(`Could not acquire store lock at ${lockPath}`, "store_locked", undefined, 503);
    }
    try {
      return await fn();
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }
}

function normalize(raw: string): DbData {
  const parsed = JSON.parse(raw) as Partial<DbData>;
  const storedAutoReply = parsed.threadsAutoReply;
  const storedComments = parsed.comments;
  return {
    version: typeof parsed.version === "number" ? parsed.version : 3,
    accounts: parsed.accounts ?? {},
    extraAccounts: parsed.extraAccounts ?? {},
    posts: Array.isArray(parsed.posts) ? parsed.posts : [],
    queue: Array.isArray(parsed.queue) ? parsed.queue : [],
    oauth: parsed.oauth ?? {},
    threadsAutoReply: {
      enabled: storedAutoReply?.enabled !== false,
      replies: Array.isArray(storedAutoReply?.replies) ? storedAutoReply.replies : [],
      flagged: Array.isArray(storedAutoReply?.flagged) ? storedAutoReply.flagged : [],
      windows: Array.isArray(storedAutoReply?.windows) ? storedAutoReply.windows : [],
      seenPostIds: Array.isArray(storedAutoReply?.seenPostIds) ? storedAutoReply.seenPostIds : [],
      ...(storedAutoReply?.lastDiscoveryAt ? { lastDiscoveryAt: storedAutoReply.lastDiscoveryAt } : {}),
    },
    comments: {
      seen: Array.isArray(storedComments?.seen) ? storedComments.seen : [],
      replied: Array.isArray(storedComments?.replied) ? storedComments.replied : [],
      templateCursor: typeof storedComments?.templateCursor === "number" ? storedComments.templateCursor : 0,
    },
    deepseekSecret: parsed.deepseekSecret && typeof parsed.deepseekSecret === "object" ? parsed.deepseekSecret : null,
  };
}

