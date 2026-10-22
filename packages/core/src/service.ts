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
import { JsonStore } from "./json-store.js";
import { acquireSchedulerLock, releaseSchedulerLock, schedulerLockOwner } from "./lock.js";
import { mediaPublicUrl, readMediaBlob } from "./media.js";
import { SecretBox } from "./secret-box.js";
import { validateDraft } from "./validation.js";
import type {
  Account,
  AdapterContext,
  BeginConnectResult,
  CreatePostResult,
  OAuthTokens,
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
        createDeepSeekReplyGenerator({ env: this.env, fetchImpl: this.fetchImpl, logger: this.logger }),
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
    const mediaDir = path.join(dataDir, "media");
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

  async accounts(): Promise<Account[]> {
    await this.store.refresh();
    return this.store.read((db) =>
      PLATFORM_IDS.map((platform) => db.accounts[platform]?.account).filter((account): account is Account => Boolean(account)),
    );
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
      threadsAutoReplyConfigured: Boolean(this.env.DEEPSEEK_API_KEY?.trim()),
    };
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
    return validateDraft(draft, adapters, {
      mediaPublicUrl: (item) => mediaPublicUrl(item, this.publicMediaBaseUrl, this.mediaDir),
      isLive: (platform) => this.adapterIsLive(this.getAdapter(platform)),
    });
  }

  async beginConnect(platform: PlatformId, options: { redirectBase?: string } = {}): Promise<BeginConnectResult> {
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
      const account = await this.saveAccount(platform, result.profile, null, "mock", result.scopes);
      return { mode: "connected", account };
    }

    const state = randomToken(24);
    const codeVerifier = randomToken(48);
    await this.store.mutate((db) => {
      db.oauth[state] = { platform, codeVerifier, redirectUri, createdAt: this.now().toISOString() };
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
    const account = await this.saveAccount(platform, result.profile, result.tokens, "live", result.scopes);
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
  ): Promise<Account> {
    const account: Account = {
      id: `${platform}:${profile.externalId || profile.handle}`,
      platform,
      handle: profile.handle,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
      mode,
      connectedAt: this.now().toISOString(),
      scopes,
    };
    const secret = tokens ? this.box.encrypt(tokens) : null;
    await this.store.mutate((db) => {
      db.accounts[platform] = { account, secret };
    });
    return account;
  }

  async disconnect(platform: PlatformId): Promise<boolean> {
    await this.store.refresh();
    const existed = this.store.read((db) => Boolean(db.accounts[platform]));
    await this.store.mutate((db) => {
      delete db.accounts[platform];
      for (const [state, pending] of Object.entries(db.oauth)) {
        if (pending.platform === platform) delete db.oauth[state];
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
    if (scheduleAt !== undefined && scheduleAt > this.now().getTime() + 1000) {
      const job: QueueJob = {
        id: `job_${randomUUID()}`,
        createdAt: this.now().toISOString(),
        scheduleAt: new Date(scheduleAt).toISOString(),
        draft,
        status: "pending",
        attempts: 0,
      };
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

  /**
   * Creates the history record before publishing so adapters can append each
   * part to the same record as soon as the provider returns an id.
   */
  private async beginPostRecord(draft: PostDraft, scheduledFor: string | undefined): Promise<PostRecord> {
    const record: PostRecord = {
      id: `post_${randomUUID()}`,
      createdAt: this.now().toISOString(),
      scheduledFor,
      draft,
      results: [],
      status: "publishing",
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
    const stored = this.store.read((db) => db.accounts[post.platform]);
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

    try {
      let result;
      try {
        result = await adapter.publish(ctx, { account: stored.account, tokens, post });
      } catch (error) {
        // Never replay a whole thread after some parts already exist: the retry
        // would publish those parts twice. Return the partial success instead.
        if (error instanceof AuthError && publishedParts.length === 0 && tokens?.refreshToken && adapter.refresh) {
          const refreshed = await adapter.refresh(ctx, tokens);
          tokens = refreshed;
          await this.store.mutate((db) => {
            const current = db.accounts[post.platform];
            if (current) db.accounts[post.platform] = { account: current.account, secret: this.box.encrypt(refreshed) };
          });
          result = await adapter.publish(ctx, { account: stored.account, tokens, post });
        } else {
          throw error;
        }
      }
      const first = publishedParts[0];
      const publishedResult: PostResult = {
        platform: post.platform,
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
    try {
      await this.autoReply.openWindow(result.postId, result.publishedAt, post.parts[0]?.text);
    } catch (error) {
      this.logger(`[threads-autoreply] could not open window for ${result.postId}: ${errorMessage(error)}`);
    }
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
  async readThreadsComments(limitPosts = 10): Promise<ThreadsCommentsResult> {
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
            await this.assertNotDuplicate(report.normalized, false);
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
