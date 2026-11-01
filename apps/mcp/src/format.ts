/**
 * Formatting helpers for MCP tool results.
 *
 * Every tool returns text content built as `<human summary>\n\n<pretty JSON>` so
 * both humans and models can read it. Nothing here writes to stdout: the caller
 * (index.ts) is the only process that talks on stdout, and that is JSON-RPC.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  Account,
  PlatformId,
  PlatformLimits,
  PlatformStatus,
  PostRecord,
  PostResult,
  QueueJob,
  ValidationIssue,
} from "@relay/core";

export const PLATFORM_LABELS: Record<PlatformId, string> = {
  x: "X",
  threads: "Threads",
  tiktok: "TikTok",
  youtube: "YouTube",
  instagram: "Instagram",
  linkedin: "LinkedIn",
};

export function platformLabel(platform: PlatformId): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

/** Environment variables that enable live publishing for each platform. */
export const CREDENTIAL_ENV_HINTS: Record<PlatformId, string> = {
  x: "X_CLIENT_ID and X_CLIENT_SECRET",
  threads: "THREADS_CLIENT_ID and THREADS_CLIENT_SECRET",
  tiktok: "TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET",
  youtube: "YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET",
  instagram: "INSTAGRAM_CLIENT_ID and INSTAGRAM_CLIENT_SECRET",
  linkedin: "LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET",
};

export function truncate(value: string, max = 90): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1)}…`;
}

export function formatAccount(account: Account): string {
  return account.displayName ? `@${account.handle} (${account.displayName})` : `@${account.handle}`;
}

export function formatIssues(issues: ValidationIssue[]): string {
  if (issues.length === 0) return "- No issues.";
  return issues
    .map((issue) => {
      const where = [
        issue.platform ? platformLabel(issue.platform) : null,
        issue.part !== undefined ? `part ${issue.part + 1}` : null,
      ]
        .filter((part): part is string => Boolean(part))
        .join(", ");
      return `- ${where ? `${where}: ` : ""}${issue.message} [${issue.code}]`;
    })
    .join("\n");
}

export function formatStatus(status: PlatformStatus): string {
  const account = status.account
    ? `connected as ${formatAccount(status.account)} (${status.account.mode} account)`
    : "not connected";
  const credentials = status.configured ? "credentials configured" : "no credentials configured";
  const mode = status.live ? "live publishing" : "simulated publishing";
  return `${status.displayName}: ${account}; ${credentials}; ${mode}`;
}

/** What the user should do next for one platform. */
export function nextStep(status: PlatformStatus, consoleUrl: string): string {
  if (status.connected) {
    if (status.live) {
      return `Ready to publish live. Compose a post with relay_post.`;
    }
    if (status.configured) {
      return (
        `Account is connected, but this server runs in simulated mode (--mock / RELAY_MOCK=1). ` +
        `Restart the MCP server without --mock to publish live.`
      );
    }
    return (
      `Connected in simulated mode only (no ${CREDENTIAL_ENV_HINTS[status.platform]} configured). ` +
      `Set those credentials and restart to publish for real.`
    );
  }
  if (status.live) {
    return (
      `Call relay_connect with platform "${status.platform}" and open the returned sign-in URL. ` +
      `The Relay console must be running at ${consoleUrl} to receive the OAuth callback.`
    );
  }
  if (status.configured) {
    return (
      `Call relay_connect with platform "${status.platform}" to link a simulated account, ` +
      `or restart the MCP server without --mock to sign in for real.`
    );
  }
  return (
    `Call relay_connect with platform "${status.platform}" to link a simulated account, ` +
    `or set ${CREDENTIAL_ENV_HINTS[status.platform]} and restart to sign in for real.`
  );
}

export function formatResults(results: PostResult[]): string {
  if (results.length === 0) return "- No platform results.";
  return results
    .map((result) => {
      const mode = result.mode === "mock" ? "simulated" : "live";
      if (result.ok && result.status === "partial") {
        const link = result.url ? ` — ${result.url}` : "";
        const parts = result.publishedParts?.length ?? 0;
        const failed = result.failedPart ? ` part ${result.failedPart}` : " a later part";
        return (
          `~ ${platformLabel(result.platform)}: partially published in ${mode} mode ` +
          `(${parts} part(s), id ${result.postId ?? "unknown"})${link} — ${failed} failed: ${result.error ?? "unknown error"}`
        );
      }
      if (result.ok) {
        const link = result.url ? ` — ${result.url}` : "";
        return `✓ ${platformLabel(result.platform)}: published in ${mode} mode (id ${result.postId ?? "unknown"})${link}`;
      }
      return `✗ ${platformLabel(result.platform)}: failed in ${mode} mode — ${result.error ?? "unknown error"}`;
    })
    .join("\n");
}

export function postPreview(record: Pick<PostRecord, "draft">): string {
  const text = record.draft.thread?.map((part) => part.text).join(" / ") ?? record.draft.text ?? "";
  return truncate(text) || "(no text)";
}

/** "[Claude] " when the draft carries a source label, otherwise "". */
export function labelPrefix(draft: { label?: unknown } | undefined): string {
  const label = typeof draft?.label === "string" ? draft.label.trim() : "";
  return label ? `[${label}] ` : "";
}

export function formatQueueJob(job: QueueJob): string {
  const platforms = job.draft.platforms?.join(", ") ?? "unknown";
  const error = job.lastError ? ` — ${job.lastError}` : "";
  const repeat = job.draft.recurrence
    ? ` — repeats ${job.draft.recurrence.interval}${job.draft.recurrence.count ? ` (${job.occurrence ?? 1}/${job.draft.recurrence.count})` : ""}`
    : "";
  return `${job.id} [${job.status}] scheduled for ${job.scheduleAt} — ${platforms}${repeat} — ${labelPrefix(job.draft)}${postPreview(job)}${error}`;
}

export function formatPostRecord(record: PostRecord): string {
  const platforms = record.draft.platforms?.join(", ") ?? "unknown";
  const succeeded = record.results.filter((result) => result.ok).length;
  const scheduled = record.scheduledFor ? ` (scheduled for ${record.scheduledFor})` : "";
  return `${record.createdAt}${scheduled} — ${platforms} — ${succeeded}/${record.results.length} ok — ${labelPrefix(record.draft)}${postPreview(record)}`;
}

export function formatLimits(limits: PlatformLimits): string {
  const media = limits.requiresMedia ? "media required" : "media optional";
  const notes = limits.notes ? ` — ${limits.notes}` : "";
  return (
    `${limits.displayName}: ${limits.maxTextLength} chars per post, up to ${limits.maxParts} part(s); ` +
    `${limits.maxMediaPerPost} media item(s) per post (max ${limits.maxVideosPerPost} video, ` +
    `${limits.maxMediaWithVideo} media with a video); ${media}; upload via ${limits.mediaUpload}${notes}`
  );
}

/** Standard successful tool result: readable summary followed by the JSON payload. */
export function textResult(summary: string, data: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: `${summary.trim()}\n\n${JSON.stringify(data, null, 2)}`,
      },
    ],
  };
}

/** Standard error tool result. Includes an actionable hint and a JSON payload. */
export function errorResult(message: string, hint?: string, data?: unknown): CallToolResult {
  const parts = [`Error: ${message}`];
  if (hint) parts.push(hint);
  parts.push(JSON.stringify(data ?? { error: message }, null, 2));
  return {
    isError: true,
    content: [{ type: "text", text: parts.join("\n\n") }],
  };
}

