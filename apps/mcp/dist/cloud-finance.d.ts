import type { PostDraft, RelayService } from "@relay/core";
import { type CloudLedger, type PriceTable, type RateLimiter, type CloudRateConfig } from "@relay/cloud";
import type { CloudStore, Customer } from "@relay/cloud";
import type { ToolContext } from "./tools.js";
interface QuotePart {
    kind: string;
    amount: number;
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
/** Cloud-only finance hooks around the existing relay_post / relay_cancel tools. */
export declare class CloudFinance {
    private readonly options;
    constructor(options: {
        store: CloudStore;
        ledger: CloudLedger;
        prices: PriceTable;
        tenants: {
            get(customer: Customer): Promise<RelayService>;
            recordMappings(customer: Customer, relay: RelayService): Promise<void>;
        };
        limiter?: RateLimiter;
        rateConfig?: CloudRateConfig;
    });
    hooks(customer: Customer): Pick<ToolContext, "beforePost" | "afterPost" | "afterPostError" | "afterCancel" | "quotePost">;
    balance(customerId: string): {
        balance: number;
        held: number;
        available: number;
    };
    /** Whether a quote can actually be published with current wallet state. */
    canPublish(customer: Customer, quote: QuotePreview): {
        eligible: boolean;
        reason?: string;
        paidRequired: number;
        available: number;
        freeRemaining: number;
    };
    usage(customerId: string, limit?: number): import("@relay/cloud").LedgerEntry[];
    private pricingConfig;
    /** Price a draft without reserving or charging. Used by relay_validate and the cost preview. */
    quote(customer: Customer, draft: PostDraft): QuotePreview;
    private reserve;
    private settle;
    private release;
    private cancel;
    /** Reconcile scheduled jobs after the cloud scheduler runs them. */
    reconcile(customer: Customer, relay: RelayService): Promise<void>;
}
export {};
