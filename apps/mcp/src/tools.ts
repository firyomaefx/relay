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

const platformEnum = z.enum(["x", "threads", "tiktok", "youtube", "instagram"]);

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
  text: z.string().optional().describe("Post text for a single-part post."),
  media: z.array(mediaSchema).optional().describe("Media for a single-part post."),
  thread: z
    .array(threadPartSchema)
    .optional()
    .describe("Multi-part post (X thread, Threads chain). Use this instead of text/media for single parts."),
  schedule_at: z
    .string()
    .optional()
    .describe("ISO-8601 timestamp. If it is in the future the post is queued for the scheduler; otherwise it is published immediately."),
  options: z
    .record(platformEnum, platformOptionsSchema)
    .optional()
    .describe('Per-platform options keyed by platform, e.g. {"x":{"quotePostId":"123"}} or {"tiktok":{"selfOnly":true}}.'),
  force: z
    .boolean()
    .optional()
    .describe(
      "Publish even if identical content was already posted to the same platform in the last 30 minutes. Use only when the earlier post is known to be unwanted or lost.",
    ),
});

const connectInputSchema = z.object({
  platform: platformEnum.describe('Platform to connect: "x", "threads", "tiktok", "youtube" or "instagram".'),
});

const disconnectInputSchema = z.object({
  platform: platformEnum.describe('Platform to disconnect: "x", "threads", "tiktok", "youtube" or "instagram".'),
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

export interface ToolContext {
  relay: RelayService;
  /** Absolute path of the built server entry, used to render client config snippets. */
  entryPath?: string;
}

function toDraft(input: z.infer<typeof postInputSchema>): PostDraft {
  return {
    // Unknown platform names are rejected by platformArgsProblem() before publishing.
    platforms: input.platforms as PlatformId[],
    text: input.text,
    media: input.media,
    thread: input.thread,
    scheduleAt: input.schedule_at,
    options: input.options,
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
  queue: "Call relay_queue to inspect jobs and their ids.",
  cancel: 'Only jobs with status "pending" can be canceled.',
  history: "Publish a post with relay_post first, or call relay_queue for scheduled posts.",
  limits: "Check relay_accounts for connection state and relay_console for configuration.",
  console: "Call relay_accounts for per-platform readiness, or relay_connect to link an account.",
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
        "List connected social accounts and per-platform readiness for X, Threads and TikTok. Shows whether credentials are configured, whether publishing is live or simulated, and the exact next step for each platform. Call this before posting.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      safely(async () => {
        const [accounts, platforms] = await Promise.all([relay.accounts(), relay.platformStatuses()]);
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
        lines.push("");
        for (const platform of platforms) {
          lines.push(`- ${formatStatus(platform)}`);
          lines.push(`  next: ${nextStep(platform, relay.consoleUrl)}`);
        }

        return textResult(lines.join("\n"), {
          mock: relay.isMockForced,
          consoleUrl: relay.consoleUrl,
          dataDir: relay.dataDir,
          accounts,
          platforms,
          credentials,
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
        const result = await relay.beginConnect(args.platform);
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
        const existed = await relay.disconnect(args.platform);
        const label = platformLabel(args.platform);
        return textResult(
          existed
            ? `Disconnected the ${label} account.`
            : `No ${label} account was connected; nothing changed.`,
          { platform: args.platform, disconnected: existed },
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
        const report = await relay.validate(draft);
        if (!report.ok) {
          return errorResult(
            `Post not published: the draft failed validation with ${report.issues.length} issue(s).`,
            [
              formatIssues(report.issues),
              "",
              "Fix the issues above and call relay_post again, or call relay_validate to iterate without publishing.",
            ].join("\n"),
            { valid: false, issues: report.issues, perPlatform: report.perPlatform },
          );
        }

        const result = await relay.createPost(draft, { force: args.force === true });
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
              "Nothing was published yet. The scheduler publishes due jobs while any Relay process holds the scheduler lock — this MCP server or the Relay console.",
              "Use relay_queue to inspect it and relay_cancel to cancel it before it runs.",
            ].join("\n"),
            {
              scheduled: true,
              jobId: result.jobId,
              scheduleAt,
              platforms: draft.platforms,
              report: result.report,
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
        ];
        if (succeeded === 0) {
          lines.push("No platform accepted the post. Connect the missing accounts with relay_connect, then retry relay_post.");
        }
        const content = textResult(lines.join("\n\n"), {
          scheduled: false,
          results: result.results,
          report: result.report,
        });
        return succeeded === 0 ? { ...content, isError: true } : content;
      }, HINTS.post),
  );

  server.registerTool(
    "relay_validate",
    {
      title: "Validate a post draft",
      description:
        "Dry run: validate platforms, text length, thread parts, media and per-platform options without publishing anything. Returns a per-platform report with actionable issues. Use this to iterate on a draft before relay_post.",
      inputSchema: postInputSchema.shape,
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      safely(async () => {
        const platformProblem = platformArgsProblem(args.platforms);
        if (platformProblem) return platformProblem;
        const draft = toDraft(args);
        const report: ValidationReport = await relay.validate(draft);
        const targets = draft.platforms.map((platform) => platformLabel(platform)).join(", ");
        const summary = report.ok
          ? `Draft is valid for ${targets}. Dry run only — nothing was published.`
          : [`Draft is invalid for ${targets} (${report.issues.length} issue(s)). Nothing was published.`, formatIssues(report.issues)].join("\n");
        return textResult(summary, report);
      }, HINTS.validate),
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
    "relay_limits",
    {
      title: "Per-platform limits",
      description:
        "Show the publishing limits and requirements for X, Threads and TikTok: text length, thread parts, media counts and sizes, upload style and platform notes. Check this before composing long posts or media posts.",
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
