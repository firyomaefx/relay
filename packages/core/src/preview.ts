/**
 * Draft previews: show how one draft will land on each selected platform.
 *
 * This is intentionally pure and side-effect free so the HTTP console, MCP
 * tools and tests share the same adaptation rules.
 */
import type {
  DraftPreview,
  PlatformId,
  PlatformLimits,
  PlatformPreview,
  PostDraft,
  ValidationReport,
} from "./types.js";
import { PLATFORM_IDS } from "./types.js";

/** Split text into parts, preferring word boundaries. */
function splitForLimit(text: string, limit: number): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [""];
  if (Array.from(normalized).length <= limit) return [normalized];

  const words = normalized.split(/(\s+)/).filter((token) => token.length > 0);
  const parts: string[] = [];
  let current = "";

  const pushCurrent = () => {
    const trimmed = current.trim();
    if (trimmed) parts.push(trimmed);
    current = "";
  };

  for (const token of words) {
    const tokenLength = Array.from(token).length;
    // Hard-split an overlong token (URL, hashtag, CJK run) before it can
    // overflow a part, even when it appears after a wrapped line.
    if (tokenLength > limit) {
      pushCurrent();
      let remaining = token;
      while (Array.from(remaining).length > limit) {
        parts.push(Array.from(remaining).slice(0, limit).join(""));
        remaining = Array.from(remaining).slice(limit).join("");
      }
      current = remaining;
      continue;
    }
    const candidate = current + token;
    if (Array.from(candidate).length <= limit) {
      current = candidate;
      continue;
    }
    pushCurrent();
    current = token.trimStart();
  }
  pushCurrent();
  return parts.length > 0 ? parts : [""];
}

function shorten(text: string, limit: number): string {
  const characters = Array.from(text.trim());
  if (characters.length <= limit) return text.trim();
  if (limit <= 1) return "…";
  return `${characters.slice(0, limit - 1).join("").trimEnd()}…`;
}

function sourceText(draft: PostDraft): { parts: string[]; sourcePartCount: number } {
  if (draft.thread && draft.thread.length > 0) {
    const parts = draft.thread.map((part) => part.text ?? "");
    return { parts, sourcePartCount: parts.length };
  }
  return { parts: [draft.text ?? ""], sourcePartCount: 1 };
}

function mediaCountFor(draft: PostDraft): number {
  const top = draft.media?.length ?? 0;
  const threaded = draft.thread?.reduce((total, part) => total + (part.media?.length ?? 0), 0) ?? 0;
  return top + threaded;
}

/**
 * Build previews for every selected platform (or all platforms when the draft
 * has no explicit selection). Validation issues are merged into each card.
 */
export function buildDraftPreview(
  draft: PostDraft,
  limits: readonly PlatformLimits[],
  report?: ValidationReport,
): DraftPreview {
  const source = sourceText(draft);
  const sourceBody = source.parts.join("\n\n").trim();
  const firstBody = (source.parts[0] ?? "").trim();
  const isThread = Boolean(draft.thread && draft.thread.length > 1);
  const platforms = (draft.platforms?.length ? draft.platforms : [...PLATFORM_IDS]) as PlatformId[];
  const previews: PlatformPreview[] = [];

  for (const platform of platforms) {
    const limit = limits.find((entry) => entry.platform === platform);
    if (!limit) continue;

    const validation = report?.perPlatform?.[platform];
    const issues = (validation?.issues ?? []).map((issue) => issue.message);
    const supportsThread = limit.maxParts > 1;
    // A non-threading platform can only publish the first part. Never join the
    // whole thread into a body the platform would not actually receive.
    const body = supportsThread ? sourceBody : firstBody;
    let parts: string[];
    let adapted = false;
    let truncated = false;

    if (isThread && supportsThread) {
      const expanded = source.parts.flatMap((part) => splitForLimit(part, limit.maxTextLength));
      parts = expanded.slice(0, limit.maxParts);
      adapted = expanded.length !== source.parts.length;
      truncated = expanded.length > limit.maxParts;
      if (truncated) issues.push(`Thread needs ${expanded.length} parts; ${limit.displayName} allows ${limit.maxParts}.`);
    } else if (supportsThread && Array.from(body).length > limit.maxTextLength) {
      const expanded = splitForLimit(body, limit.maxTextLength);
      parts = expanded.slice(0, limit.maxParts);
      adapted = true;
      truncated = expanded.length > limit.maxParts;
      if (truncated) issues.push(`Text needs ${expanded.length} parts; ${limit.displayName} allows ${limit.maxParts}.`);
    } else if (Array.from(body).length > limit.maxTextLength) {
      parts = [shorten(body, limit.maxTextLength)];
      adapted = true;
      truncated = true;
      issues.push(`Text is longer than ${limit.displayName}'s ${limit.maxTextLength}-character limit; it will be shortened.`);
    } else {
      parts = [body];
    }

    if (isThread && !supportsThread) {
      adapted = true;
      truncated = true;
      issues.push(`${limit.displayName} supports one part; only the first part can be published.`);
    }

    const characterCounts = parts.map((part) => Array.from(part).length);
    const fits = !truncated && parts.length <= limit.maxParts && characterCounts.every((count) => count <= limit.maxTextLength);

    previews.push({
      platform,
      displayName: limit.displayName,
      parts,
      characterCounts,
      maxTextLength: limit.maxTextLength,
      maxParts: limit.maxParts,
      mediaCount: mediaCountFor(draft),
      adapted,
      truncated,
      ok: Boolean(validation?.ok ?? true) && fits,
      issues: [...new Set(issues)],
    });
  }

  return {
    platforms: previews,
    sourcePartCount: source.sourcePartCount,
    generatedAt: new Date().toISOString(),
  };
}
