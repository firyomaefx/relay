/**
 * Shared contracts for Relay: platforms, drafts, accounts, adapters, results.
 * This file is the integration surface between core, platforms, MCP and the web app.
 */

export type PlatformId = "x" | "threads" | "tiktok" | "youtube" | "instagram";

export const PLATFORM_IDS = ["x", "threads", "tiktok", "youtube", "instagram"] as const satisfies readonly PlatformId[];

export function isPlatformId(value: unknown): value is PlatformId {
  return typeof value === "string" && (PLATFORM_IDS as readonly string[]).includes(value);
}

export interface MediaItem {
  /** Local file path. Relative paths resolve against the process working directory. */
  path?: string;
  /** Publicly reachable URL. Required by platforms that pull media from a URL. */
  url?: string;
  kind: "image" | "video";
  altText?: string;
}

export interface ThreadPartDraft {
  text: string;
  media?: MediaItem[];
}

export type ReplySetting = "everyone" | "followers" | "mentioned";

export interface PlatformOptions {
  replySetting?: ReplySetting;
  /** TikTok: mark the post private (used while an app is unaudited). */
  selfOnly?: boolean;
  /**
   * TikTok publishing path:
   * - direct (default): Direct Post to the profile (requires an audited app for public posts)
   * - draft: upload the video to the user's TikTok inbox as a draft (works for unaudited apps)
   */
  tiktokMode?: "direct" | "draft";
  tiktokPrivacy?: "PUBLIC_TO_EVERYONE" | "MUTUAL_FOLLOW_FRIENDS" | "SELF_ONLY";
  /**
   * TikTok photo posts: let TikTok add recommended background music. Defaults
   * to true. TikTok's API cannot pick a specific song, so this is only an
   * on/off switch; video posts never send it.
   */
  tiktokAutoAddMusic?: boolean;
  disableComment?: boolean;
  /** X: quote-tweet an existing post by id. */
  quotePostId?: string;
  /** YouTube: video visibility. Defaults to public. */
  youtubePrivacy?: "public" | "unlisted" | "private";
  /** YouTube: video title (max 100 chars). Defaults to the first line of the post text. */
  youtubeTitle?: string;
  /** YouTube: extra description appended before the post text. */
  youtubeDescription?: string;
  /** YouTube: up to 15 tags. */
  youtubeTags?: string[];
  /** YouTube: numeric category id (default 27 = Education). */
  youtubeCategoryId?: string;
  /** YouTube: COPPA declaration. Defaults to false. */
  youtubeMadeForKids?: boolean;
  /**
   * Instagram: also share a Reel to the main feed. Defaults to true. Images are
   * always feed posts.
   */
  instagramShareToFeed?: boolean;
  /** Instagram: alt text for image posts (max 1000 chars). */
  instagramAltText?: string;
}

export interface PostDraft {
  platforms: PlatformId[];
  text?: string;
  media?: MediaItem[];
  /** Multi-part post: X thread, Threads chain. Takes precedence over `text`/`media`. */
  thread?: ThreadPartDraft[];
  /** ISO-8601 timestamp. When in the future the post is queued instead of published. */
  scheduleAt?: string;
  options?: Partial<Record<PlatformId, PlatformOptions>>;
}

export interface ResolvedPart {
  text: string;
  media: MediaItem[];
}

export interface ResolvedPost {
  platform: PlatformId;
  parts: ResolvedPart[];
  options: PlatformOptions;
}

export interface PlatformLimits {
  platform: PlatformId;
  displayName: string;
  maxTextLength: number;
  maxParts: number;
  maxMediaPerPost: number;
  maxVideosPerPost: number;
  /** Media items allowed in a post that contains a video (usually 1). */
  maxMediaWithVideo: number;
  requiresMedia: boolean;
  maxImageBytes: number;
  maxVideoBytes: number;
  allowedImageTypes: readonly string[];
  allowedVideoTypes: readonly string[];
  /**
   * How this platform accepts media:
   * - direct: binary upload (X, TikTok video)
   * - url: platform fetches a public URL (Threads, TikTok photos)
   * - mixed: depends on media kind (TikTok: video direct, photos by URL)
   */
  mediaUpload: "direct" | "url" | "mixed";
  notes?: string;
}

export type AccountMode = "live" | "mock";

export interface Account {
  id: string;
  platform: PlatformId;
  handle: string;
  displayName?: string;
  avatarUrl?: string;
  mode: AccountMode;
  connectedAt: string;
  scopes?: string[];
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** ISO timestamp of access-token expiry, when the provider reports it. */
  expiresAt?: string;
  tokenType?: string;
  scope?: string;
}

export interface ProfileInfo {
  externalId: string;
  handle: string;
  displayName?: string;
  avatarUrl?: string;
}

