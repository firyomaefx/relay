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
  OwnComment,
  OwnCommentsInput,
  ThreadsReplyAuth,
  ThreadsReplyResult,
} from "@relay/core";
import { mockProfile, mockPublish, mockScopes } from "../mock.js";
import {
  asArray,
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
const COMMENT_THREADS_URL = "https://www.googleapis.com/youtube/v3/commentThreads";
const COMMENTS_URL = "https://www.googleapis.com/youtube/v3/comments";
const VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";
const MAX_COMMENT_REPLY = 10000;
/** commentThreads.list costs 1 unit per page; two pages of 100 is plenty per poll. */
const MAX_COMMENT_PAGES = 2;

const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.force-ssl",
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

  /**
   * READ-ONLY: recent comment threads across the whole channel in ONE list call
   * (commentThreads.list with allThreadsRelatedToChannelId, 1 quota unit per
   * page, newest first), plus one videos.list call (1 unit) for the titles.
   * Needs the youtube.force-ssl scope.
   */
  async readOwnComments(ctx: AdapterContext, input: OwnCommentsInput): Promise<OwnComment[]> {
    if (!this.isLive(ctx) || !input.tokens) return [];
    const channelId = input.account.id.startsWith("youtube:") ? input.account.id.slice("youtube:".length) : "";
    if (!channelId) {
      throw new RelayError("YouTube channel id is unknown; reconnect the channel.", "youtube_channel_missing", undefined, 400);
    }
    const headers = { Authorization: `Bearer ${input.tokens.accessToken}` };
    const out: OwnComment[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_COMMENT_PAGES; page += 1) {
      const url = new URL(COMMENT_THREADS_URL);
      url.searchParams.set("part", "snippet,replies");
      url.searchParams.set("allThreadsRelatedToChannelId", channelId);
      url.searchParams.set("order", "time");
      url.searchParams.set("textFormat", "plainText");
      url.searchParams.set("maxResults", "100");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const json = await this.commentFetch(ctx, "YouTube comment threads", url.toString(), { headers });
      const data = asObject(json);
      let reachedOld = false;
      for (const entry of asArray(data?.items)) {
        const thread = asObject(entry);
        const threadSnippet = asObject(thread?.snippet);
        const top = asObject(asObject(threadSnippet?.topLevelComment)?.snippet);
        const id = getString(thread, "id");
        if (!id || !top) continue;
        const publishedAt = getString(top, "publishedAt") ?? ctx.now().toISOString();
        if (Date.parse(publishedAt) < input.sinceMs) {
          reachedOld = true;
          continue;
        }
        const authorChannel = getString(asObject(top.authorChannelId), "value");
        if (authorChannel === channelId) continue;
        // Skip threads the channel already answered (for example from Studio).
        const replies = asArray(asObject(thread?.replies)?.comments);
        const answered = replies.some(
          (reply) => getString(asObject(asObject(asObject(reply)?.snippet)?.authorChannelId), "value") === channelId,
        );
        if (answered) continue;
        out.push({
          platform: "youtube",
          postId: getString(threadSnippet, "videoId") ?? "",
          commentId: id,
          author: getString(top, "authorDisplayName") ?? "unknown",
          text: getString(top, "textOriginal") ?? getString(top, "textDisplay") ?? "",
          createdAt: publishedAt,
        });
        if (out.length >= input.maxComments) break;
      }
      pageToken = getString(data, "nextPageToken");
      if (reachedOld || !pageToken || out.length >= input.maxComments) break;
    }

    const videoIds = [...new Set(out.map((comment) => comment.postId).filter(Boolean))].slice(0, 50);
    if (videoIds.length > 0) {
      try {
        const url = new URL(VIDEOS_URL);
        url.searchParams.set("part", "snippet");
        url.searchParams.set("id", videoIds.join(","));
        const json = await this.commentFetch(ctx, "YouTube video titles", url.toString(), { headers });
        const titles = new Map<string, string>();
        for (const entry of asArray(asObject(json)?.items)) {
          const video = asObject(entry);
          const videoId = getString(video, "id");
          const title = getString(asObject(video?.snippet), "title");
          if (videoId && title) titles.set(videoId, title);
        }
        for (const comment of out) {
          const title = titles.get(comment.postId);
          if (title) comment.postCaption = title;
        }
      } catch {
        // Titles are a nicety; the comments are still usable without them.
      }
    }
    return out;
  }

  /**
   * EXPLICIT-ONLY: reply to one top-level comment (comments.insert with
   * parentId, 50 quota units). Needs the youtube.force-ssl scope.
   */
  async replyToComment(
    ctx: AdapterContext,
    commentId: string,
    text: string,
    input: ThreadsReplyAuth,
  ): Promise<ThreadsReplyResult> {
    const raw = typeof commentId === "string" ? commentId.trim() : "";
    if (!raw) throw new RelayError("A YouTube comment id is required.", "youtube_reply_comment_id_invalid", undefined, 400);
    // A reply id looks like "<parent>.<suffix>"; YouTube wants the top-level id.
    const parentId = raw.split(".")[0]!;
    const body = typeof text === "string" ? text.trim() : "";
    if (!body) throw new RelayError("Reply text is required.", "youtube_reply_text_required", undefined, 400);
    const length = Array.from(body).length;
    if (length > MAX_COMMENT_REPLY) {
      throw new RelayError(
        `YouTube replies allow at most ${MAX_COMMENT_REPLY} characters; this reply has ${length}.`,
        "youtube_reply_text_too_long",
        { maxLength: MAX_COMMENT_REPLY, length },
        400,
      );
    }
    if (!this.isLive(ctx) || !input.tokens) {
      return { id: `mock_youtube_reply_${randomUUID()}`, mock: true };
    }
    const json = await this.commentFetch(ctx, "YouTube comment reply", `${COMMENTS_URL}?part=snippet`, {
      method: "POST",
      headers: { Authorization: `Bearer ${input.tokens.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ snippet: { parentId, textOriginal: body } }),
    });
    const id = getString(asObject(json), "id");
    if (!id) throw new RelayError("YouTube did not return a reply id", "youtube_reply_id_missing", json, 502);
    const videoId = getString(asObject(asObject(json)?.snippet), "videoId");
    return {
      id,
      ...(videoId ? { permalink: `https://www.youtube.com/watch?v=${videoId}&lc=${id}` } : {}),
      mock: false,
    };
  }

  /** providerFetch that maps quota and permission failures to stable error codes. */
  private async commentFetch(ctx: AdapterContext, label: string, url: string, init: RequestInit): Promise<unknown> {
    try {
      return await providerFetch(ctx, label, url, init);
    } catch (error) {
      if (isYouTubeQuotaError(error)) {
        throw new RelayError(
          "YouTube's daily API quota is exhausted. Comment calls resume after the quota resets at midnight Pacific Time.",
          "youtube_quota_exceeded",
          error instanceof RelayError ? error.details : undefined,
          429,
        );
      }
      if (error instanceof RelayError && error.code === "provider_error" && error.statusCode === 403) {
        let details = "";
        try {
          details = JSON.stringify(error.details ?? "");
        } catch {
          details = "";
        }
        if (/insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(`${error.message} ${details}`)) {
          throw new RelayError(
            "YouTube: needs reconnect for comments. Reconnect YouTube so it can grant youtube.force-ssl.",
            "comments_scope_missing",
            error.details,
            403,
          );
        }
      }
      throw error;
    }
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
