/**
 * Relay MCP tools.
 *
 * Each tool is a thin, well-described wrapper over RelayService. Handlers never
 * throw: every failure becomes an `isError` tool result with a readable message
 * and an actionable next step. Results are `human summary + "\n\n" + JSON`.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { errorMessage, isPlatformId, PLATFORM_IDS, RelayError } from "@relay/core";
import type {
  ArticleDraft,
  PlatformId,
  PostDraft,
  QueueJob,
  QueueStatus,
  RelayService,
  ValidationReport,
} from "@relay/core";
import {
  CREDENTIAL_ENV_HINTS,
  errorResult,
  formatIssues,
  formatLimits,
  formatPostRecord,
  formatQueueJob,
  formatResults,
  formatStatus,
  nextStep,
  platformLabel,
  postPreview,
  textResult,
} from "./format.js";
import { openInBrowser } from "./open.js";

const DEFAULT_HISTORY_LIMIT = 50;

const platformEnum = z.enum(["x", "threads", "tiktok", "youtube", "instagram", "linkedin"]);

const mediaSchema = z.object({
  path: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Local file path the MCP server can read. Relative paths resolve against the server's working directory, so absolute paths are safest.",
    ),
  url: z
    .string()
    .min(1)
    .optional()
    .describe("Publicly reachable media URL. Required for live posts on platforms that fetch media (Threads, Instagram, TikTok photos)."),
  kind: z.enum(["image", "video"]).describe("Media kind: image or video."),
  altText: z.string().optional().describe("Accessibility description for the media."),
});

const threadPartSchema = z.object({
  text: z.string().describe("Text of this thread part."),
  media: z.array(mediaSchema).optional().describe("Media attached to this part."),
});

const platformOptionsSchema = z.object({
  replySetting: z.enum(["everyone", "followers", "mentioned"]).optional().describe("Who may reply to the post."),
  selfOnly: z.boolean().optional().describe("TikTok: keep the post private (useful for unaudited apps)."),
  tiktokPrivacy: z
    .enum(["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"])
    .optional()
    .describe("TikTok privacy level."),
  tiktokAutoAddMusic: z
    .boolean()
    .optional()
    .describe(
      "TikTok photo posts: let TikTok add recommended background music (default true). TikTok's API cannot pick a specific song.",
    ),
  disableComment: z.boolean().optional().describe("Disable comments on the post."),
  tiktokMode: z
    .enum(["direct", "draft"])
    .optional()
    .describe(
      "TikTok publishing path: direct posts to the profile (needs an audited app for public posts); draft uploads the video to the TikTok inbox for review/editing (works while unaudited).",
    ),
  quotePostId: z.string().optional().describe("X only: quote an existing post by its id."),
  replyToId: z
    .string()
    .optional()
    .describe("X and Threads: publish as a reply under this existing PUBLISHED post id (numeric; part 1 replies to it, thread parts chain after). Set it per platform in options.x / options.threads."),
  youtubePrivacy: z.enum(["public", "unlisted", "private"]).optional().describe("YouTube video visibility (default public)."),
  youtubeTitle: z.string().optional().describe("YouTube video title (max 100 chars; defaults to the first line of text)."),
  youtubeDescription: z.string().optional().describe("YouTube: text prepended to the post text in the description."),
  youtubeTags: z.array(z.string()).optional().describe("YouTube: up to 15 tags."),
  youtubeCategoryId: z.string().optional().describe("YouTube numeric category id (default 27 = Education)."),
  youtubeMadeForKids: z.boolean().optional().describe("YouTube COPPA declaration (default false)."),
  instagramShareToFeed: z
    .boolean()
    .optional()
    .describe("Instagram Reels: also share to the main feed (default true). Images are always feed posts."),
  instagramAltText: z.string().optional().describe("Instagram image posts: alt text (max 1000 chars)."),
});

const postInputSchema = z.object({
  platforms: z
    .array(z.string())
    .describe('Target platforms: one or more of "x", "threads", "tiktok", "youtube", "instagram".'),
  account_ids: z
    .record(platformEnum, z.string())
    .optional()
    .describe("Optional account id per platform. Omit to use the primary account for that platform."),
  text: z.string().optional().describe("Post text for a single-part post."),
  media: z.array(mediaSchema).optional().describe("Media for a single-part post."),
  thread: z
    .array(threadPartSchema)
    .optional()
    .describe("Multi-part post (X thread, Threads chain). Use this instead of text/media for single parts."),
  replyToId: z
    .string()
    .optional()
    .describe(
      'Reply to an existing PUBLISHED post. Works on X (numeric X post id; the post, or the first part of a thread, is sent as a reply to it) and on Threads (numeric Threads post id). Use it when the draft targets only one of them; for a draft with both, set options.x.replyToId and options.threads.replyToId. Other platforms are rejected. Cannot be combined with quotePostId. Works with schedule_at.',
    ),
  schedule_at: z
    .string()
    .optional()
    .describe("ISO-8601 timestamp. If it is in the future the post is queued for the scheduler; otherwise it is published immediately."),
  label: z
    .string()
    .max(40)
    .optional()
    .describe('Who planned this post, shown in front of it in the Relay queue and calendar, e.g. "Claude" or "Grokbot". Never published.'),
  recurrence: z
    .object({
      interval: z.enum(["daily", "weekly"]).describe("Repeat interval."),
      count: z.number().int().min(2).max(104).optional().describe("Total publishes including the first (2-104). Omit for an open-ended series."),
      until: z.string().optional().describe("ISO-8601 end time; no occurrence is queued after it."),
    })
    .optional()
    .describe("Turn a future scheduled post into an evergreen/recurring series. Requires schedule_at."),
  options: z
    .record(platformEnum, platformOptionsSchema)
    .optional()
    .describe('Per-platform options keyed by platform, e.g. {"x":{"quotePostId":"123"}}, {"x":{"replyToId":"123"}} or {"tiktok":{"selfOnly":true}}.'),
  force: z
    .boolean()
    .optional()
    .describe(
      "Publish even if identical content was already posted to the same platform in the last 30 minutes. Use only when the earlier post is known to be unwanted or lost.",
    ),
});

const connectInputSchema = z.object({
  platform: platformEnum.describe('Platform to connect: "x", "threads", "tiktok", "youtube", "instagram" or "linkedin".'),
  account_id: z.string().min(1).optional().describe("Optional account id from a claimed cloud slot. Omit for a normal new account."),
  label: z.string().min(1).max(60).optional().describe("Optional visible label, e.g. Agency X."),
});

const disconnectInputSchema = z.object({
  platform: platformEnum.describe('Platform to disconnect: "x", "threads", "tiktok", "youtube", "instagram" or "linkedin".'),
  account_id: z.string().min(1).optional().describe("Optional account id; omit to disconnect all accounts on the platform."),
});

const cancelInputSchema = z.object({
  job_id: z.string().min(1).describe('Queued job id, as returned by relay_post or relay_queue (for example "job_...").'),
});

const historyInputSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe(`How many recent posts to return (1-200, default ${DEFAULT_HISTORY_LIMIT}).`),
});

const threadsCommentsInputSchema = z.object({
  limit_posts: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("How many recent Threads posts to inspect for comments (1-50, default 10)."),
});

const threadsReplyInputSchema = z.object({
  comment_id: z
    .string()
    .min(1)
    .describe("Id of the Threads comment to reply to, as returned by relay_threads_comments."),
  text: z.string().min(1).max(500).describe("Reply text (1-500 characters)."),
});

const commentsNewInputSchema = z.object({
  platform: z
    .enum(["threads", "instagram", "youtube", "all"])
    .optional()
    .describe('Which platform to check: "threads", "instagram", "youtube" or "all" (default all).'),
  since_hours: z
    .number()
    .int()
    .min(1)
    .max(168)
    .optional()
    .describe("Only posts and comments from the last N hours (1-168, default 48)."),
  limit: z.number().int().min(1).max(100).optional().describe("Max comments to return (1-100, default 20)."),
  mark_seen: z
    .boolean()
    .optional()
    .describe("Record the returned comments as seen so they are never returned again (default true). Use false for a read-only peek."),
});

const replyInputSchema = z.object({
  platform: z.enum(["threads", "instagram", "youtube"]).describe('Platform of the comment: "threads", "instagram" or "youtube".'),
  comment_id: z.string().min(1).describe("Id of the comment to reply to, as returned by relay_comments_new."),
  text: z
    .string()
    .min(1)
    .max(10000)
    .describe("Reply text. Limits: Threads 500, Instagram 2200, YouTube 10000 characters."),
  post_id: z.string().optional().describe("Optional id of the post the comment belongs to (kept in the reply log)."),
  dry_run: z.boolean().optional().describe("true = check everything but send nothing and record nothing."),
});

const articleInputSchema = z.object({
  title: z.string().describe("Article title (1-100 characters)."),
  body: z
    .array(
      z.object({
        heading: z.string().optional().describe("Section heading (optional)."),
        paragraphs: z.array(z.string()).optional().describe("Paragraphs of this section, in order."),
        image: z
          .object({
            path: z.string().min(1).describe("Local image file path (JPEG, PNG or WebP, max 5 MB). Absolute paths are safest."),
            altText: z.string().optional().describe("Alt text kept in Relay. The X Article format has no alt field, so it is not shown on X."),
            caption: z.string().optional().describe("Caption shown under the image on X (optional)."),
          })
          .optional()
          .describe("Inline image placed after this section's heading and paragraphs. To put an image between two paragraphs, give it its own item: {image:{path}}."),
      }),
    )
    .optional()
    .describe("Article body as sections, in order. Each item has an optional heading, optional paragraphs and an optional inline image, for example [{paragraphs:[...]}, {image:{path:\"<file path>\"}}, {paragraphs:[...]}]. Up to 10 images. Use this or body_markdown."),
  body_markdown: z
    .string()
    .optional()
    .describe("Article body as simple Markdown: #, ## or ### headings, > quote, - bullets, 1. numbered items, blank line between paragraphs, and an inline image on its own line as ![alt](<file path>) or ![alt](<file path> \"caption\"). Use this or body."),
  cover: z
    .object({
      path: z.string().min(1).describe("Local image file path (JPEG, PNG or WebP, max 5 MB). Absolute paths are safest."),
      altText: z.string().optional().describe("Accessibility description of the cover."),
    })
    .optional()
    .describe("Optional cover image."),
  schedule_at: z
    .string()
    .optional()
    .describe("ISO-8601 timestamp, for example 2026-10-27T09:00:00+08:00. If it is in the future the article is queued; otherwise it is published now."),
});

const deleteInputSchema = z.object({
  job_id: z.string().optional().describe("Queued job id (from relay_queue). Removes it from the Relay queue."),
  platform: platformEnum.optional().describe("Platform of a published post. Use with post_id."),
  post_id: z.string().optional().describe("Published post id on that platform (from relay_history)."),
  record_id: z.string().optional().describe("History record id (from relay_history). Deletes every published part of it."),
  confirm: z
    .boolean()
    .optional()
    .describe("Must be true to really delete a published post. Without it you only get a preview."),
});

export interface ToolContext {
  relay: RelayService;
  /** Absolute path of the built server entry, used to render client config snippets. */
  entryPath?: string;
  /** Cloud-only hooks. Existing owner contexts omit them. */
  beforePost?: (draft: PostDraft) => Promise<unknown>;
  afterPost?: (hold: unknown, result: Awaited<ReturnType<RelayService["createPost"]>>) => Promise<void>;
  afterPostError?: (hold: unknown) => Promise<void>;
  afterCancel?: (jobId: string) => Promise<void>;
  /** Cloud-only: price a draft without reserving or publishing. */
  quotePost?: (draft: PostDraft) => unknown;
  /** Cloud-only: enforce account tier/limit before OAuth. */
  beforeConnect?: (platform: PlatformId, options: { accountId?: string; label?: string }) => Promise<{ accountId?: string } | void>;
}

