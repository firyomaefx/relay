/**
 * Instagram and YouTube comment adapters against a fake fetch. Checks the exact
 * Graph / Data API calls (and how few of them), the scope names added to the
 * sign-in URLs, and the error mapping. No network.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { InstagramAdapter, YouTubeAdapter } from "@relay/platforms";
import { cleanupTempDir, makeTempDir } from "../helpers.mjs";

const NOW = Date.now();
const iso = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function makeCtx(fetchImpl) {
  const dataDir = await makeTempDir("relay-comment-adapters-");
  return {
    dir: dataDir,
    ctx: {
      dataDir,
      env: {},
      fetch: fetchImpl,
      logger: () => undefined,
      readMedia: async () => {
        throw new Error("not used");
      },
      mediaPublicUrl: () => null,
      credentials: () => ({ clientId: "cid", clientSecret: "secret" }),
      now: () => new Date(NOW),
      forceMock: false,
      publicMediaBaseUrl: null,
    },
  };
}

const igAccount = { id: "instagram:17841", platform: "instagram", handle: "duitpoket26", mode: "live", connectedAt: iso(1), scopes: [] };
const ytAccount = { id: "youtube:UCchan", platform: "youtube", handle: "duitpoketttrg", mode: "live", connectedAt: iso(1), scopes: [] };
const tokens = { accessToken: "tok" };

test("sign-in URLs request the comment scopes", async () => {
  const { ctx, dir } = await makeCtx(async () => json({}));
  try {
    const ig = await new InstagramAdapter().authorize(ctx, { state: "s", codeVerifier: "v".repeat(50), redirectUri: "https://x/cb" });
    assert.equal(ig.kind, "redirect");
    assert.ok(new URL(ig.url).searchParams.get("scope").split(",").includes("instagram_business_manage_comments"));
    const yt = await new YouTubeAdapter().authorize(ctx, { state: "s", codeVerifier: "v".repeat(50), redirectUri: "https://x/cb" });
    assert.ok(new URL(yt.url).searchParams.get("scope").split(" ").includes("https://www.googleapis.com/auth/youtube.force-ssl"));
  } finally {
    await cleanupTempDir(dir);
  }
});

test("Instagram: reads only recent media with comments, skips own and answered comments", async () => {
  const calls = [];
  const { ctx, dir } = await makeCtx(async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ? String(init.body) : undefined });
    const u = String(url);
    if (u.includes("/17841/media")) {
      return json({
        data: [
          { id: "m-new", caption: "KWSP atau ASB?", timestamp: iso(60), comments_count: 3 },
          { id: "m-quiet", caption: "tiada komen", timestamp: iso(90), comments_count: 0 },
          { id: "m-old", caption: "lama", timestamp: iso(60 * 24 * 10), comments_count: 9 },
        ],
      });
    }
    if (u.includes("/m-new/comments")) {
      return json({
        data: [
          { id: "c1", text: "Berapa dividend ASB?", username: "aina", timestamp: iso(30) },
          { id: "c2", text: "mine", username: "duitpoket26", timestamp: iso(20) },
          { id: "c3", text: "already answered", username: "ben", timestamp: iso(25), replies: { data: [{ id: "r1", username: "duitpoket26" }] } },
        ],
      });
    }
    return json({ error: { message: "unexpected" } }, 500);
  });
  try {
    const out = await new InstagramAdapter().readOwnComments(ctx, {
      account: igAccount,
      tokens,
      sinceMs: NOW - 48 * 3600_000,
      limitPosts: 25,
      maxComments: 50,
    });
    assert.deepEqual(out.map((c) => c.commentId), ["c1"]);
    assert.equal(out[0].platform, "instagram");
    assert.equal(out[0].postId, "m-new");
    assert.equal(out[0].author, "aina");
    assert.equal(out[0].postCaption, "KWSP atau ASB?");
    assert.equal(calls.length, 2, "1 media list + 1 comments call (quiet and old media are skipped)");
  } finally {
    await cleanupTempDir(dir);
  }
});

test("Instagram: reply posts to /{comment-id}/replies; permission errors say needs reconnect", async () => {
  let mode = "ok";
  const calls = [];
  const { ctx, dir } = await makeCtx(async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, body: init.body ? String(init.body) : undefined, auth: init.headers?.Authorization });
    if (mode === "perm") return json({ error: { message: "(#10) Application does not have permission for this action", code: 10, type: "OAuthException" } }, 400);
    return json({ id: "reply-99" });
  });
  try {
    const adapter = new InstagramAdapter();
    const result = await adapter.replyToComment(ctx, "c1", "Terima kasih sudi singgah.", { account: igAccount, tokens });
    assert.deepEqual(result, { id: "reply-99", mock: false });
    assert.match(calls[0].url, /graph\.instagram\.com\/v[\d.]+\/c1\/replies$/);
    assert.equal(calls[0].method, "POST");
    assert.equal(new URLSearchParams(calls[0].body).get("message"), "Terima kasih sudi singgah.");
    assert.match(calls[0].auth, /^Bearer /);

    await assert.rejects(() => adapter.replyToComment(ctx, "c1", "x".repeat(2201), { account: igAccount, tokens }), (e) => e.code === "instagram_reply_text_too_long");
    mode = "perm";
    await assert.rejects(
      () => adapter.replyToComment(ctx, "c1", "ok", { account: igAccount, tokens }),
      (e) => e.code === "comments_scope_missing" && /needs reconnect for comments/.test(e.message),
    );
  } finally {
    await cleanupTempDir(dir);
  }
});

test("YouTube: one channel-wide list call, own and answered threads skipped, titles in one call", async () => {
  const calls = [];
  const { ctx, dir } = await makeCtx(async (url) => {
    const u = new URL(String(url));
    calls.push(u);
    if (u.pathname.endsWith("/commentThreads")) {
      return json({
        items: [
          {
            id: "th1",
            snippet: { videoId: "vid1", topLevelComment: { snippet: { authorDisplayName: "Aina", authorChannelId: { value: "UCaina" }, textOriginal: "Boleh terangkan ASB?", publishedAt: iso(30) } } },
          },
          {
            id: "th2",
            snippet: { videoId: "vid1", topLevelComment: { snippet: { authorDisplayName: "Me", authorChannelId: { value: "UCchan" }, textOriginal: "own", publishedAt: iso(20) } } },
          },
          {
            id: "th3",
            snippet: { videoId: "vid2", topLevelComment: { snippet: { authorDisplayName: "Ben", authorChannelId: { value: "UCben" }, textOriginal: "answered", publishedAt: iso(25) } } },
            replies: { comments: [{ snippet: { authorChannelId: { value: "UCchan" } } }] },
          },
          {
            id: "th-old",
            snippet: { videoId: "vid3", topLevelComment: { snippet: { authorDisplayName: "Old", authorChannelId: { value: "UCold" }, textOriginal: "lama", publishedAt: iso(60 * 24 * 9) } } },
          },
        ],
        nextPageToken: "NEXT",
      });
    }
    if (u.pathname.endsWith("/videos")) return json({ items: [{ id: "vid1", snippet: { title: "ASB vs KWSP" } }] });
    return json({ error: { message: "unexpected" } }, 500);
  });
  try {
    const out = await new YouTubeAdapter().readOwnComments(ctx, { account: ytAccount, tokens, sinceMs: NOW - 48 * 3600_000, limitPosts: 25, maxComments: 50 });
    assert.deepEqual(out.map((c) => c.commentId), ["th1"]);
    assert.equal(out[0].postId, "vid1");
    assert.equal(out[0].postCaption, "ASB vs KWSP");
    assert.equal(out[0].author, "Aina");
    const list = calls[0];
    assert.equal(list.searchParams.get("allThreadsRelatedToChannelId"), "UCchan");
    assert.equal(list.searchParams.get("order"), "time");
    assert.equal(calls.length, 2, "reached an old comment, so no second page: 1 list + 1 videos.list = 2 quota units");
  } finally {
    await cleanupTempDir(dir);
  }
});

test("YouTube: reply uses comments.insert with parentId; quota and scope errors are mapped", async () => {
  let mode = "ok";
  const calls = [];
  const { ctx, dir } = await makeCtx(async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, body: init.body ? String(init.body) : undefined });
    if (mode === "quota") return json({ error: { code: 403, message: "quotaExceeded", errors: [{ reason: "quotaExceeded" }] } }, 403);
    if (mode === "scope") return json({ error: { code: 403, message: "Request had insufficient authentication scopes.", errors: [{ reason: "insufficientPermissions" }] } }, 403);
    return json({ id: "th1.reply7", snippet: { videoId: "vid1" } });
  });
  try {
    const adapter = new YouTubeAdapter();
    const result = await adapter.replyToComment(ctx, "th1.abc", "Sama-sama.", { account: ytAccount, tokens });
    assert.equal(result.id, "th1.reply7");
    assert.equal(result.permalink, "https://www.youtube.com/watch?v=vid1&lc=th1.reply7");
    assert.equal(result.mock, false);
    assert.match(calls[0].url, /youtube\/v3\/comments\?part=snippet$/);
    assert.equal(calls[0].method, "POST");
    assert.deepEqual(JSON.parse(calls[0].body), { snippet: { parentId: "th1", textOriginal: "Sama-sama." } }, "a reply id is turned into the top-level id");

    mode = "quota";
    await assert.rejects(() => adapter.replyToComment(ctx, "th1", "ok", { account: ytAccount, tokens }), (e) => e.code === "youtube_quota_exceeded");
    mode = "scope";
    await assert.rejects(
      () => adapter.replyToComment(ctx, "th1", "ok", { account: ytAccount, tokens }),
      (e) => e.code === "comments_scope_missing" && /needs reconnect for comments/.test(e.message),
    );
  } finally {
    await cleanupTempDir(dir);
  }
});
