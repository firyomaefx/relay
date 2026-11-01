import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  createDeepSeekReplyGenerator,
  ThreadsAutoReplyEngine,
  threadsAutoReplyEnvEnabled,
  type ReplyGenerator,
  type ThreadsAutoReplyTickResult,
} from "./autoreply.js";
import { CredentialStore, credentialsFilePath } from "./credentials.js";
import { AuthError, RelayError, errorMessage } from "./errors.js";
import { JsonStore, type DbData, type StoredAccount } from "./json-store.js";
import { acquireSchedulerLock, releaseSchedulerLock, schedulerLockOwner } from "./lock.js";
import { mediaPublicUrl, readMediaBlob } from "./media.js";
import { extractVideoCarousel } from "./video-carousel.js";
import { SecretBox } from "./secret-box.js";
import { parseLinkGuard, validateDraft } from "./validation.js";
import { buildDraftPreview } from "./preview.js";
import { articleContentHash, articleStandInDraft, validateArticleDraft } from "./article.js";
import {
  COMMENT_PLATFORMS,
  COMMENT_PLATFORM_LABEL,
  COMMENT_REPLY_MAX,
  MAX_REPLIED_COMMENTS,
  MAX_SEEN_COMMENTS,
  classifyComment,
  commentKey,
  isCommentPlatform,
  missingCommentScopes,
  reconnectMessage,
  replyTextWarnings,
  snippet,
  suggestedTemplate,
  type CommentPlatform,
  type CommentPlatformReport,
  type NewComment,
  type NewCommentsResult,
  type ReplyCommentResult,
} from "./comments.js";
import type {
  Account,
  AdapterContext,
  ArticleDraft,
  ArticleValidationReport,
  BeginConnectResult,
  CreateArticleResult,
  CreatePostResult,
  DeletePostOutcome,
  DeleteTarget,
  RemoveQueueJobResult,
  ResolvedArticle,
  OAuthTokens,
  OwnComment,
  PlatformAdapter,
  PlatformCredentials,
  PlatformId,
  PlatformLimits,
  PlatformStatus,
  PostDraft,
  PostRecord,
  PostResult,
  ProfileInfo,
  PublishedPart,
  QueueJob,
  ResolvedPost,
  SchedulerStatus,
  SettingsView,
  ThreadsAutoReplyLog,
  ThreadsCommentsResult,
  ThreadsOwnPost,
  ThreadsReplyResult,
} from "./types.js";
import { PLATFORM_IDS } from "./types.js";

const MAX_HISTORY = 500;
const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;
const DUPLICATE_WINDOW_MS = 30 * 60 * 1000;
/** A reply reservation older than this (crash mid-send) no longer blocks a retry. */
const PENDING_REPLY_TTL_MS = 15 * 60 * 1000;

const UNSUPPORTED_DELETE_REASON: Record<PlatformId, string> = {
  x: "X delete is not available in this build.",
  threads: "Threads delete is not available in this build.",
  tiktok: "Unsupported: the TikTok Content Posting API has no delete endpoint Relay can use. Delete the post in the TikTok app.",
  instagram: "Unsupported: the Instagram API has no endpoint to delete posts. Delete it in the Instagram app.",
  youtube:
    "Unsupported: Relay's YouTube login only has upload and read access, which cannot delete videos. Delete it in YouTube Studio.",
  linkedin: "LinkedIn delete is not available in this build. Delete the post in LinkedIn.",
};

/**
 * Stable SHA-256 of the content that will actually be sent to a platform.
 * Platform identity is part of the hash, so identical text on X and Threads
 * does not collide.
 */