function safeQuote(context: ToolContext, draft: PostDraft): unknown {
  try {
    return context.quotePost?.(draft) ?? null;
  } catch {
    // An invalid draft may have no valid price for a platform; validation reports that first.
    return null;
  }
}

function formatQuote(value: unknown): string {
  const quote = value as {
    unit?: string;
    total?: number;
    freeCreditApplied?: number;
    paidTotal?: number;
    lines?: Array<{ platform?: string; amount?: number; paidAmount?: number; parts?: number }>;
  } | null;
  if (!quote || !Array.isArray(quote.lines) || quote.lines.length === 0) return "";
  const money = (amount: number): string =>
    quote.unit === "milliUSD" ? `$${(amount / 1000).toFixed(3)}` : `${amount} ${quote.unit ?? "units"}`;
  const lines = quote.lines.map((line) => {
    const label = line.platform ? platformLabel(line.platform as never) : "platform";
    return `- ${label}: ${line.parts ?? 1} part(s), ${money(Number(line.amount ?? 0))} (${money(Number(line.paidAmount ?? 0))} paid)`;
  });
  return [
    `Estimated cost: ${money(Number(quote.total ?? 0))} total · ${money(Number(quote.freeCreditApplied ?? 0))} free credit · ${money(Number(quote.paidTotal ?? 0))} paid.`,
    ...lines,
  ].join("\n");
}

