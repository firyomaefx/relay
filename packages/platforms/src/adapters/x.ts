import { randomUUID } from "node:crypto";
import { AuthError, ConfigurationError, RelayError } from "@relay/core";
import type {
  MediaItem,
  AdapterContext,
  ArticlePublishInput,
  DeletePostInput,
  DeletePostResult,
  AuthorizeRequest,
  AuthorizeResult,
  ConnectResult,
  ExchangeRequest,
  MediaBlob,
  OAuthTokens,
  PlatformAdapter,
  PlatformLimits,
  ProfileInfo,
  PublishInput,
  PublishResult,
} from "@relay/core";
import { mockProfile, mockPublish, mockScopes } from "../mock.js";
import {
  asObject,
  authHeaders,
  basicAuthorization,
  chunkBuffer,
  formBody,
  getNumber,
  getString,
  oauthTokensFrom,
  pkceChallenge,
  providerFetch,
  scopesFrom,
  sleep,
} from "./http.js";

const AUTHORIZE_URL = "https://twitter.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const API_BASE = "https://api.x.com/2";
const MEDIA_UPLOAD_URL = `${API_BASE}/media/upload`;
const SCOPES = ["tweet.read", "tweet.write", "users.read", "offline.access", "media.write"] as const;

/** Maps Relay's reply controls onto X's `reply_settings` enum. */
function mapReplySetting(value: "everyone" | "followers" | "mentioned" | undefined): string | undefined {
  if (value === "followers") return "following";
  if (value === "mentioned") return "mentionedUsers";
  return undefined;
}

/** X append calls accept at most 5 MB per segment; 4 MB leaves headroom. */
const MEDIA_CHUNK_BYTES = 4 * 1024 * 1024;
const MEDIA_POLL_LIMIT = 90;

/**
 * X (Twitter) adapter: OAuth 2.0 authorization code + PKCE, token refresh,
 * profile lookup, chunked v2 media upload and posting (single posts, threads,
 * replies and quote posts).
 */
export class XAdapter implements PlatformAdapter {
  readonly platform = "x" as const;

  readonly limits: PlatformLimits = {
    platform: "x",
    displayName: "X",
    maxTextLength: 280,
    maxParts: 25,
    maxMediaPerPost: 4,
    maxVideosPerPost: 1,
    maxMediaWithVideo: 1,
    requiresMedia: false,
    maxImageBytes: 5 * 1024 * 1024,
    maxVideoBytes: 512 * 1024 * 1024,
    allowedImageTypes: ["image/jpeg", "image/png", "image/webp"],
    allowedVideoTypes: ["video/mp4", "video/quicktime"],
    mediaUpload: "direct",
    notes: "Threads of up to 25 posts; 4 images or 1 video per post.",
  };

  isConfigured(ctx: AdapterContext): boolean {
    const credentials = ctx.credentials("x");
    return Boolean(credentials.clientId && credentials.clientSecret);
  }

  isLive(ctx: AdapterContext): boolean {
    return !ctx.forceMock && this.isConfigured(ctx);
  }

  async authorize(ctx: AdapterContext, req: AuthorizeRequest): Promise<AuthorizeResult> {
    if (!this.isLive(ctx)) {
      return { kind: "mock", profile: mockProfile("x"), scopes: mockScopes("x") };
    }
    const { clientId } = ctx.credentials("x");
    if (!clientId) throw new ConfigurationError("X credentials are not configured", "x_credentials_missing");
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", req.redirectUri);
    url.searchParams.set("scope", SCOPES.join(" "));
    url.searchParams.set("state", req.state);
    url.searchParams.set("code_challenge", pkceChallenge(req.codeVerifier));
    url.searchParams.set("code_challenge_method", "S256");
    return { kind: "redirect", url: url.toString() };
  }

