import { randomUUID } from "node:crypto";
import { ConfigurationError, RelayError } from "@relay/core";
import type {
  Account,
  AdapterContext,
  DeletePostInput,
  DeletePostResult,
  AuthorizeRequest,
  AuthorizeResult,
  ConnectResult,
  ExchangeRequest,
  OAuthTokens,
  PlatformAdapter,
  PlatformLimits,
  ProfileInfo,
  PublishInput,
  PublishResult,
  ThreadsComment,
  ThreadsCommentsInput,
  ThreadsCommentsResult,
  ThreadsOwnPost,
  ThreadsPostsInput,
  ThreadsReplyAuth,
  ThreadsReplyResult,
} from "@relay/core";
import { mockProfile, mockPublish, mockScopes } from "../mock.js";
import {
  asArray,
  asObject,
  authHeaders,
  formBody,
  getString,
  oauthTokensFrom,
  providerFetch,
  publicMediaUrl,
  scopesFrom,
  sleep,
} from "./http.js";

const AUTHORIZE_URL = "https://threads.net/oauth/authorize";
const TOKEN_URL = "https://graph.threads.net/oauth/access_token";
const LONG_LIVED_TOKEN_URL = "https://graph.threads.net/access_token";
const REFRESH_TOKEN_URL = "https://graph.threads.net/refresh_access_token";
const GRAPH_URL = "https://graph.threads.net/v1.0";
const PROFILE_URL = `${GRAPH_URL}/me?fields=id,username,threads_profile_picture_url`;
const SCOPES = [
  "threads_basic",
  "threads_content_publish",
  "threads_manage_replies",
  "threads_read_replies",
] as const;

/**
 * threads_delete is needed to delete posts. It is only requested at sign-in when
 * THREADS_REQUEST_DELETE_SCOPE=1, because the Meta app must have it enabled
 * first (otherwise the sign-in screen rejects the scope list).
 */
function requestedScopes(ctx: AdapterContext): string[] {
  const wantsDelete = /^(1|true|yes)$/i.test(ctx.env?.THREADS_REQUEST_DELETE_SCOPE ?? "");
  return wantsDelete ? [...SCOPES, "threads_delete"] : [...SCOPES];
}

const THREADS_POST_FIELDS = "id,text,timestamp,permalink";
const THREADS_CONVERSATION_FIELDS = "id,text,username,timestamp,replied_to,is_reply,hide_status";
const THREADS_REPLY_SCOPE = "threads_manage_replies";
const MAX_REPLY_TEXT_LENGTH = 500;

/** Maps Relay's reply controls onto Threads' `reply_control` values. */
function mapReplyControl(value: "everyone" | "followers" | "mentioned" | undefined): string | undefined {
  if (value === "followers") return "followers_only";
  if (value === "mentioned") return "mentioned_only";
  return undefined;
}

const CONTAINER_POLL_LIMIT = 60;
const CONTAINER_POLL_INTERVAL_MS = 2000;
/** Pause before creating a reply so Meta has registered the parent post. */
const DEFAULT_REPLY_SETTLE_MS = 3000;
const DEFAULT_NOT_FOUND_RETRIES = 4;
const DEFAULT_NOT_FOUND_BACKOFF_MS = 2000;

