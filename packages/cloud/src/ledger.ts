import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { RelayError } from "@relay/core";

export type LedgerType = "topup" | "charge" | "refund" | "adjustment";
export type ReservationStatus = "held" | "committed" | "released";

export interface LedgerEntry {
  id: string;
  customerId: string;
  amount: number;
  type: LedgerType;
  postId: string | null;
  idempotencyKey: string;
  reason: string | null;
  createdAt: string;
}

export interface Reservation {
  id: string;
  customerId: string;
  amount: number;
  status: ReservationStatus;
  idempotencyKey: string;
  jobId: string | null;
  freeUnits: number;
  freeJson: string | null;
  createdAt: string;
  expiresAt: string;
}

function toReservation(row: Record<string, unknown>): Reservation {
  return {
    id: String(row.id),
    customerId: String(row.customer_id),
    amount: Number(row.amount),
    status: String(row.status) as ReservationStatus,
    idempotencyKey: String(row.idempotency_key),
    jobId: row.job_id == null ? null : String(row.job_id),
    freeUnits: Number(row.free_units ?? 0),
    freeJson: row.free_json == null ? null : String(row.free_json),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
  };
}

export interface PaymentEvent {
  id: string;
  customerId: string;
  provider: string;
  providerPaymentId: string;
  amount: number;
  currency: string;
  status: string;
  note: string | null;
  createdAt: string;
}

/**
 * Append-only ledger and held reservations in cloud.sqlite. Amounts are whole
 * integer units; credits are positive, charges negative. Available balance is
 * ledger sum minus active holds.
 */