function toArticleDraft(input: z.infer<typeof articleInputSchema>): ArticleDraft {
  return {
    title: input.title,
    ...(input.body ? { body: input.body } : {}),
    ...(input.body_markdown !== undefined ? { bodyMarkdown: input.body_markdown } : {}),
    ...(input.cover ? { cover: { kind: "image" as const, path: input.cover.path, ...(input.cover.altText ? { altText: input.cover.altText } : {}) } } : {}),
    ...(input.schedule_at ? { scheduleAt: input.schedule_at } : {}),
  };
}

function toDraft(input: z.infer<typeof postInputSchema>): PostDraft {
  return {
    // Unknown platform names are rejected by platformArgsProblem() before publishing.
    platforms: input.platforms as PlatformId[],
    ...(input.account_ids ? { accountIds: input.account_ids as PostDraft["accountIds"] } : {}),
    text: input.text,
    media: input.media,
    thread: input.thread,
    scheduleAt: input.schedule_at,
    ...(input.recurrence ? { recurrence: input.recurrence } : {}),
    options: input.options,
    ...(input.replyToId?.trim() ? { replyToId: input.replyToId.trim() } : {}),
    ...(input.label?.trim() ? { label: input.label.trim() } : {}),
  };
}

/**
 * Validates platform names inside the handler (instead of relying on the schema)
 * so unknown or empty platform lists produce a readable `isError` tool result
 * rather than a protocol-level InvalidParams error.
 */
function platformArgsProblem(platforms: string[]): CallToolResult | null {
  if (platforms.length === 0) {
    return errorResult(
      "Choose at least one platform.",
      'Pass one or more of "x", "threads", "tiktok" in the platforms array.',
      { validPlatforms: PLATFORM_IDS },
    );
  }
  const unknown = platforms.filter((platform) => !isPlatformId(platform));
  if (unknown.length > 0) {
    return errorResult(
      `Unknown platform(s): ${unknown.join(", ")}.`,
      'Valid platforms are "x", "threads" and "tiktok".',
      { unknown, validPlatforms: PLATFORM_IDS },
    );
  }
  return null;
}

const HINTS = {
  service:
    "The Relay service could not complete this request. Check the MCP server's stderr logs for details, and confirm the data directory is writable.",
  connect:
    "For live sign-in, the Relay console must be running at the configured console URL (npm run web) so it can receive the OAuth callback. Start the MCP server with --mock or RELAY_MOCK=1 to link a simulated account instead.",
  disconnect: "Call relay_accounts to see the current account state.",
  post:
    "Call relay_accounts to check which platforms are connected, and relay_validate to iterate on the draft without publishing.",
  validate: "Fix the draft and call relay_validate again, or check relay_limits for per-platform requirements.",
  preview: "Adjust the draft and call relay_preview again; previews are read-only and never publish.",
  queue: "Call relay_queue to inspect jobs and their ids.",
  cancel: 'Only jobs with status "pending" can be canceled.',
  history: "Publish a post with relay_post first, or call relay_queue for scheduled posts.",
  limits: "Check relay_accounts for connection state and relay_console for configuration.",
  console: "Call relay_accounts for per-platform readiness, or relay_connect to link an account.",
  article:
    "Call relay_article_validate to check the article without publishing, and relay_accounts to confirm X is connected with tweet.write.",
  articleValidate: "Fix the article and call relay_article_validate again.",
  delete:
    "Call relay_queue for job ids and relay_history for record ids and post ids. Published deletes need confirm: true.",
  commentsNew:
    "Call relay_accounts to see which platforms are connected and whether any need a reconnect for comments.",
  commentsReply:
    "Call relay_comments_new to get comment ids. A comment can only be replied to once. If the error says needs reconnect for comments, reconnect that platform with relay_connect.",
  reply:
    "Call relay_threads_comments to find a comment id, confirm Threads is connected with the threads_manage_replies scope, then call relay_threads_reply. Nothing is posted unless this tool is called explicitly.",
} as const;

