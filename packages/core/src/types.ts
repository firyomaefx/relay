/**
 * Shared contracts for Relay: platforms, drafts, accounts, adapters, results.
 * This file is the integration surface between core, platforms, MCP and the web app.
 */

export type PlatformId = "x" | "threads" | "tiktok" | "youtube" | "instagram" | "linkedin";

export const PLATFORM_IDS = ["x", "threads", "tiktok", "youtube", "instagram", "linkedin"] as const satisfies readonly PlatformId[];

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
  /**
   * Instagram and TikTok: when the post contains a video, extract still frames
   * and publish them as a photo carousel instead of a video/Reel.
   */
  carouselFromVideo?: boolean;
  /** Number of still frames to extract (2-10). Defaults to 6. */
  carouselSlides?: number;
  disableComment?: boolean;
  /**
   * Threads and X: publish the post (or the parts of a thread) as a reply under
   * an existing PUBLISHED post id (part 1 replies to it, part 2 replies to
   * part 1, ...). Must be numeric. Threads and X ids differ, so a draft that
   * targets both needs options.x.replyToId and options.threads.replyToId.
   */
  replyToId?: string;
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
  /** Optional account id per platform. Omit to use the platform primary account. */
  accountIds?: Partial<Record<PlatformId, string>>;
  text?: string;
  media?: MediaItem[];
  /** Multi-part post: X thread, Threads chain. Takes precedence over `text`/`media`. */
  thread?: ThreadPartDraft[];
  /** ISO-8601 timestamp. When in the future the post is queued instead of published. */
  scheduleAt?: string;
  /** Repeat a scheduled post. The first run is at scheduleAt; count includes that run. */
  recurrence?: Recurrence;
  options?: Partial<Record<PlatformId, PlatformOptions>>;
  /** Shorthand for options.<platform>.replyToId when the draft targets only X or only Threads (alias: parentPostId). */
  replyToId?: string;
  parentPostId?: string;
  /**
   * Internal source tag shown in front of the post in Relay's queue and calendar
   * (for example "Claude" or "Grokbot"). Never sent to any platform. Max 40 characters.
   */
  label?: string;
}

/** A recurring/evergreen scheduled post. */
export interface Recurrence {
  interval: "daily" | "weekly";
  /** Total number of publishes, including the first. Omit for an open-ended series. */
  count?: number;
  /** ISO-8601 end time. No occurrence scheduled after this time. */
  until?: string;
}

/** One block of an X Article body (maps onto the DraftJS block types X accepts). */
export type ArticleBlockType =
  | "header-one"
  | "header-two"
  | "header-three"
  | "unstyled"
  | "blockquote"
  | "unordered-list-item"
  | "ordered-list-item"
  /** An inline image: text is a single space and `image` carries the file. */
  | "atomic";

/** An inline Article image. X uploads the file directly, so `path` is required. */
export interface ArticleImage extends MediaItem {
  /** Caption shown under the image on X (optional). */
  caption?: string;
}

export interface ArticleBlock {
  type: ArticleBlockType;
  text: string;
  /** Set on "atomic" blocks only. */
  image?: ArticleImage;
}

export interface ArticleImageInput {
  path?: string;
  url?: string;
  altText?: string;
  caption?: string;
}

/** One body section: optional heading, then paragraphs, then an optional image. */
export interface ArticleSection {
  heading?: string;
  paragraphs?: string[];
  image?: ArticleImageInput;
}

export interface ArticleImageInfo {
  path: string;
  mimeType?: string;
  bytes: number;
  width?: number;
  height?: number;
}

/** Input for an X Article: give `body` (sections) or `bodyMarkdown`, not both. */
export interface ArticleDraft {
  title: string;
  body?: ArticleSection[];
  bodyMarkdown?: string;
  /** Optional cover image. X uploads the file directly, so `path` is required. */
  cover?: MediaItem;
  /** ISO-8601. When in the future the article is queued instead of published. */
  scheduleAt?: string;
}

export interface ResolvedArticle {
  title: string;
  blocks: ArticleBlock[];
  cover?: MediaItem;
}

export interface ArticleValidationReport {
  ok: boolean;
  issues: ValidationIssue[];
  normalized?: ResolvedArticle;
  stats?: { blocks: number; chars: number; words: number; images?: number; imageFiles?: ArticleImageInfo[] };
}