export class CloudLedger {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ledger (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        amount INTEGER NOT NULL,
        type TEXT NOT NULL,
        post_id TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        reason TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ledger_customer_created ON ledger(customer_id, created_at);
      CREATE TABLE IF NOT EXISTS reservations (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        amount INTEGER NOT NULL,
        status TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        job_id TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS free_usage (customer_id TEXT PRIMARY KEY, units_used INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS reservations_customer_status ON reservations(customer_id, status);
      CREATE UNIQUE INDEX IF NOT EXISTS reservations_job ON reservations(job_id) WHERE job_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS payment_events (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_payment_id TEXT NOT NULL,
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL,
        status TEXT NOT NULL,
        note TEXT,
        raw_json TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(provider, provider_payment_id)
      );
      CREATE INDEX IF NOT EXISTS payment_events_customer ON payment_events(customer_id, created_at);
    `);
    const columns = new Set((this.db.prepare("PRAGMA table_info(reservations)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!columns.has("free_units")) this.db.exec("ALTER TABLE reservations ADD COLUMN free_units INTEGER NOT NULL DEFAULT 0");
    if (!columns.has("free_json")) this.db.exec("ALTER TABLE reservations ADD COLUMN free_json TEXT");
  }

  private freeUsedInTransaction(customerId: string): number {
    const row = this.db.prepare("SELECT units_used FROM free_usage WHERE customer_id = ?").get(customerId) as { units_used: number } | undefined;
    return Number(row?.units_used ?? 0);
  }

  private freeHeldInTransaction(customerId: string): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(free_units), 0) AS total FROM reservations WHERE customer_id = ? AND status = 'held'").get(customerId) as { total: number };
    return Number(row.total);
  }

  freeRemaining(customerId: string, limit: number): number {
    return Math.max(0, limit - this.freeUsedInTransaction(customerId) - this.freeHeldInTransaction(customerId));
  }

  /** Lifetime successful top-ups, excluding free starter credit and charges. */
  totalTopups(customerId: string): number {
    const row = this.db.prepare(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM ledger WHERE customer_id = ? AND type = 'topup'",
    ).get(customerId) as { total: number };
    return Number(row.total);
  }

  private balanceInTransaction(customerId: string): number {
    const sum = this.db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM ledger WHERE customer_id = ?").get(customerId) as { total: number };
    const holds = this.db.prepare(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM reservations WHERE customer_id = ? AND status = 'held'",
    ).get(customerId) as { total: number };
    return Number(sum.total) - Number(holds.total);
  }

  balance(customerId: string): number {
    return this.balanceInTransaction(customerId);
  }

  balanceWithHold(customerId: string): { balance: number; held: number; available: number } {
    const balance = this.balanceInTransaction(customerId);
    const heldRow = this.db.prepare(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM reservations WHERE customer_id = ? AND status = 'held'",
    ).get(customerId) as { total: number };
    const held = Number(heldRow.total);
    return { balance: balance + held, held, available: balance };
  }

  entries(customerId: string, limit = 20): LedgerEntry[] {
    const rows = this.db.prepare(
      "SELECT * FROM ledger WHERE customer_id = ? ORDER BY created_at DESC LIMIT ?",
    ).all(customerId, Math.max(1, Math.min(limit, 200))) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      customerId: String(row.customer_id),
      amount: Number(row.amount),
      type: String(row.type) as LedgerType,
      postId: row.post_id == null ? null : String(row.post_id),
      idempotencyKey: String(row.idempotency_key),
      reason: row.reason == null ? null : String(row.reason),
      createdAt: String(row.created_at),
    }));
  }

  credit(input: {
    customerId: string;
    amount: number;
    type: Extract<LedgerType, "topup" | "refund" | "adjustment">;
    idempotencyKey: string;
    reason?: string;
    postId?: string;
  }): LedgerEntry {
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new RelayError("Credit amount must be a positive whole number.", "cloud_amount_invalid");
    }
    return this.insertLedger({ ...input, amount: input.amount });
  }

  reserve(input: {
    customerId: string;
    amount: number;
    idempotencyKey: string;
    jobId?: string;
    ttlMs?: number;
    freeUnits?: number;
    freeLimit?: number;
    freeJson?: string;
  }): Reservation {
    if (!Number.isInteger(input.amount) || input.amount < 0) {
      throw new RelayError("Reservation amount must be a non-negative whole number.", "cloud_amount_invalid");
    }
    const freeUnits = input.freeUnits ?? 0;
    if (!Number.isInteger(freeUnits) || freeUnits < 0) {
      throw new RelayError("Free units must be a non-negative whole number.", "cloud_free_units_invalid");
    }
    const existing = this.db.prepare("SELECT * FROM reservations WHERE idempotency_key = ?").get(input.idempotencyKey) as
      | Record<string, unknown>
      | undefined;
    if (existing) return toReservation(existing);
    try {
      this.db.exec("BEGIN IMMEDIATE");
      if (freeUnits > 0) {
        const used = this.freeUsedInTransaction(input.customerId);
        const heldFree = this.freeHeldInTransaction(input.customerId);
        const limit = input.freeLimit ?? 0;
        if (used + heldFree + freeUnits > limit) {
          throw new RelayError("Free allowance exceeded.", "cloud_free_allowance_exceeded", { limit, used: used + heldFree, requested: freeUnits });
        }
      }
      const available = this.balanceInTransaction(input.customerId);
      if (available < input.amount) {
        throw new RelayError(`Insufficient balance: need ${input.amount}, available ${available}.`, "cloud_insufficient_balance", {
          required: input.amount,
          available,
        });
      }
      const caps = this.db.prepare("SELECT daily_cap, monthly_cap FROM customers WHERE id = ?").get(input.customerId) as
        | { daily_cap: number | null; monthly_cap: number | null }
        | undefined;
      if (caps?.daily_cap != null) {
        const dayStart = new Date();
        dayStart.setUTCHours(0, 0, 0, 0);
        const spent = this.spentSince(input.customerId, dayStart.toISOString());
        const held = this.heldSince(input.customerId, dayStart.toISOString());
        if (spent + held + input.amount > Number(caps.daily_cap)) {
          throw new RelayError(`Daily spend cap exceeded (${caps.daily_cap}).`, "cloud_daily_cap_exceeded", {
            cap: Number(caps.daily_cap),
            spent: spent + held,
            requested: input.amount,
          });
        }
      }
      if (caps?.monthly_cap != null) {
        const monthStart = new Date();
        monthStart.setUTCDate(1);
        monthStart.setUTCHours(0, 0, 0, 0);
        const spent = this.spentSince(input.customerId, monthStart.toISOString());
        const held = this.heldSince(input.customerId, monthStart.toISOString());
        if (spent + held + input.amount > Number(caps.monthly_cap)) {
          throw new RelayError(`Monthly spend cap exceeded (${caps.monthly_cap}).`, "cloud_monthly_cap_exceeded", {
            cap: Number(caps.monthly_cap),
            spent: spent + held,
            requested: input.amount,
          });
        }
      }
      const id = `res_${randomUUID()}`;
      const now = new Date();
      const expiresAt = new Date(now.getTime() + (input.ttlMs ?? 24 * 60 * 60 * 1000)).toISOString();
      this.db.prepare(
        "INSERT INTO reservations (id, customer_id, amount, status, idempotency_key, job_id, free_units, free_json, created_at, expires_at) VALUES (?, ?, ?, 'held', ?, ?, ?, ?, ?, ?)",
      ).run(id, input.customerId, input.amount, input.idempotencyKey, input.jobId ?? null, freeUnits, input.freeJson ?? null, now.toISOString(), expiresAt);
      this.db.exec("COMMIT");
      return toReservation({
        id,
        customer_id: input.customerId,
        amount: input.amount,
        status: "held",
        idempotency_key: input.idempotencyKey,
        job_id: input.jobId ?? null,
        free_units: freeUnits,
        free_json: input.freeJson ?? null,
        created_at: now.toISOString(),
        expires_at: expiresAt,
      });
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // No active transaction.
      }
      throw error;
    }
  }

  bindJob(reservationId: string, jobId: string): void {
    this.db.prepare("UPDATE reservations SET job_id = ? WHERE id = ? AND status = 'held'").run(jobId, reservationId);
  }

  reservationForJob(customerId: string, jobId: string): Reservation | null {
    const row = this.db.prepare(
      "SELECT * FROM reservations WHERE customer_id = ? AND job_id = ? AND status = 'held'",
    ).get(customerId, jobId) as Record<string, unknown> | undefined;
    return row ? toReservation(row) : null;
  }

  commit(reservationId: string, actualAmount: number, postId?: string, usedFreeUnits = 0): LedgerEntry | null {
    if (!Number.isInteger(actualAmount) || actualAmount < 0) {
      throw new RelayError("Charge amount must be a non-negative whole number.", "cloud_amount_invalid");
    }
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const row = this.db.prepare("SELECT * FROM reservations WHERE id = ?").get(reservationId) as
        | Record<string, unknown>
        | undefined;
      if (!row) throw new RelayError("Reservation not found.", "cloud_reservation_not_found", undefined, 404);
      if (String(row.status) !== "held") {
        this.db.exec("COMMIT");
        return null;
      }
      const reservedFree = Number(row.free_units ?? 0);
      if (!Number.isInteger(usedFreeUnits) || usedFreeUnits < 0 || usedFreeUnits > reservedFree) {
        throw new RelayError("Invalid free-unit settlement.", "cloud_free_units_invalid");
      }
      this.db.prepare("UPDATE reservations SET status = 'committed' WHERE id = ?").run(reservationId);
      if (usedFreeUnits > 0) {
        this.db.prepare(
          "INSERT INTO free_usage (customer_id, units_used) VALUES (?, ?) ON CONFLICT(customer_id) DO UPDATE SET units_used = units_used + excluded.units_used",
        ).run(String(row.customer_id), usedFreeUnits);
      }
      const entry = actualAmount > 0
        ? this.insertLedger({
            customerId: String(row.customer_id),
            amount: -actualAmount,
            type: "charge",
            idempotencyKey: `charge:${reservationId}`,
            postId,
            reason: "post charge",
          })
        : null;
      this.db.exec("COMMIT");
      return entry;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // No active transaction.
      }
      throw error;
    }
  }

  release(reservationId: string): void {
    try {
      this.db.exec("BEGIN IMMEDIATE");
      this.db.prepare("UPDATE reservations SET status = 'released' WHERE id = ? AND status = 'held'").run(reservationId);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // No active transaction.
      }
      throw error;
    }
  }

  recordTopup(input: {
    customerId: string;
    amount: number;
    currency?: string;
    reference: string;
    note?: string;
    provider?: string;
  }): { event: PaymentEvent; entry: LedgerEntry; paymentReplayed: boolean } {
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new RelayError("Top-up amount must be a positive whole number.", "cloud_amount_invalid");
    }
    const provider = input.provider ?? "manual";
    const providerPaymentId = input.reference.trim();
    if (!providerPaymentId) throw new RelayError("A payment reference is required.", "cloud_payment_reference_required");
    const existing = this.db.prepare(
      "SELECT * FROM payment_events WHERE provider = ? AND provider_payment_id = ?",
    ).get(provider, providerPaymentId) as Record<string, unknown> | undefined;
    if (existing) {
      return {
        event: {
          id: String(existing.id),
          customerId: String(existing.customer_id),
          provider: String(existing.provider),
          providerPaymentId: String(existing.provider_payment_id),
          amount: Number(existing.amount),
          currency: String(existing.currency),
          status: String(existing.status),
          note: existing.note == null ? null : String(existing.note),
          createdAt: String(existing.created_at),
        },
        entry: this.entries(input.customerId, 1).find((entry) => entry.idempotencyKey === `payment:${provider}:${providerPaymentId}`)!,
        paymentReplayed: true,
      };
    }

    try {
      this.db.exec("BEGIN IMMEDIATE");
      const event: PaymentEvent = {
        id: `pay_${randomUUID()}`,
        customerId: input.customerId,
        provider,
        providerPaymentId,
        amount: input.amount,
        currency: input.currency ?? "MYR",
        status: "succeeded",
        note: input.note?.trim() || null,
        createdAt: new Date().toISOString(),
      };
      this.db.prepare(
        "INSERT INTO payment_events (id, customer_id, provider, provider_payment_id, amount, currency, status, note, raw_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        event.id,
        event.customerId,
        event.provider,
        event.providerPaymentId,
        event.amount,
        event.currency,
        event.status,
        event.note,
        JSON.stringify({ source: "manual", reference: event.providerPaymentId }),
        event.createdAt,
      );
      const entry = this.insertLedger({
        customerId: input.customerId,
        amount: input.amount,
        type: "topup",
        idempotencyKey: `payment:${provider}:${providerPaymentId}`,
        reason: input.note?.trim() || "manual top-up",
      });
      this.db.exec("COMMIT");
      return { event, entry, paymentReplayed: false };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // No active transaction.
      }
      throw error;
    }
  }

  listPayments(customerId: string, limit = 20): PaymentEvent[] {
    const rows = this.db.prepare(
      "SELECT * FROM payment_events WHERE customer_id = ? ORDER BY created_at DESC LIMIT ?",
    ).all(customerId, Math.max(1, Math.min(limit, 200))) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      customerId: String(row.customer_id),
      provider: String(row.provider),
      providerPaymentId: String(row.provider_payment_id),
      amount: Number(row.amount),
      currency: String(row.currency),
      status: String(row.status),
      note: row.note == null ? null : String(row.note),
      createdAt: String(row.created_at),
    }));
  }

  private spentSince(customerId: string, since: string): number {    const charges = this.db.prepare(
      "SELECT COALESCE(SUM(-amount), 0) AS total FROM ledger WHERE customer_id = ? AND type = 'charge' AND created_at >= ?",
    ).get(customerId, since) as { total: number };
    return Number(charges.total);
  }

  private heldSince(customerId: string, since: string): number {
    const held = this.db.prepare(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM reservations WHERE customer_id = ? AND status = 'held' AND created_at >= ?",
    ).get(customerId, since) as { total: number };
    return Number(held.total);
  }

  private insertLedger(input: {    customerId: string;
    amount: number;
    type: LedgerType;
    idempotencyKey: string;
    reason?: string;
    postId?: string;
  }): LedgerEntry {
    const existing = this.db.prepare("SELECT * FROM ledger WHERE idempotency_key = ?").get(input.idempotencyKey) as
      | Record<string, unknown>
      | undefined;
    if (existing) {
      return {
        id: String(existing.id),
        customerId: String(existing.customer_id),
        amount: Number(existing.amount),
        type: String(existing.type) as LedgerType,
        postId: existing.post_id == null ? null : String(existing.post_id),
        idempotencyKey: String(existing.idempotency_key),
        reason: existing.reason == null ? null : String(existing.reason),
        createdAt: String(existing.created_at),
      };
    }
    const entry: LedgerEntry = {
      id: `led_${randomUUID()}`,
      customerId: input.customerId,
      amount: input.amount,
      type: input.type,
      postId: input.postId ?? null,
      idempotencyKey: input.idempotencyKey,
      reason: input.reason ?? null,
      createdAt: new Date().toISOString(),
    };
    this.db.prepare(
      "INSERT INTO ledger (id, customer_id, amount, type, post_id, idempotency_key, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(entry.id, entry.customerId, entry.amount, entry.type, entry.postId, entry.idempotencyKey, entry.reason, entry.createdAt);
    return entry;
  }

  close(): void {
    this.db.close();
  }
}



