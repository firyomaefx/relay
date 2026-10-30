import type { PostDraft, RelayService } from "@relay/core";
import { randomUUID } from "node:crypto";
import type { CloudLedger, PriceTable, RateLimiter, CloudRateConfig } from "@relay/cloud";
import type { CloudStore, Customer } from "@relay/cloud";
import type { ToolContext } from "./tools.js";

interface QuotePart {
  kind: string;
  amount: number;
}

interface QuoteHold {
  platform: string;
  kind: string;
  amount: number;
  parts: number;
  breakdown: QuotePart[];
  units: number;
  free: boolean;
  freeAmount: number;
  paidAmount: number;
}

interface Hold {
  reservationId: string;
  customerId: string;
  quotes: QuoteHold[];
}

export interface QuotePreviewLine {
  platform: string;
  kind: string;
  parts: number;
  amount: number;
  freeAmount: number;
  paidAmount: number;
  breakdown: QuotePart[];
}

export interface QuotePreview {
  currency: string;
  unit: string;
  total: number;
  freeCreditApplied: number;
  paidTotal: number;
  lines: QuotePreviewLine[];
}

function unitFor(kind: string): number {
  return kind === "video" ? 2 : 1;
}

/** Older reservations stored only `free`/`units`; normalize them when reconciling. */
function normalizeHold(entry: QuoteHold): QuoteHold {
  const paidAmount = Number.isFinite(Number(entry.paidAmount))
    ? Number(entry.paidAmount)
    : entry.free
      ? 0
      : entry.amount;
  const freeAmount = Number.isFinite(Number(entry.freeAmount))
    ? Number(entry.freeAmount)
    : entry.free
      ? Number(entry.units)
      : 0;
  return { ...entry, paidAmount, freeAmount };
}

/** Cloud-only finance hooks around the existing relay_post / relay_cancel tools. */
export class CloudFinance {
  constructor(
    private readonly options: {
      store: CloudStore;
      ledger: CloudLedger;
      prices: PriceTable;
      tenants: { get(customer: Customer): Promise<RelayService>; recordMappings(customer: Customer, relay: RelayService): Promise<void> };
      limiter?: RateLimiter;
      rateConfig?: CloudRateConfig;
    },
  ) {}

  hooks(customer: Customer): Pick<ToolContext, "beforePost" | "afterPost" | "afterPostError" | "afterCancel" | "quotePost"> {
    return {
      beforePost: async (draft) => this.reserve(customer, draft),
      afterPost: async (hold, result) => this.settle(hold as Hold | null, result),
      afterPostError: async (hold) => this.release(hold as Hold | null),
      afterCancel: async (jobId) => this.cancel(customer, jobId),
      quotePost: (draft) => this.quote(customer, draft),
    };
  }

  balance(customerId: string) {
    return this.options.ledger.balanceWithHold(customerId);
  }

  usage(customerId: string, limit = 20) {
    return this.options.ledger.entries(customerId, limit);
  }

  private pricingConfig() {
    const config = this.options.prices.list();
    const freeCredit = config.free_allowance_milli_usd;
    if (Number.isInteger(freeCredit) && freeCredit! > 0) {
      return {
        freeLimit: freeCredit!,
        creditMode: true,
        excluded: new Set(config.free_excluded_platforms ?? []),
      };
    }
    return {
      freeLimit: config.free_allowance_units ?? config.free_allowance_posts ?? 0,
      creditMode: false,
      excluded: new Set(config.free_excluded_platforms ?? []),
    };
  }

  /** Price a draft without reserving or charging. Used by relay_validate and the cost preview. */
  quote(customer: Customer, draft: PostDraft): QuotePreview {
    const priced = this.options.prices.quote(draft, draft.platforms ?? []);
    const { freeLimit, creditMode, excluded } = this.pricingConfig();
    let freeRemaining = this.options.ledger.freeRemaining(customer.id, freeLimit);
    const lines: QuotePreviewLine[] = priced.quotes.map((entry) => {
      const units = creditMode
        ? entry.amount
        : entry.breakdown.reduce((sum, part) => sum + unitFor(part.kind), 0);
      const freeAmount = !excluded.has(entry.platform)
        ? (creditMode ? Math.min(entry.amount, freeRemaining) : freeRemaining >= units ? units : 0)
        : 0;
      freeRemaining -= freeAmount;
      const paidAmount = creditMode ? entry.amount - freeAmount : freeAmount > 0 ? 0 : entry.amount;
      return {
        platform: entry.platform,
        kind: entry.kind,
        parts: entry.parts,
        amount: entry.amount,
        freeAmount,
        paidAmount,
        breakdown: entry.breakdown,
      };
    });
    return {
      currency: priced.currency,
      unit: priced.unit,
      total: lines.reduce((sum, line) => sum + line.amount, 0),
      freeCreditApplied: creditMode ? lines.reduce((sum, line) => sum + line.freeAmount, 0) : 0,
      paidTotal: lines.reduce((sum, line) => sum + line.paidAmount, 0),
      lines,
    };
  }

