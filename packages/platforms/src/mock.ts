import { randomUUID } from "node:crypto";
import type { Account, MediaItem, PlatformId, PublishInput } from "@relay/core";

export function mockProfile(platform: PlatformId): { externalId: string; handle: string; displayName: string } {
  switch (platform) {
    case "x":
      return { externalId: "mock-x-1", handle: "relay_demo", displayName: "Relay Demo (X)" };
    case "threads":
      return { externalId: "mock-threads-1", handle: "relay.demo", displayName: "Relay Demo (Threads)" };
    case "tiktok":
      return { externalId: "mock-tiktok-1", handle: "relaydemo", displayName: "Relay Demo (TikTok)" };
    case "youtube":
      return { externalId: "mock-youtube-1", handle: "relaydemo", displayName: "Relay Demo (YouTube)" };
    case "instagram":
      return { externalId: "mock-instagram-1", handle: "relay.demo", displayName: "Relay Demo (Instagram)" };
    case "linkedin":
      return { externalId: "mock-linkedin-1", handle: "relay-demo", displayName: "Relay Demo (LinkedIn)" };
  }
}

export function mockScopes(platform: PlatformId): string[] {
  switch (platform) {
    case "x":
      return ["tweet.read", "tweet.write", "users.read", "offline.access"];
    case "threads":
      return ["threads_basic", "threads_content_publish", "threads_manage_replies", "threads_read_replies"];
    case "tiktok":
      return ["user.info.basic", "video.publish", "video.upload"];
    case "youtube":
      return [
        "https://www.googleapis.com/auth/youtube.upload",
        "https://www.googleapis.com/auth/youtube.readonly",
        "https://www.googleapis.com/auth/youtube.force-ssl",
      ];
    case "instagram":
      return ["instagram_business_basic", "instagram_business_content_publish", "instagram_business_manage_comments"];
    case "linkedin":
      return ["openid", "profile", "w_member_social"];
  }
}

/** A believable simulated publish used whenever credentials are absent. */
export function mockPublish(platform: PlatformId, input: PublishInput): {
  platformPostId: string;
  mock: true;
  details: Record<string, unknown>;
} {
  const post = input.post;
  const caption = post.parts.map((part) => part.text).filter(Boolean).join("\n\n");
  const mediaCount = post.parts.reduce((total, part) => total + part.media.length, 0);
  return {
    platformPostId: `mock_${platform}_${randomUUID()}`,
    mock: true,
    details: {
      simulated: true,
      handle: input.account.handle,
      parts: post.parts.length,
      media: mediaCount,
      characters: caption.length,
      privacy: post.options.tiktokPrivacy ?? (post.options.selfOnly ? "SELF_ONLY" : "PUBLIC_TO_EVERYONE"),
    },
  };
}

export function requireMediaUrl(item: MediaItem, url: string | null, platform: string): string {
  if (!url) {
    throw new Error(
      `${platform} fetches media from a public URL. Set RELAY_PUBLIC_MEDIA_BASE_URL to a tunnel that serves this console, or pass media with a "url".`,
    );
  }
  return url;
}