function envMs(ctx: AdapterContext, name: string, fallback: number): number {
  const raw = ctx.env?.[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Meta's "requested resource does not exist" (code 24 / subcode 4279009). */
function isThreadsMediaNotFound(error: unknown): boolean {
  if (!(error instanceof RelayError)) return false;
  const provider = asObject(asObject(error.details)?.provider) ?? {};
  const body = asObject(asObject(asObject(error.details)?.body)?.error) ?? asObject(asObject(error.details)?.error) ?? {};
  const code = String(provider.code ?? body.code ?? "");
  const sub = String(provider.error_subcode ?? provider.subcode ?? body.error_subcode ?? "");
  if (sub === "4279009") return true;
  if (code === "24" && /does not exist|not found|tidak boleh ditemui/i.test(error.message)) return true;
  return /error_subcode=4279009/.test(error.message);
}

/**
 * Threads (Meta) adapter: OAuth dialog, short-lived -> long-lived token
 * exchange, token refresh, profile lookup and container/publish posting with
 * reply chains and bounded video-processing polling.
 *
 * Threads pulls media from public URLs, so every image/video must be reachable
 * from the outside (or carry an explicit `url`).
 */
export class ThreadsAdapter implements PlatformAdapter {
  readonly platform = "threads" as const;

  readonly limits: PlatformLimits = {
    platform: "threads",
    displayName: "Threads",
    maxTextLength: 500,
    maxParts: 20,
    maxMediaPerPost: 20,
    maxVideosPerPost: 20,
    maxMediaWithVideo: 20,
    requiresMedia: false,
    maxImageBytes: 8 * 1024 * 1024,
    maxVideoBytes: 500 * 1024 * 1024,
    allowedImageTypes: ["image/jpeg", "image/png", "image/webp"],
    allowedVideoTypes: ["video/mp4", "video/quicktime"],
    mediaUpload: "url",
    notes: "Chains of up to 20 posts; each part can carry one image/video or a carousel of 2-20 images and/or videos, all served from public URLs.",
  };

  isConfigured(ctx: AdapterContext): boolean {
    const credentials = ctx.credentials("threads");
    return Boolean(credentials.clientId && credentials.clientSecret);
  }

  isLive(ctx: AdapterContext): boolean {
    return !ctx.forceMock && this.isConfigured(ctx);
  }

  async authorize(ctx: AdapterContext, req: AuthorizeRequest): Promise<AuthorizeResult> {
    if (!this.isLive(ctx)) {
      return { kind: "mock", profile: mockProfile("threads"), scopes: mockScopes("threads") };
    }
    const { clientId } = ctx.credentials("threads");
    if (!clientId) throw new ConfigurationError("Threads credentials are not configured", "threads_credentials_missing");
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", req.redirectUri);
    url.searchParams.set("scope", requestedScopes(ctx).join(","));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", req.state);
    return { kind: "redirect", url: url.toString() };
  }

  async exchange(ctx: AdapterContext, req: ExchangeRequest): Promise<ConnectResult> {
    if (!this.isLive(ctx)) {
      throw new ConfigurationError(
        "Threads sign-in is simulated in mock mode; disable mock mode and configure credentials to connect a real account",
        "threads_live_disabled",
      );
    }
    const { clientId, clientSecret } = ctx.credentials("threads");
    if (!clientId || !clientSecret) {
      throw new ConfigurationError(
        "Threads client id and client secret are required for the token exchange",
        "threads_credentials_missing",
      );
    }

    const shortJson = await providerFetch(ctx, "Threads token exchange", TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        redirect_uri: req.redirectUri,
        code: req.code,
      }),
    });
    const shortLived = oauthTokensFrom(shortJson, ctx.now());

    const longLivedUrl = new URL(LONG_LIVED_TOKEN_URL);
    longLivedUrl.searchParams.set("grant_type", "th_exchange_token");
    longLivedUrl.searchParams.set("client_secret", clientSecret);
    longLivedUrl.searchParams.set("access_token", shortLived.accessToken);
    const longJson = await providerFetch(ctx, "Threads long-lived token exchange", longLivedUrl.toString(), {
      method: "GET",
    });
    const longLived = oauthTokensFrom(longJson, ctx.now());

    // Threads refreshes long-lived tokens by presenting the current long-lived
    // token, so keep it in `refreshToken` to enable the service retry path.
    const tokens: OAuthTokens = {
      accessToken: longLived.accessToken,
      refreshToken: longLived.accessToken,
      expiresAt: longLived.expiresAt,
      tokenType: longLived.tokenType ?? "bearer",
      scope: requestedScopes(ctx).join(","),
    };
    const profile = await this.fetchProfile(ctx, tokens);
    return { profile, tokens, scopes: requestedScopes(ctx) };
  }

  async refresh(ctx: AdapterContext, tokens: OAuthTokens): Promise<OAuthTokens> {
    const current = tokens.refreshToken ?? tokens.accessToken;
    if (!current) throw new ConfigurationError("Threads access token is missing; reconnect the account", "threads_token_missing");
    const url = new URL(REFRESH_TOKEN_URL);
    url.searchParams.set("grant_type", "th_refresh_token");
    url.searchParams.set("access_token", current);
    const json = await providerFetch(ctx, "Threads token refresh", url.toString(), { method: "GET" });
    const refreshed = oauthTokensFrom(json, ctx.now());
    return {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.accessToken,
      expiresAt: refreshed.expiresAt,
      tokenType: refreshed.tokenType ?? tokens.tokenType,
      scope: tokens.scope ?? SCOPES.join(","),
    };
  }

  async publish(ctx: AdapterContext, input: PublishInput): Promise<PublishResult> {
    const oversizedPart = input.post.parts.findIndex((part) => part.media.length > 20);
    if (oversizedPart >= 0) {
      const part = input.post.parts[oversizedPart]!;
      throw new RelayError(
        `Threads carousels support at most 20 media items; part ${oversizedPart + 1} has ${part.media.length}`,
        "threads_too_many_media",
      );
    }
    const rootReplyToId = input.post.options.replyToId?.trim() || undefined;
    if (rootReplyToId && !/^\d+$/.test(rootReplyToId)) {
      throw new RelayError(`Threads replyToId must be a numeric published post id (got "${rootReplyToId}")`, "threads_reply_to_invalid");
    }
    if (!this.isLive(ctx) || !input.tokens) return mockPublish("threads", input);
    const tokens = input.tokens;
    const userId = await this.resolveUserId(ctx, input.account, tokens);
    const settleMs = envMs(ctx, "RELAY_THREADS_REPLY_SETTLE_MS", DEFAULT_REPLY_SETTLE_MS);
    const log = (message: string): void => ctx.logger(`[threads] ${message}`);
    const formHeaders = { ...authHeaders(tokens.accessToken), "Content-Type": "application/x-www-form-urlencoded" };
    if (rootReplyToId) log(`chaining ${input.post.parts.length} part(s) under existing published post ${rootReplyToId}`);

    const publishedIds: string[] = [];
    const parts: Record<string, unknown>[] = [];

    for (let index = 0; index < input.post.parts.length; index += 1) {
      const part = input.post.parts[index]!;
      const replyControl = mapReplyControl(input.post.options.replySetting);
      // Every reply targets the PUBLISHED media id returned by /threads_publish
      // for the previous part (or the caller's existing post id for part 1).
      // Container / carousel-child ids are never valid reply targets.
      const replyToId = index > 0 ? publishedIds[index - 1]! : rootReplyToId;
      const isCarousel = part.media.length > 1;
      const carouselItemIds: string[] = [];
      let containerId: string | undefined;
      let mediaType = "TEXT";
      let postId: string;

      if (replyToId && settleMs > 0) {
        // Meta needs a moment before a freshly published post accepts replies.
        await sleep(settleMs);
      }

      try {
        let params: Record<string, string>;
        if (isCarousel) {
          mediaType = "CAROUSEL";
          for (let mediaIndex = 0; mediaIndex < part.media.length; mediaIndex += 1) {
            const item = part.media[mediaIndex]!;
            const mediaUrl = publicMediaUrl(ctx, item, "Threads");
            const itemParams: Record<string, string> = {
              media_type: item.kind === "video" ? "VIDEO" : "IMAGE",
              is_carousel_item: "true",
            };
            if (item.kind === "video") itemParams.video_url = mediaUrl;
            else itemParams.image_url = mediaUrl;
            const itemContainer = await providerFetch(
              ctx,
              `Threads create carousel item (part ${index + 1}, item ${mediaIndex + 1})`,
              `${GRAPH_URL}/${userId}/threads`,
              { method: "POST", headers: formHeaders, body: formBody(itemParams) },
            );
            const itemContainerId = getString(asObject(itemContainer), "id");
            if (!itemContainerId) {
              throw new RelayError(
                "Threads did not return a carousel item container id",
                "threads_carousel_item_id_missing",
                itemContainer,
                502,
              );
            }
            log(`part ${index + 1} carousel child container ${mediaIndex + 1}: ${itemContainerId}`);
            await this.waitForContainer(ctx, tokens, itemContainerId);
            carouselItemIds.push(itemContainerId);
          }
          params = { media_type: "CAROUSEL", children: carouselItemIds.join(",") };
          if (part.text) params.text = part.text;
        } else {
          const media = part.media[0];
          params = { media_type: "TEXT" };
          if (part.text) params.text = part.text;
          if (media) {
            const mediaUrl = publicMediaUrl(ctx, media, "Threads");
            if (media.kind === "video") {
              params.media_type = "VIDEO";
              params.video_url = mediaUrl;
            } else {
              params.media_type = "IMAGE";
              params.image_url = mediaUrl;
            }
          } else if (!part.text) {
            throw new RelayError(`Threads part ${index + 1} has no text or media`, "threads_part_empty");
          }
          mediaType = params.media_type!;
        }
        if (replyToId) params.reply_to_id = replyToId;
        if (replyControl) params.reply_control = replyControl;

        const containerLabel = isCarousel
          ? `Threads create carousel container (part ${index + 1})`
          : `Threads create container (part ${index + 1})`;
        const container = await this.withMediaNotFoundRetry(ctx, containerLabel, () =>
          providerFetch(ctx, containerLabel, `${GRAPH_URL}/${userId}/threads`, {
            method: "POST",
            headers: formHeaders,
            body: formBody(params),
          }),
        );
        containerId = getString(asObject(container), "id");
        if (!containerId) {
          throw new RelayError(
            isCarousel ? "Threads did not return a carousel container id" : "Threads did not return a container id",
            "threads_container_id_missing",
            container,
            502,
          );
        }
        log(`part ${index + 1} ${mediaType} container ${containerId} (reply_to_id=${replyToId ?? "none"})`);

        // Every container (text replies included) must be FINISHED before publish.
        await this.waitForContainer(ctx, tokens, containerId);

        const creationId = containerId;
        const publishLabel = `Threads publish (part ${index + 1})`;
        const published = await this.withMediaNotFoundRetry(ctx, publishLabel, async () => {
          await this.waitForContainer(ctx, tokens, creationId);
          return providerFetch(ctx, publishLabel, `${GRAPH_URL}/${userId}/threads_publish`, {
            method: "POST",
            headers: formHeaders,
            body: formBody({ creation_id: creationId }),
          });
        });
        postId = getString(asObject(published), "id") ?? "";
        if (!postId) throw new RelayError("Threads did not return a published post id", "threads_post_id_missing", published, 502);
      } catch (error) {
        const reconciled = await this.reconcileAmbiguousPublish(ctx, tokens, part.text, containerId, error);
        if (!reconciled) throw error;
        postId = reconciled;
      }
      log(`part ${index + 1} published media id ${postId} (container ${containerId ?? "?"}, reply_to_id=${replyToId ?? "none"})`);
      const url = this.postUrl(input.account, postId);
      const details: Record<string, unknown> = { containerId: containerId ?? null, mediaType, replyToId: replyToId ?? null };
      if (isCarousel) {
        details.carouselItemIds = carouselItemIds;
        details.children = carouselItemIds.join(",");
      }
      await ctx.onPartPublished?.({ platform: "threads", part: index + 1, postId, url, details });
      publishedIds.push(postId);
      parts.push({ part: index + 1, postId, url, ...details });
    }

    const firstId = publishedIds[0];
    if (!firstId) throw new RelayError("Threads post has no parts to publish", "threads_post_empty");
    const handle = input.account.handle.replace(/^@/, "");
    return {
      platformPostId: firstId,
      url: `https://www.threads.net/@${handle}/post/${firstId}`,
      mock: false,
      details: { parts, replyToId: rootReplyToId ?? null },
    };
  }

  /**
   * DELETE /{media-id} (threads_basic + threads_delete). Only the account's own
   * posts can be deleted; Meta allows 100 deletes per account per 24 hours.
   * Replies under the post are not deleted with it.
   */
  async deletePost(ctx: AdapterContext, postId: string, input: DeletePostInput): Promise<DeletePostResult> {
    if (!this.isLive(ctx) || !input.tokens) return { deleted: true, mock: true };
    if (!/^\d+$/.test(postId)) {
      throw new RelayError(`Threads post ids are numbers; got "${postId}"`, "threads_post_id_invalid", undefined, 400);
    }

    const granted = new Set([
      ...(input.account.scopes ?? []),
      ...(input.tokens.scope ?? "").split(/[,\s]+/).filter(Boolean),
    ]);
    if (!granted.has("threads_delete")) {
      throw new RelayError(
        "The connected Threads account lacks threads_delete. Enable it on the Meta app, set THREADS_REQUEST_DELETE_SCOPE=1, restart Relay and reconnect Threads.",
        "threads_scope_missing",
        { requiredScope: "threads_delete", grantedScopes: [...granted] },
        403,
      );
    }
    let json: unknown;
    try {
      json = await providerFetch(ctx, "Threads delete post", `${GRAPH_URL}/${postId}`, {
        method: "DELETE",
        headers: authHeaders(input.tokens.accessToken),
      });
    } catch (error) {
      if (isThreadsMediaNotFound(error)) return { deleted: true, mock: false, alreadyGone: true };
      throw error;
    }
    if (asObject(json)?.success !== true) {
      throw new RelayError("Threads did not confirm the delete", "threads_delete_not_confirmed", json, 502);
    }
    return { deleted: true, mock: false };
  }

  /**
   * Retries a Threads call that failed with "media not found" (code 24,
   * subcode 4279009). Meta returns it while a just-created container or a
   * just-published parent is not yet visible, so back off and try again.
   */
  private async withMediaNotFoundRetry<T>(ctx: AdapterContext, label: string, run: () => Promise<T>): Promise<T> {
    const attempts = Math.max(1, Math.floor(envMs(ctx, "RELAY_THREADS_NOT_FOUND_RETRIES", DEFAULT_NOT_FOUND_RETRIES)) + 1);
    let delay = envMs(ctx, "RELAY_THREADS_NOT_FOUND_BACKOFF_MS", DEFAULT_NOT_FOUND_BACKOFF_MS);
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await run();
      } catch (error) {
        if (attempt >= attempts || !isThreadsMediaNotFound(error)) throw error;
        ctx.logger(`[threads] ${label}: media not found (24/4279009), retry ${attempt}/${attempts - 1} in ${delay}ms`);
        if (delay > 0) await sleep(delay);
        delay *= 2;
      }
    }
  }

  /**
   * READ-ONLY comment reading: list the account's recent posts, then read each
   * post's conversation. The account's own replies are excluded. This method
   * never publishes, replies, edits or deletes anything.
   */
  async readComments(ctx: AdapterContext, input: ThreadsCommentsInput): Promise<ThreadsCommentsResult> {
    const accessToken = input.tokens?.accessToken;
    if (!accessToken) {
      throw new RelayError(
        "Threads comment reading needs a live account with an access token. Reconnect the Threads account.",
        "threads_token_missing",
        undefined,
        401,
      );
    }
    this.assertReadRepliesScope(input);

    const limitPosts = Math.max(1, Math.min(50, Math.floor(input.limitPosts)));
    const ownHandle = input.account.handle.replace(/^@/, "").trim().toLowerCase();
    const headers = authHeaders(accessToken);

    const listJson = await this.readFetch(
      ctx,
      "Threads recent posts",
      `${GRAPH_URL}/me/threads?fields=${THREADS_POST_FIELDS}&limit=${limitPosts}`,
      headers,
    );

    const posts: ThreadsCommentsResult["posts"] = [];
    for (const entry of asArray(asObject(listJson)?.data)) {
      const post = asObject(entry);
      const id = getString(post, "id");
      if (!id) continue;
      // Posts older than the caller's window cannot hold new comments we care
      // about, so skip their conversation call (saves one API call per post).
      const publishedMs = Date.parse(getString(post, "timestamp") ?? "");
      if (input.sinceMs !== undefined && Number.isFinite(publishedMs) && publishedMs < input.sinceMs) continue;

      const conversationJson = await this.readFetch(
        ctx,
        `Threads conversation for ${id}`,
        `${GRAPH_URL}/${encodeURIComponent(id)}/conversation?fields=${THREADS_CONVERSATION_FIELDS}&reverse=false`,
        headers,
      );

      const comments: ThreadsComment[] = [];
      for (const replyEntry of asArray(asObject(conversationJson)?.data)) {
        const reply = asObject(replyEntry);
        if (!reply) continue;
        const replyId = getString(reply, "id");
        // The conversation edge can include the root post; it is not a comment.
        if (!replyId || replyId === id) continue;
        const username = getString(reply, "username");
        // Exclude the connected account's own replies.
        if (username && username.replace(/^@/, "").trim().toLowerCase() === ownHandle) continue;
        comments.push({
          id: replyId,
          text: getString(reply, "text"),
          username,
          timestamp: getString(reply, "timestamp"),
          replied_to: getString(reply, "replied_to"),
          is_reply: typeof reply.is_reply === "boolean" ? reply.is_reply : undefined,
          hide_status: getString(reply, "hide_status"),
        });
      }

      posts.push({
        id,
        text: getString(post, "text"),
        permalink: getString(post, "permalink"),
        timestamp: getString(post, "timestamp"),
        comments,
      });
    }

    return { posts };
  }

  /**
   * READ-ONLY: the account's own recent posts from /me/threads. The local
   * auto-reply engine uses this to discover new own posts that were published
   * outside Relay (for example from the Threads app).
   */
  async listOwnPosts(ctx: AdapterContext, input: ThreadsPostsInput): Promise<ThreadsOwnPost[]> {
    const accessToken = input.tokens?.accessToken;
    if (!accessToken) {
      throw new RelayError(
        "Threads post polling needs a live account with an access token. Reconnect the Threads account.",
        "threads_token_missing",
        undefined,
        401,
      );
    }
    const limitPosts = Math.max(1, Math.min(50, Math.floor(input.limitPosts)));
    const json = await this.readFetch(
      ctx,
      "Threads recent posts",
      `${GRAPH_URL}/me/threads?fields=${THREADS_POST_FIELDS}&limit=${limitPosts}`,
      authHeaders(accessToken),
    );
    const posts: ThreadsOwnPost[] = [];
    for (const entry of asArray(asObject(json)?.data)) {
      const post = asObject(entry);
      const id = getString(post, "id");
      if (!id) continue;
      posts.push({
        id,
        ...(getString(post, "text") ? { text: getString(post, "text") } : {}),
        ...(getString(post, "permalink") ? { permalink: getString(post, "permalink") } : {}),
        ...(getString(post, "timestamp") ? { timestamp: getString(post, "timestamp") } : {}),
      });
    }
    return posts;
  }

  /**
   * EXPLICIT-ONLY reply to one comment. Creates a TEXT container with
   * `reply_to_id`, then publishes it. Callers must already have decided that a
   * reply is wanted: nothing in Relay invokes this from the scheduler or in
   * response to reading comments.
   */
  async replyToComment(
    ctx: AdapterContext,
    commentId: string,
    text: string,
    input: ThreadsReplyAuth,
  ): Promise<ThreadsReplyResult> {
    const target = typeof commentId === "string" ? commentId.trim() : "";
    if (!target) {
      throw new RelayError(
        "A Threads comment id is required to post a reply.",
        "threads_reply_comment_id_invalid",
        undefined,
        400,
      );
    }
    const body = typeof text === "string" ? text.trim() : "";
    if (!body) {
      throw new RelayError("Reply text is required.", "threads_reply_text_required", undefined, 400);
    }
    const length = Array.from(body).length;
    if (length > MAX_REPLY_TEXT_LENGTH) {
      throw new RelayError(
        `Threads replies allow at most ${MAX_REPLY_TEXT_LENGTH} characters; this reply has ${length}.`,
        "threads_reply_text_too_long",
        { maxLength: MAX_REPLY_TEXT_LENGTH, length },
        400,
      );
    }
    this.assertManageRepliesScope(input);

    if (!this.isLive(ctx) || !input.tokens) {
      const id = `mock_threads_reply_${randomUUID()}`;
      return { id, permalink: this.postUrl(input.account, id), mock: true };
    }

    const tokens = input.tokens;
    const userId = await this.resolveUserId(ctx, input.account, tokens);
    const container = await this.replyFetch(ctx, input, "Threads create reply container", `${GRAPH_URL}/${userId}/threads`, {
      media_type: "TEXT",
      text: body,
      reply_to_id: target,
    });
    const containerId = getString(asObject(container), "id");
    if (!containerId) {
      throw new RelayError("Threads did not return a reply container id", "threads_container_id_missing", container, 502);
    }

    const published = await this.replyFetch(
      ctx,
      input,
      "Threads publish reply",
      `${GRAPH_URL}/${userId}/threads_publish`,
      { creation_id: containerId },
    );
    const id = getString(asObject(published), "id");
    if (!id) throw new RelayError("Threads did not return a reply id", "threads_reply_id_missing", published, 502);

    return { id, permalink: this.postUrl(input.account, id), mock: false };
  }

  /**
   * Sends one reply Graph request, translating Meta permission failures into
   * the stable `threads_scope_missing` code (HTTP 403) used by the read path.
   */
  private async replyFetch(
    ctx: AdapterContext,
    input: ThreadsReplyAuth,
    label: string,
    url: string,
    fields: Record<string, string>,
  ): Promise<unknown> {
    const accessToken = input.tokens?.accessToken;
    if (!accessToken) {
      throw new RelayError(
        "Threads replies need a live account with an access token. Reconnect the Threads account.",
        "threads_token_missing",
        undefined,
        401,
      );
    }
    try {
      return await providerFetch(ctx, label, url, {
        method: "POST",
        headers: { ...authHeaders(accessToken), "Content-Type": "application/x-www-form-urlencoded" },
        body: formBody(fields),
      });
    } catch (error) {
      if (isThreadsScopeError(error)) {
        throw new RelayError(
          "The connected Threads token lacks threads_manage_replies. Reconnect Threads and approve the reply-management scope to reply.",
          "threads_scope_missing",
          error instanceof RelayError ? error.details : undefined,
          403,
        );
      }
      throw error;
    }
  }

  /** Fails before any provider call when the stored account lacks the reply scope. */
  private assertManageRepliesScope(input: ThreadsReplyAuth): void {
    const scopes = Array.isArray(input.account.scopes) ? input.account.scopes : [];
    if (scopes.includes(THREADS_REPLY_SCOPE)) return;
    throw new RelayError(
      "The connected Threads account lacks threads_manage_replies. Reconnect Threads and approve the reply-management scope to reply.",
      "threads_scope_missing",
      { requiredScope: THREADS_REPLY_SCOPE, grantedScopes: scopes },
      403,
    );
  }

  /** Fails with a stable code before any call when the stored token lacks the read scope. */
  private assertReadRepliesScope(input: ThreadsCommentsInput): void {
    const rawScope = input.tokens?.scope ?? input.account.scopes?.join(",");
    if (!rawScope) return;
    const scopes = rawScope.split(/[,\s]+/).filter(Boolean);
    if (scopes.includes("threads_read_replies")) return;
    throw new RelayError(
      "The connected Threads token lacks threads_read_replies. Reconnect Threads and approve the new read-only scope to read comments.",
      "threads_scope_missing",
      { requiredScope: "threads_read_replies", grantedScopes: scopes },
      403,
    );
  }

  private async readFetch(
    ctx: AdapterContext,
    label: string,
    url: string,
    headers: Record<string, string>,
  ): Promise<unknown> {
    try {
      return await providerFetch(ctx, label, url, { headers });
    } catch (error) {
      if (isThreadsScopeError(error)) {
        throw new RelayError(
          "The connected Threads token lacks threads_read_replies. Reconnect Threads and approve the new read-only scope to read comments.",
          "threads_scope_missing",
          error instanceof RelayError ? error.details : undefined,
          403,
        );
      }
      throw error;
    }
  }

  private postUrl(account: Account, postId: string): string {
    const handle = account.handle.replace(/^@/, "");
    return `https://www.threads.net/@${handle}/post/${postId}`;
  }

  /**
   * When a publish call fails ambiguously (network drop, timeout, 5xx, unknown),
   * the post may still exist at Meta. Ask the container status endpoint and,
   * failing that, list the five newest posts on the account and match the text
   * plus a recent timestamp. Returns the post id when it can be reconciled.
   */
  private async reconcileAmbiguousPublish(
    ctx: AdapterContext,
    tokens: OAuthTokens,
    text: string,
    containerId: string | undefined,
    error: unknown,
  ): Promise<string | null> {
    if (!isAmbiguousThreadsError(error)) return null;

    if (containerId) {
      try {
        const json = await providerFetch(ctx, "Threads reconcile container status", `${GRAPH_URL}/${containerId}?fields=status,id`, {
          headers: authHeaders(tokens.accessToken),
        });
        const data = asObject(json);
        const id = getString(data, "id");
        if (getString(data, "status") === "PUBLISHED" && id) return id;
      } catch {
        // Fall through to the recent-posts lookup.
      }
    }

    try {
      const json = await providerFetch(
        ctx,
        "Threads reconcile recent posts",
        `${GRAPH_URL}/me/threads?fields=id,text,timestamp&limit=5`,
        { headers: authHeaders(tokens.accessToken) },
      );
      const wanted = text.trim();
      if (!wanted) return null;
      const now = ctx.now().getTime();
      for (const entry of asArray(asObject(json)?.data)) {
        const data = asObject(entry);
        const id = getString(data, "id");
        const entryText = getString(data, "text");
        const timestamp = getString(data, "timestamp");
        if (!id || !entryText || !timestamp || entryText.trim() !== wanted) continue;
        const created = Date.parse(timestamp);
        if (!Number.isFinite(created)) continue;
        const age = now - created;
        if (age >= -60_000 && age <= 10 * 60 * 1000) return id;
      }
    } catch {
      // No reconciliation was possible; the original error is more useful.
    }
    return null;
  }

  /** Threads ids look like `threads:<external id>` in the account record. */
  private async resolveUserId(ctx: AdapterContext, account: Account, tokens: OAuthTokens): Promise<string> {
    const prefix = "threads:";
    if (account.id.startsWith(prefix) && account.id.length > prefix.length) {
      return account.id.slice(prefix.length);
    }
    const profile = await this.fetchProfile(ctx, tokens);
    return profile.externalId;
  }

  private async fetchProfile(ctx: AdapterContext, tokens: OAuthTokens): Promise<ProfileInfo> {
    const json = await providerFetch(ctx, "Threads profile", PROFILE_URL, { headers: authHeaders(tokens.accessToken) });
    const data = asObject(json);
    const externalId = getString(data, "id");
    if (!externalId) throw new RelayError("Threads did not return a profile id", "threads_profile_invalid", json, 502);
    return {
      externalId,
      handle: getString(data, "username") ?? externalId,
      displayName: getString(data, "username"),
      avatarUrl: getString(data, "threads_profile_picture_url"),
    };
  }

  /** Polls a media container until Meta reports FINISHED (or fails). */
  private async waitForContainer(ctx: AdapterContext, tokens: OAuthTokens, containerId: string): Promise<void> {
    const pollInterval = envMs(ctx, "RELAY_THREADS_POLL_INTERVAL_MS", CONTAINER_POLL_INTERVAL_MS);
    for (let attempt = 0; attempt < CONTAINER_POLL_LIMIT; attempt += 1) {
      const json = await providerFetch(
        ctx,
        "Threads container status",
        `${GRAPH_URL}/${containerId}?fields=status,error_message`,
        { headers: authHeaders(tokens.accessToken) },
      );
      const data = asObject(json);
      const status = getString(data, "status");
      if (status === "FINISHED" || status === "PUBLISHED") return;
      if (status === "ERROR" || status === "EXPIRED") {
        const errorMessage = getString(data, "error_message");
        throw new RelayError(
          `Threads could not process container ${containerId}: ${errorMessage ?? status}`,
          "threads_media_processing_failed",
          data,
        );
      }
      await sleep(pollInterval);
    }
    throw new RelayError(
      `Timed out waiting for Threads to process container ${containerId}`,
      "threads_media_processing_timeout",
    );
  }
}

/**
 * Definite 4xx failures mean Meta rejected the request, so there is nothing to
 * reconcile. Timeouts, transport failures, 5xx responses and unknown thrown
 * values are ambiguous: the publish may have succeeded.
 */
function isAmbiguousThreadsError(error: unknown): boolean {
  if (!(error instanceof RelayError)) return true;
  if (/timeout|network/i.test(error.code) || /timed out|timeout|network|could not reach/i.test(error.message)) {
    return true;
  }
  return !(error.statusCode >= 400 && error.statusCode < 500);
}

/**
 * Recognizes Meta's permission/scope failures so comment reads can report the
 * actionable `threads_scope_missing` code instead of a generic provider error.
 */
function isThreadsScopeError(error: unknown): boolean {
  if (!(error instanceof RelayError)) return false;
  const details = error.details === undefined ? "" : JSON.stringify(error.details);
  if (/scope|permission|not authorized|application does not have/i.test(`${error.message} ${details}`)) {
    return true;
  }
  const provider = asObject(asObject(error.details)?.provider);
  const code = provider?.code;
  return code === 10 || code === 200 || code === "10" || code === "200";
}
