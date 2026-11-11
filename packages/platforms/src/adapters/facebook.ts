// Facebook Pages adapter. The whole platform is feature-flagged until Meta
// review and app keys are in place.
import { ConfigurationError, RelayError, errorMessage } from "@relay/core";
import type {
  AdapterContext,
  AuthorizeRequest,
  AuthorizeResult,
  ConnectResult,
  ExchangeRequest,
  OAuthTokens,
  PlatformAdapter,
  PlatformLimits,
  PublishInput,
  PublishResult,
} from "@relay/core";
import { mockProfile, mockPublish, mockScopes } from "../mock.js";
import {
  asArray,
  asObject,
  formBody,
  getString,
  oauthTokensFrom,
  providerFetch,
  publicMediaUrl,
} from "./http.js";

const GRAPH_VERSION = "v23.0";
const GRAPH_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;
const AUTHORIZE_URL = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;
const SCOPES = ["pages_show_list", "pages_read_engagement", "pages_manage_posts"] as const;

function facebookEnabled(ctx: AdapterContext): boolean {
  return ctx.env.RELAY_ENABLE_FACEBOOK === "1";
}

function coverPicture(page: Record<string, unknown> | undefined): string | undefined {
  const picture = asObject(page?.picture);
  const data = asObject(picture?.data);
  return getString(data, "url");
}

