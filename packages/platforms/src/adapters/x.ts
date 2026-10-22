import { ConfigurationError, RelayError } from "@relay/core";
import type {
  AdapterContext,
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
        details: { replyToId: partIds[index - 1] ?? null, mediaIds },
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
      },
    };
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