export function registerTools(server: McpServer, context: ToolContext): void {
  const { relay } = context;

  /** Wraps a tool body: no handler may throw out of the MCP server. */
  async function safely(work: () => Promise<CallToolResult>, hint: string): Promise<CallToolResult> {
    try {
      return await work();
    } catch (error) {
      const message = errorMessage(error);
      return errorResult(
        message,
        hint,
        error instanceof RelayError
          ? { error: message, code: error.code, details: error.details }
          : { error: message },
      );
    }
  }

  server.registerTool(
    "relay_accounts",
    {
      title: "List Relay accounts",
      description:
        "List connected social accounts and per-platform readiness for X, Threads, TikTok, YouTube, Instagram and LinkedIn. Shows whether credentials are configured, whether publishing is live or simulated, and the exact next step for each platform. Call this before posting.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      safely(async () => {
        const [accounts, platforms, comments] = await Promise.all([relay.accounts(), relay.platformStatuses(), relay.commentsStatus()]);
        const credentials = relay.credentialInfos();
        const liveCount = platforms.filter((platform) => platform.live).length;

        const lines: string[] = [
          `Relay accounts — ${accounts.length} connected, ${liveCount} platform(s) publishing live.`,
        ];
        if (relay.isMockForced) {
          lines.push("Mode: forced simulated (--mock / RELAY_MOCK=1); no real API calls will be made.");
        } else if (liveCount === 0) {
          lines.push("Mode: simulated; add platform credentials and restart for live publishing.");
        }
        if (accounts.length === 0) lines.push("No accounts are connected yet.");
        for (const account of accounts) {
          lines.push(
            `- ${platformLabel(account.platform)} · ${account.label || account.handle} · @${account.handle}` +
              `${account.primaryForPlatform ? " · primary" : ""} · ${account.mode} · id ${account.id}`,
          );
        }
        lines.push("");
        for (const platform of platforms) {
          lines.push(`- ${formatStatus(platform)}`);
          lines.push(`  next: ${nextStep(platform, relay.consoleUrl)}`);
        }
        const commentNotes = comments.filter((entry) => entry.status === "needs_reconnect");
        if (commentNotes.length > 0) {
          lines.push("");
          for (const entry of commentNotes) lines.push(`Comments: ${entry.message}`);
        }

        return textResult(lines.join("\n"), {
          mock: relay.isMockForced,
          consoleUrl: relay.consoleUrl,
          dataDir: relay.dataDir,
          accounts,
          platforms,
          credentials,
          comments,
        });
      }, HINTS.service),
  );

  server.registerTool(
    "relay_connect",
    {
      title: "Connect a platform account",
      description:
        "Sign in a social account. In simulated/mock mode the account is connected immediately with a demo handle. In live mode this returns a sign-in URL: open it in a browser, and the Relay console must be running at the console URL to receive the OAuth callback. Call relay_accounts afterwards to confirm.",
      inputSchema: connectInputSchema.shape,
    },
    async (args) =>
      safely(async () => {
        const gate = await context.beforeConnect?.(args.platform, { accountId: args.account_id, label: args.label });
        const accountId = args.account_id ?? gate?.accountId;
        const result = await relay.beginConnect(args.platform, {
          ...(accountId ? { accountId } : {}),
          ...(args.label ? { label: args.label } : {}),
        });
        if (result.mode === "connected") {
          const account = result.account;
          return textResult(
            `Connected ${platformLabel(account.platform)} as @${account.handle} in ${account.mode} mode. You can publish with relay_post now.`,
            {
              mode: "connected",
              platform: account.platform,
              account,
              mock: relay.isMockForced,
              consoleUrl: relay.consoleUrl,
              dataDir: relay.dataDir,
            },
          );
        }
        const summary = [
          `Sign in to ${platformLabel(args.platform)} by opening this URL in a browser:`,
          "",
          result.url,
          "",
          "A browser window was opened automatically on this machine. If it did not appear, open the URL above.",
          `The Relay console must be running at ${relay.consoleUrl} to receive the OAuth callback (start it from the repo root with "npm run web" or the start-relay launcher).`,
          `After you approve access the account is stored under ${relay.dataDir}. Call relay_accounts to confirm it is connected.`,
          "The sign-in link is single-use and expires in about 15 minutes.",
        ].join("\n");
        openInBrowser(result.url);
        return textResult(summary, {
          mode: "redirect",
          platform: args.platform,
          url: result.url,
          state: result.state,
          consoleUrl: relay.consoleUrl,
          dataDir: relay.dataDir,
        });
      }, HINTS.connect),
  );

  server.registerTool(
    "relay_disconnect",
    {
      title: "Disconnect a platform account",
      description:
        "Remove the stored account and tokens for one platform. Scheduled jobs for that platform will fail until an account is connected again. Safe to call when no account is connected.",
      inputSchema: disconnectInputSchema.shape,
    },
    async (args) =>
      safely(async () => {
        const existed = await relay.disconnect(args.platform, args.account_id);
        const label = platformLabel(args.platform);
        return textResult(
          existed
            ? `Disconnected the ${label} account.`
            : `No ${label} account was connected; nothing changed.`,
          { platform: args.platform, accountId: args.account_id, disconnected: existed },
        );
      }, HINTS.disconnect),
  );

  server.registerTool(
    "relay_post",
    {
      title: "Publish or schedule a post",
      description:
        "Validate a draft, then publish it to one or more platforms immediately, or queue it when schedule_at is a future ISO-8601 timestamp. Simulated accounts publish in mock mode and live accounts call the real APIs; results state which mode was used. Supports plain posts, media, threads and per-platform options.",
      inputSchema: postInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      safely(async () => {
        const platformProblem = platformArgsProblem(args.platforms);
        if (platformProblem) return platformProblem;
        const draft = toDraft(args);
        const quote = safeQuote(context, draft);
        const report = await relay.validate(draft);
        if (!report.ok) {
          return errorResult(
            `Post not published: the draft failed validation with ${report.issues.length} issue(s).`,
            [
              formatIssues(report.issues),
              "",
              "Fix the issues above and call relay_post again, or call relay_validate to iterate without publishing.",
            ].join("\n"),
            { valid: false, issues: report.issues, perPlatform: report.perPlatform, quote },
          );
        }

        const hold = context.beforePost ? await context.beforePost(draft) : null;
        let result: Awaited<ReturnType<RelayService["createPost"]>>;
        try {
          result = await relay.createPost(draft, { force: args.force === true });
        } catch (error) {
          await context.afterPostError?.(hold);
          throw error;
        }
        await context.afterPost?.(hold, result);
        if (!result.report.ok) {
          return errorResult(
            "Post not published: validation failed while creating the post.",
            [formatIssues(result.report.issues), "", HINTS.post].join("\n"),
            result.report,
          );
        }

        const preview = postPreview({ draft });
        if (result.scheduled && result.jobId) {
          const scheduleAt = draft.scheduleAt ? new Date(draft.scheduleAt).toISOString() : "the scheduled time";
          return textResult(
            [
              `Scheduled "${preview}" for ${scheduleAt} (job ${result.jobId}).`,
              ...(formatQuote(quote) ? [formatQuote(quote)] : []),
              "Nothing was published yet. The scheduler publishes due jobs while any Relay process holds the scheduler lock — this MCP server or the Relay console.",
              "Use relay_queue to inspect it and relay_cancel to cancel it before it runs.",
            ].join("\n"),
            {
              scheduled: true,
              jobId: result.jobId,
              scheduleAt,
              platforms: draft.platforms,
              report: result.report,
              quote,
            },
          );
        }

        if (result.results.length === 0) {
          return errorResult(
            "The post was not published because the draft did not resolve to any platform.",
            HINTS.post,
            result,
          );
        }

        const succeeded = result.results.filter((entry) => entry.ok).length;
        const lines = [
          succeeded === result.results.length
            ? `Published "${preview}" to ${succeeded} platform(s).`
            : `Published to ${succeeded} of ${result.results.length} platform(s); some platforms failed.`,
          formatResults(result.results),
          ...(formatQuote(quote) ? [formatQuote(quote)] : []),
        ];
        if (succeeded === 0) {
          lines.push("No platform accepted the post. Connect the missing accounts with relay_connect, then retry relay_post.");
        }
        const content = textResult(lines.join("\n\n"), {
          scheduled: false,
          results: result.results,
          report: result.report,
          quote,
        });
        return succeeded === 0 ? { ...content, isError: true } : content;
      }, HINTS.post),
  );

  server.registerTool(
    "relay_validate",
    {
      title: "Validate a post draft",
      description:
        "Dry run: validate platforms, text length, thread parts, media and per-platform options without publishing anything. Returns a per-platform report, actionable issues, and in cloud mode a per-part cost estimate. Use this to iterate on a draft before relay_post.",
      inputSchema: postInputSchema.shape,
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      safely(async () => {
        const platformProblem = platformArgsProblem(args.platforms);
        if (platformProblem) return platformProblem;
        const draft = toDraft(args);
        const quote = safeQuote(context, draft);
        const report: ValidationReport = await relay.validate(draft);
        const targets = draft.platforms.map((platform) => platformLabel(platform)).join(", ");
        const summary = report.ok
          ? `Draft is valid for ${targets}. Dry run only — nothing was published.`
          : [`Draft is invalid for ${targets} (${report.issues.length} issue(s)). Nothing was published.`, formatIssues(report.issues)].join("\n");
        const pricing = formatQuote(quote);
        return textResult(pricing ? `${summary}\n\n${pricing}` : summary, { ...report, quote });
      }, HINTS.validate),
  );

  server.registerTool(
    "relay_preview",
    {
      title: "Preview a post across platforms",
      description:
        "Show how one draft will look on every selected platform without publishing. Returns per-platform adapted text, part counts, character counts, media counts, truncation warnings and validation issues. Use this before relay_post to catch format differences, especially when auto-threading X or Threads or shortening for Instagram/TikTok.",
      inputSchema: postInputSchema.shape,
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      safely(async () => {
        const platformProblem = platformArgsProblem(args.platforms);
        if (platformProblem) return platformProblem;
        const draft = toDraft(args);
        const preview = await relay.preview(draft);
        const lines = preview.platforms.map((entry) => {
          const parts = entry.parts.length > 1 ? `${entry.parts.length} parts` : "1 part";
          const counts = entry.characterCounts.join("/");
          const state = entry.ok ? "ready" : "needs attention";
          const warning = entry.issues.length > 0 ? ` — ${entry.issues.join(" ")}` : "";
          return `- ${entry.displayName}: ${parts}, ${counts} chars, ${entry.mediaCount} media, ${state}${warning}`;
        });
        const first = preview.platforms[0];
        const summary = [
          `Preview for ${preview.platforms.length} platform(s). Nothing was published.`,
          ...lines,
          ...(first ? ["", `First platform preview: ${first.parts.join(" / ").slice(0, 800)}`] : []),
        ].join("\n");
        return textResult(summary, preview);
      }, HINTS.preview),
  );

  server.registerTool(
    "relay_queue",
    {
      title: "List scheduled posts",
      description:
        "List queued or previously processed scheduled posts with status (pending/running/done/failed/canceled), schedule time, target platforms, draft preview and results where available. Cancel a pending job with relay_cancel.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      safely(async () => {
        const jobs: QueueJob[] = await relay.listQueue();
        const counts: Record<QueueStatus, number> = {
          pending: 0,
          running: 0,
          done: 0,
          failed: 0,
          canceled: 0,
        };
        for (const job of jobs) counts[job.status] += 1;
        const lines = [
          `${jobs.length} queued job(s): ${counts.pending} pending, ${counts.running} running, ${counts.done} done, ${counts.failed} failed, ${counts.canceled} canceled.`,
        ];
        if (jobs.length === 0) {
          lines.push('Nothing is scheduled. Schedule a post with relay_post and a future schedule_at (ISO-8601).');
        } else {
          lines.push("", ...jobs.map((job) => `- ${formatQueueJob(job)}`));
        }
        return textResult(lines.join("\n"), { count: jobs.length, counts, jobs });
      }, HINTS.queue),
  );

  server.registerTool(
    "relay_cancel",
    {
      title: "Cancel a scheduled post",
      description:
        'Cancel a still-pending scheduled job by id. Jobs that are already running, done, failed or canceled cannot be canceled. Use relay_queue to find job ids.',
      inputSchema: cancelInputSchema.shape,
    },
    async (args) =>
      safely(async () => {
        const canceled = await relay.cancelJob(args.job_id);
        if (!canceled) {
          return errorResult(
            `No pending job found with id "${args.job_id}".`,
            'Only jobs with status "pending" can be canceled. Call relay_queue to list current job ids and statuses.',
            { jobId: args.job_id, canceled: false },
          );
        }
        await context.afterCancel?.(args.job_id);
        return textResult(`Canceled scheduled job ${args.job_id}. It will not be published.`, {
          jobId: args.job_id,
          canceled: true,
        });
      }, HINTS.cancel),
  );

  server.registerTool(
    "relay_history",
    {
      title: "Recent post history",
      description:
        "Return recently published posts (newest first), including target platforms, per-platform result ids/urls and simulated-vs-live mode. Scheduled posts appear once the scheduler runs them.",
      inputSchema: historyInputSchema.shape,
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      safely(async () => {
        const limit = args.limit ?? DEFAULT_HISTORY_LIMIT;
        const records = await relay.history(limit);
        const lines = [`${records.length} post record(s), most recent first.`];
        if (records.length === 0) {
          lines.push("No posts yet. Publish one with relay_post.");
        } else {
          lines.push("", ...records.map((record) => `- ${formatPostRecord(record)}`));
        }
        return textResult(lines.join("\n"), { limit, count: records.length, records });
      }, HINTS.history),
  );

  server.registerTool(
    "relay_threads_comments",
    {
      title: "Read Threads comments",
      description:
        "READ-ONLY: list the connected Threads account's recent posts and their replies/comments. Never posts, replies, edits or deletes anything. Requires the threads_read_replies scope; an older token returns error code threads_scope_missing and must be reconnected.",
      inputSchema: threadsCommentsInputSchema.shape,
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      safely(async () => {
        const limitPosts = args.limit_posts ?? 10;
        const result = await relay.readThreadsComments(limitPosts);
        const commentCount = result.posts.reduce((total, post) => total + post.comments.length, 0);
        const lines = [
          `Read ${result.posts.length} recent Threads post(s) with ${commentCount} comment(s) from other accounts.`,
          "Read-only: nothing was posted, replied to, edited or deleted.",
        ];
        for (const post of result.posts.slice(0, 10)) {
          lines.push(
            `- ${post.id}${post.timestamp ? ` (${post.timestamp})` : ""}: ${post.comments.length} comment(s)${post.permalink ? ` — ${post.permalink}` : ""}`,
          );
        }
        return textResult(lines.join("\n"), {
          limitPosts,
          count: result.posts.length,
          commentCount,
          posts: result.posts,
        });
      }, HINTS.history),
  );

  server.registerTool(
    "relay_threads_autoreply",
    {
      title: "Read Threads auto-reply log",
      description:
        "READ-ONLY: show the local Threads auto-reply log — posted replies, spam/hostile comments that were flagged instead of answered, and the persisted 30-minute windows. Never posts, replies or changes any setting.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      safely(async () => {
        const log = await relay.threadsAutoReplyLog();
        const openWindows = log.windows.filter((window) => window.status === "open").length;
        const lines = [
          `${log.replies.length} auto-repl${log.replies.length === 1 ? "y" : "ies"}, ${log.flagged.length} flagged comment(s), ${log.windows.length} window(s) (${openWindows} open).`,
          "Read-only: nothing was posted, replied to, edited, deleted or toggled.",
        ];
        for (const reply of log.replies.slice(0, 10)) {
          lines.push(`- replied to ${reply.commenter ?? reply.commentId} on ${reply.postId}: ${reply.replyText}`);
        }
        for (const flagged of log.flagged.slice(0, 10)) {
          lines.push(`- flagged ${flagged.classification} comment ${flagged.commentId} on ${flagged.postId}`);
        }
        return textResult(lines.join("\n"), log);
      }, HINTS.history),
  );

  server.registerTool(
    "relay_threads_reply",
    {
      title: "Reply to a Threads comment",
      description:
        "EXPLICIT ACTION ONLY: post one text reply to one Threads comment. Nothing runs automatically and the scheduler never calls this tool; a reply is published only when this tool is invoked with a comment_id and text. Requires the threads_manage_replies scope and a connected Threads account. Use relay_threads_comments to read comments and their ids first. Mock mode simulates the reply without calling the real API.",
      inputSchema: threadsReplyInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) =>
      safely(async () => {
        const result = await relay.replyToThreadsComment(args.comment_id, args.text);
        const target = args.comment_id;
        const summary = [
          result.mock
            ? `Simulated a Threads reply to comment ${target}; no real API call was made.`
            : `Posted a Threads reply to comment ${target}.`,
          result.permalink ? `Reply: ${result.permalink}` : undefined,
        ]
          .filter(Boolean)
          .join("\n");
        return textResult(summary, {
          id: result.id,
          permalink: result.permalink,
          mock: result.mock,
        });
      }, HINTS.reply),
  );

  server.registerTool(
    "relay_comments_new",
    {
      title: "New comments on my posts",
      description:
        "Comments on the connected accounts' OWN posts (Threads, Instagram, YouTube) that have not been handed out yet, each pre-filtered in code with no AI: kind is 'spam' (links, repeated characters, spam words; never reply), 'simple' (emoji only, thanks, nice, ok; comes with a suggested_template) or 'needs_reply'. With mark_seen true (default) the returned comments are recorded so each one is returned only once, even after a restart. Never posts or replies. An account whose token lacks the comment scope is reported as 'needs reconnect for comments' in platforms[] instead of failing. YouTube costs about 2-3 quota units per call.",
      inputSchema: commentsNewInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      safely(async () => {
        const result = await relay.newComments({
          platform: args.platform ?? "all",
          sinceHours: args.since_hours,
          limit: args.limit,
          markSeen: args.mark_seen,
        });
        const lines = [
          `${result.comments.length} new comment(s): ${result.counts.needs_reply} need a reply, ${result.counts.simple} simple, ${result.counts.spam} spam.${result.more_available ? " More are waiting; call again." : ""}`,
          result.mark_seen ? "Marked as seen." : "Read-only peek: nothing marked as seen.",
          "Nothing was posted or replied to.",
        ];
        for (const entry of result.platforms) {
          if (entry.status !== "ok" && entry.status !== "not_connected") lines.push(`- ${entry.platform}: ${entry.message ?? entry.status}`);
        }
        return textResult(lines.join("\n"), result);
      }, HINTS.commentsNew),
  );

  server.registerTool(
    "relay_reply",
    {
      title: "Reply to a comment",
      description:
        "EXPLICIT ACTION ONLY: post one reply to one comment on Threads, Instagram or YouTube. The same comment_id is never replied to twice (a second call returns comment_already_replied). Validates length per platform (Threads 500, Instagram 2200, YouTube 10000). dry_run true checks everything and sends nothing. Needs the comment scope on the stored token; otherwise the error says 'needs reconnect for comments'. Mock mode simulates the reply. YouTube costs 50 quota units per reply.",
      inputSchema: replyInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) =>
      safely(async () => {
        const result = await relay.replyToComment({
          platform: args.platform,
          commentId: args.comment_id,
          text: args.text,
          postId: args.post_id,
          dryRun: args.dry_run,
        });
        const summary = result.dry_run
          ? `Dry run OK: a ${result.platform} reply to comment ${result.comment_id} (${result.length}/${result.max_length} chars) would be sent. Nothing was sent.`
          : result.mock
            ? `Simulated a ${result.platform} reply to comment ${result.comment_id}; no real API call was made.`
            : `Posted a ${result.platform} reply to comment ${result.comment_id}.${result.permalink ? ` ${result.permalink}` : ""}`;
        return textResult(result.warnings.length > 0 ? `${summary}\nWarning: ${result.warnings.join(" ")}` : summary, result);
      }, HINTS.commentsReply),
  );

  server.registerTool(
    "relay_article_validate",
    {
      title: "Validate an X Article",
      description:
        "Dry run for an X Article (long-form post): checks the title, body, optional cover image, inline body images (each file path, type, size and dimensions are checked and listed in stats.imageFiles), schedule_at, the X connection and the granted scopes (tweet.write, plus media.write for a cover or inline images). Publishes nothing, uploads nothing and creates no draft on X.",
      inputSchema: articleInputSchema.shape,
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      safely(async () => {
        const draft = toArticleDraft(args);
        const report = await relay.validateArticle(draft);
        const summary = report.ok
          ? `Article is valid (${report.stats?.words ?? 0} words, ${report.stats?.blocks ?? 0} blocks, ${report.stats?.images ?? 0} inline image(s)). Dry run only, nothing was created on X.`
          : [`Article is invalid (${report.issues.length} issue(s)). Nothing was created on X.`, formatIssues(report.issues)].join("\n");
        return textResult(summary, report);
      }, HINTS.articleValidate),
  );

  server.registerTool(
    "relay_article",
    {
      title: "Publish or schedule an X Article",
      description:
        "Publish an X Article (long-form post) to the connected X account. It validates first, then creates the Article draft on X and publishes it, using POST /2/articles/draft and POST /2/articles/{id}/publish. Give body as sections [{heading?, paragraphs?[], image?{path, altText?, caption?}}] (an image between paragraphs is its own item, for example [{paragraphs:[..]},{image:{path}},{paragraphs:[..]}]) or body_markdown (#, ##, ### headings, > quotes, - bullets, 1. numbers, blank line between paragraphs, ![alt](path) on its own line for an inline image). cover is an optional image with a local path. Inline images: up to 10, local JPEG/PNG/WebP files, 5 MB each. Relay uploads each one to X before creating the draft, and publishes nothing if any step fails. If schedule_at is a future ISO-8601 time (use +08:00 for Malaysia), the article is queued; X has no native Article scheduling, so Relay creates and publishes it at that time and nothing exists on X before then. Queued articles show in relay_queue and published ones in relay_history. Needs the tweet.write scope (media.write for a cover or inline images) and an X account that can write Articles (Premium).",
      inputSchema: articleInputSchema.extend({
        force: z
          .boolean()
          .optional()
          .describe("Publish even if this exact article was published in the last 30 minutes or is already queued."),
      }).shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      safely(async () => {
        const draft = toArticleDraft(args);
        const result = await relay.createArticle(draft, { force: args.force === true });
        if (!result.report.ok) {
          return errorResult(
            `Article not published: it failed validation with ${result.report.issues.length} issue(s).`,
            [formatIssues(result.report.issues), "", "Fix the issues and call relay_article again, or use relay_article_validate to check without publishing."].join("\n"),
            { valid: false, issues: result.report.issues },
          );
        }
        if (result.scheduled && result.jobId) {
          return textResult(
            [
              `Scheduled the article "${draft.title.trim()}" for ${result.scheduleAt} (job ${result.jobId}).`,
              "Nothing exists on X yet. Relay creates and publishes it at that time while a Relay process holds the scheduler lock.",
              "Use relay_queue to see it and relay_delete with job_id to remove it before it runs.",
            ].join("\n"),
            { scheduled: true, jobId: result.jobId, scheduleAt: result.scheduleAt, stats: result.report.stats },
          );
        }
        const outcome = result.results[0];
        if (!outcome || !outcome.ok) {
          const draftId = (outcome?.details as { articleDraftId?: string } | undefined)?.articleDraftId;
          return errorResult(
            `The article was not published: ${outcome?.error ?? "unknown error"}`,
            draftId
              ? `A draft (${draftId}) was created on X and is still in your X drafts. Open it there to publish by hand.`
              : HINTS.article,
            { scheduled: false, results: result.results },
          );
        }
        return textResult(
          [
            outcome.mode === "mock"
              ? `Simulated publishing the article "${draft.title.trim()}"; no real API call was made.`
              : `Published the article "${draft.title.trim()}" on X.`,
            outcome.url ? `Link: ${outcome.url}` : undefined,
          ]
            .filter(Boolean)
            .join("\n"),
          { scheduled: false, results: result.results, stats: result.report.stats },
        );
      }, HINTS.article),
  );

  server.registerTool(
    "relay_delete",
    {
      title: "Delete a scheduled or published post",
      description:
        "Delete a post. Three ways: (1) job_id removes a pending job from the Relay queue (nothing is touched on any platform); (2) platform + post_id deletes one published post on X or Threads; (3) record_id deletes every published part of a relay_history record (for example a whole X thread). Published deletes need confirm: true; without it this only previews what would be deleted. X uses DELETE /2/tweets/{id}. Threads needs the threads_delete scope. TikTok, Instagram and YouTube return 'unsupported' with the reason. A deleted post cannot be restored.",
      inputSchema: deleteInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) =>
      safely(async () => {
        const modes = [args.job_id ? "job_id" : null, args.record_id ? "record_id" : null, args.post_id || args.platform ? "platform+post_id" : null].filter(
          Boolean,
        );
        if (modes.length !== 1) {
          return errorResult(
            "Choose exactly one way to say what to delete.",
            "Use job_id (queued job), record_id (history record), or platform with post_id (one published post).",
            { modes },
          );
        }

        if (args.job_id) {
          const outcome = await relay.removeQueueJob(args.job_id);
          if (!outcome.found) {
            return errorResult(`No queued job has the id "${args.job_id}".`, HINTS.queue, { jobId: args.job_id, removed: false });
          }
          if (!outcome.removed) {
            return errorResult(
              `Job ${args.job_id} is ${outcome.status}, so it cannot be removed from the queue.`,
              outcome.status === "done"
                ? "It already published. Delete the live post with record_id or platform + post_id (see relay_history)."
                : "Only pending, canceled or failed jobs can be removed. A running job cannot be stopped.",
              { jobId: args.job_id, removed: false, status: outcome.status },
            );
          }
          return textResult(`Removed job ${args.job_id} from the Relay queue. It will not run. Nothing was touched on any platform.`, {
            jobId: args.job_id,
            removed: true,
            previousStatus: outcome.status,
          });
        }

        let targets: { platform: PlatformId; postId: string; url?: string }[];
        if (args.record_id) {
          const plan = await relay.recordDeleteTargets(args.record_id);
          if (!plan.found) {
            return errorResult(`No history record has the id "${args.record_id}".`, HINTS.history, { recordId: args.record_id });
          }
          targets = plan.targets;
          if (targets.length === 0) {
            return textResult("Nothing left to delete for this record (no published posts, or all already deleted).", {
              recordId: args.record_id,
              deleted: [],
            });
          }
        } else {
          if (!args.platform || !args.post_id) {
            return errorResult("Give both platform and post_id.", "Example: platform \"x\", post_id \"1234567890\".", {
              platform: args.platform,
              postId: args.post_id,
            });
          }
          targets = [{ platform: args.platform, postId: args.post_id }];
        }

        if (args.confirm !== true) {
          return textResult(
            [
              `Preview only. Nothing was deleted. These ${targets.length} post(s) would be deleted:`,
              ...targets.map((target) => `- ${platformLabel(target.platform)} ${target.postId}${target.url ? ` ${target.url}` : ""}`),
              "",
              "Call relay_delete again with confirm: true to delete them. This cannot be undone.",
            ].join("\n"),
            { confirmed: false, targets },
          );
        }

        const outcomes = [];
        for (const target of targets) outcomes.push(await relay.deletePublishedPost(target.platform, target.postId));
        const deleted = outcomes.filter((entry) => entry.status === "deleted" || entry.status === "already_gone").length;
        const lines = outcomes.map((entry) => {
          const label = `${platformLabel(entry.platform)} ${entry.postId}`;
          const mode = entry.mock ? " (simulated)" : "";
          if (entry.status === "deleted") return `- ${label}: deleted${mode}`;
          if (entry.status === "already_gone") return `- ${label}: already gone`;
          if (entry.status === "unsupported") return `- ${label}: unsupported. ${entry.error ?? ""}`.trim();
          return `- ${label}: failed. ${entry.error ?? "unknown error"}`;
        });
        const content = textResult(
          [`Deleted ${deleted} of ${outcomes.length} post(s).`, ...lines].join("\n"),
          { confirmed: true, deleted, outcomes },
        );
        return deleted === 0 ? { ...content, isError: true } : content;
      }, HINTS.delete),
  );

  server.registerTool(
    "relay_limits",
    {
      title: "Per-platform limits",
      description:
        "Show the publishing limits and requirements for X, Threads, TikTok, YouTube, Instagram and LinkedIn: text length, thread parts, media counts and sizes, upload style and platform notes. Check this before composing long posts or media posts.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      safely(async () => {
        const limits = relay.platformLimits();
        const platforms = await relay.platformStatuses();
        const lines = ["Per-platform publishing limits:", ""];
        for (const limit of limits) lines.push(`- ${formatLimits(limit)}`);
        lines.push(
          "",
          "Upload notes:",
          "- X accepts direct binary uploads; Threads fetches images/videos from public URLs.",
          "- TikTok uploads videos directly but fetches photos from public URLs.",
          "- Media items accept a local `path` (read by the MCP server) and/or a public `url`; alternative text is supported.",
          "- Set RELAY_PUBLIC_MEDIA_BASE_URL to a tunnel that serves the console so local files under the data dir get a public URL automatically.",
        );
        return textResult(lines.join("\n"), { limits, platforms });
      }, HINTS.limits),
  );

  server.registerTool(
    "relay_console",
    {
      title: "Relay console and configuration",
      description:
        "Show how this Relay instance is configured: console URL, data directory, simulated-vs-live summary, scheduler state, credential sources and exactly how to add platform credentials or start live sign-in. Also returns a ready-to-use stdio MCP client configuration snippet.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      safely(async () => {
        const settings = await relay.getSettings();
        const scheduler = await relay.schedulerStatus();
        const credentials = relay.credentialInfos();
        const livePlatforms = settings.platforms
          .filter((platform) => platform.live)
          .map((platform) => platformLabel(platform.platform));
        const mode = settings.mock
          ? "forced simulated (--mock / RELAY_MOCK=1)"
          : livePlatforms.length > 0
            ? `live for ${livePlatforms.join(", ")}; simulated elsewhere`
            : "simulated (no platform credentials configured)";

        const lines = [
          `Relay console: ${settings.consoleUrl}`,
          `Data directory: ${settings.dataDir}`,
          `Mode: ${mode}`,
          `Scheduler: ${
            scheduler.running
              ? scheduler.ownedByThisProcess
                ? `running in this MCP server (every ${scheduler.intervalMs} ms)`
                : "running in another Relay process; that process publishes scheduled posts"
              : "not running"
          }`,
        ];
        if (settings.publicMediaBaseUrl) {
          lines.push(`Public media base URL: ${settings.publicMediaBaseUrl}`);
        }
        lines.push(
          "",
          "How to add credentials for live publishing:",
          "1. Set client credentials in the environment (or a repo-root .env file) before starting the console / MCP server:",
          ...settings.platforms.map(
            (platform) => `   ${platformLabel(platform.platform)}: ${CREDENTIAL_ENV_HINTS[platform.platform]}`,
          ),
          `2. Start the Relay console at ${settings.consoleUrl} (repo root: "npm run web") and use its Settings screen, or call relay_connect to open the platform's OAuth sign-in URL.`,
          "3. Threads (and TikTok photos) fetch media from public URLs: set RELAY_PUBLIC_MEDIA_BASE_URL to a public tunnel that serves the console's /media route.",
          "For simulated-only use, start with --mock (or RELAY_MOCK=1); every post is then simulated.",
        );

        const clientConfig = buildClientConfig(
          context.entryPath ?? process.argv[1] ?? "<path-to>/apps/mcp/dist/index.js",
          settings.dataDir,
          settings.consoleUrl,
          settings.mock,
        );
        if (context.entryPath) {
          lines.push("", "MCP client configuration (stdio):", JSON.stringify(clientConfig, null, 2));
        }

        return textResult(lines.join("\n"), {
          settings,
          credentials,
          scheduler,
          clientConfig: context.entryPath ? clientConfig : undefined,
          env: {
            RELAY_DATA_DIR: settings.dataDir,
            RELAY_CONSOLE_URL: settings.consoleUrl,
            RELAY_MOCK: settings.mock ? "1" : undefined,
            RELAY_PUBLIC_MEDIA_BASE_URL: settings.publicMediaBaseUrl ?? undefined,
          },
        });
      }, HINTS.console),
  );
}

function buildClientConfig(entryPath: string, dataDir: string, consoleUrl: string, mock: boolean): unknown {
  const args = [entryPath, "--data-dir", dataDir, "--console-url", consoleUrl];
  if (mock) args.push("--mock");
  return {
    mcpServers: {
      relay: {
        command: "node",
        args,
      },
    },
  };
}







