import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RelayError } from "@relay/core";

export interface Customer {
  id: string;
  displayName: string;
  status: "active" | "disabled";
  owner: boolean;
  dailyCap: number | null;
  monthlyCap: number | null;
  createdAt: string;
}

export interface ApiKeyRecord {
  id: string;
  customerId: string;
  prefix: string;
  label: string | null;
  status: "active" | "revoked";
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export interface CreatedApiKey extends ApiKeyRecord {
  /** Returned exactly once. Never stored. */
  key: string;
}

export interface ConnectTokenRecord {
  id: string;
  customerId: string;
  prefix: string;
  label: string | null;
  status: "active" | "revoked";
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export interface CreatedConnectToken extends ConnectTokenRecord {
  /** Returned exactly once. Never stored. */
  token: string;
}

export interface ApiKeyIdentity {
  customer: Customer;
  key: ApiKeyRecord;
}

function hashKey(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function toCustomer(row: Record<string, unknown>): Customer {
  return {
    id: String(row.id),
    displayName: String(row.display_name),
    status: String(row.status) === "disabled" ? "disabled" : "active",
    owner: Number(row.owner) === 1,
    dailyCap: row.daily_cap == null ? null : Number(row.daily_cap),
    monthlyCap: row.monthly_cap == null ? null : Number(row.monthly_cap),
    createdAt: String(row.created_at),
  };
}

function toKey(row: Record<string, unknown>): ApiKeyRecord {
  return {
    id: String(row.id),
    customerId: String(row.customer_id),
    prefix: String(row.prefix),
    label: row.label == null ? null : String(row.label),
    status: String(row.status) === "revoked" ? "revoked" : "active",
    createdAt: String(row.created_at),
    revokedAt: row.revoked_at == null ? null : String(row.revoked_at),
    lastUsedAt: row.last_used_at == null ? null : String(row.last_used_at),
  };
}

/**
 * Separate cloud database. It never reads or mutates db.json.
 * Money and tenant data are added here in later phases.
 */
export class CloudStore {
  private constructor(private readonly db: DatabaseSync) {}

  static open(dbPath: string): CloudStore {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    try {
      chmodSync(dbPath, 0o600);
    } catch {
      // Windows ACLs are managed by the host; the DB contains only hashes in Phase 1.
    }
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`
      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        owner INTEGER NOT NULL DEFAULT 0,
        daily_cap INTEGER,
        monthly_cap INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS customers_one_owner
        ON customers(owner) WHERE owner = 1;
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id),
        key_hash TEXT NOT NULL UNIQUE,
        prefix TEXT NOT NULL,
        label TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        last_used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS api_keys_customer ON api_keys(customer_id);
      CREATE TABLE IF NOT EXISTS customer_data (
        customer_id TEXT PRIMARY KEY REFERENCES customers(id),
        data_dir TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS account_owners (
        customer_id TEXT NOT NULL REFERENCES customers(id),
        platform TEXT NOT NULL,
        account_ref TEXT NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY (customer_id, platform, account_ref)
      );
      CREATE TABLE IF NOT EXISTS job_owners (
        job_id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id),
        source TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS post_owners (
        post_id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id),
        source TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS customer_accounts (
        customer_id TEXT NOT NULL REFERENCES customers(id),
        platform TEXT NOT NULL,
        account_ref TEXT,
        status TEXT NOT NULL,
        profile_json TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (customer_id, platform)
      );
      CREATE TABLE IF NOT EXISTS connect_tokens (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id),
        token_hash TEXT NOT NULL UNIQUE,
        prefix TEXT NOT NULL,
        label TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        last_used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS connect_tokens_customer ON connect_tokens(customer_id);
      CREATE TABLE IF NOT EXISTS oauth_states (
        state TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id),
        platform TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    return new CloudStore(db);
  }

  createCustomer(input: { displayName: string; owner?: boolean; dailyCap?: number | null; monthlyCap?: number | null }): Customer {
    const displayName = input.displayName.trim();
    if (!displayName) throw new RelayError("Customer name is required.", "cloud_customer_name_required", undefined, 400);
    const id = `cus_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    try {
      this.db.prepare(
        "INSERT INTO customers (id, display_name, status, owner, daily_cap, monthly_cap, created_at) VALUES (?, ?, 'active', ?, ?, ?, ?)",
      ).run(id, displayName, input.owner ? 1 : 0, input.dailyCap ?? null, input.monthlyCap ?? null, createdAt);
    } catch (error) {
      if (String(error).includes("UNIQUE") && input.owner) {
        throw new RelayError("An owner customer already exists.", "cloud_owner_exists", undefined, 409);
      }
      throw error;
    }
    return this.getCustomer(id)!;
  }

  getCustomer(id: string): Customer | null {
    const row = this.db.prepare("SELECT * FROM customers WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? toCustomer(row) : null;
  }

  listCustomers(): Customer[] {
    return (this.db.prepare("SELECT * FROM customers ORDER BY created_at ASC").all() as Record<string, unknown>[]).map(toCustomer);
  }

  /** Internal bootstrap so the current Relay installation is always the owner. */
  ensureOwnerCustomer(displayName = "Owner"): Customer {
    const existing = this.db.prepare("SELECT * FROM customers WHERE owner = 1 LIMIT 1").get() as
      | Record<string, unknown>
      | undefined;
    if (existing) return toCustomer(existing);
    try {
      return this.createCustomer({ displayName, owner: true });
    } catch (error) {
      if (String(error).includes("cloud_owner_exists")) {
        const owner = this.db.prepare("SELECT * FROM customers WHERE owner = 1 LIMIT 1").get() as
          | Record<string, unknown>
          | undefined;
        if (owner) return toCustomer(owner);
      }
      throw error;
    }
  }

  createApiKey(customerId: string, label?: string): CreatedApiKey {
    const customer = this.getCustomer(customerId);
    if (!customer) throw new RelayError("Customer not found.", "cloud_customer_not_found", undefined, 404);
    if (customer.status !== "active") throw new RelayError("Customer is disabled.", "cloud_customer_disabled", undefined, 409);
    const prefix = randomBytes(5).toString("hex");
    const secret = randomBytes(32).toString("base64url");
    const raw = `rly_${prefix}_${secret}`;
    const id = `key_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    this.db.prepare(
      "INSERT INTO api_keys (id, customer_id, key_hash, prefix, label, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)",
    ).run(id, customerId, hashKey(raw), prefix, label?.trim() || null, createdAt);
    return {
      id,
      customerId,
      prefix,
      label: label?.trim() || null,
      status: "active",
      createdAt,
      revokedAt: null,
      lastUsedAt: null,
      key: raw,
    };
  }

  listApiKeys(customerId?: string): ApiKeyRecord[] {
    const rows = customerId
      ? (this.db.prepare("SELECT * FROM api_keys WHERE customer_id = ? ORDER BY created_at ASC").all(customerId) as Record<string, unknown>[])
      : (this.db.prepare("SELECT * FROM api_keys ORDER BY created_at ASC").all() as Record<string, unknown>[]);
    return rows.map(toKey);
  }

  revokeApiKey(id: string): ApiKeyRecord {
    const current = this.db.prepare("SELECT * FROM api_keys WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!current) throw new RelayError("API key not found.", "cloud_api_key_not_found", undefined, 404);
    if (String(current.status) !== "revoked") {
      this.db.prepare("UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE id = ?").run(new Date().toISOString(), id);
    }
    return toKey(this.db.prepare("SELECT * FROM api_keys WHERE id = ?").get(id) as Record<string, unknown>);
  }

  createConnectToken(customerId: string, label?: string): CreatedConnectToken {
    const customer = this.getCustomer(customerId);
    if (!customer) throw new RelayError("Customer not found.", "cloud_customer_not_found", undefined, 404);
    if (customer.status !== "active") throw new RelayError("Customer is disabled.", "cloud_customer_disabled", undefined, 409);
    const prefix = randomBytes(5).toString("hex");
    const secret = randomBytes(32).toString("base64url");
    const raw = `rlc_${prefix}_${secret}`;
    const id = `ct_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    this.db.prepare(
      "INSERT INTO connect_tokens (id, customer_id, token_hash, prefix, label, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)",
    ).run(id, customerId, hashKey(raw), prefix, label?.trim() || null, createdAt);
    return { id, customerId, prefix, label: label?.trim() || null, status: "active", createdAt, revokedAt: null, lastUsedAt: null, token: raw };
  }

  listConnectTokens(customerId?: string): ConnectTokenRecord[] {
    const rows = customerId
      ? (this.db.prepare("SELECT * FROM connect_tokens WHERE customer_id = ? ORDER BY created_at ASC").all(customerId) as Record<string, unknown>[])
      : (this.db.prepare("SELECT * FROM connect_tokens ORDER BY created_at ASC").all() as Record<string, unknown>[]);
    return rows.map((row) => ({
      id: String(row.id),
      customerId: String(row.customer_id),
      prefix: String(row.prefix),
      label: row.label == null ? null : String(row.label),
      status: String(row.status) === "revoked" ? "revoked" : "active",
      createdAt: String(row.created_at),
      revokedAt: row.revoked_at == null ? null : String(row.revoked_at),
      lastUsedAt: row.last_used_at == null ? null : String(row.last_used_at),
    }));
  }

  resolveConnectToken(rawToken: string): ApiKeyIdentity {
    if (!rawToken || !rawToken.startsWith("rlc_")) {
      throw new RelayError("Invalid connect token.", "cloud_connect_token_invalid", undefined, 401);
    }
    const row = this.db.prepare(
      `SELECT t.*, c.id AS c_id, c.display_name, c.status AS c_status, c.owner, c.daily_cap, c.monthly_cap, c.created_at AS c_created_at
       FROM connect_tokens t JOIN customers c ON c.id = t.customer_id
       WHERE t.token_hash = ?`,
    ).get(hashKey(rawToken)) as Record<string, unknown> | undefined;
    if (!row) throw new RelayError("Invalid connect token.", "cloud_connect_token_invalid", undefined, 401);
    if (String(row.status) !== "active") throw new RelayError("Connect token revoked.", "cloud_connect_token_revoked", undefined, 401);
    if (String(row.c_status) !== "active") throw new RelayError("Customer disabled.", "cloud_customer_disabled", undefined, 403);
    this.db.prepare("UPDATE connect_tokens SET last_used_at = ? WHERE id = ?").run(new Date().toISOString(), String(row.id));
    return {
      customer: {
        id: String(row.c_id), displayName: String(row.display_name), status: "active",
        owner: Number(row.owner) === 1,
        dailyCap: row.daily_cap == null ? null : Number(row.daily_cap),
        monthlyCap: row.monthly_cap == null ? null : Number(row.monthly_cap),
        createdAt: String(row.c_created_at),
      },
      key: {
        id: String(row.id), customerId: String(row.c_id), prefix: String(row.prefix),
        label: row.label == null ? null : String(row.label),
        status: "active", createdAt: String(row.created_at), revokedAt: null, lastUsedAt: null,
      },
    };
  }

  /** Resolve a raw API key to exactly one active customer. */
  resolveApiKey(rawKey: string): ApiKeyIdentity {
    if (!rawKey || !rawKey.startsWith("rly_")) {
      throw new RelayError("Invalid API key.", "cloud_api_key_invalid", undefined, 401);
    }
    const row = this.db.prepare(
      `SELECT k.*, c.id AS c_id, c.display_name, c.status AS c_status, c.owner, c.daily_cap, c.monthly_cap, c.created_at AS c_created_at
       FROM api_keys k JOIN customers c ON c.id = k.customer_id
       WHERE k.key_hash = ?`,
    ).get(hashKey(rawKey)) as Record<string, unknown> | undefined;
    if (!row) throw new RelayError("Invalid API key.", "cloud_api_key_invalid", undefined, 401);
    if (String(row.status) !== "active") throw new RelayError("API key revoked.", "cloud_api_key_revoked", undefined, 401);
    if (String(row.c_status) !== "active") throw new RelayError("Customer disabled.", "cloud_customer_disabled", undefined, 403);
    this.db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(new Date().toISOString(), String(row.id));
    return {
      customer: {
        id: String(row.c_id),
        displayName: String(row.display_name),
        status: "active",
        owner: Number(row.owner) === 1,
        dailyCap: row.daily_cap == null ? null : Number(row.daily_cap),
        monthlyCap: row.monthly_cap == null ? null : Number(row.monthly_cap),
        createdAt: String(row.c_created_at),
      },
      key: toKey(row),
    };
  }

  close(): void {
    this.db.close();
  }

  /** Persist the isolated data directory assigned to a customer. */
  getOrCreateCustomerData(customerId: string, dataDir: string): string {
    const existing = this.db.prepare("SELECT data_dir FROM customer_data WHERE customer_id = ?").get(customerId) as
      | { data_dir: string }
      | undefined;
    if (existing) return existing.data_dir;
    this.db.prepare("INSERT INTO customer_data (customer_id, data_dir, created_at) VALUES (?, ?, ?)").run(
      customerId,
      dataDir,
      new Date().toISOString(),
    );
    return dataDir;
  }

  getCustomerData(customerId: string): string | null {
    const row = this.db.prepare("SELECT data_dir FROM customer_data WHERE customer_id = ?").get(customerId) as
      | { data_dir: string }
      | undefined;
    return row?.data_dir ?? null;
  }

  recordAccountOwner(customerId: string, platform: string, accountRef: string, source = "cloud"): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO account_owners (customer_id, platform, account_ref, source) VALUES (?, ?, ?, ?)",
    ).run(customerId, platform, accountRef, source);
  }

  recordJobOwner(customerId: string, jobId: string, source = "cloud"): void {
    this.db.prepare("INSERT OR REPLACE INTO job_owners (job_id, customer_id, source) VALUES (?, ?, ?)").run(
      jobId,
      customerId,
      source,
    );
  }

  recordPostOwner(customerId: string, postId: string, source = "cloud"): void {
    this.db.prepare("INSERT OR REPLACE INTO post_owners (post_id, customer_id, source) VALUES (?, ?, ?)").run(
      postId,
      customerId,
      source,
    );
  }

  ownerOfJob(jobId: string): string | null {
    const row = this.db.prepare("SELECT customer_id FROM job_owners WHERE job_id = ?").get(jobId) as
      | { customer_id: string }
      | undefined;
    return row?.customer_id ?? null;
  }

  ownerOfPost(postId: string): string | null {
    const row = this.db.prepare("SELECT customer_id FROM post_owners WHERE post_id = ?").get(postId) as
      | { customer_id: string }
      | undefined;
    return row?.customer_id ?? null;
  }

  setCustomerAccount(
    customerId: string,
    platform: string,
    status: "not_connected" | "needs_reconnect" | "ready",
    account: Record<string, unknown> | null,
  ): void {
    this.db.prepare(
      `INSERT INTO customer_accounts (customer_id, platform, account_ref, status, profile_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(customer_id, platform) DO UPDATE SET
         account_ref = excluded.account_ref,
         status = excluded.status,
         profile_json = excluded.profile_json,
         updated_at = excluded.updated_at`,
    ).run(
      customerId,
      platform,
      typeof account?.handle === "string" ? account.handle : null,
      status,
      account ? JSON.stringify(account) : null,
      new Date().toISOString(),
    );
  }

  listCustomerAccounts(customerId: string): Array<{
    platform: string;
    accountRef: string | null;
    status: string;
    profile: Record<string, unknown> | null;
    updatedAt: string;
  }> {
    const rows = this.db.prepare("SELECT * FROM customer_accounts WHERE customer_id = ? ORDER BY platform").all(customerId) as Record<string, unknown>[];
    return rows.map((row) => ({
      platform: String(row.platform),
      accountRef: row.account_ref == null ? null : String(row.account_ref),
      status: String(row.status),
      profile: row.profile_json ? (JSON.parse(String(row.profile_json)) as Record<string, unknown>) : null,
      updatedAt: String(row.updated_at),
    }));
  }

  saveOauthState(state: string, customerId: string, platform: string): void {
    this.db.prepare("INSERT OR REPLACE INTO oauth_states (state, customer_id, platform, created_at) VALUES (?, ?, ?, ?)").run(
      state,
      customerId,
      platform,
      new Date().toISOString(),
    );
  }

  consumeOauthState(state: string): { customerId: string; platform: string } | null {
    const row = this.db.prepare("SELECT * FROM oauth_states WHERE state = ?").get(state) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    this.db.prepare("DELETE FROM oauth_states WHERE state = ?").run(state);
    return { customerId: String(row.customer_id), platform: String(row.platform) };
  }
}