export interface AuthorizeRequest {
  state: string;
  /** PKCE code verifier (43-128 chars). Adapters that do not use PKCE ignore it. */
  codeVerifier: string;
  redirectUri: string;
}

export type AuthorizeResult =
  | { kind: "redirect"; url: string }
  | { kind: "mock"; profile: ProfileInfo; scopes: string[] };

export interface ExchangeRequest {
  code: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface ConnectResult {
  profile: ProfileInfo;
  tokens: OAuthTokens;
  scopes: string[];
}

export interface MediaBlob {
  buffer: Buffer;
  mimeType: string;
  filename: string;
}

export interface PlatformCredentials {
  clientId?: string;
  clientSecret?: string;
  extra?: Record<string, string>;
}

/** One platform post created during a multi-part publish. */
export interface PublishedPart {
  platform: PlatformId;
  /** 1-based part number within the published thread/carousel. */
  part: number;
  postId: string;
  url?: string;
  details?: Record<string, unknown>;
}

export interface AdapterContext {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  logger: (message: string) => void;
  readMedia: (item: MediaItem) => Promise<MediaBlob>;
  /** Returns a public URL for a media item when one is configured, else null. */
  mediaPublicUrl: (item: MediaItem) => string | null;
  credentials: (platform: PlatformId) => PlatformCredentials;
  now: () => Date;
  forceMock: boolean;
  publicMediaBaseUrl: string | null;
  /**
   * Called by an adapter immediately after one part (or a TikTok publish id)
   * exists at the provider. The adapter must await it before continuing so the
   * id/permalink is persisted even if a later part fails.
   */
  onPartPublished?: (part: PublishedPart) => Promise<void> | void;
}

export interface PublishInput {
  account: Account;
  tokens: OAuthTokens | null;
  post: ResolvedPost;
}

export interface PublishResult {
  platformPostId: string;
  url?: string;
  mock: boolean;
  details?: Record<string, unknown>;
}

/** One reply/comment on a Threads post, as returned by the conversation edge. */
export interface ThreadsComment {
  id: string;
  text?: string;
  username?: string;
  timestamp?: string;
  replied_to?: string;
  is_reply?: boolean;
  hide_status?: string;
}

/** A recent Threads post together with its read-only conversation replies. */
export interface ThreadsPostComments {
  id: string;
  text?: string;
  permalink?: string;
  timestamp?: string;
  comments: ThreadsComment[];
}

export interface ThreadsCommentsResult {
  posts: ThreadsPostComments[];
}

/** One of the connected account's own recent Threads posts (for new-post polling). */
export interface ThreadsOwnPost {
  id: string;
  text?: string;
  permalink?: string;
  timestamp?: string;
}

export interface ThreadsPostsInput {
  account: Account;
  tokens: OAuthTokens | null;
  limitPosts: number;
}

export type ThreadsAutoReplyClassification = "spam" | "hostile" | "genuine";

/** A 30-minute auto-reply window opened for one published Threads post. */
export interface ThreadsAutoReplyWindow {
  postId: string;
  postText?: string;
  publishedAt: string;
  openedAt: string;
  expiresAt: string;
  status: "open" | "closed" | "stopped";
  closeReason?: string;
  lastPollAt?: string;
  closedAt?: string;
}

/** One auto-reply that was actually posted. */
export interface ThreadsAutoReplyReply {
  postId: string;
  commentId: string;
  commenter?: string;
  commentText?: string;
  replyText: string;
  replyId: string;
  permalink?: string;
  createdAt: string;
}

/** One spam/hostile comment that was deliberately not replied to. */
export interface ThreadsAutoReplyFlagged {
  postId: string;
  commentId: string;
  commenter?: string;
  commentText?: string;
  classification: Exclude<ThreadsAutoReplyClassification, "genuine">;
  createdAt: string;
}

export interface ThreadsAutoReplyLog {
  replies: ThreadsAutoReplyReply[];
  flagged: ThreadsAutoReplyFlagged[];
  windows: ThreadsAutoReplyWindow[];
}

/** Persisted state for the local Threads auto-reply feature. */
export interface ThreadsAutoReplyState extends ThreadsAutoReplyLog {
  /** Settings flag. The env toggle can still force the feature off. */
  enabled: boolean;
  lastDiscoveryAt?: string;
  seenPostIds: string[];
}

export interface ThreadsCommentsInput {
  account: Account;
  tokens: OAuthTokens | null;
  /** Maximum number of recent posts to inspect (the conversation is read for each). */
  limitPosts: number;
}

/** Stored credentials needed to post one explicit Threads reply. */
export interface ThreadsReplyAuth {
  account: Account;
  tokens: OAuthTokens | null;
}

/** Result of one explicit Threads reply-to-comment call. */
export interface ThreadsReplyResult {
  id: string;
  permalink?: string;
  /** True when the reply was simulated because Relay is in mock mode. */
  mock: boolean;
}

export interface PlatformAdapter {
  readonly platform: PlatformId;
  readonly limits: PlatformLimits;
  /** True when credentials are present for this platform. */
  isConfigured(ctx: AdapterContext): boolean;
  /** True when this adapter will call the real API (configured and not forced to mock). */
  isLive(ctx: AdapterContext): boolean;
  authorize(ctx: AdapterContext, req: AuthorizeRequest): Promise<AuthorizeResult>;
  exchange(ctx: AdapterContext, req: ExchangeRequest): Promise<ConnectResult>;
  publish(ctx: AdapterContext, input: PublishInput): Promise<PublishResult>;
  refresh?(ctx: AdapterContext, tokens: OAuthTokens): Promise<OAuthTokens>;
  /** Read-only: recent posts plus their replies. Currently implemented by Threads. */
  readComments?(ctx: AdapterContext, input: ThreadsCommentsInput): Promise<ThreadsCommentsResult>;
  /** Read-only: the account's own recent posts (used to discover newly published posts). */
  listOwnPosts?(ctx: AdapterContext, input: ThreadsPostsInput): Promise<ThreadsOwnPost[]>;
  /**
   * EXPLICIT-ONLY: post one reply to one comment. The scheduler never calls
   * this method; it runs only when the HTTP endpoint or MCP tool is invoked.
   */
  replyToComment?(
    ctx: AdapterContext,
    commentId: string,
    text: string,
    input: ThreadsReplyAuth,
  ): Promise<ThreadsReplyResult>;
}

export interface ValidationIssue {
  platform?: PlatformId;
  part?: number;
  code: string;
  message: string;
}

export interface PlatformValidation {
  ok: boolean;
  issues: ValidationIssue[];
}

export interface ValidationReport {
  ok: boolean;
  issues: ValidationIssue[];
  perPlatform: Record<PlatformId, PlatformValidation>;
  normalized?: Partial<Record<PlatformId, ResolvedPost>>;
}

export type PostResultStatus = "publishing" | "published" | "partial" | "failed";

export interface PostResult {
  platform: PlatformId;
  ok: boolean;
  mode: AccountMode;
  /** `partial` means at least one part was published, then a later part failed. */
  status?: PostResultStatus;
  postId?: string;
  url?: string;
  error?: string;
  /** 1-based part number that failed, when known. */
  failedPart?: number;
  /** Every part that reached the provider, in publish order. */
  publishedParts?: PublishedPart[];
  /** SHA-256 of the normalized content, used by the duplicate guard. */
  contentHash?: string;
  details?: Record<string, unknown>;
  publishedAt: string;
}

export type PostRecordStatus = "publishing" | "published" | "partial" | "failed";

export interface PostRecord {
  id: string;
  createdAt: string;
  scheduledFor?: string;
  draft: PostDraft;
  results: PostResult[];
  status?: PostRecordStatus;
}

export type QueueStatus = "pending" | "running" | "done" | "failed" | "canceled";

export interface QueueJob {
  id: string;
  createdAt: string;
  scheduleAt: string;
  draft: PostDraft;
  status: QueueStatus;
  attempts: number;
  lastError?: string;
  results?: PostResult[];
}

export interface PlatformStatus {
  platform: PlatformId;
  displayName: string;
  /** Credentials present (regardless of forced mock mode). */
  configured: boolean;
  /** Real API calls will be made. */
  live: boolean;
  connected: boolean;
  account?: Account;
}

export type BeginConnectResult =
  | { mode: "connected"; account: Account }
  | { mode: "redirect"; url: string; state: string };

export interface CreatePostResult {
  scheduled: boolean;
  jobId?: string;
  results: PostResult[];
  report: ValidationReport;
}

export interface SettingsView {
  dataDir: string;
  consoleUrl: string;
  mock: boolean;
  publicMediaBaseUrl: string | null;
  platforms: PlatformStatus[];
  passwordProtected: boolean;
  /** Effective local Threads auto-reply switch (env toggle AND the settings flag). */
  threadsAutoReplyEnabled: boolean;
  /** True when DEEPSEEK_API_KEY is present; without it auto-replies are skipped. */
  threadsAutoReplyConfigured: boolean;
}

export interface CredentialInfo {
  platform: PlatformId;
  configured: boolean;
  source: "env" | "settings" | "none";
}

export interface SchedulerStatus {
  running: boolean;
  ownedByThisProcess: boolean;
  intervalMs: number;
}
