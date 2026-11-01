import { AuthError, RelayError } from "@relay/core";
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
  formBody,
  getString,
  oauthTokensFrom,
  providerFetch,
} from "./http.js";

const AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const USERINFO_URL = "https://api.linkedin.com/v2/userinfo";
const POSTS_URL = "https://api.linkedin.com/rest/posts";
const IMAGES_URL = "https://api.linkedin.com/rest/images";
const VIDEOS_URL = "https://api.linkedin.com/rest/videos";

/** Pin a tested LinkedIn version; upgrade deliberately, never silently. */
const API_VERSION = "202608";
const SCOPES = ["openid", "profile", "w_member_social"] as const;
const VIDEO_POLL_LIMIT = 60;
const VIDEO_POLL_INTERVAL_MS = 2000;

function linkedinHeaders(accessToken: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...authHeaders(accessToken),
    "LinkedIn-Version": API_VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
    ...extra,
  };
}

function personUrn(account: { externalId?: string; id: string; handle: string }): string {
  if (account.externalId) return `urn:li:person:${account.externalId}`;
  if (account.id.startsWith("urn:li:person:")) return account.id;
  return `urn:li:person:${account.handle}`;
}

function postUrl(postId: string): string {
  return `https://www.linkedin.com/feed/update/${encodeURIComponent(postId)}/`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rawRequest(
  ctx: AdapterContext,
  label: string,
  url: string,
  init: RequestInit,
): Promise<{ body: unknown; headers: Headers }> {
  let response: Response;
  try {
    response = await ctx.fetch(url, init);
  } catch (cause) {
    throw new RelayError(`${label} could not reach LinkedIn: ${String(cause)}`, "provider_network_error", cause, 502);
  }
  let text = "";
  try {
    text = await response.text();
  } catch {
    text = "";
  }
  let body: unknown;
  try {
    body = text.trim() ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  if (!response.ok) {
    const object = asObject(body);
    const message =
      getString(object, "message") ??
      getString(asObject(object?.error), "message") ??
      (typeof body === "string" && body.trim() ? body.trim() : `HTTP ${response.status}`);
    if (response.status === 401) throw new AuthError(`${label}: ${message}`, { status: response.status, body });
    throw new RelayError(
      `${label}: ${message}`,
      "provider_error",
      { status: response.status, body },
      response.status >= 400 && response.status < 500 ? response.status : 502,
    );
  }
  return { body, headers: response.headers };
}

export class LinkedInAdapter implements PlatformAdapter {
  readonly platform = "linkedin" as const;

  readonly limits: PlatformLimits = {
    platform: "linkedin",
    displayName: "LinkedIn",
    maxTextLength: 3000,
    maxParts: 1,
    maxMediaPerPost: 1,
    maxVideosPerPost: 1,
    maxMediaWithVideo: 1,
    requiresMedia: false,
    maxImageBytes: 20 * 1024 * 1024,
    maxVideoBytes: 500 * 1024 * 1024,
    allowedImageTypes: ["image/jpeg", "image/png", "image/gif"],
    allowedVideoTypes: ["video/mp4", "video/quicktime"],
    mediaUpload: "direct",
    notes: "One LinkedIn post per draft; text up to 3,000 characters and one image or one video. Company pages are a later phase.",
  };

  isConfigured(ctx: AdapterContext): boolean {
    const credentials = ctx.credentials("linkedin");
    return Boolean(credentials.clientId && credentials.clientSecret);
  }

  isLive(ctx: AdapterContext): boolean {
    return !ctx.forceMock && this.isConfigured(ctx);
  }

  async authorize(ctx: AdapterContext, req: AuthorizeRequest): Promise<AuthorizeResult> {
    if (!this.isLive(ctx)) return { kind: "mock", profile: mockProfile("linkedin"), scopes: mockScopes("linkedin") };
    const { clientId } = ctx.credentials("linkedin");
    if (!clientId) throw new RelayError("LinkedIn client id is missing", "linkedin_credentials_missing");
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", req.redirectUri);
    url.searchParams.set("state", req.state);
    url.searchParams.set("scope", SCOPES.join(" "));
    return { kind: "redirect", url: url.toString() };
  }

  async exchange(ctx: AdapterContext, req: ExchangeRequest): Promise<ConnectResult> {
    const { clientId, clientSecret } = ctx.credentials("linkedin");
    if (!clientId || !clientSecret) {
      throw new RelayError("LinkedIn client id and secret are required", "linkedin_credentials_missing");
    }
    const tokenBody = await providerFetch(ctx, "LinkedIn token exchange", TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({
        grant_type: "authorization_code",
        code: req.code,
        redirect_uri: req.redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    const tokens = oauthTokensFrom(tokenBody, ctx.now());
    const profileBody = await providerFetch(ctx, "LinkedIn userinfo", USERINFO_URL, {
      headers: authHeaders(tokens.accessToken),
    });
    const profileObject = asObject(profileBody) ?? {};
    const externalId = getString(profileObject, "sub");
    if (!externalId) throw new RelayError("LinkedIn userinfo did not return a subject", "linkedin_profile_missing");
    const name = getString(profileObject, "name") ?? getString(profileObject, "given_name") ?? externalId;
    const profile: ProfileInfo = {
      externalId,
      handle: getString(profileObject, "preferred_username") ?? externalId,
      displayName: name,
      ...(getString(profileObject, "picture") ? { avatarUrl: getString(profileObject, "picture") } : {}),
    };
    return { profile, tokens, scopes: [...SCOPES] };
  }

  async refresh(ctx: AdapterContext, tokens: OAuthTokens): Promise<OAuthTokens> {
    const { clientId, clientSecret } = ctx.credentials("linkedin");
    if (!clientId || !clientSecret) throw new RelayError("LinkedIn client id and secret are required", "linkedin_credentials_missing");
    if (!tokens.refreshToken) throw new AuthError("LinkedIn refresh token is missing; reconnect the account", { reason: "refresh_token_missing" });
    const body = await providerFetch(ctx, "LinkedIn token refresh", TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    const refreshed = oauthTokensFrom(body, ctx.now());
    return { ...refreshed, refreshToken: refreshed.refreshToken ?? tokens.refreshToken };
  }

  async publish(ctx: AdapterContext, input: PublishInput): Promise<PublishResult> {
    if (!this.isLive(ctx) || !input.tokens) return mockPublish("linkedin", input);
    const part = input.post.parts[0];
    if (!part) throw new RelayError("LinkedIn requires at least one part", "linkedin_part_missing");
    if (input.post.parts.length !== 1) {
      throw new RelayError("LinkedIn supports one post per draft; split the thread into separate drafts.", "linkedin_thread_unsupported", undefined, 400);
    }
    if (part.media.length > 1) {
      throw new RelayError("LinkedIn supports one image or one video per post.", "linkedin_media_limit", undefined, 400);
    }

    const author = personUrn(input.account);
    let mediaUrn: string | undefined;
    if (part.media[0]) {
      const blob = await ctx.readMedia(part.media[0]);
      mediaUrn = part.media[0].kind === "video"
        ? await this.uploadVideo(ctx, input.tokens, author, blob)
        : await this.uploadImage(ctx, input.tokens, author, blob);
    }

    const payload: Record<string, unknown> = {
      author,
      commentary: part.text,
      visibility: "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
      ...(mediaUrn ? { content: { media: { id: mediaUrn } } } : {}),
    };
    const { headers } = await rawRequest(ctx, "LinkedIn create post", POSTS_URL, {
      method: "POST",
      headers: linkedinHeaders(input.tokens.accessToken, { "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    const postId = headers.get("x-restli-id") ?? "";
    if (!postId) throw new RelayError("LinkedIn accepted the post without returning x-restli-id", "linkedin_post_id_missing", undefined, 502);
    return {
      platformPostId: postId,
      url: postUrl(postId),
      mock: false,
      details: { author, mediaUrn },
    };
  }

  private async uploadImage(ctx: AdapterContext, tokens: OAuthTokens, owner: string, blob: MediaBlob): Promise<string> {
    const { body } = await rawRequest(ctx, "LinkedIn image initialize", `${IMAGES_URL}?action=initializeUpload`, {
      method: "POST",
      headers: linkedinHeaders(tokens.accessToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ initializeUploadRequest: { owner } }),
    });
    const value = asObject(asObject(body)?.value) ?? {};
    const uploadUrl = getString(value, "uploadUrl");
    const image = getString(value, "image");
    if (!uploadUrl || !image) throw new RelayError("LinkedIn image initialize response was incomplete", "linkedin_image_upload_failed", undefined, 502);
    const upload = await ctx.fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": blob.mimeType },
      body: new Uint8Array(blob.buffer),
    });
    if (!upload.ok) throw new RelayError(`LinkedIn image upload failed with HTTP ${upload.status}`, "linkedin_image_upload_failed", undefined, 502);
    return image;
  }

  private async uploadVideo(ctx: AdapterContext, tokens: OAuthTokens, owner: string, blob: MediaBlob): Promise<string> {
    const initialize = await rawRequest(ctx, "LinkedIn video initialize", `${VIDEOS_URL}?action=initializeUpload`, {
      method: "POST",
      headers: linkedinHeaders(tokens.accessToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        initializeUploadRequest: {
          owner,
          fileSize: blob.buffer.length,
          uploadCaptions: false,
          uploadThumbnail: false,
        },
      }),
    });
    const value = asObject(asObject(initialize.body)?.value) ?? {};
    const video = getString(value, "video");
    const uploadToken = getString(value, "uploadToken") ?? "";
    const instructions = Array.isArray(value.uploadInstructions) ? value.uploadInstructions : [];
    if (!video || instructions.length === 0) {
      throw new RelayError("LinkedIn video initialize response was incomplete", "linkedin_video_upload_failed", undefined, 502);
    }
    const uploadedPartIds: string[] = [];
    for (const raw of instructions) {
      const instruction = asObject(raw) ?? {};
      const url = getString(instruction, "uploadUrl");
      const first = Number(instruction.firstByte ?? 0);
      const last = Number(instruction.lastByte ?? -1);
      if (!url || !Number.isFinite(first) || !Number.isFinite(last) || last < first) {
        throw new RelayError("LinkedIn video upload instruction was invalid", "linkedin_video_upload_failed", undefined, 502);
      }
      const chunk = blob.buffer.subarray(first, last + 1);
      const upload = await ctx.fetch(url, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Range": `bytes ${first}-${last}/${blob.buffer.length}`,
        },
        body: new Uint8Array(chunk),
      });
      if (!upload.ok) throw new RelayError(`LinkedIn video chunk failed with HTTP ${upload.status}`, "linkedin_video_upload_failed", undefined, 502);
      const partId = upload.headers.get("x-amz-upload-part-id") ?? upload.headers.get("etag") ?? "";
      if (partId) uploadedPartIds.push(partId);
    }
    await rawRequest(ctx, "LinkedIn video finalize", `${VIDEOS_URL}?action=finalizeUpload`, {
      method: "POST",
      headers: linkedinHeaders(tokens.accessToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ finalizeUploadRequest: { video, uploadToken, uploadedPartIds } }),
    });
    for (let attempt = 0; attempt < VIDEO_POLL_LIMIT; attempt += 1) {
      const { body } = await rawRequest(ctx, "LinkedIn video status", `${VIDEOS_URL}/${encodeURIComponent(video)}`, {
        headers: linkedinHeaders(tokens.accessToken),
      });
      const status = (getString(asObject(body), "status") ?? "").toUpperCase();
      if (status === "AVAILABLE" || status === "READY") return video;
      if (status === "FAILED" || status === "ERROR") {
        throw new RelayError("LinkedIn video processing failed", "linkedin_video_processing_failed", body, 502);
      }
      await sleep(VIDEO_POLL_INTERVAL_MS);
    }
    throw new RelayError("LinkedIn video processing timed out", "linkedin_video_processing_timeout", undefined, 504);
  }
}


