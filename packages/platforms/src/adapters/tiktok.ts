import { ConfigurationError, RelayError } from "@relay/core";
import type {
  AdapterContext,
  AuthorizeRequest,
  AuthorizeResult,
  ConnectResult,
  ExchangeRequest,
  MediaItem,
  OAuthTokens,
  PlatformAdapter,
  PlatformLimits,
  ProfileInfo,
  PublishInput,
  PublishResult,
} from "@relay/core";
import { mockProfile, mockPublish, mockScopes } from "../mock.js";
import {
  asArray,
  asObject,
  authHeaders,
  formBody,
  getString,
  oauthTokensFrom,
  pkceChallengeHex,
  providerErrorCode,
  providerFetch,
  publicMediaUrl,
  scopesFrom,
  sleep,
} from "./http.js";

const AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";
const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const USER_INFO_URL = "https://open.tiktokapis.com/v2/user/info/?fields=open_id,avatar_url,display_name";
const VIDEO_INIT_URL = "https://open.tiktokapis.com/v2/post/publish/video/init/";
const INBOX_VIDEO_INIT_URL = "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/";
const PHOTO_INIT_URL = "https://open.tiktokapis.com/v2/post/publish/content/init/";
const CREATOR_INFO_URL = "https://open.tiktokapis.com/v2/post/publish/creator_info/query/";
const PUBLISH_STATUS_URL = "https://open.tiktokapis.com/v2/post/publish/status/fetch/";
const JSON_HEADERS = { "Content-Type": "application/json; charset=UTF-8" };
const SCOPES = ["user.info.basic", "video.publish", "video.upload"] as const;

/** TikTok wants non-final chunks between 5 MB and 64 MB; one chunk is fine up to 64 MB. */
const MAX_SINGLE_CHUNK_BYTES = 64 * 1024 * 1024;
const MULTI_CHUNK_BYTES = 10 * 1024 * 1024;
const PUBLISH_POLL_LIMIT = 90;
const PUBLISH_POLL_INTERVAL_MS = 2000;

type TikTokPrivacy = "PUBLIC_TO_EVERYONE" | "MUTUAL_FOLLOW_FRIENDS" | "SELF_ONLY";

/**
 * TikTok adapter: OAuth (PKCE supported), token refresh, profile lookup and
 * Content Posting API publishing:
 * - videos via FILE_UPLOAD (init, chunk PUTs, status polling);
 * - photo carousels via PULL_FROM_URL with public image URLs.
 */
export class TikTokAdapter implements PlatformAdapter {
  readonly platform = "tiktok" as const;

  readonly limits: PlatformLimits = {
    platform: "tiktok",
    displayName: "TikTok",
    maxTextLength: 2200,
    maxParts: 1,
    maxMediaPerPost: 35,
    maxVideosPerPost: 1,
    maxMediaWithVideo: 1,
    requiresMedia: true,
    maxImageBytes: 20 * 1024 * 1024,
    maxVideoBytes: 4 * 1024 * 1024 * 1024,
    allowedImageTypes: ["image/jpeg", "image/png", "image/webp"],
    allowedVideoTypes: ["video/mp4", "video/quicktime", "video/webm"],
    mediaUpload: "mixed",
    notes: "One video or a photo carousel per post. Video uploads directly; photos need public URLs.",
  };

  isConfigured(ctx: AdapterContext): boolean {
    const credentials = ctx.credentials("tiktok");
    return Boolean(credentials.clientId && credentials.clientSecret);
  }

  isLive(ctx: AdapterContext): boolean {
    return !ctx.forceMock && this.isConfigured(ctx);
  }

