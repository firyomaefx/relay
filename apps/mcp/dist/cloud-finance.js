import { randomUUID } from "node:crypto";
import { effectiveFreeLimit } from "@relay/cloud";
function unitFor(kind) {
    return kind === "video" ? 2 : 1;
}
/** Older reservations stored only `free`/`units`; normalize them when reconciling. */
function normalizeHold(entry) {
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
    options;
    constructor(options) {
        this.options = options;
    }
    hooks(customer) {
        return {
            beforePost: async (draft) => this.reserve(customer, draft),
            afterPost: async (hold, result) => this.settle(hold, result),
            afterPostError: async (hold) => this.release(hold),
            afterCancel: async (jobId) => this.cancel(customer, jobId),
            quotePost: (draft) => this.quote(customer, draft),
        };
    }
    balance(customerId) {
        const customer = this.options.store.getCustomer(customerId);
        const balance = this.options.ledger.balanceWithHold(customerId);
        if (!customer)
            return balance;
        const { freeLimit, creditMode } = this.pricingConfig(customer);
        const freeRemaining = creditMode ? this.options.ledger.freeRemaining(customerId, freeLimit) : 0;
        return {
            ...balance,
            ...(creditMode
                ? {
                    freeCredit: { limit: freeLimit, remaining: freeRemaining, currency: this.options.prices.list().currency },
                    totalAvailable: balance.available + freeRemaining,
                    // totalAvailable includes free credit which is NOT usable for excluded platforms (e.g. X).
                    // Live publishing checks ONLY balance.available for the paid portion.
                }
                : {}),
        };
    }
    /** Whether a quote can actually be published with current wallet state. */
    canPublish(customer, quote) {
        const { available } = this.options.ledger.balanceWithHold(customer.id);
        const { freeLimit, creditMode } = this.pricingConfig(customer);
        const freeRemaining = creditMode ? this.options.ledger.freeRemaining(customer.id, freeLimit) : 0;
        const paidRequired = quote.paidTotal;
        if (paidRequired > available) {
            return {
                eligible: false,
                reason: `Insufficient cash balance: need ${paidRequired} milliUSD paid, available ${available} milliUSD. Free credit (${freeRemaining} milliUSD) cannot cover excluded platforms (X). Top up cash wallet.`,
                paidRequired,
                available,
                freeRemaining,
            };
        }
        if (creditMode && quote.freeCreditApplied > freeRemaining) {
            return {
                eligible: false,
                reason: `Insufficient free credit: need ${quote.freeCreditApplied}, remaining ${freeRemaining}.`,
                paidRequired,
                available,
                freeRemaining,
            };
        }
        return { eligible: true, paidRequired, available, freeRemaining };
    }
    usage(customerId, limit = 20) {
        return this.options.ledger.entries(customerId, limit);
    }
    pricingConfig(customer) {
        const config = this.options.prices.list();
        const freeCredit = config.free_allowance_milli_usd;
        // X is excluded from free credit for normal customers (anti-abuse), but the
        // operator/owner's $10 starter credit is intended to be fully spendable
        // including X, so the visible $8.50 is genuinely usable. Product rule:
        // owner free credit covers all platforms.
        const baseExcluded = new Set(config.free_excluded_platforms ?? []);
        if (customer.owner)
            baseExcluded.delete("x");
        if (Number.isInteger(freeCredit) && freeCredit > 0) {
            return {
                freeLimit: effectiveFreeLimit(this.options.ledger, customer, freeCredit),
                creditMode: true,
                excluded: baseExcluded,
            };
        }
        return {
            freeLimit: config.free_allowance_units ?? config.free_allowance_posts ?? 0,
            creditMode: false,
            excluded: baseExcluded,
        };
    }
    /** Price a draft without reserving or charging. Used by relay_validate and the cost preview. */
    quote(customer, draft) {
        const priced = this.options.prices.quote(draft, draft.platforms ?? []);
        const { freeLimit, creditMode, excluded } = this.pricingConfig(customer);
        let freeRemaining = this.options.ledger.freeRemaining(customer.id, freeLimit);
        const lines = priced.quotes.map((entry) => {
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
    async reserve(customer, draft) {
        this.options.limiter?.check(customer.id, "posts", this.options.rateConfig?.postsPerHour ?? 60, 60 * 60 * 1000);
        const { freeLimit, creditMode, excluded } = this.pricingConfig(customer);
        const priced = this.options.prices.quote(draft, draft.platforms ?? []);
        let freeRemaining = this.options.ledger.freeRemaining(customer.id, freeLimit);
        const quotes = priced.quotes.map((entry) => {
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
        if (paidTotal === 0 && freeUnits === 0)
            return null;
        let reservation;
        try {
            reservation = this.options.ledger.reserve({
                customerId: customer.id,
                amount: paidTotal,
                freeUnits,
                freeLimit,
                freeJson: JSON.stringify(quotes),
                idempotencyKey: `post:${customer.id}:${randomUUID()}`,
                ttlMs: 24 * 60 * 60 * 1000,
            });
        }
        catch (error) {
            // Enrich the generic ledger error with free-credit context so the user
            // sees why $8.50 "total" is not spendable for X when they are not owner.
            if (error instanceof Error && error.code === "cloud_insufficient_balance") {
                const { available } = this.options.ledger.balanceWithHold(customer.id);
                const freeRemaining = creditMode ? this.options.ledger.freeRemaining(customer.id, freeLimit) : 0;
                const detail = customer.owner
                    ? ` (owner freeRemaining ${freeRemaining})`
                    : ` Free credit ${freeRemaining} cannot cover X (excluded).`;
                error.message = `Insufficient balance: need ${paidTotal} milliUSD ($${(paidTotal / 1000).toFixed(2)}) paid, available ${available} milliUSD ($${(available / 1000).toFixed(2)}).${detail} Cash top-up required for X.`;
            }
            throw error;
        }
        return { reservationId: reservation.id, customerId: customer.id, quotes };
    }
    async settle(hold, result) {
        if (!hold)
            return;
        if (result.scheduled && result.jobId) {
            this.options.ledger.bindJob(hold.reservationId, result.jobId);
            return;
        }
        const succeeded = new Set(result.results.filter((entry) => entry.ok).map((entry) => entry.platform));
        const actual = hold.quotes
            .filter((entry) => succeeded.has(entry.platform))
            .reduce((sum, entry) => sum + entry.paidAmount, 0);
        const freeUsed = hold.quotes
            .filter((entry) => succeeded.has(entry.platform))
            .reduce((sum, entry) => sum + entry.freeAmount, 0);
        this.options.ledger.commit(hold.reservationId, actual, result.results.find((entry) => entry.ok)?.postId, freeUsed);
    }
    async release(hold) {
        if (hold)
            this.options.ledger.release(hold.reservationId);
    }
    async cancel(customer, jobId) {
        const reservation = this.options.ledger.reservationForJob(customer.id, jobId);
        if (reservation)
            this.options.ledger.release(reservation.id);
    }
    /** Reconcile scheduled jobs after the cloud scheduler runs them. */
    async reconcile(customer, relay) {
        const jobs = await relay.listQueue();
        for (const job of jobs) {
            const reservation = this.options.ledger.reservationForJob(customer.id, job.id);
            if (!reservation)
                continue;
            if (job.status === "canceled") {
                this.options.ledger.release(reservation.id);
                continue;
            }
            if (job.status !== "done" && job.status !== "failed")
                continue;
            let quotes = [];
            try {
                quotes = reservation.freeJson
                    ? JSON.parse(reservation.freeJson).map(normalizeHold)
                    : [];
            }
            catch {
                quotes = [];
            }
            const succeeded = new Set((job.results ?? []).filter((entry) => entry.ok).map((entry) => entry.platform));
            const actual = quotes
                .filter((entry) => succeeded.has(entry.platform))
                .reduce((sum, entry) => sum + entry.paidAmount, 0);
            const freeUsed = quotes
                .filter((entry) => succeeded.has(entry.platform))
                .reduce((sum, entry) => sum + entry.freeAmount, 0);
            this.options.ledger.commit(reservation.id, actual, job.results?.find((entry) => entry.ok)?.postId, freeUsed);
        }
    }
}
//# sourceMappingURL=cloud-finance.js.map