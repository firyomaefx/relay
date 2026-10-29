import { DatabaseSync } from "node:sqlite";
import { RelayError } from "@relay/core";

/**
 * Fixed-window per-customer rate limiter in cloud.sqlite. Windows are stored
 * with their start time, so restarts do not reset an active limit.
 */
export class RateLimiter {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rate_limits (
        customer_id TEXT NOT NULL,
        bucket TEXT NOT NULL,
        window_start INTEGER NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (customer_id, bucket, window_start)
      );
    `);
  }

  /** Increment and allow, or throw a 429 RelayError. */
  check(customerId: string, bucket: string, limit: number, windowMs: number): { remaining: number; resetAt: string } {
    if (!Number.isInteger(limit) || limit < 1) throw new RelayError("Rate limit is not configured.", "cloud_rate_limit_invalid", undefined, 500);
    const now = Date.now();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const resetAt = new Date(windowStart + windowMs).toISOString();
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const row = this.db.prepare(
        "SELECT count FROM rate_limits WHERE customer_id = ? AND bucket = ? AND window_start = ?",
      ).get(customerId, bucket, windowStart) as { count: number } | undefined;
      const count = Number(row?.count ?? 0);
      if (count >= limit) {
        this.db.exec("COMMIT");
        const retryAfter = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));
        throw new RelayError(`Rate limit exceeded for ${bucket}. Retry in ${retryAfter}s.`, "cloud_rate_limited", {
          bucket,
          limit,
          retryAfter,
          resetAt,
        }, 429);
      }
      this.db.prepare(
        `INSERT INTO rate_limits (customer_id, bucket, window_start, count) VALUES (?, ?, ?, 1)
         ON CONFLICT(customer_id, bucket, window_start) DO UPDATE SET count = count + 1`,
      ).run(customerId, bucket, windowStart);
      this.db.exec("COMMIT");
      return { remaining: Math.max(0, limit - count - 1), resetAt };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // No active transaction after the explicit commit.
      }
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}

export interface CloudRateConfig {
  mcpPerMinute: number;
  postsPerHour: number;
}

export function loadRateConfig(env: NodeJS.ProcessEnv = process.env): CloudRateConfig {
  const mcp = Number(env.RELAY_CLOUD_RATE_MCP_PER_MINUTE ?? "120");
  const posts = Number(env.RELAY_CLOUD_RATE_POSTS_PER_HOUR ?? "60");
  if (!Number.isInteger(mcp) || mcp < 1 || !Number.isInteger(posts) || posts < 1) {
    throw new RelayError("Cloud rate limits must be positive whole numbers.", "cloud_rate_limit_invalid", undefined, 500);
  }
  return { mcpPerMinute: mcp, postsPerHour: posts };
}
