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
  authHeaders,
  formBody,
  getString,
  oauthTokensFrom,
  providerFetch,
  publicMediaUrl,
  sleep,
} from "./http.js";
import type { MediaItem } from "@relay/core";

const AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";
const TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const LONG_LIVED_TOKEN_URL = "https://graph.instagram.com/access_token";
const REFRESH_TOKEN_URL = "https://graph.instagram.com/refresh_access_token";
const GRAPH_URL = "https://graph.instagram.com/v23.0";
const PROFILE_FIELDS = "user_id,username,account_type,profile_picture_url";
const SCOPES = ["instagram_business_basic", "instagram_business_content_publish"] as const;

const CONTAINER_POLL_LIMIT = 60;
const CONTAINER_POLL_INTERVAL_MS = 2000;

/**
 * Instagram (Meta) adapter using "Instagram API with Instagram Login".
 *
 * This path needs an Instagram Business/Creator account and does not require a
 * Facebook Page. Instagram fetches media from public URLs, so images and Reels
 * must be reachable from the internet (Relay serves local media through the
 * configured public media base URL).
 *
 * Publishing is a two-step container flow: create a media container, wait for
 * video processing to finish, then publish the container.
 */
export class InstagramAdapter implements PlatformAdapter {
  readonly platform = "instagram" as const;

  readonly limits: PlatformLimits = {
    platform: "instagram",
    displayName: "Instagram",
    maxTextLength: 2200,
    maxParts: 1,
    maxMediaPerPost: 1,
    maxVideosPerPost: 1,
    maxMediaWithVideo: 1,
    requiresMedia: true,
    maxImageBytes: 8 * 1024 * 1024,
    maxVideoBytes: 1024 * 1024 * 1024,
    allowedImageTypes: ["image/jpeg"],
    allowedVideoTypes: ["video/mp4", "video/quicktime"],
    mediaUpload: "url",
    notes:
      "One image post or one Reel per post. Instagram pulls media from a public URL; images must be JPEG and Reels MP4/MOV. Business or Creator account required.",
  };

  isConfigured(ctx: AdapterContext): boolean {
    const credentials = ctx.credentials("instagram");
    return Boolean(credentials.clientId && credentials.clientSecret);
  }

  isLive(ctx: AdapterContext): boolean {
    return !ctx.forceMock && this.isConfigured(ctx);
  }

