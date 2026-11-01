import { readFileSync } from "node:fs";
import path from "node:path";
import { RelayError, type PlatformId, type PostDraft, type ThreadPartDraft } from "@relay/core";

export interface CloudPrices {
  currency: string;
  unit: string;
  /** Free starter credit in milliUSD (500 = $0.50). Prefer this over legacy post units. */
  free_allowance_milli_usd?: number;
  free_allowance_units?: number;
  free_allowance_posts?: number;
  free_excluded_platforms?: string[];
  prices: Record<string, Record<string, number>>;
}

export interface PriceBreakdownPart {
  kind: string;
  amount: number;
}

export interface PriceQuote {
  platform: PlatformId;
  kind: string;
  /** Total price for every part published on this platform. */
  amount: number;
  /** Number of billable post parts on this platform. */
  parts: number;
  breakdown: PriceBreakdownPart[];
}

function kindForPart(part: ThreadPartDraft): string {
  const media = part.media ?? [];
  if (media.some((item) => item.kind === "video")) return "video";
  if (media.filter((item) => item.kind === "image").length > 1) return "carousel";
  if (media.some((item) => item.kind === "image")) return "image";
  return /https?:\/\//i.test(part.text ?? "") ? "link" : "text";
}

function partsFor(draft: PostDraft): ThreadPartDraft[] {
  if (draft.thread?.length) return draft.thread;
  return [{ text: draft.text ?? "", ...(draft.media?.length ? { media: draft.media } : {}) }];
}

export class PriceTable {
  private constructor(private readonly config: CloudPrices) {}

  static load(filePath: string): PriceTable {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, "utf8"));
    } catch (error) {
      throw new RelayError(`Unable to read price config at ${filePath}: ${error instanceof Error ? error.message : String(error)}`, "cloud_prices_unreadable", undefined, 500);
    }
    if (!parsed || typeof parsed !== "object" || !("prices" in parsed)) {
      throw new RelayError("Price config must contain a prices object.", "cloud_prices_invalid", undefined, 500);
    }
    return new PriceTable(parsed as CloudPrices);
  }

  list(): CloudPrices {
    return this.config;
  }

  quote(draft: PostDraft, platforms: PlatformId[]): { quotes: PriceQuote[]; total: number; currency: string; unit: string } {
    const parts = partsFor(draft);
    const quotes = platforms.map((platform) => {
      const platformPrices = this.config.prices[platform];
      if (!platformPrices) {
        throw new RelayError(`No price configuration for ${platform}.`, "cloud_price_missing", undefined, 500);
      }
      const breakdown = parts.map((part) => {
        const kind = kindForPart(part);
        const amount = platformPrices[kind] ?? platformPrices.text;
        if (!Number.isInteger(amount) || amount < 0) {
          throw new RelayError(`No valid price for ${platform}/${kind}.`, "cloud_price_missing", undefined, 500);
        }
        return { kind, amount };
      });
      const amount = breakdown.reduce((sum, entry) => sum + entry.amount, 0);
      return { platform, kind: breakdown[0]?.kind ?? "text", amount, parts: breakdown.length, breakdown };
    });
    return { quotes, total: quotes.reduce((sum, quote) => sum + quote.amount, 0), currency: this.config.currency, unit: this.config.unit };
  }
}

export function defaultPricePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.RELAY_CLOUD_PRICES?.trim() || "config/cloud-prices.json");
}