  async exchange(ctx: AdapterContext, req: ExchangeRequest): Promise<ConnectResult> {
    if (!this.isLive(ctx)) {
      throw new ConfigurationError(
        "X sign-in is simulated in mock mode; disable mock mode and configure credentials to connect a real account",
        "x_live_disabled",
      );
    }
    const { clientId, clientSecret } = ctx.credentials("x");
    if (!clientId || !clientSecret) {
      throw new ConfigurationError(
        "X client id and client secret are required for the token exchange",
        "x_credentials_missing",
      );
    }
    const json = await providerFetch(ctx, "X token exchange", TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: basicAuthorization(clientId, clientSecret),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formBody({
        grant_type: "authorization_code",
        code: req.code,
        redirect_uri: req.redirectUri,
        code_verifier: req.codeVerifier,
      }),
    });
    const tokens = oauthTokensFrom(json, ctx.now());
    const profile = await this.fetchProfile(ctx, tokens);
    return { profile, tokens, scopes: scopesFrom(json, SCOPES) };
  }

  async refresh(ctx: AdapterContext, tokens: OAuthTokens): Promise<OAuthTokens> {
    const { clientId, clientSecret } = ctx.credentials("x");
    if (!clientId || !clientSecret) {
      throw new ConfigurationError("X client id and client secret are required to refresh a token", "x_credentials_missing");
    }
    if (!tokens.refreshToken) {
      throw new ConfigurationError("X refresh token is missing; reconnect the account", "x_refresh_token_missing");
    }
    const json = await providerFetch(ctx, "X token refresh", TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: basicAuthorization(clientId, clientSecret),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formBody({ grant_type: "refresh_token", refresh_token: tokens.refreshToken }),
    });
    const refreshed = oauthTokensFrom(json, ctx.now());
    return {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
      expiresAt: refreshed.expiresAt,
      tokenType: refreshed.tokenType ?? tokens.tokenType,
      scope: refreshed.scope ?? tokens.scope,
    };
  }

  async publish(ctx: AdapterContext, input: PublishInput): Promise<PublishResult> {
    if (!this.isLive(ctx) || !input.tokens) return mockPublish("x", input);
    const tokens = input.tokens;
    const quotePostId = input.post.options.quotePostId?.trim() || undefined;
    const rootReplyToId = input.post.options.replyToId?.toString().trim() || undefined;
    if (rootReplyToId && !/^\d{1,25}$/.test(rootReplyToId)) {
      throw new RelayError(`X replyToId must be a numeric X post id (got "${rootReplyToId}")`, "x_reply_to_invalid");
    }
    if (rootReplyToId && quotePostId) {
      throw new RelayError("X: use either replyToId or quotePostId, not both", "x_reply_to_invalid");
    }

    const partIds: string[] = [];
    const partMediaIds: string[][] = [];

    for (let index = 0; index < input.post.parts.length; index += 1) {
      const part = input.post.parts[index]!;
      const mediaIds: string[] = [];
      for (const item of part.media) {
        const blob = await ctx.readMedia(item);
        mediaIds.push(await this.uploadMedia(ctx, tokens, blob, item.kind));
      }

      const payload: Record<string, unknown> = {};
      if (part.text) payload.text = part.text;
      if (mediaIds.length > 0) payload.media = { media_ids: mediaIds };
      if (index > 0) {
        payload.reply = { in_reply_to_tweet_id: partIds[index - 1] };
      } else if (rootReplyToId) {
        payload.reply = { in_reply_to_tweet_id: rootReplyToId };
      } else if (quotePostId) {
        payload.quote_tweet_id = quotePostId;
      }
      const replySettings = mapReplySetting(input.post.options.replySetting);
      if (replySettings) payload.reply_settings = replySettings;

      const json = await providerFetch(ctx, `X create post (part ${index + 1})`, `${API_BASE}/tweets`, {
        method: "POST",
        headers: { ...authHeaders(tokens.accessToken), "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const tweetId = getString(asObject(asObject(json)?.data), "id");
      if (!tweetId) throw new RelayError("X did not return a post id", "x_post_id_missing", json, 502);
      const handle = input.account.handle.replace(/^@/, "");
      const url = `https://x.com/${handle}/status/${tweetId}`;
      await ctx.onPartPublished?.({
        platform: "x",
        part: index + 1,
        postId: tweetId,
        url,
        details: { replyToId: partIds[index - 1] ?? rootReplyToId ?? null, mediaIds },
      });
      partIds.push(tweetId);
      partMediaIds.push(mediaIds);
    }

    const firstId = partIds[0];
    if (!firstId) throw new RelayError("X post has no parts to publish", "x_post_empty");
    const handle = input.account.handle.replace(/^@/, "");
    return {
      platformPostId: firstId,
      url: `https://x.com/${handle}/status/${firstId}`,
      mock: false,
      details: {
        partIds,
        mediaIds: partMediaIds,
        quotePostId: quotePostId ?? null,
        replyToId: rootReplyToId ?? null,
      },
    };
  }

  /**
   * Publishes an X Article: POST /2/articles/draft, then POST /2/articles/{id}/publish.
   * Both need the tweet.write scope; a cover image also needs media.write.
   * An AuthError can only come from steps before the draft exists, so the core
   * service may retry it after a token refresh without creating a second draft.
   */
  async publishArticle(ctx: AdapterContext, input: ArticlePublishInput): Promise<PublishResult> {
    const { article } = input;
    if (!this.isLive(ctx) || !input.tokens) {
      return {
        platformPostId: `mock_x_article_${randomUUID()}`,
        mock: true,
        details: {
          simulated: true,
          handle: input.account.handle,
          title: article.title,
          blocks: article.blocks.length,
          cover: Boolean(article.cover),
          images: article.blocks.filter((block) => block.type === "atomic" && block.image).length,
        },
      };
    }
    const tokens = input.tokens;
    // Every upload happens before the draft exists. The error names the step that failed,
    // and nothing is created or published on X unless all of them worked.
    const uploadedByPath = new Map<string, string>();
    const uploadImage = async (item: MediaItem, label: string): Promise<string> => {
      const cacheKey = item.path ?? "";
      const cached = cacheKey ? uploadedByPath.get(cacheKey) : undefined;
      if (cached) return cached;
      try {
        const blob = await ctx.readMedia(item);
        const mediaId = await this.uploadMedia(ctx, tokens, blob, "image");
        if (cacheKey) uploadedByPath.set(cacheKey, mediaId);
        return mediaId;
      } catch (error) {
        if (error instanceof AuthError) throw error;
        if (error instanceof RelayError) {
          throw new RelayError(`${label} failed: ${error.message}`, error.code, error.details, error.statusCode);
        }
        throw new RelayError(
          `${label} failed: ${error instanceof Error ? error.message : String(error)}`,
          "x_article_media_failed",
          undefined,
          502,
        );
      }
    };

    let coverMedia: { media_category: string; media_id: string } | undefined;
    if (article.cover) {
      const mediaId = await uploadImage(article.cover, "Cover image upload");
      coverMedia = { media_category: "tweet_image", media_id: mediaId };
    }

    // Inline images are DraftJS atomic blocks. The block text is one space, entity_ranges
    // points at an entry of the entities array (by index), and the entity carries the media id.
    const entities: Array<Record<string, unknown>> = [];
    const contentBlocks: Array<Record<string, unknown>> = [];
    const inlineMediaIds: string[] = [];
    for (const [index, block] of article.blocks.entries()) {
      if (block.type === "atomic") {
        if (!block.image) continue;
        const number = inlineMediaIds.length + 1;
        const mediaId = await uploadImage(block.image, `Inline image ${number} upload (${block.image.path ?? "no path"})`);
        inlineMediaIds.push(mediaId);
        const entityIndex = entities.length;
        const caption = block.image.caption?.trim();
        entities.push({
          key: String(entityIndex),
          value: {
            type: "image",
            mutability: "immutable",
            data: {
              media_items: [{ media_category: "tweet_image", media_id: mediaId }],
              ...(caption ? { caption } : {}),
            },
          },
        });
        contentBlocks.push({
          key: `b${index}`,
          text: " ",
          type: "atomic",
          entity_ranges: [{ key: entityIndex, offset: 0, length: 1 }],
          inline_style_ranges: [],
        });
      } else {
        contentBlocks.push({ key: `b${index}`, text: block.text, type: block.type });
      }
    }

    const payload: Record<string, unknown> = {
      title: article.title,
      content_state: { blocks: contentBlocks, entities },
    };
    if (coverMedia) payload.cover_media = coverMedia;

    const drafted = await providerFetch(ctx, "X create Article draft", `${API_BASE}/articles/draft`, {
      method: "POST",
      headers: { ...authHeaders(tokens.accessToken), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const draftId = getString(asObject(asObject(drafted)?.data), "id");
    if (!draftId) throw new RelayError("X did not return an Article draft id", "x_article_draft_id_missing", drafted, 502);

    let published: unknown;
    try {
      published = await providerFetch(ctx, "X publish Article", `${API_BASE}/articles/${draftId}/publish`, {
        method: "POST",
        headers: authHeaders(tokens.accessToken),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new RelayError(
        `${message} (the Article draft ${draftId} was created and is still in your X drafts)`,
        "x_article_publish_failed",
        { articleDraftId: draftId, cause: error instanceof RelayError ? error.details : undefined },
        error instanceof RelayError ? error.statusCode : 502,
      );
    }
    const postId = getString(asObject(asObject(published)?.data), "post_id");
    if (!postId) {
      throw new RelayError(
        `X did not return a post id for the Article (draft ${draftId})`,
        "x_article_post_id_missing",
        { articleDraftId: draftId, body: published },
        502,
      );
    }
    const handle = input.account.handle.replace(/^@/, "");
    return {
      platformPostId: postId,
      url: `https://x.com/${handle}/status/${postId}`,
      mock: false,
      details: { articleDraftId: draftId, coverMediaId: coverMedia?.media_id ?? null, inlineMediaIds },
    };
  }

  /** DELETE /2/tweets/{id} (tweet.write). Only the account's own posts can be deleted. */
  async deletePost(ctx: AdapterContext, postId: string, input: DeletePostInput): Promise<DeletePostResult> {
    if (!this.isLive(ctx) || !input.tokens) return { deleted: true, mock: true };
    if (!/^\d{1,19}$/.test(postId)) {
      throw new RelayError(`X post ids are numbers; got "${postId}"`, "x_post_id_invalid", undefined, 400);
    }

    let json: unknown;
    try {
      json = await providerFetch(ctx, "X delete post", `${API_BASE}/tweets/${postId}`, {
        method: "DELETE",
        headers: authHeaders(input.tokens.accessToken),
      });
    } catch (error) {
      if (error instanceof RelayError && !(error.code === "auth_error") && error.statusCode === 404) {
        return { deleted: true, mock: false, alreadyGone: true };
      }
      throw error;
    }
    if (asObject(asObject(json)?.data)?.deleted !== true) {
      throw new RelayError("X did not confirm the delete", "x_delete_not_confirmed", json, 502);
    }
    return { deleted: true, mock: false };
  }

  private async fetchProfile(ctx: AdapterContext, tokens: OAuthTokens): Promise<ProfileInfo> {
    const json = await providerFetch(
      ctx,
      "X profile",
      `${API_BASE}/users/me?user.fields=profile_image_url`,
      { headers: authHeaders(tokens.accessToken) },
    );
    const data = asObject(asObject(json)?.data);
    const externalId = getString(data, "id");
    if (!externalId) throw new RelayError("X did not return a profile id", "x_profile_invalid", json, 502);
    return {
      externalId,
      handle: getString(data, "username") ?? externalId,
      displayName: getString(data, "name"),
      avatarUrl: getString(data, "profile_image_url"),
    };
  }

  /**
   * Uploads one media item and returns its media id.
   *
   * Images use the single-request multipart upload (documented as the normal
   * path for small media). Videos always use the v2 INIT/APPEND/FINALIZE flow,
   * which the X docs require for video uploads.
   */
  private async uploadMedia(
    ctx: AdapterContext,
    tokens: OAuthTokens,
    blob: MediaBlob,
    kind: "image" | "video",
  ): Promise<string> {
    if (blob.buffer.length === 0) {
      throw new RelayError(`Cannot upload an empty ${kind} file to X`, "x_media_empty");
    }
    const mediaCategory = kind === "video" ? "tweet_video" : "tweet_image";
    if (kind === "image") {
      const form = new FormData();
      form.set("media", new Blob([new Uint8Array(blob.buffer)], { type: blob.mimeType }), blob.filename);
      form.set("media_category", mediaCategory);
      const uploaded = await providerFetch(ctx, "X media upload", MEDIA_UPLOAD_URL, {
        method: "POST",
        headers: authHeaders(tokens.accessToken),
        body: form,
      });
      const mediaId = getString(asObject(asObject(uploaded)?.data), "id");
      if (!mediaId) throw new RelayError("X did not return a media id", "x_media_id_missing", uploaded, 502);
      const processing = asObject(asObject(uploaded)?.data)?.processing_info;
      await this.waitForMediaProcessing(ctx, tokens, mediaId, processing);
      return mediaId;
    }

    const init = await providerFetch(ctx, "X media upload init", `${MEDIA_UPLOAD_URL}/initialize`, {
      method: "POST",
      headers: { ...authHeaders(tokens.accessToken), "Content-Type": "application/json" },
      body: JSON.stringify({
        media_type: blob.mimeType,
        total_bytes: blob.buffer.length,
        media_category: mediaCategory,
      }),
    });
    const initData = asObject(asObject(init)?.data);
    const mediaId = getString(initData, "id") ?? getString(initData, "media_id");
    if (!mediaId) throw new RelayError("X did not return a media id", "x_media_id_missing", init, 502);

    const chunks = chunkBuffer(blob.buffer, MEDIA_CHUNK_BYTES);
    for (let index = 0; index < chunks.length; index += 1) {
      const form = new FormData();
      form.set("segment_index", String(index));
      form.set("media", new Blob([new Uint8Array(chunks[index]!)], { type: blob.mimeType }), blob.filename);
      await providerFetch(ctx, `X media upload chunk ${index + 1}`, `${MEDIA_UPLOAD_URL}/${mediaId}/append`, {
        method: "POST",
        headers: authHeaders(tokens.accessToken),
        body: form,
      });
    }

    const finalized = await providerFetch(ctx, "X media upload finalize", `${MEDIA_UPLOAD_URL}/${mediaId}/finalize`, {
      method: "POST",
      headers: authHeaders(tokens.accessToken),
    });
    const processing = asObject(asObject(finalized)?.data)?.processing_info;
    await this.waitForMediaProcessing(ctx, tokens, mediaId, processing);
    return mediaId;
  }

  private async waitForMediaProcessing(
    ctx: AdapterContext,
    tokens: OAuthTokens,
    mediaId: string,
    initial: unknown,
  ): Promise<void> {
    let processing = asObject(initial);
    for (let attempt = 0; attempt < MEDIA_POLL_LIMIT; attempt += 1) {
      if (!processing) return;
      const state = getString(processing, "state");
      if (!state || state === "succeeded") return;
      if (state === "failed") {
        const error = asObject(processing.error);
        throw new RelayError(
          `X could not process the uploaded media: ${getString(error, "message") ?? "processing failed"}`,
          "x_media_processing_failed",
          processing,
        );
      }
      const checkAfter = getNumber(processing, "check_after_secs") ?? 1;
      await sleep(Math.min(Math.max(checkAfter * 1000, 250), 5000));
      const status = await providerFetch(
        ctx,
        "X media processing status",
        `${MEDIA_UPLOAD_URL}?command=STATUS&media_id=${encodeURIComponent(mediaId)}`,
        { headers: authHeaders(tokens.accessToken) },
      );
      processing = asObject(asObject(asObject(status)?.data)?.processing_info);
    }
    throw new RelayError("Timed out waiting for X to process the uploaded media", "x_media_processing_timeout");
  }
}