  async authorize(ctx: AdapterContext, req: AuthorizeRequest): Promise<AuthorizeResult> {
    if (!this.isLive(ctx)) {
      return { kind: "mock", profile: mockProfile("instagram"), scopes: mockScopes("instagram") };
    }
    const { clientId } = ctx.credentials("instagram");
    if (!clientId) {
      throw new ConfigurationError("Instagram credentials are not configured", "instagram_credentials_missing");
    }
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", req.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", SCOPES.join(","));
    url.searchParams.set("state", req.state);
    return { kind: "redirect", url: url.toString() };
  }

  async exchange(ctx: AdapterContext, req: ExchangeRequest): Promise<ConnectResult> {
    if (!this.isLive(ctx)) {
      throw new ConfigurationError(
        "Instagram sign-in is simulated in mock mode; disable mock mode and configure credentials to connect a real account",
        "instagram_live_disabled",
      );
    }
    const { clientId, clientSecret } = ctx.credentials("instagram");
    if (!clientId || !clientSecret) {
      throw new ConfigurationError(
        "Instagram client id and client secret are required for the token exchange",
        "instagram_credentials_missing",
      );
    }

    const shortJson = await providerFetch(ctx, "Instagram token exchange", TOKEN_URL, {
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

    // Instagram short-lived tokens last one hour. Exchange immediately for the
    // 60-day long-lived token; keep it as refreshToken because Instagram
    // refreshes by presenting the current long-lived token again.
    let tokens: OAuthTokens = shortLived;
    try {
      const longUrl = new URL(LONG_LIVED_TOKEN_URL);
      longUrl.searchParams.set("grant_type", "ig_exchange_token");
      longUrl.searchParams.set("client_secret", clientSecret);
      longUrl.searchParams.set("access_token", shortLived.accessToken);
      const longJson = await providerFetch(ctx, "Instagram long-lived token exchange", longUrl.toString(), {
        method: "GET",
      });
      const longLived = oauthTokensFrom(longJson, ctx.now());
      tokens = {
        accessToken: longLived.accessToken,
        refreshToken: longLived.accessToken,
        expiresAt: longLived.expiresAt,
        tokenType: longLived.tokenType ?? "bearer",
        scope: SCOPES.join(","),
      };
    } catch {
      // Keep the short-lived token rather than failing the connection; the
      // user can reconnect once it expires.
      tokens = {
        ...shortLived,
        tokenType: shortLived.tokenType ?? "bearer",
        scope: SCOPES.join(","),
      };
    }

    const profile = await this.fetchProfile(ctx, tokens, shortJson);
    return { profile, tokens, scopes: [...SCOPES] };
  }

  async refresh(ctx: AdapterContext, tokens: OAuthTokens): Promise<OAuthTokens> {
    const current = tokens.refreshToken ?? tokens.accessToken;
    if (!current) {
      throw new ConfigurationError("Instagram access token is missing; reconnect the account", "instagram_token_missing");
    }
    const url = new URL(REFRESH_TOKEN_URL);
    url.searchParams.set("grant_type", "ig_refresh_token");
    url.searchParams.set("access_token", current);
    const json = await providerFetch(ctx, "Instagram token refresh", url.toString(), { method: "GET" });
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
    if (!this.isLive(ctx) || !input.tokens) return mockPublish("instagram", input);
    const tokens = input.tokens;
    const parts = input.post.parts;
    if (parts.length !== 1) {
      throw new RelayError("Instagram supports exactly one post per publish", "instagram_single_post_only");
    }
    const part = parts[0]!;
    if (part.media.length !== 1) {
      throw new RelayError(
        "Instagram needs exactly one image or video per post",
        "instagram_media_required",
        { media: part.media.length },
        400,
      );
    }

    const item: MediaItem = part.media[0]!;
    const publicUrl = publicMediaUrl(ctx, item, "Instagram");
    const userId = await this.resolveUserId(ctx, input.account, tokens);
    const caption = part.text.trim();
    const options = input.post.options;

    let containerId: string;
    if (item.kind === "video") {
      const params: Record<string, string | undefined> = {
        media_type: "REELS",
        video_url: publicUrl,
        caption: caption || undefined,
        share_to_feed: options.instagramShareToFeed === false ? "false" : "true",
      };
      const created = await providerFetch(ctx, "Instagram Reels container", `${GRAPH_URL}/${userId}/media`, {
        method: "POST",
        headers: { ...authHeaders(tokens.accessToken), "Content-Type": "application/x-www-form-urlencoded" },
        body: formBody(params),
      });
      containerId = getString(asObject(created), "id") ?? "";
      if (!containerId) {
        throw new RelayError("Instagram did not return a Reels container id", "instagram_container_id_missing", created, 502);
      }
      await this.waitForContainer(ctx, tokens, containerId);
    } else {
      const params: Record<string, string | undefined> = {
        image_url: publicUrl,
        caption: caption || undefined,
        alt_text: options.instagramAltText,
      };
      const created = await providerFetch(ctx, "Instagram image container", `${GRAPH_URL}/${userId}/media`, {
        method: "POST",
        headers: { ...authHeaders(tokens.accessToken), "Content-Type": "application/x-www-form-urlencoded" },
        body: formBody(params),
      });
      containerId = getString(asObject(created), "id") ?? "";
      if (!containerId) {
        throw new RelayError("Instagram did not return an image container id", "instagram_container_id_missing", created, 502);
      }
    }

    const published = await providerFetch(
      ctx,
      "Instagram publish",
      `${GRAPH_URL}/${userId}/media_publish`,
      {
        method: "POST",
        headers: { ...authHeaders(tokens.accessToken), "Content-Type": "application/x-www-form-urlencoded" },
        body: formBody({ creation_id: containerId }),
      },
    );
    const mediaId = getString(asObject(published), "id") ?? "";
    if (!mediaId) {
      throw new RelayError("Instagram did not return a published media id", "instagram_media_id_missing", published, 502);
    }

    let permalink: string | undefined;
    try {
      const info = await providerFetch(ctx, "Instagram permalink", `${GRAPH_URL}/${mediaId}?fields=permalink`, {
        headers: authHeaders(tokens.accessToken),
      });
      permalink = getString(asObject(info), "permalink");
    } catch {
      // The post exists even if the follow-up permalink lookup fails.
    }

    return {
      platformPostId: mediaId,
      url: permalink,
      mock: false,
      details: {
        mediaType: item.kind === "video" ? "REELS" : "IMAGE",
        containerId,
        permalink,
        shareToFeed: item.kind === "video" ? options.instagramShareToFeed !== false : true,
      },
    };
  }

  private async resolveUserId(ctx: AdapterContext, account: PublishInput["account"], tokens: OAuthTokens): Promise<string> {
    const prefix = "instagram:";
    if (account.id.startsWith(prefix) && account.id.length > prefix.length) {
      return account.id.slice(prefix.length);
    }
    const profile = await this.fetchProfile(ctx, tokens);
    return profile.externalId;
  }

  private async fetchProfile(
    ctx: AdapterContext,
    tokens: OAuthTokens,
    tokenResponse?: unknown,
  ): Promise<ProfileInfo> {
    // The token response carries user_id even when the profile edge is not
    // available yet, so prefer it as the account id.
    const tokenUserId = getString(asObject(tokenResponse), "user_id");
    let json: unknown;
    try {
      json = await providerFetch(
        ctx,
        "Instagram profile",
        `${GRAPH_URL}/me?fields=${PROFILE_FIELDS}`,
        { headers: authHeaders(tokens.accessToken) },
      );
    } catch (error) {
      if (!tokenUserId) throw error;
      return { externalId: tokenUserId, handle: tokenUserId, displayName: tokenUserId };
    }
    const data = asObject(json);
    const externalId = getString(data, "user_id") ?? getString(data, "id") ?? tokenUserId;
    if (!externalId) {
      throw new RelayError("Instagram did not return a profile id", "instagram_profile_invalid", json, 502);
    }
    const username = getString(data, "username");
    return {
      externalId,
      handle: username ?? tokenUserId ?? externalId,
      displayName: username,
      avatarUrl: getString(data, "profile_picture_url"),
    };
  }

  /** Polls a media container until Instagram reports FINISHED (or fails). */
  private async waitForContainer(ctx: AdapterContext, tokens: OAuthTokens, containerId: string): Promise<void> {
    for (let attempt = 0; attempt < CONTAINER_POLL_LIMIT; attempt += 1) {
      const json = await providerFetch(
        ctx,
        "Instagram container status",
        `${GRAPH_URL}/${containerId}?fields=status_code,status`,
        { headers: authHeaders(tokens.accessToken) },
      );
      const data = asObject(json);
      const status = getString(data, "status_code") ?? getString(data, "status");
      if (status === "FINISHED" || status === "PUBLISHED") return;
      if (status === "ERROR" || status === "EXPIRED") {
        throw new RelayError(
          `Instagram could not process the Reel: ${status}`,
          "instagram_media_processing_failed",
          data,
          502,
        );
      }
      await sleep(CONTAINER_POLL_INTERVAL_MS);
    }
    throw new RelayError(
      `Instagram is still processing container ${containerId}; try again later`,
      "instagram_media_processing_timeout",
      { containerId },
      504,
    );
  }
}