export interface CreateArticleResult {
  scheduled: boolean;
  jobId?: string;
  scheduleAt?: string;
  results: PostResult[];
  report: ArticleValidationReport;
}

export interface ArticlePublishInput {
  account: Account;
  tokens: OAuthTokens | null;
  article: ResolvedArticle;
}

export interface DeletePostInput {
  account: Account;
  tokens: OAuthTokens | null;
}

export interface DeletePostResult {
  deleted: boolean;
  /** True when the delete was simulated (mock mode). */
  mock: boolean;
  /** The platform said the post does not exist (already deleted). */
  alreadyGone?: boolean;
}

export interface DeleteTarget {
  platform: PlatformId;
  postId: string;
  url?: string;
}

export type DeleteStatus = "deleted" | "already_gone" | "unsupported" | "failed";

export interface DeletePostOutcome {
  platform: PlatformId;
  postId: string;
  status: DeleteStatus;
  mock: boolean;
  error?: string;
  code?: string;
}

export interface RemoveQueueJobResult {
  found: boolean;
  removed: boolean;
  status?: QueueStatus;
  job?: QueueJob;
}

export interface ResolvedPart {
  text: string;
  media: MediaItem[];
}

export interface ResolvedPost {
  platform: PlatformId;
  /** Selected account id, resolved from PostDraft.accountIds. */
  accountId?: string;
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
  externalId?: string;
  label?: string;
  primaryForPlatform?: boolean;
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
  accountId?: string;
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
  accountId?: string;
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
  accountId?: string;
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
  accountId?: string;
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

/** One comment on one of the connected account's own posts (Threads, Instagram, YouTube). */
export interface OwnComment {
  platform: "threads" | "instagram" | "youtube";
  postId: string;
  commentId: string;
  author: string;
  text: string;
  createdAt: string;
  postCaption?: string;
}

export interface OwnCommentsInput {
  account: Account;
  tokens: OAuthTokens | null;
  /** Epoch ms. Only posts/comments newer than this are wanted. */
  sinceMs: number;
  /** Max own posts (or videos) to look at. */
  limitPosts: number;
  /** Stop collecting after about this many comments. */
  maxComments: number;
}

export interface ThreadsCommentsInput {
  account: Account;
  tokens: OAuthTokens | null;
  /** Epoch ms. When set, posts published before it are listed but their conversation is not fetched. */
  sinceMs?: number;
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
  /** Read-only: comments on the account's own recent posts. Implemented by Instagram and YouTube. */
  readOwnComments?(ctx: AdapterContext, input: OwnCommentsInput): Promise<OwnComment[]>;
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
  /** X only: create a draft Article and publish it. */
  publishArticle?(ctx: AdapterContext, input: ArticlePublishInput): Promise<PublishResult>;
  /**
   * EXPLICIT-ONLY: delete one published post. Implemented by X and Threads. The
   * scheduler never calls this.
   */
  deletePost?(ctx: AdapterContext, postId: string, input: DeletePostInput): Promise<DeletePostResult>;
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

/** A platform-specific preview of the draft after Relay adapts it. */
export interface PlatformPreview {
  platform: PlatformId;
  displayName: string;
  /** One entry per published part; single-part posts have one entry. */
  parts: string[];
  characterCounts: number[];
  maxTextLength: number;
  maxParts: number;
  mediaCount: number;
  /** The text was split, shortened, or otherwise adapted for this platform. */
  adapted: boolean;
  /** The draft cannot fit even after adaptation (for example, too many parts). */
  truncated: boolean;
  ok: boolean;
  issues: string[];
}

export interface DraftPreview {
  platforms: PlatformPreview[];
  sourcePartCount: number;
  generatedAt: string;
}

export type PostResultStatus = "publishing" | "published" | "partial" | "failed";

export interface PostResult {
  platform: PlatformId;
  accountId?: string;
  accountLabel?: string;
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
  /** Posts deleted on the platform through relay_delete. */
  deletions?: { postId: string; deletedAt: string; mock?: boolean }[];
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
  /** "article" for X Articles. Absent for normal posts. */
  kind?: "post" | "article";
  article?: ArticleDraft;
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
  /** "article" for X Articles. Absent for normal posts. */
  kind?: "post" | "article";
  article?: ArticleDraft;
  /** Content hash of a queued article, used to refuse duplicates. */
  contentHash?: string;
  /** Series identity for recurring posts. */
  seriesId?: string;
  /** 1-based occurrence within a recurring series. */
  occurrence?: number;
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