  private async reserve(customer: Customer, draft: PostDraft): Promise<Hold | null> {
    this.options.limiter?.check(customer.id, "posts", this.options.rateConfig?.postsPerHour ?? 60, 60 * 60 * 1000);
    const { freeLimit, creditMode, excluded } = this.pricingConfig();
    const priced = this.options.prices.quote(draft, draft.platforms ?? []);
    let freeRemaining = this.options.ledger.freeRemaining(customer.id, freeLimit);
    const quotes: QuoteHold[] = priced.quotes.map((entry) => {
      // $0.50 free credit is spent at the real post price; legacy configs count post units.
      const units = creditMode
        ? entry.amount
        : entry.breakdown.reduce((sum, part) => sum + unitFor(part.kind), 0);
      const freeAmount = !excluded.has(entry.platform)
        ? (creditMode ? Math.min(entry.amount, freeRemaining) : freeRemaining >= units ? units : 0)
        : 0;
      freeRemaining -= freeAmount;
      const paidAmount = creditMode ? entry.amount - freeAmount : freeAmount > 0 ? 0 : entry.amount;
      return {
        platform: entry.platform,
        kind: entry.kind,
        amount: entry.amount,
        parts: entry.parts,
        breakdown: entry.breakdown,
        units,
        free: freeAmount > 0,
        freeAmount,
        paidAmount,
      };
    });
    const paidTotal = quotes.reduce((sum, entry) => sum + entry.paidAmount, 0);
    const freeUnits = quotes.reduce((sum, entry) => sum + entry.freeAmount, 0);
    if (paidTotal === 0 && freeUnits === 0) return null;
    const reservation = this.options.ledger.reserve({
      customerId: customer.id,
      amount: paidTotal,
      freeUnits,
      freeLimit,
      freeJson: JSON.stringify(quotes),
      idempotencyKey: `post:${customer.id}:${randomUUID()}`,
      ttlMs: 24 * 60 * 60 * 1000,
    });
    return { reservationId: reservation.id, customerId: customer.id, quotes };
  }

  private async settle(
    hold: Hold | null,
    result: Awaited<ReturnType<RelayService["createPost"]>>,
  ): Promise<void> {
    if (!hold) return;
    if (result.scheduled && result.jobId) {
      this.options.ledger.bindJob(hold.reservationId, result.jobId);
      return;
    }
    const succeeded = new Set(result.results.filter((entry) => entry.ok).map((entry) => entry.platform));
    const actual = hold.quotes
      .filter((entry) => succeeded.has(entry.platform as never))
      .reduce((sum, entry) => sum + entry.paidAmount, 0);
    const freeUsed = hold.quotes
      .filter((entry) => succeeded.has(entry.platform as never))
      .reduce((sum, entry) => sum + entry.freeAmount, 0);
    this.options.ledger.commit(
      hold.reservationId,
      actual,
      result.results.find((entry) => entry.ok)?.postId,
      freeUsed,
    );
  }

  private async release(hold: Hold | null): Promise<void> {
    if (hold) this.options.ledger.release(hold.reservationId);
  }

  private async cancel(customer: Customer, jobId: string): Promise<void> {
    const reservation = this.options.ledger.reservationForJob(customer.id, jobId);
    if (reservation) this.options.ledger.release(reservation.id);
  }

  /** Reconcile scheduled jobs after the cloud scheduler runs them. */
  async reconcile(customer: Customer, relay: RelayService): Promise<void> {
    const jobs = await relay.listQueue();
    for (const job of jobs) {
      const reservation = this.options.ledger.reservationForJob(customer.id, job.id);
      if (!reservation) continue;
      if (job.status === "canceled") {
        this.options.ledger.release(reservation.id);
        continue;
      }
      if (job.status !== "done" && job.status !== "failed") continue;
      let quotes: QuoteHold[] = [];
      try {
        quotes = reservation.freeJson
          ? (JSON.parse(reservation.freeJson) as QuoteHold[]).map(normalizeHold)
          : [];
      } catch {
        quotes = [];
      }
      const succeeded = new Set((job.results ?? []).filter((entry) => entry.ok).map((entry) => entry.platform));
      const actual = quotes
        .filter((entry) => succeeded.has(entry.platform as never))
        .reduce((sum, entry) => sum + entry.paidAmount, 0);
      const freeUsed = quotes
        .filter((entry) => succeeded.has(entry.platform as never))
        .reduce((sum, entry) => sum + entry.freeAmount, 0);
      this.options.ledger.commit(reservation.id, actual, job.results?.find((entry) => entry.ok)?.postId, freeUsed);
    }
  }
}
