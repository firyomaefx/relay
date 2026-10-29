import type { PostDraft, RelayService } from "@relay/core";
import { randomUUID } from "node:crypto";
import type { CloudLedger, PriceTable, RateLimiter, CloudRateConfig } from "@relay/cloud";
import type { CloudStore, Customer } from "@relay/cloud";
import type { ToolContext } from "./tools.js";

interface Hold {
  reservationId: string;
  customerId: string;
  quotes: Array<{ platform: string; amount: number }>;
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

  hooks(customer: Customer): Pick<ToolContext, "beforePost" | "afterPost" | "afterPostError" | "afterCancel"> {
    return {
      beforePost: async (draft) => this.reserve(customer, draft),
      afterPost: async (hold, result) => this.settle(customer, hold as Hold | null, result),
      afterPostError: async (hold) => this.release(hold as Hold | null),
      afterCancel: async (jobId) => this.cancel(customer, jobId),
    };
  }

  balance(customerId: string) {
    return this.options.ledger.balanceWithHold(customerId);
  }

  usage(customerId: string, limit = 20) {
    return this.options.ledger.entries(customerId, limit);
  }

  private async reserve(customer: Customer, draft: PostDraft): Promise<Hold | null> {
    this.options.limiter?.check(customer.id, "posts", this.options.rateConfig?.postsPerHour ?? 60, 60 * 60 * 1000);
    const platforms = draft.platforms ?? [];
    const quote = this.options.prices.quote(draft, platforms);
    if (quote.total <= 0) return null;
    const reservation = this.options.ledger.reserve({
      customerId: customer.id,
      amount: quote.total,
      idempotencyKey: `post:${customer.id}:${randomUUID()}`,
      ttlMs: 24 * 60 * 60 * 1000,
    });
    return { reservationId: reservation.id, customerId: customer.id, quotes: quote.quotes };
  }

  private async settle(
    customer: Customer,
    hold: Hold | null,
    result: Awaited<ReturnType<RelayService["createPost"]>>,
  ): Promise<void> {
    if (!hold) return;
    if (result.scheduled && result.jobId) {
      this.options.ledger.bindJob(hold.reservationId, result.jobId);
      return;
    }
    const succeeded = new Set(result.results.filter((entry) => entry.ok).map((entry) => entry.platform));
    const actual = hold.quotes.filter((quote) => succeeded.has(quote.platform as never)).reduce((sum, quote) => sum + quote.amount, 0);
    if (actual > 0) this.options.ledger.commit(hold.reservationId, actual, result.results.find((entry) => entry.ok)?.postId);
    else this.options.ledger.release(hold.reservationId);
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
      const quote = this.options.prices.quote(job.draft, job.draft.platforms ?? []);
      const succeeded = new Set((job.results ?? []).filter((entry) => entry.ok).map((entry) => entry.platform));
      const actual = quote.quotes.filter((entry) => succeeded.has(entry.platform as never)).reduce((sum, entry) => sum + entry.amount, 0);
      if (actual > 0) this.options.ledger.commit(reservation.id, actual, job.results?.find((entry) => entry.ok)?.postId);
      else this.options.ledger.release(reservation.id);
    }
  }
}