function pagePermissionError(error: unknown): unknown {
  const text = errorMessage(error);
  if (/pages_manage_posts|\(#10\)|permission|not authorized|oauth exception/i.test(text)) {
    return new RelayError(
      `Facebook refused the Page post. Reconnect the Page and grant pages_show_list, pages_read_engagement and pages_manage_posts, then try again. Provider message: ${text}`,
      "facebook_page_permission",
      undefined,
      403,
    );
  }
  return error;
}

/**
 * Facebook Login for Business with a Page access token.
 *
 * The account stored by Relay is the Page, not the person who signed in. Page
 * tokens are used directly for publishing. Relay keeps its own scheduler and
 * never uses Facebook's scheduled_publish_time.
 */
export class FacebookAdapter implements PlatformAdapter {
  readonly platform = "facebook" as const;

  readonly limits: PlatformLimits = {
    platform: "facebook",
    displayName: "Facebook Page",
    maxTextLength: 63206,
    maxParts: 1,
    maxMediaPerPost: 10,
    maxVideosPerPost: 1,
    maxMediaWithVideo: 1,
    requiresMedia: false,
    maxImageBytes: 10 * 1024 * 1024,
    maxVideoBytes: 1024 * 1024 * 1024,
    allowedImageTypes: ["image/jpeg", "image/png", "image/webp"],
    allowedVideoTypes: ["video/mp4", "video/quicktime"],
    mediaUpload: "url",
    notes:
      "A Facebook Page is required, not a personal profile. Text, one link, up to 10 photos, or one video per post. Facebook pulls media from a public URL.",
  };

  isConfigured(ctx: AdapterContext): boolean {
    if (!facebookEnabled(ctx)) return false;
    const credentials = ctx.credentials("facebook");
    return Boolean(credentials.clientId && credentials.clientSecret);
  }

  isLive(ctx: AdapterContext): boolean {
    return !ctx.forceMock && this.isConfigured(ctx);
  }

  async authorize(ctx: AdapterContext, req: AuthorizeRequest): Promise<AuthorizeResult> {
    if (!facebookEnabled(ctx)) {
      throw new ConfigurationError(
        "Facebook Pages is behind a feature flag. Set RELAY_ENABLE_FACEBOOK=1 after Meta approves the app.",
        "facebook_disabled",
      );
    }
    if (!this.isLive(ctx)) {
      return { kind: "mock", profile: mockProfile("facebook"), scopes: mockScopes("facebook") };
    }
    const { clientId } = ctx.credentials("facebook");
    if (!clientId) {
      throw new ConfigurationError("Facebook app credentials are missing", "facebook_credentials_missing");
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
    if (!facebookEnabled(ctx) || !this.isLive(ctx)) {
      throw new ConfigurationError(
        "Facebook Page sign-in is not enabled. Set RELAY_ENABLE_FACEBOOK=1 and add the Meta app credentials first.",
        "facebook_live_disabled",
      );
    }
    const { clientId, clientSecret } = ctx.credentials("facebook");
    if (!clientId || !clientSecret) {
      throw new ConfigurationError(
        "Facebook client id and client secret are required for the token exchange",
        "facebook_credentials_missing",
      );
    }

    const shortUrl = new URL(`${GRAPH_URL}/oauth/access_token`);
    shortUrl.searchParams.set("client_id", clientId);
    shortUrl.searchParams.set("client_secret", clientSecret);
    shortUrl.searchParams.set("redirect_uri", req.redirectUri);
    shortUrl.searchParams.set("code", req.code);
    const shortJson = await providerFetch(ctx, "Facebook token exchange", shortUrl.toString(), { method: "GET" });
    const shortLived = oauthTokensFrom(shortJson, ctx.now());

    // A long-lived user token is what makes the resulting Page token durable.
    let userToken = shortLived.accessToken;
    try {
      const longUrl = new URL(`${GRAPH_URL}/oauth/access_token`);
      longUrl.searchParams.set("grant_type", "fb_exchange_token");
      longUrl.searchParams.set("client_id", clientId);
      longUrl.searchParams.set("client_secret", clientSecret);
      longUrl.searchParams.set("fb_exchange_token", shortLived.accessToken);
      const longJson = await providerFetch(ctx, "Facebook long-lived token exchange", longUrl.toString(), { method: "GET" });
      userToken = getString(asObject(longJson), "access_token") ?? userToken;
    } catch {
      // Keep the short-lived token. The person can reconnect if it expires.
    }

    const pagesUrl = new URL(`${GRAPH_URL}/me/accounts`);
    pagesUrl.searchParams.set("fields", "id,name,access_token,picture{url}");
    pagesUrl.searchParams.set("access_token", userToken);
    const pagesJson = await providerFetch(ctx, "Facebook Page list", pagesUrl.toString(), { method: "GET" });
    const page = asArray(asObject(pagesJson)?.data)
      .map((entry) => asObject(entry))
      .find((entry) => Boolean(entry && getString(entry, "id") && getString(entry, "access_token")));
    if (!page) {
      throw new RelayError(
        "No Facebook Page was returned. Make sure this person is a Page admin and grants pages_show_list, then reconnect.",
        "facebook_page_missing",
        undefined,
        400,
      );
    }

    const pageId = getString(page, "id") ?? "";
    const pageName = getString(page, "name") ?? "Facebook Page";
    const pageToken = getString(page, "access_token") ?? "";
    const tokens: OAuthTokens = {
      accessToken: pageToken,
      tokenType: "bearer",
      scope: SCOPES.join(","),
    };
    return {
      profile: {
        externalId: pageId,
        handle: pageName,
        displayName: pageName,
        ...(coverPicture(page) ? { avatarUrl: coverPicture(page) } : {}),
      },
      tokens,
      scopes: [...SCOPES],
    };
  }

  async publish(ctx: AdapterContext, input: PublishInput): Promise<PublishResult> {
    if (!this.isLive(ctx) || !input.tokens) return mockPublish("facebook", input);
    const part = input.post.parts[0];
    if (input.post.parts.length !== 1 || !part) {
      throw new RelayError("Facebook Pages support one post per publish", "facebook_single_post_only", undefined, 400);
    }
    const pageId = input.account.externalId?.trim();
    if (!pageId) {
      throw new RelayError("The Facebook Page id is missing. Reconnect the Page.", "facebook_page_id_missing", undefined, 400);
    }
    const media = part.media;
    if (media.length > 10) {
      throw new RelayError("Facebook Page posts support at most 10 photos", "facebook_too_many_media", { media: media.length }, 400);
    }
    if (media.some((item) => item.kind === "video") && media.length > 1) {
      throw new RelayError("A Facebook Page video cannot be mixed with other media", "facebook_video_mixed_media", undefined, 400);
    }
    const message = part.text.trim();
    if (!message && media.length === 0) {
      throw new RelayError("Facebook needs text or media", "facebook_content_required", undefined, 400);
    }

    try {
      if (media.length === 1 && media[0]!.kind === "video") {
        const video = media[0]!;
        const title = message.split(/\n/)[0]?.slice(0, 100) || "Video";
        const created = await providerFetch(ctx, "Facebook video post", `${GRAPH_URL}/${pageId}/videos`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: formBody({
            file_url: publicMediaUrl(ctx, video, "Facebook Page"),
            description: message || undefined,
            title,
          }),
        });
        const id = getString(asObject(created), "id");
        if (!id) throw new RelayError("Facebook did not return a video id", "facebook_post_id_missing", created, 502);
        return { platformPostId: id, url: `https://www.facebook.com/${id}`, mock: false, details: { pageId, kind: "video" } };
      }

      if (media.length === 1) {
        const image = media[0]!;
        const created = await providerFetch(ctx, "Facebook photo post", `${GRAPH_URL}/${pageId}/photos`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: formBody({
            url: publicMediaUrl(ctx, image, "Facebook Page"),
            message: message || undefined,
          }),
        });
        const id = getString(asObject(created), "id") ?? getString(asObject(created), "post_id");
        if (!id) throw new RelayError("Facebook did not return a photo id", "facebook_post_id_missing", created, 502);
        return { platformPostId: id, url: `https://www.facebook.com/${id}`, mock: false, details: { pageId, kind: "photo" } };
      }

      if (media.length > 1) {
        const photoIds: string[] = [];
        for (const image of media) {
          const created = await providerFetch(ctx, "Facebook unpublished photo", `${GRAPH_URL}/${pageId}/photos`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: formBody({
              url: publicMediaUrl(ctx, image, "Facebook Page"),
              published: "false",
            }),
          });
          const id = getString(asObject(created), "id");
          if (!id) throw new RelayError("Facebook did not return an unpublished photo id", "facebook_photo_id_missing", created, 502);
          photoIds.push(id);
        }
        const fields: Record<string, string | undefined> = { message: message || undefined };
        photoIds.forEach((id, index) => {
          fields[`attached_media[${index}]`] = JSON.stringify({ media_fbid: id });
        });
        const created = await providerFetch(ctx, "Facebook multi-photo post", `${GRAPH_URL}/${pageId}/feed`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: formBody(fields),
        });
        const id = getString(asObject(created), "id");
        if (!id) throw new RelayError("Facebook did not return a post id", "facebook_post_id_missing", created, 502);
        return { platformPostId: id, url: `https://www.facebook.com/${id}`, mock: false, details: { pageId, kind: "photos", photos: photoIds.length } };
      }

      const link = message.match(/https?:\/\/[^\s]+/i)?.[0];
      const created = await providerFetch(ctx, "Facebook text post", `${GRAPH_URL}/${pageId}/feed`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formBody({
          message: message || undefined,
          link,
        }),
      });
      const id = getString(asObject(created), "id");
      if (!id) throw new RelayError("Facebook did not return a post id", "facebook_post_id_missing", created, 502);
      return { platformPostId: id, url: `https://www.facebook.com/${id}`, mock: false, details: { pageId, kind: link ? "link" : "text" } };
    } catch (error) {
      throw pagePermissionError(error);
    }
  }
}
