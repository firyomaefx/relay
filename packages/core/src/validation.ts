import { inspectMedia } from "./media.js";
import { isPlatformId, PLATFORM_IDS } from "./types.js";
import type {
  MediaItem,
  PlatformAdapter,
  PlatformId,
  PostDraft,
  ResolvedPart,
  ResolvedPost,
  ValidationIssue,
  ValidationReport,
} from "./types.js";

export interface ValidateOptions {
  /** Resolves a public URL for locally stored media, when one is configured. */
  mediaPublicUrl?: (item: MediaItem) => string | null;
  /** Platforms that will make real API calls. Simulated platforms skip network-only rules. */
  isLive?: (platform: PlatformId) => boolean;
  /** Refuses posts that contain blocked links (for example affiliate shop links) while active. */
  linkGuard?: LinkGuard;
  /** Clock for time-limited rules (epoch ms); defaults to Date.now. */
  now?: () => number;
}

/**
 * Link guard read from the environment:
 *   RELAY_BLOCKED_LINKS            comma-separated, case-insensitive fragments, e.g. "s.shopee.com.my,shope.ee"
 *   RELAY_BLOCKED_LINKS_UNTIL      optional ISO-8601 end; the guard is off from that instant on
 *   RELAY_BLOCKED_LINKS_PLATFORMS  optional comma list (x, threads, tiktok, youtube, instagram); empty = all
 */
export interface LinkGuard {
  patterns: string[];
  /** Epoch ms after which the guard stops applying; null = no end date. */
  until: number | null;
  /** Platforms the guard covers; an empty list covers every platform. */
  platforms: PlatformId[];
}

function splitList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function parseLinkGuard(env: Record<string, string | undefined>): LinkGuard | undefined {
  const patterns = splitList(env.RELAY_BLOCKED_LINKS);
  if (patterns.length === 0) return undefined;
  const untilRaw = env.RELAY_BLOCKED_LINKS_UNTIL?.trim();
  const untilMs = untilRaw ? Date.parse(untilRaw) : Number.NaN;
  const platforms = splitList(env.RELAY_BLOCKED_LINKS_PLATFORMS).filter(isPlatformId) as PlatformId[];
  return { patterns, until: Number.isNaN(untilMs) ? null : untilMs, platforms };
}

/** Returns the first blocked fragment found in the text, or null. */
export function findBlockedLink(text: string, guard: LinkGuard | undefined, platform: PlatformId, nowMs: number): string | null {
  if (!guard || guard.patterns.length === 0 || !text) return null;
  if (guard.until !== null && nowMs >= guard.until) return null;
  if (guard.platforms.length > 0 && !guard.platforms.includes(platform)) return null;
  const lower = text.toLowerCase();
  return guard.patterns.find((pattern) => lower.includes(pattern)) ?? null;
}

interface PlatformIssues {
  ok: boolean;
  issues: ValidationIssue[];
}

function emptyPerPlatform(): Record<PlatformId, PlatformIssues> {
  return {
    x: { ok: true, issues: [] },
    threads: { ok: true, issues: [] },
    tiktok: { ok: true, issues: [] },
    youtube: { ok: true, issues: [] },
    instagram: { ok: true, issues: [] },
    linkedin: { ok: true, issues: [] },
  };
}

export function normalizeFor(platform: PlatformId, draft: PostDraft): ResolvedPost {
  const thread = Array.isArray(draft.thread) && draft.thread.length > 0 ? draft.thread : null;
  const parts: ResolvedPart[] = thread
    ? thread.map((part) => ({ text: (part.text ?? "").trim(), media: part.media ?? [] }))
    : [{ text: (draft.text ?? "").trim(), media: draft.media ?? [] }];
  const options = { ...(draft.options?.[platform] ?? {}) };
  const topReplyTo = (draft.replyToId ?? draft.parentPostId)?.toString().trim();
  if ((platform === "threads" || platform === "x") && topReplyTo && !options.replyToId) options.replyToId = topReplyTo;
  const accountId = draft.accountIds?.[platform];
  return { platform, ...(accountId ? { accountId } : {}), parts, options };
}

