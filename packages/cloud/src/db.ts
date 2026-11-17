import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RelayError } from "@relay/core";

export interface Customer {
  id: string;
  displayName: string;
  email: string;
  phone: string;
  status: "active" | "disabled";
  owner: boolean;
  dailyCap: number | null;
  monthlyCap: number | null;
  createdAt: string;
}

export interface CustomerAuthRecord {
  customer: Customer;
  passwordHash: string;
  sessionVersion: number;
}

export type CustomerInvitePurpose = "setup" | "reset";

export interface CustomerInvite {
  id: string;
  customerId: string;
  purpose: CustomerInvitePurpose;
  expiresAt: string;
  usedAt: string | null;
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

/** Short-lived, tenant-bound session used by one Relay Connector flow. */
export interface ConnectSessionRecord {
  id: string;
  customerId: string;
  requestedClients: string[];
  status: "pending" | "consumed" | "expired";
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

export interface CreatedConnectSession extends ConnectSessionRecord {
  /** Returned exactly once. Only the SHA-256 hash is stored. */
  token: string;
}

export interface ConnectVerificationRecord {
  sessionId: string;
  clientId: string;
  status: "connected" | "failed";
  detail: string;
  checkedAt: string;
}

export interface WaitlistEntry {
  id: string;
  name: string;
  email: string;
  phone: string;
  platforms: string;
  volume: string;
  useCase: string;
  status: "pending" | "invited" | "active" | "rejected";
  customerId: string | null;
  note: string | null;
  createdAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
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
    email: row.email == null ? "" : String(row.email),
    phone: row.phone == null ? "" : String(row.phone),
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

function toConnectSession(row: Record<string, unknown>): ConnectSessionRecord {
  let requestedClients: string[] = [];
  try {
    const parsed = JSON.parse(String(row.requested_clients ?? "[]")) as unknown;
    if (Array.isArray(parsed)) {
      requestedClients = parsed.filter((value): value is string => typeof value === "string");
    }
  } catch {
    requestedClients = [];
  }
  const status = String(row.status);
  return {
    id: String(row.id),
    customerId: String(row.customer_id),
    requestedClients,
    status: status === "consumed" ? "consumed" : status === "expired" ? "expired" : "pending",
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    usedAt: row.used_at == null ? null : String(row.used_at),
  };
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizePhone(value: string): string {
  let raw = value.trim().replace(/[\s().-]/g, "");
  if (raw.startsWith("00")) raw = `+${raw.slice(2)}`;
  if (!raw.startsWith("+")) return "";
  const digits = raw.slice(1).replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return "";
  return `+${digits}`;
}

function toWaitlist(row: Record<string, unknown>): WaitlistEntry {
  const status = String(row.status) as WaitlistEntry["status"];
  return {
    id: String(row.id),
    name: String(row.name),
    email: String(row.email),
    phone: String(row.phone ?? ""),
    platforms: String(row.platforms ?? ""),
    volume: String(row.volume ?? ""),
    useCase: String(row.use_case ?? ""),
    status: status === "invited" || status === "active" || status === "rejected" ? status : "pending",
    customerId: row.customer_id == null ? null : String(row.customer_id),
    note: row.note == null ? null : String(row.note),
    createdAt: String(row.created_at),
    approvedAt: row.approved_at == null ? null : String(row.approved_at),
    rejectedAt: row.rejected_at == null ? null : String(row.rejected_at),
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
      CREATE TABLE IF NOT EXISTS connect_verifications (
        session_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        PRIMARY KEY (session_id, client_id)
      );
      CREATE TABLE IF NOT EXISTS connect_sessions (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id),
        token_hash TEXT NOT NULL UNIQUE,
        requested_clients TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS connect_sessions_customer ON connect_sessions(customer_id);
      CREATE TABLE IF NOT EXISTS oauth_states (
        state TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id),
        platform TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS waitlist (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        email_normalized TEXT NOT NULL UNIQUE,
        phone TEXT NOT NULL DEFAULT '',
        platforms TEXT NOT NULL DEFAULT '',
        volume TEXT NOT NULL DEFAULT '',
        use_case TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        customer_id TEXT REFERENCES customers(id),
        note TEXT,
        created_at TEXT NOT NULL,
        approved_at TEXT,
        rejected_at TEXT
      );
      CREATE INDEX IF NOT EXISTS waitlist_status_created ON waitlist(status, created_at);
      CREATE TABLE IF NOT EXISTS customer_invites (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id),
        token_hash TEXT NOT NULL UNIQUE,
        purpose TEXT NOT NULL DEFAULT 'setup',
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS customer_invites_customer ON customer_invites(customer_id);
    `);
    const waitlistColumns = db.prepare("PRAGMA table_info(waitlist)").all() as Array<{ name: string }>;
    if (!waitlistColumns.some((column) => column.name === "phone")) {
      db.exec("ALTER TABLE waitlist ADD COLUMN phone TEXT NOT NULL DEFAULT ''");
    }
    const customerColumns = db.prepare("PRAGMA table_info(customers)").all() as Array<{ name: string }>;
    if (!customerColumns.some((column) => column.name === "email")) {
      db.exec("ALTER TABLE customers ADD COLUMN email TEXT NOT NULL DEFAULT ''");
    }
    if (!customerColumns.some((column) => column.name === "phone")) {
      db.exec("ALTER TABLE customers ADD COLUMN phone TEXT NOT NULL DEFAULT ''");
    }
    if (!customerColumns.some((column) => column.name === "password_hash")) {
      db.exec("ALTER TABLE customers ADD COLUMN password_hash TEXT NOT NULL DEFAULT ''");
    }
    if (!customerColumns.some((column) => column.name === "session_version")) {
      db.exec("ALTER TABLE customers ADD COLUMN session_version INTEGER NOT NULL DEFAULT 1");
    }
    const inviteColumns = db.prepare("PRAGMA table_info(customer_invites)").all() as Array<{ name: string }>;
    if (!inviteColumns.some((column) => column.name === "purpose")) {
      db.exec("ALTER TABLE customer_invites ADD COLUMN purpose TEXT NOT NULL DEFAULT 'setup'");
    }
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS customers_email_unique ON customers(email COLLATE NOCASE) WHERE email <> ''");
    return new CloudStore(db);
  }

  createCustomer(input: { displayName: string; email?: string; owner?: boolean; dailyCap?: number | null; monthlyCap?: number | null }): Customer {
    const displayName = input.displayName.trim();
    if (!displayName) throw new RelayError("Customer name is required.", "cloud_customer_name_required", undefined, 400);
    const email = normalizeEmail(input.email ?? "");
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new RelayError("A valid email is required.", "cloud_email_invalid", undefined, 400);
    }
    const id = `cus_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    try {
      this.db.prepare(
        "INSERT INTO customers (id, display_name, email, status, owner, daily_cap, monthly_cap, created_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)",
      ).run(id, displayName, email, input.owner ? 1 : 0, input.dailyCap ?? null, input.monthlyCap ?? null, createdAt);
    } catch (error) {
      if (String(error).includes("UNIQUE") && input.owner) {
        throw new RelayError("An owner customer already exists.", "cloud_owner_exists", undefined, 409);
      }
      throw error;
    }
    return this.getCustomer(id)!;
  }

  updateCustomerProfile(customerId: string, input: { email?: string; phone?: string }): Customer {
    const customer = this.getCustomer(customerId);
    if (!customer) throw new RelayError("Customer not found.", "cloud_customer_not_found", undefined, 404);
    const email = normalizeEmail(input.email ?? customer.email);
    const phone = input.phone?.trim() ?? customer.phone;
    if (email.length > 254) throw new RelayError("Email is too long.", "cloud_email_invalid", undefined, 400);
    if (phone.length > 40) throw new RelayError("Phone number is too long.", "cloud_phone_invalid", undefined, 400);
    this.db.prepare("UPDATE customers SET email = ?, phone = ? WHERE id = ?").run(email, phone, customerId);
    return this.getCustomer(customerId)!;
  }

  getCustomerAuthByEmail(email: string): CustomerAuthRecord | null {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    const row = this.db.prepare("SELECT * FROM customers WHERE email = ? COLLATE NOCASE LIMIT 1").get(normalized) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      customer: toCustomer(row),
      passwordHash: String(row.password_hash ?? ""),
      sessionVersion: Number(row.session_version ?? 1),
    };
  }

  getCustomerAuthById(id: string): CustomerAuthRecord | null {
    const row = this.db.prepare("SELECT * FROM customers WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      customer: toCustomer(row),
      passwordHash: String(row.password_hash ?? ""),
      sessionVersion: Number(row.session_version ?? 1),
    };
  }

  setCustomerPassword(customerId: string, passwordHash: string): CustomerAuthRecord {
    const customer = this.getCustomer(customerId);
    if (!customer) throw new RelayError("Customer not found.", "cloud_customer_not_found", undefined, 404);
    this.db.prepare("UPDATE customers SET password_hash = ?, session_version = session_version + 1 WHERE id = ?").run(passwordHash, customerId);
    return this.getCustomerAuthById(customerId)!;
  }

  createCustomerInvite(
    customerId: string,
    tokenHash: string,
    ttlMs: number,
    purpose: CustomerInvitePurpose = "setup",
  ): CustomerInvite {
    if (!this.getCustomer(customerId)) throw new RelayError("Customer not found.", "cloud_customer_not_found", undefined, 404);
    const now = new Date();
    const id = `cinv_${randomUUID()}`;
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    this.db.prepare("UPDATE customer_invites SET used_at = ? WHERE customer_id = ? AND used_at IS NULL").run(now.toISOString(), customerId);
    this.db.prepare(
      "INSERT INTO customer_invites (id, customer_id, token_hash, purpose, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, customerId, tokenHash, purpose, expiresAt, now.toISOString());
    return { id, customerId, purpose, expiresAt, usedAt: null, createdAt: now.toISOString() };
  }

  private toCustomerInvite(row: Record<string, unknown>): CustomerInvite {
    const purpose = String(row.purpose ?? "setup");
    return {
      id: String(row.id),
      customerId: String(row.customer_id),
      purpose: purpose === "reset" ? "reset" : "setup",
      expiresAt: String(row.expires_at),
      usedAt: row.used_at == null ? null : String(row.used_at),
      createdAt: String(row.created_at),
    };
  }

  private inviteAllowedForCustomer(invite: CustomerInvite, auth: CustomerAuthRecord): boolean {
    if (auth.customer.owner || auth.customer.status !== "active") return false;
    const hasPassword = Boolean(auth.passwordHash);
    if (invite.purpose === "setup" && hasPassword) return false;
    if (invite.purpose === "reset" && !hasPassword) return false;
    return true;
  }

  peekCustomerInvite(tokenHash: string): { invite: CustomerInvite; auth: CustomerAuthRecord } | null {
    const row = this.db.prepare("SELECT * FROM customer_invites WHERE token_hash = ?").get(tokenHash) as Record<string, unknown> | undefined;
    if (!row || row.used_at != null) return null;
    if (Date.parse(String(row.expires_at)) <= Date.now()) return null;
    const invite = this.toCustomerInvite(row);
    const auth = this.getCustomerAuthById(invite.customerId);
    if (!auth || !this.inviteAllowedForCustomer(invite, auth)) return null;
    return { invite, auth };
  }

  consumeCustomerInvite(tokenHash: string): CustomerAuthRecord | null {
    const pending = this.peekCustomerInvite(tokenHash);
    if (!pending) return null;
    this.db.prepare("UPDATE customer_invites SET used_at = ? WHERE id = ? AND used_at IS NULL").run(new Date().toISOString(), pending.invite.id);
    return this.getCustomerAuthById(pending.invite.customerId);
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

  /** True when the key exists, is not revoked, and its customer is active. */
  isApiKeyActive(keyId: string, customerId: string): boolean {
    const row = this.db.prepare(
      `SELECT k.status AS key_status, c.status AS customer_status
       FROM api_keys k JOIN customers c ON c.id = k.customer_id
       WHERE k.id = ? AND k.customer_id = ?`,
    ).get(keyId, customerId) as { key_status: string; customer_status: string } | undefined;
    return !!row && row.key_status === "active" && row.customer_status === "active";
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

  revokeConnectToken(id: string): ConnectTokenRecord {
    const current = this.db.prepare("SELECT * FROM connect_tokens WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!current) throw new RelayError("Connect token not found.", "cloud_connect_token_not_found", undefined, 404);
    if (String(current.status) !== "revoked") {
      this.db.prepare("UPDATE connect_tokens SET status = 'revoked', revoked_at = ? WHERE id = ?").run(new Date().toISOString(), id);
    }
    return this.listConnectTokens().find((token) => token.id === id)!;
  }

  saveConnectVerification(record: ConnectVerificationRecord): void {
    this.db.prepare(
      `INSERT INTO connect_verifications (session_id, client_id, status, detail, checked_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, client_id) DO UPDATE SET status = excluded.status, detail = excluded.detail, checked_at = excluded.checked_at`,
    ).run(record.sessionId, record.clientId, record.status, record.detail, record.checkedAt);
  }

  listConnectVerifications(sessionId: string): ConnectVerificationRecord[] {
    return (this.db.prepare("SELECT * FROM connect_verifications WHERE session_id = ? ORDER BY client_id ASC").all(sessionId) as Record<string, unknown>[]).map((row) => ({
      sessionId: String(row.session_id),
      clientId: String(row.client_id),
      status: String(row.status) === "connected" ? "connected" : "failed",
      detail: String(row.detail),
      checkedAt: String(row.checked_at),
    }));
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
      `SELECT t.*, c.id AS c_id, c.display_name, c.status AS c_status, c.email, c.phone, c.owner, c.daily_cap, c.monthly_cap, c.created_at AS c_created_at
       FROM connect_tokens t JOIN customers c ON c.id = t.customer_id
       WHERE t.token_hash = ?`,
    ).get(hashKey(rawToken)) as Record<string, unknown> | undefined;
    if (!row) throw new RelayError("Invalid connect token.", "cloud_connect_token_invalid", undefined, 401);
    if (String(row.status) !== "active") throw new RelayError("Connect token revoked.", "cloud_connect_token_revoked", undefined, 401);
    if (String(row.c_status) !== "active") throw new RelayError("Customer disabled.", "cloud_customer_disabled", undefined, 403);
    this.db.prepare("UPDATE connect_tokens SET last_used_at = ? WHERE id = ?").run(new Date().toISOString(), String(row.id));
    return {
      customer: {
        id: String(row.c_id), displayName: String(row.display_name),
        email: row.email == null ? "" : String(row.email),
        phone: row.phone == null ? "" : String(row.phone),
        status: "active",
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

  /** Create one short-lived, tenant-bound session for a Connector flow. */
  // REQ-002, REQ-003
  createConnectSession(
    customerId: string,
    requestedClients: string[] = [],
    ttlMs = 15 * 60 * 1000,
  ): CreatedConnectSession {
    const customer = this.getCustomer(customerId);
    if (!customer) throw new RelayError("Customer not found.", "cloud_customer_not_found", undefined, 404);
    if (customer.status !== "active") throw new RelayError("Customer is disabled.", "cloud_customer_disabled", undefined, 409);
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 15 * 60 * 1000) {
      throw new RelayError("Connect session lifetime must be at most 15 minutes.", "cloud_connect_session_ttl_invalid", undefined, 400);
    }
    const clients = Array.from(
      new Set(
        requestedClients
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim().slice(0, 64))
          .filter((value) => value.length > 0),
      ),
    ).slice(0, 32);
    const prefix = randomBytes(5).toString("hex");
    const secret = randomBytes(32).toString("base64url");
    const token = `rcs_${prefix}_${secret}`;
    const id = `cs_${randomUUID()}`;
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + ttlMs);
    this.db.prepare(
      "INSERT INTO connect_sessions (id, customer_id, token_hash, requested_clients, status, created_at, expires_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
    ).run(
      id,
      customerId,
      hashKey(token),
      JSON.stringify(clients),
      createdAt.toISOString(),
      expiresAt.toISOString(),
    );
    return {
      id,
      customerId,
      requestedClients: clients,
      status: "pending",
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      usedAt: null,
      token,
    };
  }

  /** Resolve a scoped session token without consuming it. */
  // REQ-002, REQ-030
  getConnectSession(rawToken: string, sessionId?: string): ConnectSessionRecord {
    if (!rawToken || !rawToken.startsWith("rcs_")) {
      throw new RelayError("Invalid connect session.", "cloud_connect_session_invalid", undefined, 401);
    }
    const row = this.db.prepare(
      `SELECT s.*, c.status AS customer_status
       FROM connect_sessions s JOIN customers c ON c.id = s.customer_id
       WHERE s.token_hash = ? AND (? IS NULL OR s.id = ?)`,
    ).get(hashKey(rawToken), sessionId ?? null, sessionId ?? null) as Record<string, unknown> | undefined;
    if (!row) throw new RelayError("Invalid connect session.", "cloud_connect_session_invalid", undefined, 401);
    if (String(row.customer_status) !== "active") {
      throw new RelayError("Customer is disabled.", "cloud_customer_disabled", undefined, 403);
    }
    const session = toConnectSession(row);
    if (session.status === "consumed") {
      throw new RelayError("Connect session already used.", "cloud_connect_session_used", undefined, 409);
    }
    if (session.status === "expired" || Date.parse(session.expiresAt) <= Date.now()) {
      if (session.status !== "expired") {
        this.db.prepare("UPDATE connect_sessions SET status = 'expired' WHERE id = ?").run(session.id);
      }
      throw new RelayError("Connect session expired.", "cloud_connect_session_expired", undefined, 410);
    }
    return session;
  }

  /** Consume a session after the Connector reports its final state. */
  // REQ-002, REQ-030
  consumeConnectSession(rawToken: string, sessionId: string): ConnectSessionRecord {
    const session = this.getConnectSession(rawToken, sessionId);
    const usedAt = new Date().toISOString();
    this.db.prepare(
      "UPDATE connect_sessions SET status = 'consumed', used_at = ? WHERE id = ? AND status = 'pending'",
    ).run(usedAt, session.id);
    return { ...session, status: "consumed", usedAt };
  }

  /** Resolve a raw API key to exactly one active customer. */
  resolveApiKey(rawKey: string): ApiKeyIdentity {
    if (!rawKey || !rawKey.startsWith("rly_")) {
      throw new RelayError("Invalid API key.", "cloud_api_key_invalid", undefined, 401);
    }
    const row = this.db.prepare(
      `SELECT k.*, c.id AS c_id, c.display_name, c.status AS c_status, c.email, c.phone, c.owner, c.daily_cap, c.monthly_cap, c.created_at AS c_created_at
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
        email: row.email == null ? "" : String(row.email),
        phone: row.phone == null ? "" : String(row.phone),
        status: "active",
        owner: Number(row.owner) === 1,
        dailyCap: row.daily_cap == null ? null : Number(row.daily_cap),
        monthlyCap: row.monthly_cap == null ? null : Number(row.monthly_cap),
        createdAt: String(row.c_created_at),
      },
      key: toKey(row),
    };
  }

  createWaitlistEntry(input: {
    name: string;
    email: string;
    phone?: string;
    platforms?: string;
    volume?: string;
    useCase?: string;
  }): { entry: WaitlistEntry; duplicate: boolean } {
    const name = input.name.trim();
    const email = input.email.trim();
    const emailNormalized = normalizeEmail(email);
    const phone = normalizePhone(input.phone ?? "");
    if (!name) throw new RelayError("Your name is required.", "waitlist_name_required", undefined, 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new RelayError("A valid email is required.", "waitlist_email_invalid", undefined, 400);
    }
    if (input.phone?.trim() && !phone) {
      throw new RelayError("Enter a valid phone number with country code, or leave it blank.", "waitlist_phone_invalid", undefined, 400);
    }
    const existing = this.db.prepare("SELECT * FROM waitlist WHERE email_normalized = ?").get(emailNormalized) as
      | Record<string, unknown>
      | undefined;
    if (existing) return { entry: toWaitlist(existing), duplicate: true };
    const id = `wl_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO waitlist (id, name, email, email_normalized, phone, platforms, volume, use_case, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(
      id,
      name.slice(0, 120),
      email.slice(0, 200),
      emailNormalized,
      phone,
      (input.platforms ?? "").trim().slice(0, 300),
      (input.volume ?? "").trim().slice(0, 120),
      (input.useCase ?? "").trim().slice(0, 2000),
      createdAt,
    );
    return { entry: this.getWaitlist(id)!, duplicate: false };
  }

  getWaitlist(id: string): WaitlistEntry | null {
    const row = this.db.prepare("SELECT * FROM waitlist WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? toWaitlist(row) : null;
  }

  listWaitlist(status?: string): WaitlistEntry[] {
    const rows = status
      ? (this.db.prepare("SELECT * FROM waitlist WHERE status = ? ORDER BY created_at ASC").all(status) as Record<string, unknown>[])
      : (this.db.prepare("SELECT * FROM waitlist ORDER BY created_at ASC").all() as Record<string, unknown>[]);
    return rows.map(toWaitlist);
  }

  waitlistPosition(id: string): number {
    const entry = this.getWaitlist(id);
    if (!entry) return 0;
    const row = this.db.prepare(
      "SELECT COUNT(*) AS n FROM waitlist WHERE status = 'pending' AND created_at <= ?",
    ).get(entry.createdAt) as { n: number };
    return Number(row.n);
  }

  waitlistAcceptedCount(): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS n FROM waitlist WHERE status IN ('invited', 'active')",
    ).get() as { n: number };
    return Number(row.n);
  }

  waitlistStatusCounts(): Record<string, number> {
    const rows = this.db.prepare("SELECT status, COUNT(*) AS n FROM waitlist GROUP BY status").all() as Array<{
      status: string;
      n: number;
    }>;
    return Object.fromEntries(rows.map((row) => [String(row.status), Number(row.n)]));
  }

  approveWaitlist(id: string, customerId: string): WaitlistEntry {
    const entry = this.getWaitlist(id);
    if (!entry) throw new RelayError("Waitlist entry not found.", "waitlist_not_found", undefined, 404);
    if (entry.status === "rejected") throw new RelayError("Rejected entries cannot be approved.", "waitlist_rejected", undefined, 409);
    if (entry.status === "invited" || entry.status === "active") return entry;
    this.db.prepare(
      "UPDATE waitlist SET status = 'invited', customer_id = ?, approved_at = ? WHERE id = ?",
    ).run(customerId, new Date().toISOString(), id);
    return this.getWaitlist(id)!;
  }

  rejectWaitlist(id: string, note?: string): WaitlistEntry {
    const entry = this.getWaitlist(id);
    if (!entry) throw new RelayError("Waitlist entry not found.", "waitlist_not_found", undefined, 404);
    if (entry.status === "invited" || entry.status === "active") {
      throw new RelayError("An invited customer cannot be rejected here.", "waitlist_already_invited", undefined, 409);
    }
    this.db.prepare(
      "UPDATE waitlist SET status = 'rejected', note = ?, rejected_at = ? WHERE id = ?",
    ).run((note ?? "").trim().slice(0, 1000) || null, new Date().toISOString(), id);
    return this.getWaitlist(id)!;
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

