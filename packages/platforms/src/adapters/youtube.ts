import { randomUUID } from "node:crypto";
import { ConfigurationError, RelayError } from "@relay/core";
import type {
  AdapterContext,
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
} from "@relay/core";
import { mockProfile, mockPublish, mockScopes } from "../mock.js";
import {
  asObject,
  formBody,
  getString,
  oauthTokensFrom,
  pkceChallenge,
  providerFetch,
  scopesFrom,
} from "./http.js";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels";
const UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos";

const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
] as const;

const DEFAULT_CATEGORY_ID = "27"; // Education
const MAX_TITLE = 100;
const MAX_DESCRIPTION = 5000;

function titleFromText(text: string, override: string | undefined): string {
  const raw = override?.trim() || text.split(/\r?\n/)[0]?.trim() || "Relay video";
  return Array.from(raw).slice(0, MAX_TITLE).join("");
}

function descriptionFrom(text: string, prefix: string | undefined): string {
  const value = prefix?.trim() ? `${prefix.trim()}\n\n${text}` : text;
  return Array.from(value).slice(0, MAX_DESCRIPTION).join("");
}

/**
 * YouTube Data API v3 adapter.
 *
 * Google OAuth 2.0 (PKCE + offline access), channel lookup, and one resumable
 * video upload per post. YouTube is video-only: the post text becomes the
 * description and its first line (or `youtubeTitle`) becomes the title.
 */
export class YouTubeAdapter implements PlatformAdapter {
  readonly platform = "youtube" as const;

  readonly limits: PlatformLimits = {
    platform: "youtube",
    displayName: "YouTube",
    maxTextLength: 5000,
    maxParts: 1,
    maxMediaPerPost: 1,
    maxVideosPerPost: 1,
    maxMediaWithVideo: 1,
    requiresMedia: true,
    maxImageBytes: 0,
    maxVideoBytes: 256 * 1024 * 1024,
    allowedImageTypes: [],
    allowedVideoTypes: ["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"],
    mediaUpload: "direct",
    notes: "One video per post; title comes from the first line (max 100 characters); ~6 uploads/day on the default quota.",
  };

  isConfigured(ctx: AdapterContext): boolean {
    const credentials = ctx.credentials("youtube");
    return Boolean(credentials.clientId && credentials.clientSecret);
  }

  isLive(ctx: AdapterContext): boolean {
    return !ctx.forceMock && this.isConfigured(ctx);
  }