  async authorize(ctx: AdapterContext, req: AuthorizeRequest): Promise<AuthorizeResult> {
    if (!this.isLive(ctx)) {
      return { kind: "mock", profile: mockProfile("tiktok"), scopes: mockScopes("tiktok") };
    }
    const { clientId } = ctx.credentials("tiktok");
    if (!clientId) throw new ConfigurationError("TikTok credentials are not configured", "tiktok_credentials_missing");
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_key", clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", SCOPES.join(","));
    url.searchParams.set("redirect_uri", req.redirectUri);
    url.searchParams.set("state", req.state);
    url.searchParams.set("code_challenge", pkceChallengeHex(req.codeVerifier));
    url.searchParams.set("code_challenge_method", "S256");
    return { kind: "redirect", url: url.toString() };
  }

  async exchange(ctx: AdapterContext, req: ExchangeRequest): Promise<ConnectResult> {
    if (!this.isLive(ctx)) {
      throw new ConfigurationError(
        "TikTok sign-in is simulated in mock mode; disable mock mode and configure credentials to connect a real account",
        "tiktok_live_disabled",
      );
    }
    const { clientId, clientSecret } = ctx.credentials("tiktok");
    if (!clientId || !clientSecret) {
      throw new ConfigurationError(
        "TikTok client key and client secret are required for the token exchange",
        "tiktok_credentials_missing",
      );
    }
    const json = await providerFetch(ctx, "TikTok token exchange", TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({
        client_key: clientId,
        client_secret: clientSecret,
        code: req.code,
        grant_type: "authorization_code",
        redirect_uri: req.redirectUri,
        code_verifier: req.codeVerifier,
      }),
    });
    const tokens = oauthTokensFrom(json, ctx.now());
    const profile = await this.fetchProfile(ctx, tokens);
    return { profile, tokens, scopes: scopesFrom(json, SCOPES) };
  }

  async refresh(ctx: AdapterContext, tokens: OAuthTokens): Promise<OAuthTokens> {
    const { clientId, clientSecret } = ctx.credentials("tiktok");
    if (!clientId || !clientSecret) {
      throw new ConfigurationError("TikTok credentials are required to refresh a token", "tiktok_credentials_missing");
    }
    if (!tokens.refreshToken) {
      throw new ConfigurationError("TikTok refresh token is missing; reconnect the account", "tiktok_refresh_token_missing");
    }
    const json = await providerFetch(ctx, "TikTok token refresh", TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({
        client_key: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
      }),
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
    if (!this.isLive(ctx) || !input.tokens) return mockPublish("tiktok", input);
    const tokens = input.tokens;
    const options = input.post.options;
    const requestedPrivacy: TikTokPrivacy =
      options.tiktokPrivacy ?? (options.selfOnly ? "SELF_ONLY" : "PUBLIC_TO_EVERYONE");
    const caption = input.post.parts
      .map((part) => part.text)
      .filter(Boolean)
      .join("\n\n");

    const media = input.post.parts.flatMap((part) => part.media);
    const videos = media.filter((item) => item.kind === "video");
    const photos = media.filter((item) => item.kind === "image");
    if (videos.length > 0 && photos.length > 0) {
      throw new RelayError("TikTok cannot mix a video with photos in one post", "tiktok_media_mixed");
    }
    if (videos.length > 1) {
      throw new RelayError("TikTok accepts one video per post", "tiktok_too_many_videos");
    }
    if (videos.length === 0 && photos.length === 0) {
      throw new RelayError("TikTok needs at least one image or video", "tiktok_media_required");
    }

    const autoAddMusic = options.tiktokAutoAddMusic ?? true;
    const draft = options.tiktokMode === "draft";
    if (draft && photos.length > 0) {
      throw new RelayError(
        "TikTok draft uploads support video only. Use Direct Post for photo posts.",
        "tiktok_draft_video_only",
      );
    }

    // Direct Post requires the creator's current options: privacy_level must be
    // one the account allows, and comments cannot be enabled when disabled.
    let privacy = requestedPrivacy;
    let privacyFallback = false;
    let disableComment = Boolean(options.disableComment);
    if (!draft) {
      const creatorInfo = await this.queryCreatorInfo(ctx, tokens);
      const allowedPrivacy = asArray(creatorInfo.privacy_level_options).filter(
        (option): option is string => typeof option === "string" && option.length > 0,
      );
      if (allowedPrivacy.length > 0 && !allowedPrivacy.includes(privacy)) {
        privacy = (allowedPrivacy.includes("SELF_ONLY") ? "SELF_ONLY" : allowedPrivacy[0]!) as TikTokPrivacy;
        privacyFallback = true;
      }
      if (creatorInfo.comment_disabled === true) disableComment = true;
    }

    const commonPostInfo = {
      privacy_level: privacy,
      disable_comment: disableComment,
      brand_content_toggle: false,
      brand_organic_toggle: false,
    };
    const videoPostInfo = { title: truncateChars(caption, 2200), ...commonPostInfo };
    const photoPostInfo = {
      // Photo posts cap the title at 90 chars, so use the first caption line
      // there and keep the full caption in `description` (max 4000 chars).
      title: truncateChars(firstLine(caption), 90),
      description: truncateChars(caption, 4000),
      ...commonPostInfo,
      auto_add_music: autoAddMusic,
    };

    let publishId: string;
    let draftFallback = false;
    if (videos.length > 0) {
      try {
        publishId = await this.publishVideo(ctx, tokens, videos[0]!, draft ? null : videoPostInfo);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // TikTok blocks public Direct Posts until the app passes its audit.
        // Send the video to the creator's inbox instead of losing the upload.
        if (!draft && /unaudited_client_can_only_post_to_private_accounts/i.test(message)) {
          publishId = await this.publishVideo(ctx, tokens, videos[0]!, null);
          draftFallback = true;
        } else {
          throw error;
        }
      }
    } else {
      publishId = await this.publishPhotos(ctx, tokens, photos, photoPostInfo);
    }
    const usedDraft = draft || draftFallback;
    // Persist the publish id before waiting for TikTok to finish processing so a
    // later status failure is still a partial success, not a lost post.
    await ctx.onPartPublished?.({
      platform: "tiktok",
      part: 1,
      postId: publishId,
      details: {
        publishId,
        mediaType: videos.length > 0 ? "video" : "photo",
        mode: usedDraft ? "draft" : "direct",
        privacy,
        ...(draftFallback ? { draftFallback: true, reason: "TikTok app is unaudited; video was sent to the TikTok inbox." } : {}),
      },
    });
    // Inbox drafts are complete once the chunks are uploaded; TikTok keeps them
    // as editable drafts and does not report a Direct Post status for them.
    const status = usedDraft ? "DRAFT_UPLOADED" : await this.waitForPublish(ctx, tokens, publishId);

    return {
      platformPostId: publishId,
      mock: false,
      details: {
        publishId,
        status,
        mediaType: videos.length > 0 ? "video" : "photo",
        mode: usedDraft ? "draft" : "direct",
        privacy,
        requestedPrivacy,
        privacyFallback,
        draftFallback,
        disableComment,
        captionLength: caption.length,
        ...(photos.length > 0 ? { autoAddMusic } : {}),
      },
    };
  }

  /** Reads the creator's allowed privacy levels and comment setting. */
  private async queryCreatorInfo(ctx: AdapterContext, tokens: OAuthTokens): Promise<Record<string, unknown>> {
    const json = await providerFetch(ctx, "TikTok creator info", CREATOR_INFO_URL, {
      method: "POST",
      headers: { ...authHeaders(tokens.accessToken), ...JSON_HEADERS },
      body: JSON.stringify({}),
    });
    return asObject(asObject(json)?.data) ?? {};
  }

  private async fetchProfile(ctx: AdapterContext, tokens: OAuthTokens): Promise<ProfileInfo> {
    const json = await providerFetch(ctx, "TikTok profile", USER_INFO_URL, { headers: authHeaders(tokens.accessToken) });
    const data = asObject(asObject(json)?.data);
    const user = asObject(data?.user);
    const externalId = getString(user, "open_id") ?? getString(data, "open_id");
    if (!externalId) throw new RelayError("TikTok did not return a profile id", "tiktok_profile_invalid", json, 502);
    const displayName = getString(user, "display_name");
    return {
      externalId,
      handle: displayName ?? externalId,
      displayName,
      avatarUrl: getString(user, "avatar_url"),
    };
  }

  private async publishVideo(
    ctx: AdapterContext,
    tokens: OAuthTokens,
    video: MediaItem,
    postInfo: {
      title: string;
      privacy_level: TikTokPrivacy;
      disable_comment: boolean;
      brand_content_toggle: boolean;
      brand_organic_toggle: boolean;
    } | null,
  ): Promise<string> {
    const blob = await ctx.readMedia(video);
    if (blob.buffer.length === 0) throw new RelayError("Cannot upload an empty video to TikTok", "tiktok_media_empty");
    const plan = planChunks(blob.buffer.length);
    const draft = postInfo === null;
    const body = {
      ...(postInfo ? { post_info: postInfo } : {}),
      source_info: {
        source: "FILE_UPLOAD",
        video_size: blob.buffer.length,
        chunk_size: plan.chunkSize,
        total_chunk_count: plan.chunkCount,
      },
    };
    const init = await providerFetch(
      ctx,
      draft ? "TikTok inbox upload init" : "TikTok video init",
      draft ? INBOX_VIDEO_INIT_URL : VIDEO_INIT_URL,
      {
        method: "POST",
        headers: { ...authHeaders(tokens.accessToken), ...JSON_HEADERS },
        body: JSON.stringify(body),
      },
    );
    const initData = asObject(asObject(init)?.data);
    const publishId = getString(initData, "publish_id");
    const uploadUrl = getString(initData, "upload_url");
    if (!publishId || !uploadUrl) {
      throw new RelayError("TikTok did not return an upload URL", "tiktok_upload_url_missing", init, 502);
    }

    let offset = 0;
    for (let index = 0; index < plan.chunkCount; index += 1) {
      const start = offset;
      const endExclusive =
        index === plan.chunkCount - 1 ? blob.buffer.length : Math.min(start + plan.chunkSize, blob.buffer.length);
      const chunk = blob.buffer.subarray(start, endExclusive);
      offset = endExclusive;
      await providerFetch(ctx, `TikTok video chunk ${index + 1}`, uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": blob.mimeType || "video/mp4",
          "Content-Length": String(chunk.length),
          "Content-Range": `bytes ${start}-${endExclusive - 1}/${blob.buffer.length}`,
        },
        body: new Uint8Array(chunk),
      });
    }
    return publishId;
  }

  private async publishPhotos(
    ctx: AdapterContext,
    tokens: OAuthTokens,
    photos: MediaItem[],
    postInfo: {
      title: string;
      description: string;
      privacy_level: TikTokPrivacy;
      disable_comment: boolean;
      auto_add_music: boolean;
      brand_content_toggle: boolean;
      brand_organic_toggle: boolean;
    },
  ): Promise<string> {
    const photoImages = photos.map((item) => publicMediaUrl(ctx, item, "TikTok"));
    let init: unknown;
    try {
      init = await providerFetch(ctx, "TikTok photo init", PHOTO_INIT_URL, {
        method: "POST",
        headers: { ...authHeaders(tokens.accessToken), ...JSON_HEADERS },
        body: JSON.stringify({
          post_info: postInfo,
          source_info: {
            source: "PULL_FROM_URL",
            photo_cover_index: 0,
            photo_images: photoImages,
          },
          post_mode: "DIRECT_POST",
          media_type: "PHOTO",
        }),
      });
    } catch (error) {
      if (error instanceof RelayError && providerErrorCode(error.details) === "url_ownership_unverified") {
        throw new RelayError(
          "TikTok rejected the photo URL because its domain is not verified for this app. Verify the media domain/URL prefix in the TikTok developer portal (Content Posting API -> URL properties), then retry.",
          "tiktok_url_ownership_unverified",
          error.details,
          error.statusCode,
        );
      }
      throw error;
    }
    const publishId = getString(asObject(asObject(init)?.data), "publish_id");
    if (!publishId) throw new RelayError("TikTok did not return a publish id", "tiktok_publish_id_missing", init, 502);
    return publishId;
  }

  private async waitForPublish(ctx: AdapterContext, tokens: OAuthTokens, publishId: string): Promise<string> {
    for (let attempt = 0; attempt < PUBLISH_POLL_LIMIT; attempt += 1) {
      const json = await providerFetch(ctx, "TikTok publish status", PUBLISH_STATUS_URL, {
        method: "POST",
        headers: { ...authHeaders(tokens.accessToken), ...JSON_HEADERS },
        body: JSON.stringify({ publish_id: publishId }),
      });
      const data = asObject(asObject(json)?.data);
      const status = getString(data, "status");
      if (status === "PUBLISH_COMPLETE") return status;
      if (status === "FAILED") {
        throw new RelayError(
          `TikTok failed to publish the post: ${getString(data, "fail_reason") ?? "unknown error"}`,
          "tiktok_publish_failed",
          data,
        );
      }
      await sleep(PUBLISH_POLL_INTERVAL_MS);
    }
    throw new RelayError("Timed out waiting for TikTok to publish the post", "tiktok_publish_timeout");
  }
}

/** Truncates by Unicode code points so a surrogate pair is never split. */
function truncateChars(value: string, max: number): string {
  return Array.from(value).slice(0, max).join("");
}

/** The first line of a caption, used for TikTok's 90-char photo title. */
function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0] ?? "";
}

function planChunks(totalBytes: number): { chunkSize: number; chunkCount: number } {
  if (totalBytes <= MAX_SINGLE_CHUNK_BYTES) {
    // TikTok: videos under 5 MB must be sent whole; 5 MB..64 MB also fits in a
    // single chunk with chunk_size equal to the file size.
    return { chunkSize: totalBytes, chunkCount: 1 };
  }
  // TikTok's rule: total_chunk_count = floor(video_size / chunk_size). The
  // trailing bytes ride along in the final chunk (allowed up to 128 MB), so
  // never round up here.
  const chunkCount = Math.max(1, Math.floor(totalBytes / MULTI_CHUNK_BYTES));
  return { chunkSize: MULTI_CHUNK_BYTES, chunkCount };
}
