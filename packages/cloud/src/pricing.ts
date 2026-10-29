import { readFileSync } from "node:fs";
import path from "node:path";
import { RelayError, type PlatformId, type PostDraft } from "@relay/core";

export interface CloudPrices {
  currency: string;
  unit: string;
  free_allowance_units?: number;
  free_allowance_posts?: number;
  free_excluded_platforms?: string[];
  prices: Record<string, Record<string, number>>;
}

export interface PriceQuote {
  platform: PlatformId;
  kind: string;
  amount: number;
}

function kindFor(draft: PostDraft): string {
  const media = (draft.thread?.flatMap((part) => part.media ?? []) ?? draft.media ?? []);
  if (media.some((item) => item.kind === "video")) return "video";
  if (media.filter((item) => item.kind === "image").length > 1) return "carousel";
  if (media.some((item) => item.kind === "image")) return "image";
  const text = draft.text ?? draft.thread?.map((part) => part.text).join(" ") ?? "";
  return /https?:\/\//i.test(text) ? "link" : "text";
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
    const kind = kindFor(draft);
    const quotes = platforms.map((platform) => {
      const platformPrices = this.config.prices[platform];
      const amount = platformPrices?.[kind] ?? platformPrices?.text;
      if (!Number.isInteger(amount) || amount < 0) {
        throw new RelayError(`No valid price for ${platform}/${kind}.`, "cloud_price_missing", undefined, 500);
      }
      return { platform, kind, amount };
    });
    return { quotes, total: quotes.reduce((sum, quote) => sum + quote.amount, 0), currency: this.config.currency, unit: this.config.unit };
  }
}

export function defaultPricePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.RELAY_CLOUD_PRICES?.trim() || "config/cloud-prices.json");
}