function textLength(value: string): number {
  return Array.from(value).length;
}

/**
 * Validates a draft against every target platform before anything is published,
 * so a post either goes out everywhere or fails loudly with actionable messages.
 */
export async function validateDraft(
  draft: PostDraft,
  adapters: Map<PlatformId, PlatformAdapter>,
  options: ValidateOptions = {},
): Promise<ValidationReport> {
  const perPlatform = emptyPerPlatform();
  const issues: ValidationIssue[] = [];

  const addIssue = (issue: ValidationIssue): void => {
    issues.push(issue);
    if (issue.platform) {
      const bucket = perPlatform[issue.platform];
      bucket.issues.push(issue);
      bucket.ok = false;
    }
  };

  if (!draft || typeof draft !== "object") {
    addIssue({ code: "draft_invalid", message: "A post draft is required" });
    return finalize(issues, perPlatform, undefined);
  }

  const rawPlatforms = Array.isArray(draft.platforms) ? draft.platforms : [];
  if (rawPlatforms.length === 0) {
    addIssue({ code: "platforms_required", message: "Choose at least one platform (x, threads, tiktok, youtube, instagram)" });
  }
  for (const platform of rawPlatforms) {
    if (!isPlatformId(platform)) {
      addIssue({ code: "platform_unknown", message: `Unknown platform: ${String(platform)}` });
    }
  }
  const targets = [...new Set(rawPlatforms.filter(isPlatformId))];

  if (draft.scheduleAt !== undefined) {
    if (typeof draft.scheduleAt !== "string" || Number.isNaN(Date.parse(draft.scheduleAt))) {
      addIssue({ code: "schedule_invalid", message: "scheduleAt must be an ISO-8601 timestamp" });
    }
  }

  if (draft.label !== undefined) {
    if (typeof draft.label !== "string" || textLength(draft.label.trim()) > 40) {
      addIssue({ code: "label_invalid", message: "label must be a string of at most 40 characters (it is shown in the queue, never published)" });
    }
  }

  const hasThread = Array.isArray(draft.thread) && draft.thread.length > 0;
  if (Array.isArray(draft.thread) && draft.thread.length === 0) {
    addIssue({ code: "thread_empty", message: "The thread has no parts" });
  }
  const hasFlatContent = Boolean(draft.text?.trim()) || Boolean(draft.media?.length);
  if (!hasThread && !hasFlatContent) {
    addIssue({ code: "content_required", message: "Provide text, media or thread parts" });
  }
  if (hasThread && hasFlatContent) {
    addIssue({
      code: "content_ambiguous",
      message: "Provide either a thread or a single text/media post, not both",
    });
  }

  const normalized: Partial<Record<PlatformId, ResolvedPost>> = {};

  // Draft-level replyToId / parentPostId is a shorthand for a single X or Threads target.
  const topReplyTo = (draft.replyToId ?? draft.parentPostId)?.toString().trim();
  if (topReplyTo) {
    const unsupported = targets.filter((p) => p !== "x" && p !== "threads");
    if (unsupported.length > 0) {
      addIssue({
        code: "option_unsupported",
        message: `replyToId only works on X and Threads, not ${unsupported.join(", ")}. Remove those platforms from this draft.`,
      });
    }
    if (targets.includes("x") && targets.includes("threads")) {
      for (const p of ["x", "threads"] as const) {
        if (!draft.options?.[p]?.replyToId) {
          addIssue({
            platform: p,
            code: "option_invalid",
            message: `replyToId is ambiguous for a draft that targets both X and Threads (their post ids differ). Set options.x.replyToId and options.threads.replyToId instead.`,
          });
        }
      }
    }
  }

  for (const platform of targets) {
    const adapter = adapters.get(platform);
    if (!adapter) {
      addIssue({ platform, code: "platform_unavailable", message: `${platform} is not available in this build` });
      continue;
    }
    const limits = adapter.limits;
    const post = normalizeFor(platform, draft);
    normalized[platform] = post;
    const platformOptions = post.options;

    if (post.parts.length > limits.maxParts) {
      addIssue({
        platform,
        code: "too_many_parts",
        message: `${limits.displayName} allows ${limits.maxParts} part(s); this draft has ${post.parts.length}`,
      });
    }

    let totalMedia = 0;

    for (let index = 0; index < post.parts.length; index += 1) {
      const part = post.parts[index]!;
      const length = textLength(part.text);
      if (length > limits.maxTextLength) {
        addIssue({
          platform,
          part: index,
          code: "text_too_long",
          message: `Part ${index + 1} is ${length} characters; ${limits.displayName} allows ${limits.maxTextLength}`,
        });
      }
      if (!part.text && part.media.length === 0) {
        addIssue({ platform, part: index, code: "part_empty", message: `Part ${index + 1} is empty` });
      }
      const blocked = findBlockedLink(part.text, options.linkGuard, platform, options.now?.() ?? Date.now());
      if (blocked) {
        const until = options.linkGuard?.until ? ` until ${new Date(options.linkGuard.until).toISOString()}` : "";
        addIssue({
          platform,
          part: index,
          code: "link_blocked",
          message: `Part ${index + 1} contains a blocked link (${blocked}). These links are switched off${until} (RELAY_BLOCKED_LINKS).`,
        });
      }
      if (part.media.length > limits.maxMediaPerPost) {
        addIssue({
          platform,
          part: index,
          code: "too_many_media",
          message: `Part ${index + 1} has ${part.media.length} media item(s); ${limits.displayName} allows ${limits.maxMediaPerPost}`,
        });
      }
      const videos = part.media.filter((item) => item.kind === "video").length;
      if (videos > limits.maxVideosPerPost) {
        addIssue({
          platform,
          part: index,
          code: "too_many_videos",
          message: `${limits.displayName} allows ${limits.maxVideosPerPost} video(s) per post`,
        });
      }
      if (videos > 0 && part.media.length > limits.maxMediaWithVideo) {
        addIssue({
          platform,
          part: index,
          code: "video_cannot_mix",
          message: `${limits.displayName} cannot mix a video with other media in the same post`,
        });
      }
      totalMedia += part.media.length;

      for (const media of part.media) {
        const inspection = await inspectMedia(media);
        if (!inspection.ok) {
          addIssue({ platform, part: index, code: "media_unreadable", message: inspection.error ?? "Media is not usable" });
          continue;
        }
        if (inspection.kind && inspection.kind !== media.kind) {
          addIssue({
            platform,
            part: index,
            code: "media_kind_mismatch",
            message: `${inspection.src} looks like a ${inspection.kind}, but it was marked as ${media.kind}`,
          });
          continue;
        }
        if (inspection.mimeType) {
          const allowed = media.kind === "video" ? limits.allowedVideoTypes : limits.allowedImageTypes;
          if (allowed.length > 0 && !allowed.includes(inspection.mimeType)) {
            addIssue({
              platform,
              part: index,
              code: "media_type_unsupported",
              message: `${inspection.mimeType} is not supported for ${media.kind} on ${limits.displayName}`,
            });
          }
        }
        if (inspection.size > 0) {
          const limit = media.kind === "video" ? limits.maxVideoBytes : limits.maxImageBytes;
          if (inspection.size > limit) {
            addIssue({
              platform,
              part: index,
              code: "media_too_large",
              message: `${inspection.src} is ${Math.round(inspection.size / 1024)} KB; the limit is ${Math.round(limit / 1024)} KB`,
            });
          }
        }
        if (limits.mediaUpload !== "direct" && (options.isLive?.(platform) ?? true)) {
          const needsPublicUrl =
            limits.mediaUpload === "url" || (limits.mediaUpload === "mixed" && media.kind === "image");
          if (needsPublicUrl && !media.url && !options.mediaPublicUrl?.(media)) {
            addIssue({
              platform,
              part: index,
              code: "media_public_url_required",
              message:
                `${limits.displayName} fetches media from a public URL. ` +
                `Set RELAY_PUBLIC_MEDIA_BASE_URL (a tunnel to this console) or pass media with a "url".`,
            });
          }
        }
      }
    }

    if (limits.requiresMedia && totalMedia === 0 && platform !== "youtube") {
      addIssue({
        platform,
        code: "media_required",
        message: `${limits.displayName} needs at least one image or video`,
      });
    }

    if (platform === "youtube") {
      const allMedia = post.parts.flatMap((entry) => entry.media);
      const videos = allMedia.filter((item) => item.kind === "video").length;
      const images = allMedia.filter((item) => item.kind === "image").length;
      if (videos === 0) {
        addIssue({
          platform,
          code: "youtube_video_required",
          message: "YouTube needs exactly one video; text-only and image-only posts are not supported",
        });
      }
      if (images > 0) {
        addIssue({ platform, code: "youtube_images_unsupported", message: "YouTube accepts videos only (no images)" });
      }
      if (platformOptions.youtubeTitle && textLength(platformOptions.youtubeTitle.trim()) > 100) {
        addIssue({
          platform,
          code: "youtube_title_too_long",
          message: `YouTube titles are limited to 100 characters (received ${textLength(platformOptions.youtubeTitle.trim())})`,
        });
      }
      if (platformOptions.youtubeTags && platformOptions.youtubeTags.length > 15) {
        addIssue({ platform, code: "youtube_too_many_tags", message: "YouTube accepts at most 15 tags" });
      }
      if (
        platformOptions.youtubePrivacy &&
        !["public", "unlisted", "private"].includes(platformOptions.youtubePrivacy)
      ) {
        addIssue({ platform, code: "option_invalid", message: `Unsupported YouTube privacy: ${platformOptions.youtubePrivacy}` });
      }
      if (platformOptions.youtubeCategoryId && !/^\d+$/.test(platformOptions.youtubeCategoryId)) {
        addIssue({ platform, code: "option_invalid", message: "YouTube category id must be numeric" });
      }
    }

    if (platform === "tiktok" && platformOptions.tiktokPrivacy) {
      const allowed = ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"];
      if (!allowed.includes(platformOptions.tiktokPrivacy)) {
        addIssue({ platform, code: "option_invalid", message: `Unsupported TikTok privacy: ${platformOptions.tiktokPrivacy}` });
      }
    }
    if (platform === "threads" && platformOptions.replyToId && !/^\d+$/.test(String(platformOptions.replyToId).trim())) {
      addIssue({ platform, code: "option_invalid", message: "Threads replyToId must be a numeric published post id" });
    }
    if (platform === "x" && platformOptions.replyToId) {
      const xReplyTo = String(platformOptions.replyToId).trim();
      if (!/^\d{1,25}$/.test(xReplyTo)) {
        addIssue({ platform, code: "option_invalid", message: "X replyToId must be a numeric X post id (digits only, e.g. 1234567890123456789)" });
      }
      if (platformOptions.quotePostId) {
        addIssue({ platform, code: "option_invalid", message: "X: use either replyToId or quotePostId, not both" });
      }
    }
    if (platform !== "threads" && platform !== "x" && platformOptions.replyToId) {
      addIssue({ platform, code: "option_unsupported", message: "replyToId is only supported on X and Threads" });
    }
    if (platform !== "x" && platformOptions.quotePostId) {
      addIssue({ platform, code: "option_unsupported", message: "quotePostId is only supported on X" });
    }
  }

  return finalize(issues, perPlatform, targets.length > 0 ? normalized : undefined);
}

function finalize(
  issues: ValidationIssue[],
  perPlatform: Record<PlatformId, PlatformIssues>,
  normalized: Partial<Record<PlatformId, ResolvedPost>> | undefined,
): ValidationReport {
  for (const platform of PLATFORM_IDS) {
    perPlatform[platform].ok = perPlatform[platform].issues.length === 0;
  }
  return {
    ok: issues.length === 0,
    issues,
    perPlatform,
    normalized,
  };
}