export function contentHashFor(post: ResolvedPost): string {
  const payload = {
    platform: post.platform,
    parts: post.parts.map((part) => ({
      text: part.text,
      media: part.media.map((item) => item.url ?? item.path ?? ""),
    })),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export interface RelayServiceOptions {
  dataDir: string;
  adapters: PlatformAdapter[];
  env?: NodeJS.ProcessEnv;
  consoleUrl?: string;
  publicMediaBaseUrl?: string | null;
  forceMock?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  logger?: (message: string) => void;
  /** Pluggable brain for Threads auto-reply. Defaults to the DeepSeek generator. */
  replyGenerator?: ReplyGenerator;
  /** Test/ops override for the ~2 minute comment poll interval. */
  autoReplyPollIntervalMs?: number;
  /** Test/ops override for the 30 minute reply window. */
  autoReplyWindowMs?: number;
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export class RelayService {
  readonly dataDir: string;
  readonly mediaDir: string;
  readonly consoleUrl: string;
  readonly publicMediaBaseUrl: string | null;
  private readonly store: JsonStore;
  private readonly box: SecretBox;
  private readonly credentials: CredentialStore;
  private readonly adapters: Map<PlatformId, PlatformAdapter>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly forceMock: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly logger: (message: string) => void;
  private readonly autoReply: ThreadsAutoReplyEngine;

  private timer: NodeJS.Timeout | null = null;
  private schedulerIntervalMs = 15000;
  private lockHeld = false;
  private ticking = false;

  private constructor(options: {
    dataDir: string;
    mediaDir: string;
    consoleUrl: string;
    publicMediaBaseUrl: string | null;
    forceMock: boolean;
    fetchImpl: typeof fetch;
    env: NodeJS.ProcessEnv;
    now: () => Date;
    logger: (message: string) => void;
    store: JsonStore;
    box: SecretBox;
    credentials: CredentialStore;
    adapters: PlatformAdapter[];
    replyGenerator?: ReplyGenerator;
    autoReplyPollIntervalMs?: number;
    autoReplyWindowMs?: number;
  }) {
    this.dataDir = options.dataDir;
    this.mediaDir = options.mediaDir;
    this.consoleUrl = options.consoleUrl.replace(/\/+$/, "");
    this.publicMediaBaseUrl = options.publicMediaBaseUrl ?? null;
    this.store = options.store;
    this.box = options.box;
    this.credentials = options.credentials;
    this.adapters = new Map(options.adapters.map((adapter) => [adapter.platform, adapter]));
    this.env = options.env;
    this.forceMock = options.forceMock;
    this.fetchImpl = options.fetchImpl;
    this.now = options.now;
    this.logger = options.logger;
    this.autoReply = new ThreadsAutoReplyEngine({
      store: this.store,
      now: this.now,
      logger: this.logger,
      generator:
        options.replyGenerator ??
        createDeepSeekReplyGenerator({
          env: this.env,
          apiKey: () => this.getDeepSeekApiKey(),
          fetchImpl: this.fetchImpl,
          logger: this.logger,
        }),
      readComments: (postId) => this.readThreadsPostComments(postId),
      listOwnPosts: () => this.listThreadsOwnPosts(),
      reply: (commentId, text) => this.replyToThreadsComment(commentId, text),
      envEnabled: threadsAutoReplyEnvEnabled(this.env),
      ...(options.autoReplyPollIntervalMs !== undefined
        ? { pollIntervalMs: options.autoReplyPollIntervalMs }
        : {}),
      ...(options.autoReplyWindowMs !== undefined ? { windowMs: options.autoReplyWindowMs } : {}),
    });
  }

  static async open(options: RelayServiceOptions): Promise<RelayService> {
    const dataDir = path.resolve(options.dataDir);
    // RELAY_MEDIA_DIR overrides the folder served publicly at /media (default: <data dir>/media).
    const mediaDirEnv = (options.env ?? process.env).RELAY_MEDIA_DIR?.trim();
    const mediaDir = mediaDirEnv ? path.resolve(mediaDirEnv) : path.join(dataDir, "media");
    await mkdir(mediaDir, { recursive: true });

    const box = await SecretBox.open(dataDir);
    const store = await JsonStore.open(path.join(dataDir, "db.json"));
    const env = options.env ?? process.env;
    const credentials = await CredentialStore.open(credentialsFilePath(dataDir), box, env);

    const consoleUrl = options.consoleUrl ?? env.RELAY_CONSOLE_URL ?? "http://127.0.0.1:4317";
    const forceMock = Boolean(options.forceMock) || env.RELAY_MOCK === "1";

    const adapters = [...options.adapters];
    for (const platform of PLATFORM_IDS) {
      if (!adapters.some((adapter) => adapter.platform === platform)) {
        throw new RelayError(`No adapter registered for ${platform}`, "adapter_missing");
      }
    }

    return new RelayService({
      dataDir,
      mediaDir,
      consoleUrl,
      publicMediaBaseUrl: options.publicMediaBaseUrl ?? env.RELAY_PUBLIC_MEDIA_BASE_URL ?? null,
      forceMock,
      fetchImpl: options.fetchImpl ?? fetch,
      env,
      now: options.now ?? (() => new Date()),
      logger: options.logger ?? ((message) => console.log(`[relay] ${message}`)),
      store,
      box,
      credentials,
      adapters,
      replyGenerator: options.replyGenerator,
      autoReplyPollIntervalMs: options.autoReplyPollIntervalMs,
      autoReplyWindowMs: options.autoReplyWindowMs,
    });
  }

  get isMockForced(): boolean {
    return this.forceMock;
  }

  getAdapter(platform: PlatformId): PlatformAdapter {
    const adapter = this.adapters.get(platform);
    if (!adapter) throw new RelayError(`Unknown platform: ${platform}`, "platform_unknown");
    return adapter;
  }

  platformLimits(): PlatformLimits[] {
    return [...this.adapters.values()].map((adapter) => adapter.limits);
  }

  private adapterContext(onPartPublished?: AdapterContext["onPartPublished"]): AdapterContext {
    return {
      dataDir: this.dataDir,
      env: this.env,
      fetch: this.fetchImpl,
      logger: this.logger,
      readMedia: (item) => readMediaBlob(item),
      mediaPublicUrl: (item) => mediaPublicUrl(item, this.publicMediaBaseUrl, this.mediaDir),
      credentials: (platform) => this.credentials.get(platform),
      now: this.now,
      forceMock: this.forceMock,
      publicMediaBaseUrl: this.publicMediaBaseUrl,
      ...(onPartPublished ? { onPartPublished } : {}),
    };
  }

  private adapterIsLive(adapter: PlatformAdapter): boolean {
    return !this.forceMock && adapter.isLive(this.adapterContext());
  }

  private storedAccount(db: DbData, platform: PlatformId, accountId?: string) {
    if (accountId) {
      const primary = db.accounts[platform];
      if (primary?.account.id === accountId) return primary;
      return db.extraAccounts[accountId];
    }
    return db.accounts[platform];
  }

  private setStoredSecret(db: DbData, platform: PlatformId, accountId: string, secret: StoredAccount["secret"]): void {
    const current = this.storedAccount(db, platform, accountId);
    if (!current) return;
    if (db.accounts[platform]?.account.id === accountId) {
      db.accounts[platform] = { account: current.account, secret };
    } else {
      db.extraAccounts[accountId] = { account: current.account, secret };
    }
  }

  async accounts(): Promise<Account[]> {
    await this.store.refresh();
    return this.store.read((db) => {
      const primary = PLATFORM_IDS.map((platform) => db.accounts[platform]?.account)
        .filter((account): account is Account => Boolean(account))
        .map((account) => ({ ...account, primaryForPlatform: true, label: account.label || `${account.platform} account` }));
      const extras = Object.values(db.extraAccounts ?? {}).map((entry) => ({
        ...entry.account,
        primaryForPlatform: false,
        label: entry.account.label || `${entry.account.platform} account`,
      }));
      return [...primary, ...extras.filter((account) => !primary.some((entry) => entry.id === account.id))];
    });
  }

  async platformStatuses(): Promise<PlatformStatus[]> {
    await this.store.refresh();
    const ctx = this.adapterContext();
    return PLATFORM_IDS.map((platform) => {
      const adapter = this.getAdapter(platform);
      const stored = this.store.read((db) => db.accounts[platform]);
      return {
        platform,
        displayName: adapter.limits.displayName,
        configured: adapter.isConfigured(ctx),
        live: this.adapterIsLive(adapter),
        connected: Boolean(stored),
        account: stored?.account,
      };
    });
  }

  credentialInfos() {
    return this.credentials.list();
  }

  async getSettings(): Promise<SettingsView> {
    await this.store.refresh();
    return {
      dataDir: this.dataDir,
      consoleUrl: this.consoleUrl,
      mock: this.forceMock,
      publicMediaBaseUrl: this.publicMediaBaseUrl,
      passwordProtected: Boolean(this.env.RELAY_CONSOLE_PASSWORD),
      platforms: await this.platformStatuses(),
      threadsAutoReplyEnabled: this.autoReply.isEnabled(),
      threadsAutoReplyConfigured: Boolean(this.getDeepSeekApiKey()),
    };
  }

  /** DeepSeek key from the environment or the encrypted console setting. */
  getDeepSeekApiKey(): string | undefined {
    const envKey = this.env.DEEPSEEK_API_KEY?.trim();
    if (envKey) return envKey;
    const secret = this.store.read((db) => db.deepseekSecret);
    if (!secret) return undefined;
    try {
      return this.box.decrypt<{ apiKey?: string }>(secret)?.apiKey?.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /** Save or clear the DeepSeek key. The key is encrypted at rest. */
  async setDeepSeekApiKey(apiKey: string | null): Promise<boolean> {
    const trimmed = apiKey?.trim() ?? "";
    await this.store.mutate((db) => {
      db.deepseekSecret = trimmed ? this.box.encrypt({ apiKey: trimmed }) : null;
    });
    return Boolean(trimmed);
  }

  /** Effective auto-reply switch (env toggle AND the persisted settings flag). */
  isThreadsAutoReplyEnabled(): boolean {
    return this.autoReply.isEnabled();
  }

  /** Persisted settings flag for the local Threads auto-reply feature. */
  async setThreadsAutoReplyEnabled(enabled: boolean): Promise<boolean> {
    return this.autoReply.setEnabled(Boolean(enabled));
  }

  /** Persisted reply/flag/window log for GET /api/threads/autoreply/log. */
  async threadsAutoReplyLog(): Promise<ThreadsAutoReplyLog> {
    return this.autoReply.getLog();
  }

  /**
   * Runs one window/discovery pass. The scheduler calls this on every tick; the
   * engine itself only polls each window every ~2 minutes.
   */
  async runThreadsAutoReplyTick(): Promise<ThreadsAutoReplyTickResult> {
    return this.autoReply.tick();
  }

  /** Opens the 30-minute auto-reply window for a freshly published Threads post. */
  async openThreadsAutoReplyWindow(postId: string, publishedAt: string, postText?: string): Promise<boolean> {
    return this.autoReply.openWindow(postId, publishedAt, postText);
  }

  async validate(draft: PostDraft) {
    const adapters = new Map<PlatformId, PlatformAdapter>();
    for (const [platform, adapter] of this.adapters) adapters.set(platform, adapter);
    const linkGuard = parseLinkGuard(this.env);
    return validateDraft(draft, adapters, {
      mediaPublicUrl: (item) => mediaPublicUrl(item, this.publicMediaBaseUrl, this.mediaDir),
      isLive: (platform) => this.adapterIsLive(this.getAdapter(platform)),
      ...(linkGuard ? { linkGuard } : {}),
      now: () => this.now().getTime(),
    });
  }

  /** Per-platform previews and auto-adapted variants without publishing. */
  async preview(draft: PostDraft) {
    const report = await this.validate(draft);
    return buildDraftPreview(draft, this.platformLimits(), report);
  }

  async beginConnect(platform: PlatformId, options: { redirectBase?: string; accountId?: string; label?: string } = {}): Promise<BeginConnectResult> {
    const adapter = this.getAdapter(platform);
    const ctx = this.adapterContext();
    // Google OAuth web clients require a registered redirect URI. localhost is
    // allowed over HTTP; the console's public tunnel URL may change, so YouTube
    // defaults to the stable local callback unless explicitly overridden.
    const youtubeBase =
      this.env.YOUTUBE_REDIRECT_BASE?.trim() || `http://localhost:${this.env.RELAY_PORT?.trim() || "4317"}`;
    const base = (options.redirectBase ?? (platform === "youtube" ? youtubeBase : this.consoleUrl)).replace(/\/+$/, "");
    const redirectUri = `${base}/auth/callback/${platform}`;

    if (!this.adapterIsLive(adapter)) {
      const result = await adapter.authorize(ctx, { state: "mock", codeVerifier: "mock", redirectUri });
      if (result.kind !== "mock") {
        throw new RelayError(`${platform} adapter unexpectedly requested a redirect in simulated mode`, "adapter_state");
      }
      const account = await this.saveAccount(platform, result.profile, null, "mock", result.scopes, { accountId: options.accountId, label: options.label });
      return { mode: "connected", account };
    }

    const state = randomToken(24);
    const codeVerifier = randomToken(48);
    await this.store.mutate((db) => {
      db.oauth[state] = { platform, ...(options.accountId ? { accountId: options.accountId } : {}), ...(options.label ? { label: options.label } : {}), codeVerifier, redirectUri, createdAt: this.now().toISOString() };
    });
    const result = await adapter.authorize(ctx, { state, codeVerifier, redirectUri });
    if (result.kind !== "redirect") {
      throw new RelayError(`${platform} adapter did not return a sign-in URL`, "adapter_state");
    }
    return { mode: "redirect", url: result.url, state };
  }

  async completeConnect(platform: PlatformId, params: { code: string; state: string }): Promise<Account> {
    const adapter = this.getAdapter(platform);
    await this.store.refresh();
    const pending = this.store.read((db) => db.oauth[params.state]);
    if (!pending || pending.platform !== platform) {
      throw new RelayError("Sign-in state is invalid or already used. Start again.", "oauth_state_invalid");
    }
    if (this.now().getTime() - Date.parse(pending.createdAt) > OAUTH_STATE_TTL_MS) {
      await this.store.mutate((db) => {
        delete db.oauth[params.state];
      });
      throw new RelayError("Sign-in took too long. Start again.", "oauth_state_expired");
    }

    const result = await adapter.exchange(this.adapterContext(), {
      code: params.code,
      state: params.state,
      codeVerifier: pending.codeVerifier,
      redirectUri: pending.redirectUri,
    });
    const account = await this.saveAccount(platform, result.profile, result.tokens, "live", result.scopes, { accountId: pending.accountId, label: pending.label });
    await this.store.mutate((db) => {
      delete db.oauth[params.state];
    });
    return account;
  }

  private async saveAccount(
    platform: PlatformId,
    profile: ProfileInfo,
    tokens: OAuthTokens | null,
    mode: "live" | "mock",
    scopes: string[],
    options: { accountId?: string; label?: string } = {},
  ): Promise<Account> {
    const id = options.accountId || `${platform}:${profile.externalId || profile.handle}`;
    const account: Account = {
      id,
      platform,
      handle: profile.handle,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
      mode,
      connectedAt: this.now().toISOString(),
      scopes,
      externalId: profile.externalId,
      label: options.label?.trim() || `${platform} account`,
    };
    const secret = tokens ? this.box.encrypt(tokens) : null;
    await this.store.mutate((db) => {
      const primary = db.accounts[platform];
      if (!primary) {
        account.primaryForPlatform = true;
        db.accounts[platform] = { account, secret };
        return;
      }
      if (primary.account.id === id) {
        account.primaryForPlatform = true;
        db.accounts[platform] = { account, secret };
        return;
      }
      account.primaryForPlatform = false;
      db.extraAccounts[id] = { account, secret };
    });
    return account;
  }

  async disconnect(platform: PlatformId, accountId?: string): Promise<boolean> {
    await this.store.refresh();
    const existed = this.store.read((db) => Boolean(this.storedAccount(db, platform, accountId)));
    await this.store.mutate((db) => {
      if (!accountId) {
        delete db.accounts[platform];
        for (const [id, stored] of Object.entries(db.extraAccounts)) {
          if (stored.account.platform === platform) delete db.extraAccounts[id];
        }
      } else {
        const primary = db.accounts[platform];
        if (primary?.account.id === accountId) delete db.accounts[platform];
        else delete db.extraAccounts[accountId];
        // Keep a platform default when other accounts remain.
        if (!db.accounts[platform]) {
          const next = Object.entries(db.extraAccounts).find(([, stored]) => stored.account.platform === platform);
          if (next) {
            const [id, stored] = next;
            stored.account.primaryForPlatform = true;
            db.accounts[platform] = stored;
            delete db.extraAccounts[id];
          }
        }
      }
      for (const [state, pending] of Object.entries(db.oauth)) {
        if (pending.platform === platform && (!accountId || pending.accountId === accountId)) delete db.oauth[state];
      }
    });
    return existed;
  }

  async createPost(
    draft: PostDraft,
    options: { force?: boolean } | boolean = {},
  ): Promise<CreatePostResult> {
    await this.store.refresh();
    const report = await this.validate(draft);
    if (!report.ok || !report.normalized) {
      return { scheduled: false, results: [], report };
    }

    const force = typeof options === "boolean" ? options : Boolean(options?.force);
    await this.assertNotDuplicate(report.normalized, force);

    const scheduleAt = draft.scheduleAt ? Date.parse(draft.scheduleAt) : undefined;
    if (draft.recurrence) {
      this.assertRecurrenceValid(draft, scheduleAt);
    }
    if (scheduleAt !== undefined && scheduleAt > this.now().getTime() + 1000) {
      const job: QueueJob = {
        id: `job_${randomUUID()}`,
        createdAt: this.now().toISOString(),
        scheduleAt: new Date(scheduleAt).toISOString(),
        draft,
        status: "pending",
        attempts: 0,
        ...(draft.recurrence ? { seriesId: "", occurrence: 1 } : {}),
      };
      if (job.seriesId === "") job.seriesId = job.id;
      await this.store.mutate((db) => {
        db.queue.push(job);
      });
      return { scheduled: true, jobId: job.id, results: [], report };
    }

    const record = await this.beginPostRecord(draft, undefined);
    const results = await this.publishResolved(report.normalized, record.id);
    await this.finalizePostRecord(record.id, results);
    return { scheduled: false, results, report };
  }

  private assertRecurrenceValid(draft: PostDraft, scheduleAt: number | undefined): void {
    const recurrence = draft.recurrence;
    if (!recurrence) return;
    if (scheduleAt === undefined || scheduleAt <= this.now().getTime() + 1000) {
      throw new RelayError(
        "A recurring post needs a future scheduleAt.",
        "recurrence_requires_future_schedule",
        undefined,
        400,
      );
    }
    if (recurrence.interval !== "daily" && recurrence.interval !== "weekly") {
      throw new RelayError(
        'Recurrence interval must be "daily" or "weekly".',
        "recurrence_interval_invalid",
        undefined,
        400,
      );
    }
    if (recurrence.count !== undefined) {
      if (!Number.isInteger(recurrence.count) || recurrence.count < 2 || recurrence.count > 104) {
        throw new RelayError(
          "Recurrence count must be an integer from 2 to 104.",
          "recurrence_count_invalid",
          undefined,
          400,
        );
      }
    }
    if (recurrence.until !== undefined) {
      const until = Date.parse(recurrence.until);
      if (Number.isNaN(until) || until <= scheduleAt) {
        throw new RelayError(
          "Recurrence until must be a valid ISO timestamp after the first schedule.",
          "recurrence_until_invalid",
          undefined,
          400,
        );
      }
    }
  }

  private nextRecurringJob(job: QueueJob): QueueJob | null {
    const recurrence = job.draft.recurrence;
    if (!recurrence) return null;
    const occurrence = job.occurrence ?? 1;
    if (recurrence.count !== undefined && occurrence >= recurrence.count) return null;
    const current = Date.parse(job.scheduleAt);
    if (Number.isNaN(current)) return null;
    const next = current + (recurrence.interval === "weekly" ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000);
    if (recurrence.until && next > Date.parse(recurrence.until)) return null;
    const scheduleAt = new Date(next).toISOString();
    return {
      id: `job_${randomUUID()}`,
      createdAt: this.now().toISOString(),
      scheduleAt,
      draft: { ...job.draft, scheduleAt },
      status: "pending",
      attempts: 0,
      seriesId: job.seriesId ?? job.id,
      occurrence: occurrence + 1,
    };
  }

  /**
   * Creates the history record before publishing so adapters can append each
   * part to the same record as soon as the provider returns an id.
   */
  private async beginPostRecord(
    draft: PostDraft,
    scheduledFor: string | undefined,
    extra: { kind?: "post" | "article"; article?: ArticleDraft } = {},
  ): Promise<PostRecord> {
    const record: PostRecord = {
      id: `post_${randomUUID()}`,
      createdAt: this.now().toISOString(),
      scheduledFor,
      draft,
      results: [],
      status: "publishing",
      ...(extra.kind ? { kind: extra.kind } : {}),
      ...(extra.article ? { article: extra.article } : {}),
    };
    await this.store.mutate((db) => {
      db.posts.unshift(record);
      db.posts = db.posts.slice(0, MAX_HISTORY);
    });
    return record;
  }

  private async appendPublishedPart(
    recordId: string,
    platform: PlatformId,
    mode: "live" | "mock",
    part: PublishedPart,
  ): Promise<void> {
    await this.store.mutate((db) => {
      const record = db.posts.find((entry) => entry.id === recordId);
      if (!record) return;
      let result = record.results.find((entry) => entry.platform === platform);
      if (!result) {
        result = {
          platform,
          ok: false,
          mode,
          status: "publishing",
          publishedAt: this.now().toISOString(),
          publishedParts: [],
        };
        record.results.push(result);
      }
      result.publishedParts = [...(result.publishedParts ?? []), part];
      if (!result.postId) {
        result.postId = part.postId;
        result.url = part.url;
      }
    });
  }

  private async finalizeRecordResult(recordId: string, result: PostResult): Promise<void> {
    await this.store.mutate((db) => {
      const record = db.posts.find((entry) => entry.id === recordId);
      if (!record) return;
      const index = record.results.findIndex((entry) => entry.platform === result.platform);
      if (index >= 0) record.results[index] = result;
      else record.results.push(result);
    });
  }

  private async finalizePostRecord(recordId: string, results: PostResult[]): Promise<void> {
    await this.store.mutate((db) => {
      const record = db.posts.find((entry) => entry.id === recordId);
      if (!record) return;
      record.results = results;
      const succeeded = results.some((result) => result.ok);
      const partiallyPublished = results.some((result) => result.status === "partial");
      const failed = results.some((result) => !result.ok || result.status === "failed");
      record.status = partiallyPublished || (failed && succeeded) ? "partial" : failed ? "failed" : "published";
    });
  }

  /** Refuses a repeat of the same normalized content within the guard window. */
  private async assertNotDuplicate(
    normalized: Partial<Record<PlatformId, ResolvedPost>>,
    force: boolean,
  ): Promise<void> {
    if (force) return;
    const cutoff = this.now().getTime() - DUPLICATE_WINDOW_MS;
    const hashes = new Map<PlatformId, string>();
    for (const platform of PLATFORM_IDS) {
      const post = normalized[platform];
      if (post) hashes.set(platform, contentHashFor(post));
    }

    const duplicate = this.store.read((db) => {
      for (const record of db.posts) {
        const createdAt = Date.parse(record.createdAt);
        if (!Number.isFinite(createdAt) || createdAt < cutoff) continue;
        for (const result of record.results) {
          if (!result.ok || !result.contentHash) continue;
          if (hashes.get(result.platform) !== result.contentHash) continue;
          return { result, record };
        }
      }
      return null;
    });

    if (!duplicate) return;
    const { result, record } = duplicate;
    const ageMinutes = Math.max(0, Math.round((this.now().getTime() - Date.parse(record.createdAt)) / 60000));
    throw new RelayError(
      `The same content was already published to ${result.platform} ${ageMinutes} minute(s) ago (${record.createdAt}). ` +
        `Pass force: true to publish it again.`,
      "duplicate_recent_post",
      {
        platform: result.platform,
        contentHash: result.contentHash,
        previousPostId: result.postId,
        previousUrl: result.url,
        previousRecordId: record.id,
        previousCreatedAt: record.createdAt,
      },
      409,
    );
  }

  private async publishResolved(
    normalized: Partial<Record<PlatformId, ResolvedPost>>,
    recordId?: string,
  ): Promise<PostResult[]> {
    const results: PostResult[] = [];
    for (const platform of PLATFORM_IDS) {
      const post = normalized[platform];
      if (!post) continue;
      const result = await this.publishOne(post, recordId);
      results.push(result);
      if (recordId) await this.finalizeRecordResult(recordId, result);
    }
    return results;
  }

  private async publishOne(post: ResolvedPost, recordId?: string): Promise<PostResult> {
    const stored = this.store.read((db) => this.storedAccount(db, post.platform, post.accountId));
    const publishedAt = this.now().toISOString();
    const contentHash = contentHashFor(post);
    if (!stored) {
      return {
        platform: post.platform,
        ok: false,
        mode: "mock",
        status: "failed",
        error: `No ${post.platform} account connected. Sign in from the console first.`,
        contentHash,
        publishedAt,
      };
    }
    const adapter = this.getAdapter(post.platform);
    const publishedParts: PublishedPart[] = [];
    const ctx = this.adapterContext(
      recordId
        ? async (part) => {
            const event: PublishedPart = { ...part, platform: post.platform };
            publishedParts.push(event);
            await this.appendPublishedPart(recordId, post.platform, stored.account.mode, event);
          }
        : undefined,
    );
    let tokens = stored.secret ? this.box.decrypt<OAuthTokens>(stored.secret) : null;
    let publishPost = post;
    if (
      (post.platform === "instagram" || post.platform === "tiktok") &&
      post.options.carouselFromVideo
    ) {
      const video = post.parts.flatMap((part) => part.media).find((item) => item.kind === "video");
      if (video) {
        const frames = await extractVideoCarousel(video, this.mediaDir, post.options.carouselSlides ?? 6);
        publishPost = {
          ...post,
          parts: post.parts.map((part, index) =>
            index === 0
              ? { ...part, media: frames }
              : part,
          ),
        };
      }
    }

    try {
      let result;
      try {
        result = await adapter.publish(ctx, { account: stored.account, tokens, post: publishPost });
      } catch (error) {
        // Never replay a whole thread after some parts already exist: the retry
        // would publish those parts twice. Return the partial success instead.
        if (error instanceof AuthError && publishedParts.length === 0 && tokens?.refreshToken && adapter.refresh) {
          const refreshed = await adapter.refresh(ctx, tokens);
          tokens = refreshed;
          await this.store.mutate((db) => {
            this.setStoredSecret(db, post.platform, stored.account.id, this.box.encrypt(refreshed));
          });
          result = await adapter.publish(ctx, { account: stored.account, tokens, post: publishPost });
        } else {
          throw error;
        }
      }
      const first = publishedParts[0];
      const publishedResult: PostResult = {
        platform: post.platform,
        accountId: stored.account.id,
        accountLabel: stored.account.label,
        ok: true,
        status: "published",
        mode: result.mock ? "mock" : "live",
        postId: first?.postId ?? result.platformPostId,
        url: first?.url ?? result.url,
        publishedParts: publishedParts.length > 0 ? publishedParts : undefined,
        contentHash,
        details: result.details,
        publishedAt,
      };
      await this.maybeOpenAutoReplyWindow(post, publishedResult);
      return publishedResult;
    } catch (error) {
      const errorText = errorMessage(error);
      if (publishedParts.length > 0) {
        const first = publishedParts[0]!;
        const partialResult: PostResult = {
          platform: post.platform,
          accountId: stored.account.id,
          accountLabel: stored.account.label,
          ok: true,
          status: "partial",
          mode: stored.account.mode,
          postId: first.postId,
          url: first.url,
          error: errorText,
          failedPart: publishedParts.length + 1,
          publishedParts,
          contentHash,
          publishedAt,
        };
        await this.maybeOpenAutoReplyWindow(post, partialResult);
        return partialResult;
      }
      return {
        platform: post.platform,
        accountId: stored.account.id,
        accountLabel: stored.account.label,
        ok: false,
        status: "failed",
        mode: stored.account.mode,
        error: errorText,
        contentHash,
        publishedAt,
      };
    }
  }

  /** Publishing a Threads post starts its local 30-minute auto-reply window. */
  private async maybeOpenAutoReplyWindow(post: ResolvedPost, result: PostResult): Promise<void> {
    if (post.platform !== "threads" || !result.ok || !result.postId) return;
    // Auto-reply is currently scoped to the platform's primary Threads account.
    // Connecting extra Threads accounts must never make replies come from the
    // wrong account. Per-account auto-reply is a later upgrade.
    if (post.accountId) {
      const primary = this.store.read((db) => db.accounts.threads?.account.id);
      if (primary && primary !== post.accountId) return;
    }
    try {
      await this.autoReply.openWindow(result.postId, result.publishedAt, post.parts[0]?.text);
    } catch (error) {
      this.logger(`[threads-autoreply] could not open window for ${result.postId}: ${errorMessage(error)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // X Articles (long-form posts)
  // ---------------------------------------------------------------------------

  /** Dry run: checks the draft, the X connection and the granted scopes. Publishes nothing. */
  async validateArticle(draft: ArticleDraft): Promise<ArticleValidationReport> {
    await this.store.refresh();
    const report = await validateArticleDraft(draft);
    const issues = [...report.issues];
    const stored = this.store.read((db) => db.accounts.x);
    if (!stored) {
      issues.push({
        platform: "x",
        code: "x_not_connected",
        message: "No X account is connected. Connect X first (relay_connect).",
      });
    } else if (stored.account.mode === "live" && Array.isArray(stored.account.scopes) && stored.account.scopes.length > 0) {
      const scopes = stored.account.scopes;
      const needed = ["tweet.write", ...(draft?.cover || (report.stats?.images ?? 0) > 0 ? ["media.write"] : [])];
      for (const scope of needed) {
        if (!scopes.includes(scope)) {
          issues.push({
            platform: "x",
            code: "x_scope_missing",
            message: `The connected X account lacks the ${scope} scope. Reconnect X and approve it.`,
          });
        }
      }
    }
    return { ...report, ok: issues.length === 0, issues, ...(issues.length === 0 ? {} : { normalized: undefined }) };
  }

  /**
   * Publishes an X Article now, or queues it when scheduleAt is in the future.
   * X has no scheduling for Articles, so the draft is created and published on X
   * at the scheduled time; until then nothing exists on X.
   */
  async createArticle(draft: ArticleDraft, options: { force?: boolean } = {}): Promise<CreateArticleResult> {
    const report = await this.validateArticle(draft);
    if (!report.ok || !report.normalized) return { scheduled: false, results: [], report };

    const hash = articleContentHash(report.normalized);
    this.assertArticleNotDuplicate(hash, Boolean(options.force));

    const standIn = articleStandInDraft(draft);
    const scheduleAt = draft.scheduleAt ? Date.parse(draft.scheduleAt) : undefined;
    if (scheduleAt !== undefined && scheduleAt > this.now().getTime() + 1000) {
      const job: QueueJob = {
        id: `job_${randomUUID()}`,
        createdAt: this.now().toISOString(),
        scheduleAt: new Date(scheduleAt).toISOString(),
        draft: standIn,
        kind: "article",
        article: draft,
        contentHash: hash,
        status: "pending",
        attempts: 0,
      };
      await this.store.mutate((db) => {
        db.queue.push(job);
      });
      return { scheduled: true, jobId: job.id, scheduleAt: job.scheduleAt, results: [], report };
    }

    const record = await this.beginPostRecord(standIn, undefined, { kind: "article", article: draft });
    const result = await this.publishArticleOne(report.normalized, record.id, hash);
    await this.finalizePostRecord(record.id, [result]);
    return { scheduled: false, results: [result], report };
  }

  /** Refuses the same article twice within the guard window, or while one is already queued. */
  private assertArticleNotDuplicate(hash: string, force: boolean): void {
    if (force) return;
    const cutoff = this.now().getTime() - DUPLICATE_WINDOW_MS;
    const found = this.store.read((db) => {
      const queued = db.queue.find((job) => job.status === "pending" && job.kind === "article" && job.contentHash === hash);
      if (queued) return { queued };
      for (const record of db.posts) {
        const createdAt = Date.parse(record.createdAt);
        if (!Number.isFinite(createdAt) || createdAt < cutoff) continue;
        const hit = record.results.find((result) => result.ok && result.contentHash === hash);
        if (hit) return { record, hit };
      }
      return null;
    });
    if (!found) return;
    if ("queued" in found && found.queued) {
      throw new RelayError(
        `This article is already queued for ${found.queued.scheduleAt} (job ${found.queued.id}). Remove it with relay_delete first, or pass force: true.`,
        "duplicate_queued_article",
        { jobId: found.queued.id, scheduleAt: found.queued.scheduleAt },
        409,
      );
    }
    const { record, hit } = found as { record: PostRecord; hit: PostResult };
    throw new RelayError(
      `The same article was already published ${Math.max(0, Math.round((this.now().getTime() - Date.parse(record.createdAt)) / 60000))} minute(s) ago (${record.createdAt}). Pass force: true to publish it again.`,
      "duplicate_recent_post",
      { previousPostId: hit.postId, previousUrl: hit.url, previousRecordId: record.id },
      409,
    );
  }

  private async persistRefreshedTokens(platform: PlatformId, refreshed: OAuthTokens): Promise<void> {
    await this.store.mutate((db) => {
      const current = db.accounts[platform];
      if (current) db.accounts[platform] = { account: current.account, secret: this.box.encrypt(refreshed) };
    });
  }

  private async publishArticleOne(article: ResolvedArticle, recordId: string | undefined, contentHash: string): Promise<PostResult> {
    await this.store.refresh();
    const stored = this.store.read((db) => db.accounts.x);
    const publishedAt = this.now().toISOString();
    const failed = (error: string, mode: "live" | "mock", details?: Record<string, unknown>): PostResult => ({
      platform: "x",
      ok: false,
      status: "failed",
      mode,
      error,
      contentHash,
      ...(details ? { details } : {}),
      publishedAt,
    });
    if (!stored) return failed("No X account connected. Sign in from the console first.", "mock");
    const adapter = this.getAdapter("x");
    if (!adapter.publishArticle) return failed("The X adapter cannot publish Articles.", stored.account.mode);

    const ctx = this.adapterContext();
    let tokens = stored.secret ? this.box.decrypt<OAuthTokens>(stored.secret) : null;
    try {
      let result;
      try {
        result = await adapter.publishArticle(ctx, { account: stored.account, tokens, article });
      } catch (error) {
        // Safe to retry: the adapter only throws AuthError before anything exists on X.
        if (error instanceof AuthError && tokens?.refreshToken && adapter.refresh) {
          tokens = await adapter.refresh(ctx, tokens);
          await this.persistRefreshedTokens("x", tokens);
          result = await adapter.publishArticle(ctx, { account: stored.account, tokens, article });
        } else {
          throw error;
        }
      }
      const part: PublishedPart = {
        platform: "x",
        part: 1,
        postId: result.platformPostId,
        url: result.url,
        details: { kind: "article", ...(result.details ?? {}) },
      };
      return {
        platform: "x",
        ok: true,
        status: "published",
        mode: result.mock ? "mock" : "live",
        postId: result.platformPostId,
        url: result.url,
        publishedParts: [part],
        contentHash,
        details: { kind: "article", title: article.title, ...(result.details ?? {}) },
        publishedAt,
      };
    } catch (error) {
      const details = error instanceof RelayError && error.details && typeof error.details === "object"
        ? (error.details as Record<string, unknown>)
        : undefined;
      const draftId = details && typeof details.articleDraftId === "string" ? details.articleDraftId : undefined;
      return failed(errorMessage(error), stored.account.mode, draftId ? { kind: "article", articleDraftId: draftId } : undefined);
    }
  }

  private async runArticleJob(job: QueueJob): Promise<void> {
    const article = job.article;
    const standIn = job.draft ?? articleStandInDraft(article ?? { title: "" });
    const record = await this.beginPostRecord(standIn, job.scheduleAt, { kind: "article", article });
    let result: PostResult;
    if (!article) {
      result = {
        platform: "x", ok: false, status: "failed", mode: "mock",
        error: "Queued article has no content", publishedAt: this.now().toISOString(),
      };
    } else {
      const report = await this.validateArticle(article);
      if (!report.ok || !report.normalized) {
        const message = report.issues.slice(0, 3).map((issue) => issue.message).join("; ");
        result = {
          platform: "x", ok: false, status: "failed", mode: "mock",
          error: `Scheduled article failed validation: ${message || "invalid article"}`,
          publishedAt: this.now().toISOString(),
        };
      } else {
        const hash = articleContentHash(report.normalized);
        try {
          this.assertArticleNotDuplicate(hash, false);
          result = await this.publishArticleOne(report.normalized, record.id, hash);
        } catch (error) {
          if (!(error instanceof RelayError)) throw error;
          result = {
            platform: "x", ok: false, status: "failed", mode: "mock",
            error: errorMessage(error), publishedAt: this.now().toISOString(),
          };
        }
      }
    }
    await this.finalizePostRecord(record.id, [result]);
    await this.store.mutate((db) => {
      const current = db.queue.find((entry) => entry.id === job.id);
      if (!current) return;
      current.status = result.ok ? "done" : "failed";
      current.results = [result];
      current.lastError = result.ok ? undefined : `x: ${result.error ?? "failed"}`;
    });
  }

  // ---------------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------------

  /**
   * Removes a not-yet-run job from the Relay queue. Nothing is touched on any
   * platform. Jobs that are running or already done are left alone.
   */
  async removeQueueJob(id: string): Promise<RemoveQueueJobResult> {
    await this.store.refresh();
    let outcome: RemoveQueueJobResult = { found: false, removed: false };
    await this.store.mutate((db) => {
      const index = db.queue.findIndex((entry) => entry.id === id);
      if (index < 0) return;
      const job = db.queue[index]!;
      outcome = { found: true, removed: false, status: job.status };
      if (job.status === "pending" || job.status === "canceled" || job.status === "failed") {
        db.queue.splice(index, 1);
        outcome = { found: true, removed: true, status: job.status, job: structuredClone(job) };
      }
    });
    return outcome;
  }

  /** The platform posts a history record created, minus ones already deleted. Read-only. */
  async recordDeleteTargets(recordId: string): Promise<{ found: boolean; targets: DeleteTarget[] }> {
    await this.store.refresh();
    const record = this.store.read((db) => db.posts.find((entry) => entry.id === recordId));
    if (!record) return { found: false, targets: [] };
    const targets: DeleteTarget[] = [];
    for (const result of record.results) {
      if (!result.ok) continue;
      const parts = result.publishedParts?.length
        ? result.publishedParts.map((part) => ({ postId: part.postId, url: part.url }))
        : result.postId
          ? [{ postId: result.postId, url: result.url }]
          : [];
      for (const part of parts) {
        if (result.deletions?.some((entry) => entry.postId === part.postId)) continue;
        targets.push({ platform: result.platform, postId: part.postId, ...(part.url ? { url: part.url } : {}) });
      }
    }
    return { found: true, targets };
  }

  /**
   * EXPLICIT-ONLY: deletes one published post on its platform. X and Threads are
   * supported; other platforms return status "unsupported" with the reason.
   * The scheduler never calls this.
   */
  async deletePublishedPost(platform: PlatformId, postId: string): Promise<DeletePostOutcome> {
    await this.store.refresh();
    const base = { platform, postId };
    const adapter = this.getAdapter(platform);
    if (!adapter.deletePost) {
      return { ...base, status: "unsupported", mock: false, error: UNSUPPORTED_DELETE_REASON[platform] };
    }
    const stored = this.store.read((db) => db.accounts[platform]);
    if (!stored) {
      return { ...base, status: "failed", mock: false, error: `No ${platform} account is connected.`, code: "account_missing" };
    }
    const ctx = this.adapterContext();
    let tokens = stored.secret ? this.box.decrypt<OAuthTokens>(stored.secret) : null;
    try {
      let result;
      try {
        result = await adapter.deletePost(ctx, postId, { account: stored.account, tokens });
      } catch (error) {
        // Deleting is idempotent, so one retry after a token refresh is safe.
        if (error instanceof AuthError && tokens?.refreshToken && adapter.refresh) {
          tokens = await adapter.refresh(ctx, tokens);
          await this.persistRefreshedTokens(platform, tokens);
          result = await adapter.deletePost(ctx, postId, { account: stored.account, tokens });
        } else {
          throw error;
        }
      }
      await this.markPostDeleted(platform, postId, result.mock);
      return { ...base, status: result.alreadyGone ? "already_gone" : "deleted", mock: result.mock };
    } catch (error) {
      return {
        ...base,
        status: "failed",
        mock: stored.account.mode === "mock",
        error: errorMessage(error),
        ...(error instanceof RelayError ? { code: error.code } : {}),
      };
    }
  }

  private async markPostDeleted(platform: PlatformId, postId: string, mock: boolean): Promise<void> {
    await this.store.mutate((db) => {
      for (const record of db.posts) {
        for (const result of record.results) {
          if (result.platform !== platform) continue;
          const owns = result.postId === postId || result.publishedParts?.some((part) => part.postId === postId);
          if (!owns) continue;
          result.deletions = [...(result.deletions ?? []), { postId, deletedAt: this.now().toISOString(), ...(mock ? { mock: true } : {}) }];
        }
      }
    });
  }

  async listQueue(): Promise<QueueJob[]> {
    await this.store.refresh();
    return this.store.read((db) =>
      [...db.queue].sort((a, b) => {
        const aDone = a.status === "done" || a.status === "canceled" || a.status === "failed";
        const bDone = b.status === "done" || b.status === "canceled" || b.status === "failed";
        if (aDone !== bDone) return aDone ? 1 : -1;
        return aDone ? Date.parse(b.scheduleAt) - Date.parse(a.scheduleAt) : Date.parse(a.scheduleAt) - Date.parse(b.scheduleAt);
      }),
    );
  }

  async cancelJob(id: string): Promise<boolean> {
    let canceled = false;
    await this.store.mutate((db) => {
      const job = db.queue.find((entry) => entry.id === id);
      if (job && job.status === "pending") {
        job.status = "canceled";
        job.lastError = "Canceled from the console";
        canceled = true;
      }
    });
    return canceled;
  }

  async history(limit = 50): Promise<PostRecord[]> {
    await this.store.refresh();
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    return this.store.read((db) => db.posts.slice(0, safeLimit));
  }

  /**
   * READ-ONLY: recent Threads posts and their comments. Reading never publishes
   * or replies. An existing token without `threads_read_replies` produces the
   * stable `threads_scope_missing` code so callers can prompt a reconnect.
   */
  async readThreadsComments(limitPosts = 10, sinceMs?: number): Promise<ThreadsCommentsResult> {
    await this.store.refresh();
    const stored = this.store.read((db) => db.accounts.threads);
    if (!stored) {
      throw new RelayError(
        "No Threads account is connected. Connect Threads from the console first.",
        "threads_not_connected",
        undefined,
        404,
      );
    }
    const adapter = this.getAdapter("threads");
    if (!adapter.readComments) {
      throw new RelayError("This Threads adapter does not support comment reading.", "threads_read_unsupported", undefined, 501);
    }
    const tokens = stored.secret ? this.box.decrypt<OAuthTokens>(stored.secret) : null;
    const safeLimit = Number.isFinite(limitPosts) ? Math.max(1, Math.min(50, Math.floor(limitPosts))) : 10;
    return adapter.readComments(this.adapterContext(), {
      account: stored.account,
      tokens,
      limitPosts: safeLimit,
      ...(sinceMs !== undefined ? { sinceMs } : {}),
    });
  }

  /**
   * Auto-reply read path: reuse readComments/conversation logic, then pick the
   * one post the window belongs to. This stays read-only.
   */
  private async readThreadsPostComments(postId: string): Promise<ThreadsCommentsResult["posts"][number]["comments"]> {
    const result = await this.readThreadsComments(50);
    return result.posts.find((post) => post.id === postId)?.comments ?? [];
  }

  /** Auto-reply discovery path: /me/threads, used to notice new own posts. */
  private async listThreadsOwnPosts(): Promise<ThreadsOwnPost[]> {
    await this.store.refresh();
    const stored = this.store.read((db) => db.accounts.threads);
    if (!stored) return [];
    const adapter = this.getAdapter("threads");
    if (!adapter.listOwnPosts) return [];
    const tokens = stored.secret ? this.box.decrypt<OAuthTokens>(stored.secret) : null;
    return adapter.listOwnPosts(this.adapterContext(), { account: stored.account, tokens, limitPosts: 20 });
  }

  /**
   * EXPLICIT-ONLY: post one reply to one Threads comment. This is never called
   * by the scheduler, comment reading or any automatic path; the HTTP endpoint
   * and MCP tool invoke it directly. The local auto-reply engine also calls it,
   * but only after its own spam/hostile/genuine classification and hard stop.
   */
  async replyToThreadsComment(commentId: string, text: string): Promise<ThreadsReplyResult> {
    await this.store.refresh();
    const stored = this.store.read((db) => db.accounts.threads);
    if (!stored) {
      throw new RelayError(
        "No Threads account is connected. Connect Threads from the console first.",
        "threads_not_connected",
        undefined,
        404,
      );
    }
    const adapter = this.getAdapter("threads");
    if (!adapter.replyToComment) {
      throw new RelayError(
        "This Threads adapter does not support replying to comments.",
        "threads_reply_unsupported",
        undefined,
        501,
      );
    }
    const tokens = stored.secret ? this.box.decrypt<OAuthTokens>(stored.secret) : null;
    return adapter.replyToComment(this.adapterContext(), commentId, text, {
      account: stored.account,
      tokens,
    });
  }

  // ---------------------------------------------------------------------------
  // Comments beyond Threads: relay_comments_new and relay_reply.
  // No LLM is used anywhere in this block.
  // ---------------------------------------------------------------------------

  /**
   * Comment bookkeeping (seen and replied ids) lives in its own file next to
   * db.json. Older Relay processes that are still running (for example a Claude
   * Desktop stdio server) rewrite db.json without keys they do not know, which
   * would wipe these lists; a separate file cannot be touched by them.
   */
  private commentsStoreHandle: Promise<JsonStore> | null = null;
  private commentsStore(): Promise<JsonStore> {
    this.commentsStoreHandle ??= JsonStore.open(path.join(this.dataDir, "comments.json"));
    return this.commentsStoreHandle;
  }

  /** Runs `work` with the stored account, refreshing the token once on a 401. */
  private async withFreshTokens<T>(
    platform: PlatformId,
    work: (account: Account, tokens: OAuthTokens | null) => Promise<T>,
  ): Promise<T> {
    await this.store.refresh();
    const stored = this.store.read((db) => db.accounts[platform]);
    if (!stored) {
      throw new RelayError(
        `No ${platform} account is connected. Connect it from the console first.`,
        `${platform}_not_connected`,
        undefined,
        404,
      );
    }
    const adapter = this.getAdapter(platform);
    const tokens = stored.secret ? this.box.decrypt<OAuthTokens>(stored.secret) : null;
    try {
      return await work(stored.account, tokens);
    } catch (error) {
      if (error instanceof AuthError && tokens?.refreshToken && adapter.refresh) {
        const refreshed = await adapter.refresh(this.adapterContext(), tokens);
        await this.persistRefreshedTokens(platform, refreshed);
        return work(stored.account, refreshed);
      }
      throw error;
    }
  }

  /** Per-platform comment readiness: connected, and does the token carry the comment scopes. */
  async commentsStatus(): Promise<CommentPlatformReport[]> {
    await this.store.refresh();
    return COMMENT_PLATFORMS.map((platform): CommentPlatformReport => {
      const label = COMMENT_PLATFORM_LABEL[platform];
      const stored = this.store.read((db) => db.accounts[platform]);
      if (!stored) {
        return { platform, connected: false, ready: false, status: "not_connected", message: `${label} is not connected.` };
      }
      const tokens = stored.secret ? this.box.decrypt<OAuthTokens>(stored.secret) : null;
      const missing = missingCommentScopes(platform, "both", stored.account, tokens);
      if (missing.length > 0) {
        return {
          platform,
          connected: true,
          ready: false,
          status: "needs_reconnect",
          message: reconnectMessage(platform, missing),
          missing_scopes: missing,
        };
      }
      return { platform, connected: true, ready: true, status: "ok" };
    });
  }

  private async collectComments(
    platform: CommentPlatform,
    sinceMs: number,
    limit: number,
  ): Promise<{ report: CommentPlatformReport; comments: OwnComment[] }> {
    const label = COMMENT_PLATFORM_LABEL[platform];
    const stored = this.store.read((db) => db.accounts[platform]);
    if (!stored) {
      return {
        report: { platform, connected: false, ready: false, status: "not_connected", message: `${label} is not connected.` },
        comments: [],
      };
    }
    const tokens = stored.secret ? this.box.decrypt<OAuthTokens>(stored.secret) : null;
    const missing = missingCommentScopes(platform, "read", stored.account, tokens);
    if (missing.length > 0) {
      return {
        report: {
          platform,
          connected: true,
          ready: false,
          status: "needs_reconnect",
          message: reconnectMessage(platform, missing),
          missing_scopes: missing,
        },
        comments: [],
      };
    }

    try {
      let comments: OwnComment[];
      if (platform === "threads") {
        const result = await this.readThreadsComments(25, sinceMs);
        const held = this.threadsPostsHeldForAutoReply();
        comments = [];
        for (const post of result.posts) {
          if (held.has(post.id)) continue;
          for (const comment of post.comments) {
            comments.push({
              platform,
              postId: post.id,
              commentId: comment.id,
              author: comment.username ?? "unknown",
              text: comment.text ?? "",
              createdAt: comment.timestamp ?? this.now().toISOString(),
              ...(post.text ? { postCaption: post.text } : {}),
            });
          }
        }
      } else {
        const adapter = this.getAdapter(platform);
        if (!adapter.readOwnComments) {
          return {
            report: {
              platform,
              connected: true,
              ready: false,
              status: "unsupported",
              message: `${label} comment reading is not available in this build.`,
            },
            comments: [],
          };
        }
        const read = adapter.readOwnComments.bind(adapter);
        comments = await this.withFreshTokens(platform, (account, toks) =>
          read(this.adapterContext(), {
            account,
            tokens: toks,
            sinceMs,
            limitPosts: 25,
            maxComments: Math.max(limit * 3, 50),
          }),
        );
      }
      return { report: { platform, connected: true, ready: true, status: "ok", found: comments.length }, comments };
    } catch (error) {
      const code = error instanceof RelayError ? error.code : "";
      if (code === "comments_scope_missing" || code === "threads_scope_missing") {
        return {
          report: {
            platform,
            connected: true,
            ready: false,
            status: "needs_reconnect",
            message: code === "comments_scope_missing" ? errorMessage(error) : `${label}: needs reconnect for comments. ${errorMessage(error)}`,
          },
          comments: [],
        };
      }
      return {
        report: { platform, connected: true, ready: false, status: "error", message: errorMessage(error) },
        comments: [],
      };
    }
  }

  /** Threads posts whose 30-minute built-in auto-reply window is still open (and active). */
  private threadsPostsHeldForAutoReply(): Set<string> {
    if (!this.autoReply.isEnabled() || !this.getDeepSeekApiKey()) return new Set();
    return this.store.read(
      (db) => new Set(db.threadsAutoReply.windows.filter((window) => window.status === "open").map((window) => window.postId)),
    );
  }

  /**
   * Own-post comments that have not been marked seen yet, pre-filtered (spam /
   * simple / needs_reply). With markSeen (default) the returned comments are
   * recorded in the JSON store, so each comment is handed out once, across
   * restarts. Read-only toward the platforms.
   */
  async newComments(
    options: { platform?: CommentPlatform | "all"; sinceHours?: number; limit?: number; markSeen?: boolean } = {},
  ): Promise<NewCommentsResult> {
    const platform = options.platform ?? "all";
    if (platform !== "all" && !isCommentPlatform(platform)) {
      throw new RelayError(
        `Comments support threads, instagram, youtube or all, not "${String(platform)}".`,
        "comment_platform_unsupported",
      );
    }
    const clampInt = (value: number | undefined, fallback: number, min: number, max: number) =>
      Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value as number))) : fallback;
    const sinceHours = clampInt(options.sinceHours, 48, 1, 168);
    const limit = clampInt(options.limit, 20, 1, 100);
    const markSeen = options.markSeen !== false;
    const nowMs = this.now().getTime();
    const sinceMs = nowMs - sinceHours * 3600 * 1000;
    const targets: CommentPlatform[] = platform === "all" ? [...COMMENT_PLATFORMS] : [platform];

    const cs = await this.commentsStore();
    await Promise.all([this.store.refresh(), cs.refresh()]);
    const collected = await Promise.all(targets.map((target) => this.collectComments(target, sinceMs, limit)));
    const reports = collected.map((entry) => entry.report);

    const handled = new Set<string>();
    cs.read((db) => {
      for (const entry of db.comments.seen) handled.add(entry.key);
      for (const entry of db.comments.replied) handled.add(entry.key);
    });
    this.store.read((db) => {
      for (const entry of db.threadsAutoReply.replies) handled.add(commentKey("threads", entry.commentId));
      for (const entry of db.threadsAutoReply.flagged) handled.add(commentKey("threads", entry.commentId));
    });

    const unique = new Map<string, OwnComment>();
    for (const entry of collected) {
      for (const comment of entry.comments) {
        if (!comment.commentId) continue;
        const key = commentKey(comment.platform, comment.commentId);
        if (handled.has(key) || unique.has(key)) continue;
        const created = Date.parse(comment.createdAt);
        if (Number.isFinite(created) && created < sinceMs) continue;
        unique.set(key, comment);
      }
    }
    const candidates = [...unique.values()].sort((a, b) => {
      const left = Date.parse(a.createdAt);
      const right = Date.parse(b.createdAt);
      return (Number.isFinite(left) ? left : nowMs) - (Number.isFinite(right) ? right : nowMs);
    });
    const classified = candidates.map((comment) => ({ comment, cls: classifyComment(comment.text) }));

    let taken = classified.slice(0, limit);
    let cursor = cs.read((db) => db.comments.templateCursor);
    if (markSeen) {
      const claimed = await cs.mutate((db) => {
        const already = new Set<string>([...db.comments.seen.map((e) => e.key), ...db.comments.replied.map((e) => e.key)]);
        const picked: typeof classified = [];
        for (const item of classified) {
          if (picked.length >= limit) break;
          if (already.has(commentKey(item.comment.platform, item.comment.commentId))) continue;
          picked.push(item);
        }
        const at = this.now().toISOString();
        for (const item of picked) db.comments.seen.push({ key: commentKey(item.comment.platform, item.comment.commentId), at });
        if (db.comments.seen.length > MAX_SEEN_COMMENTS) db.comments.seen = db.comments.seen.slice(-MAX_SEEN_COMMENTS);
        const start = db.comments.templateCursor;
        db.comments.templateCursor += picked.filter((item) => item.cls.kind === "simple").length;
        return { picked, start };
      });
      taken = claimed.picked;
      cursor = claimed.start;
    }

    const counts = { needs_reply: 0, simple: 0, spam: 0 };
    let rotation = 0;
    const comments: NewComment[] = taken.map(({ comment, cls }) => {
      counts[cls.kind] += 1;
      return {
        platform: comment.platform,
        post_id: comment.postId,
        comment_id: comment.commentId,
        author: comment.author,
        text: comment.text,
        created_at: comment.createdAt,
        post_caption_snippet: snippet(comment.postCaption),
        kind: cls.kind,
        ...(cls.kind === "spam" ? { spam_reason: cls.reason } : {}),
        ...(cls.kind === "simple" ? { suggested_template: suggestedTemplate(cls.lang, cursor + rotation++) } : {}),
      };
    });

    return {
      comments,
      counts,
      platforms: reports,
      since_hours: sinceHours,
      limit,
      mark_seen: markSeen,
      more_available: classified.length > taken.length,
    };
  }

  private findCommentReply(
    db: DbData,
    autoReplies: { commentId: string; createdAt: string; replyId: string }[],
    platform: CommentPlatform,
    commentId: string,
  ): { at: string; replyId?: string } | undefined {
    const key = commentKey(platform, commentId);
    const nowMs = this.now().getTime();
    const entry = db.comments.replied.find(
      (item) => item.key === key && (item.status === "sent" || nowMs - Date.parse(item.at) < PENDING_REPLY_TTL_MS),
    );
    if (entry) return { at: entry.at, ...(entry.replyId ? { replyId: entry.replyId } : {}) };
    if (platform === "threads") {
      const auto = autoReplies.find((item) => item.commentId === commentId);
      if (auto) return { at: auto.createdAt, replyId: auto.replyId };
    }
    return undefined;
  }

  /**
   * EXPLICIT ACTION: reply to one comment on Threads, Instagram or YouTube.
   * The same comment id is never answered twice (replied ids are persisted,
   * and the built-in Threads auto-reply log counts too). dryRun validates
   * everything without sending or recording anything.
   */
  async replyToComment(input: {
    platform: string;
    commentId: string;
    text: string;
    postId?: string;
    dryRun?: boolean;
  }): Promise<ReplyCommentResult> {
    if (!isCommentPlatform(input.platform)) {
      throw new RelayError(
        `Comment replies support threads, instagram and youtube, not "${String(input.platform)}".`,
        "comment_platform_unsupported",
      );
    }
    const platform = input.platform;
    const label = COMMENT_PLATFORM_LABEL[platform];
    const commentId = typeof input.commentId === "string" ? input.commentId.trim() : "";
    if (!commentId) throw new RelayError("comment_id is required.", "comment_id_required");
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text) throw new RelayError("Reply text is required.", "comment_text_required");
    const length = Array.from(text).length;
    const maxLength = COMMENT_REPLY_MAX[platform];
    if (length > maxLength) {
      throw new RelayError(
        `${label} replies allow at most ${maxLength} characters; this reply has ${length}.`,
        "comment_text_too_long",
        { maxLength, length },
      );
    }
    const warnings = replyTextWarnings(text);

    const cs = await this.commentsStore();
    await Promise.all([this.store.refresh(), cs.refresh()]);
    const autoReplies = this.store.read((db) => db.threadsAutoReply.replies);
    const stored = this.store.read((db) => db.accounts[platform]);
    if (!stored) {
      throw new RelayError(
        `No ${label} account is connected. Connect it from the console first.`,
        `${platform}_not_connected`,
        undefined,
        404,
      );
    }
    const tokens = stored.secret ? this.box.decrypt<OAuthTokens>(stored.secret) : null;
    const missing = missingCommentScopes(platform, "reply", stored.account, tokens);
    if (missing.length > 0) {
      throw new RelayError(reconnectMessage(platform, missing), "comments_scope_missing", { missing_scopes: missing }, 403);
    }
    const adapter = this.getAdapter(platform);
    if (!adapter.replyToComment) {
      throw new RelayError(`${label} replies are not available in this build.`, "comment_reply_unsupported", undefined, 501);
    }

    const alreadyError = (prior: { at: string; replyId?: string }) =>
      new RelayError(
        `Already replied to ${label} comment ${commentId} at ${prior.at}. Not sending a second reply.`,
        "comment_already_replied",
        { platform, commentId, ...prior },
        409,
      );
    const prior = cs.read((db) => this.findCommentReply(db, autoReplies, platform, commentId));
    if (prior) throw alreadyError(prior);

    const base = {
      ok: true as const,
      platform,
      comment_id: commentId,
      ...(input.postId ? { post_id: input.postId } : {}),
      length,
      max_length: maxLength,
      warnings,
    };
    if (input.dryRun) {
      return { ...base, dry_run: true, would_send: true, mock: stored.account.mode === "mock" || !this.adapterIsLive(adapter) };
    }

    const key = commentKey(platform, commentId);
    const at = this.now().toISOString();
    const reservedBy = await cs.mutate((db) => {
      const existing = this.findCommentReply(db, autoReplies, platform, commentId);
      if (existing) return existing;
      db.comments.replied = db.comments.replied.filter((item) => item.key !== key);
      db.comments.replied.push({
        key,
        platform,
        commentId,
        ...(input.postId ? { postId: input.postId } : {}),
        text,
        at,
        status: "pending",
      });
      if (db.comments.replied.length > MAX_REPLIED_COMMENTS) {
        db.comments.replied = db.comments.replied.slice(-MAX_REPLIED_COMMENTS);
      }
      return undefined;
    });
    if (reservedBy) throw alreadyError(reservedBy);

    let result: ThreadsReplyResult;
    try {
      const send = adapter.replyToComment.bind(adapter);
      result = await this.withFreshTokens(platform, (account, toks) =>
        send(this.adapterContext(), commentId, text, { account, tokens: toks }),
      );
    } catch (error) {
      // Nothing was sent: free the reservation so a retry is possible.
      await cs.mutate((db) => {
        db.comments.replied = db.comments.replied.filter((item) => !(item.key === key && item.status === "pending"));
      });
      throw error;
    }

    await cs.mutate((db) => {
      const entry = db.comments.replied.find((item) => item.key === key);
      if (entry) {
        entry.status = "sent";
        entry.replyId = result.id;
        if (result.mock) entry.mock = true;
      }
      if (!db.comments.seen.some((item) => item.key === key)) db.comments.seen.push({ key, at: this.now().toISOString() });
    });
    this.logger(`[comments] replied on ${platform} to comment ${commentId} as ${result.id}${result.mock ? " (mock)" : ""}`);
    return {
      ...base,
      dry_run: false,
      reply_id: result.id,
      ...(result.permalink ? { permalink: result.permalink } : {}),
      mock: result.mock,
    };
  }

  async runDueJobs(limit = 5): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      await this.store.refresh();
      const now = this.now().getTime();
      const due = this.store.read((db) =>
        db.queue
          .filter((job) => job.status === "pending" && Date.parse(job.scheduleAt) <= now)
          .slice(0, limit)
          .map((job) => structuredClone(job)),
      );

      let processed = 0;
      for (const job of due) {
        let claimed = false;
        await this.store.mutate((db) => {
          const current = db.queue.find((entry) => entry.id === job.id);
          if (current && current.status === "pending") {
            current.status = "running";
            current.attempts += 1;
            claimed = true;
          }
        });
        if (!claimed) continue;

        if (job.kind === "article") {
          await this.runArticleJob(job);
          processed += 1;
          continue;
        }

        const report = await this.validate(job.draft);
        const record = await this.beginPostRecord(job.draft, job.scheduleAt);
        let results: PostResult[];
        if (!report.ok || !report.normalized) {
          const platforms = job.draft.platforms?.length ? job.draft.platforms : [...PLATFORM_IDS];
          const message = report.issues
            .slice(0, 3)
            .map((issue) => issue.message)
            .join("; ");
          results = platforms.map((platform) => ({
            platform,
            ok: false,
            status: "failed" as const,
            mode: "mock" as const,
            error: `Scheduled post failed validation: ${message || "invalid draft"}`,
            publishedAt: this.now().toISOString(),
          }));
        } else {
          try {
            await this.assertNotDuplicate(report.normalized, Boolean(job.draft.recurrence));
            results = await this.publishResolved(report.normalized, record.id);
          } catch (error) {
            if (!(error instanceof RelayError) || error.code !== "duplicate_recent_post") throw error;
            const platforms = (Object.keys(report.normalized) as PlatformId[]);
            results = platforms.map((platform) => ({
              platform,
              ok: false,
              status: "failed" as const,
              mode: "mock" as const,
              error: errorMessage(error),
              publishedAt: this.now().toISOString(),
            }));
          }
        }

        await this.finalizePostRecord(record.id, results);
        const ok = results.length > 0 && results.every((result) => result.ok);
        await this.store.mutate((db) => {
          const current = db.queue.find((entry) => entry.id === job.id);
          if (!current) return;
          current.status = ok ? "done" : "failed";
          current.results = results;
          current.lastError = ok
            ? undefined
            : results
                .filter((result) => !result.ok)
                .map((result) => `${result.platform}: ${result.error ?? "failed"}`)
                .join("; ");
          if (ok) {
            const next = this.nextRecurringJob(job);
            if (next) db.queue.push(next);
          }
        });
        processed += 1;
      }
      return processed;
    } finally {
      this.ticking = false;
    }
  }

  async startScheduler(intervalMs = 15000): Promise<SchedulerStatus> {
    this.schedulerIntervalMs = Math.max(1000, intervalMs);
    if (this.timer) {
      return { running: true, ownedByThisProcess: this.lockHeld, intervalMs: this.schedulerIntervalMs };
    }
    const acquired = await acquireSchedulerLock(this.dataDir);
    if (!acquired) {
      this.logger("scheduler is already running in another Relay process");
      return { running: true, ownedByThisProcess: false, intervalMs: this.schedulerIntervalMs };
    }
    this.lockHeld = true;
    const tick = (): void => {
      void this.runDueJobs().catch((error) => this.logger(`scheduler error: ${errorMessage(error)}`));
      void this.runThreadsAutoReplyTick().catch((error) =>
        this.logger(`threads auto-reply error: ${errorMessage(error)}`),
      );
    };
    this.timer = setInterval(tick, this.schedulerIntervalMs);
    this.timer.unref?.();
    tick();
    return { running: true, ownedByThisProcess: true, intervalMs: this.schedulerIntervalMs };
  }

  async stopScheduler(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.lockHeld) {
      this.lockHeld = false;
      await releaseSchedulerLock(this.dataDir);
    }
  }

  async schedulerStatus(): Promise<SchedulerStatus> {
    const owner = await schedulerLockOwner(this.dataDir);
    return {
      running: Boolean(this.timer) || owner !== null,
      ownedByThisProcess: this.lockHeld,
      intervalMs: this.schedulerIntervalMs,
    };
  }

  async saveCredentials(platform: PlatformId, credentials: PlatformCredentials): Promise<void> {
    this.getAdapter(platform);
    await this.credentials.save(platform, credentials);
  }

  async removeCredentials(platform: PlatformId): Promise<void> {
    await this.credentials.remove(platform);
  }

  parseDraftFromJson(value: unknown): PostDraft {
    if (!value || typeof value !== "object") throw new RelayError("Draft must be an object", "draft_invalid");
    return value as PostDraft;
  }

  async close(): Promise<void> {
    await this.stopScheduler();
  }
}