  async authorize(ctx: AdapterContext, req: AuthorizeRequest): Promise<AuthorizeResult> {
    if (!this.isLive(ctx)) {
      return { kind: "mock", profile: mockProfile("youtube"), scopes: mockScopes("youtube") };
    }
    const { clientId } = ctx.credentials("youtube");
    if (!clientId) throw new ConfigurationError("YouTube credentials are not configured", "youtube_credentials_missing");
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", req.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", SCOPES.join(" "));
    url.searchParams.set("state", req.state);
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
    url.searchParams.set("code_challenge", pkceChallenge(req.codeVerifier));
    url.searchParams.set("code_challenge_method", "S256");
    return { kind: "redirect", url: url.toString() };
  }

  async exchange(ctx: AdapterContext, req: ExchangeRequest): Promise<ConnectResult> {
    if (!this.isLive(ctx)) {
      throw new ConfigurationError(
        "YouTube sign-in is simulated in mock mode; disable mock mode and configure credentials to connect a real channel",
        "youtube_live_disabled",
      );
    }
    const { clientId, clientSecret } = ctx.credentials("youtube");
    if (!clientId || !clientSecret) {
      throw new ConfigurationError(
        "YouTube client id and client secret are required for the token exchange",
        "youtube_credentials_missing",
      );
    }

    const json = await providerFetch(ctx, "YouTube token exchange", TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        redirect_uri: req.redirectUri,
        code: req.code,
        code_verifier: req.codeVerifier,
      }),
    });
    const tokens = oauthTokensFrom(json, ctx.now());
    const scopes = scopesFrom(json, SCOPES);
    const profile = await this.fetchProfile(ctx, tokens);
    return { profile, tokens, scopes };
  }

  async refresh(ctx: AdapterContext, tokens: OAuthTokens): Promise<OAuthTokens> {
    if (!tokens.refreshToken) {
      throw new ConfigurationError("YouTube refresh token is missing; reconnect the channel", "youtube_refresh_missing");
    }
    const { clientId, clientSecret } = ctx.credentials("youtube");
    if (!clientId || !clientSecret) {
      throw new ConfigurationError("YouTube credentials are not configured", "youtube_credentials_missing");
    }
    const json = await providerFetch(ctx, "YouTube token refresh", TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({
        client_id: clientId,
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
      scope: tokens.scope ?? SCOPES.join(" "),
    };
  }

  async publish(ctx: AdapterContext, input: PublishInput): Promise<PublishResult> {
    if (!this.isLive(ctx) || !input.tokens) return mockPublish("youtube", input);

    const media = input.post.parts.flatMap((part) => part.media);
    const videos = media.filter((item) => item.kind === "video");
    if (media.some((item) => item.kind === "image")) {
      throw new RelayError("YouTube accepts videos only", "youtube_images_unsupported");
    }
    if (videos.length !== 1 || media.length !== 1) {
      throw new RelayError("YouTube needs exactly one video per post", "youtube_video_required");
    }

    const caption = input.post.parts
      .map((part) => part.text)
      .filter(Boolean)
      .join("\n\n");
    const options = input.post.options;
    const title = titleFromText(caption, options.youtubeTitle);
    const description = descriptionFrom(caption, options.youtubeDescription);
    const tags = (options.youtubeTags ?? []).map((tag) => tag.trim()).filter(Boolean).slice(0, 15);
    const categoryId = options.youtubeCategoryId?.trim() || DEFAULT_CATEGORY_ID;
    const privacyStatus = options.youtubePrivacy ?? "public";
    const madeForKids = options.youtubeMadeForKids ?? false;

    const blob = await ctx.readMedia(videos[0]!);
    if (blob.buffer.length === 0) throw new RelayError("Cannot upload an empty video to YouTube", "youtube_media_empty");
    const mimeType = blob.mimeType || "video/mp4";
    const boundary = `relay-${randomUUID()}`;
    const metadata = JSON.stringify({
      snippet: { title, description, tags, categoryId },
      status: { privacyStatus, selfDeclaredMadeForKids: madeForKids },
    });
    const head = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
        `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
      "utf8",
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
    const body = Buffer.concat([head, blob.buffer, tail]);

    let uploaded: unknown;
    try {
      uploaded = await providerFetch(
        ctx,
        "YouTube video upload",
        `${UPLOAD_URL}?uploadType=multipart&part=snippet,status`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${input.tokens.accessToken}`,
            "Content-Type": `multipart/related; boundary=${boundary}`,
          },
          body: body as unknown as RequestInit["body"],
        },
      );
    } catch (error) {
      if (isYouTubeQuotaError(error)) {
        throw new RelayError(
          "YouTube's daily API quota is exhausted. Uploads resume after the quota resets at midnight Pacific Time.",
          "youtube_quota_exceeded",
          error instanceof RelayError ? error.details : undefined,
          429,
        );
      }
      throw error;
    }
    const videoId = getString(asObject(uploaded), "id");
    if (!videoId) throw new RelayError("YouTube did not return a video id", "youtube_video_id_missing", uploaded, 502);

    return {
      platformPostId: videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      mock: false,
      details: { videoId, title, privacyStatus, categoryId, tags: tags.length },
    };
  }

  private async fetchProfile(ctx: AdapterContext, tokens: OAuthTokens): Promise<ProfileInfo> {    const url = new URL(CHANNELS_URL);
    url.searchParams.set("part", "snippet");
    url.searchParams.set("mine", "true");
    const json = await providerFetch(ctx, "YouTube channel", url.toString(), {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    const items = asObject(json)?.items;
    const item = Array.isArray(items) ? asObject(items[0]) : undefined;
    if (!item) {
      throw new RelayError(
        "This Google account has no YouTube channel. Create a channel first, then reconnect.",
        "youtube_channel_missing",
        json,
        400,
      );
    }
    const id = getString(item, "id");
    const snippet = asObject(item.snippet);
    const customUrl = getString(snippet, "customUrl");
    const title = getString(snippet, "title");
    if (!id) throw new RelayError("YouTube did not return a channel id", "youtube_profile_invalid", json, 502);
    const thumbnails = asObject(snippet?.thumbnails);
    const defaultThumb = asObject(thumbnails?.default);
    return {
      externalId: id,
      handle: (customUrl ?? title ?? id).replace(/^@/, ""),
      displayName: title,
      avatarUrl: getString(defaultThumb, "url"),
    };
  }
}

/** True when a YouTube upload failed specifically because the daily quota is gone. */
function isYouTubeQuotaError(error: unknown): boolean {
  if (!(error instanceof RelayError)) return false;
  let details = "";
  try {
    details = JSON.stringify(error.details ?? "");
  } catch {
    details = "";
  }
  return /quotaExceeded|quota exceeded|exceeded your[^.]*quota|dailyLimitExceeded|uploadLimitExceeded/i.test(
    `${error.message} ${details}`,
  );
}
