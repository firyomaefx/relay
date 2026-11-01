/**
 * Unit tests for the Threads and TikTok adapters.
 *
 * The adapters receive their `fetch` through AdapterContext, so these tests use
 * a fake fetch that records every provider call and returns canned API shapes.
 * They run against the built packages (`npm run build` first).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ThreadsAdapter, TikTokAdapter, XAdapter, isAuthFailure } from "@relay/platforms";

const connectedAt = "2026-01-01T00:00:00.000Z";

function formBodyOf(call) {
  const body = call.init?.body;
  if (body instanceof URLSearchParams) return Object.fromEntries(body);
  if (typeof body === "string") {
    const parsed = Object.fromEntries(new URLSearchParams(body));
    return Object.keys(parsed).length > 0 ? parsed : JSON.parse(body);
  }
  return {};
}

function jsonBodyOf(call) {
  const body = call.init?.body;
  return typeof body === "string" ? JSON.parse(body) : {};
}

function makeContext({ onFetch, readMedia, dataDir } = {}) {
  const calls = [];
  const ctx = {
    dataDir: dataDir ?? process.cwd(),
    env: { RELAY_THREADS_REPLY_SETTLE_MS: "0", RELAY_THREADS_NOT_FOUND_BACKOFF_MS: "0", RELAY_THREADS_POLL_INTERVAL_MS: "0" },
    logger: () => {},
    fetch: async (url, init = {}) => {
      const call = { url: String(url), init };
      calls.push(call);
      const payload = (await onFetch(call)) ?? {};
      if (payload instanceof Response) return payload;
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    readMedia: readMedia ?? (async () => ({ buffer: Buffer.from("test"), mimeType: "image/png", filename: "test.png" })),
    mediaPublicUrl: (item) => item.url ?? null,
    credentials: () => ({ clientId: "client-id", clientSecret: "client-secret" }),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    forceMock: false,
    publicMediaBaseUrl: null,
  };
  return { ctx, calls };
}

function threadsInput(media, options = {}) {
  return {
    account: {
      id: "threads:user-1",
      platform: "threads",
      handle: "@relay_demo",
      mode: "live",
      connectedAt,
    },
    tokens: { accessToken: "threads-token" },
    post: {
      platform: "threads",
      parts: [{ text: "Carousel caption", media }],
      options,
    },
  };
}

function tiktokInput(media, options = {}) {
  return {
    account: {
      id: "tiktok:user-1",
      platform: "tiktok",
      handle: "relay_demo",
      mode: "live",
      connectedAt,
    },
    tokens: { accessToken: "tiktok-token" },
    post: {
      platform: "tiktok",
      parts: [{ text: "TikTok caption", media }],
      options,
    },
  };
}

test("isAuthFailure treats a 403 permission error as a non-auth failure", () => {
  const body = {
    error: {
      code: "unaudited_client_can_only_post_to_private_accounts",
      message: "Please review our integration guidelines",
      log_id: "tiktok-log-403",
    },
  };
  assert.equal(isAuthFailure(403, body), false);
});

test("isAuthFailure treats 401 as an auth failure", () => {
  assert.equal(isAuthFailure(401, {}), true);
});

test("isAuthFailure treats a 403 carrying error code 190 as an auth failure", () => {
  assert.equal(
    isAuthFailure(403, { error: { code: 190, message: "Invalid OAuth access token" } }),
    true,
  );
});

test("Threads carousel creates item containers, polls, then publishes the carousel", async () => {
  let itemCount = 0;
  const { ctx, calls } = makeContext({
    onFetch: (call) => {
      const method = (call.init?.method ?? "GET").toUpperCase();
      const url = new URL(call.url);
      if (method === "POST" && url.pathname.endsWith("/threads")) {
        const body = formBodyOf(call);
        if (body.is_carousel_item === "true") return { id: `item-${++itemCount}` };
        if (body.media_type === "CAROUSEL") return { id: "carousel-container" };
      }
      if (method === "POST" && url.pathname.endsWith("/threads_publish")) return { id: "threads-post-1" };
      if (method === "GET" && url.searchParams.get("fields")?.includes("status")) return { status: "FINISHED" };
      throw new Error(`Unexpected Threads request: ${method} ${call.url}`);
    },
  });

  const media = [
    { kind: "image", url: "https://media.test/one.png" },
    { kind: "image", url: "https://media.test/two.png" },
  ];
  const result = await new ThreadsAdapter().publish(ctx, threadsInput(media, { replySetting: "followers" }));

  const containerPosts = calls.filter(
    (call) => (call.init?.method ?? "GET").toUpperCase() === "POST" && new URL(call.url).pathname.endsWith("/threads"),
  );
  const itemPosts = containerPosts.filter((call) => formBodyOf(call).is_carousel_item === "true");
  assert.equal(itemPosts.length, 2, "one container per carousel item");
  assert.deepEqual(
    itemPosts.map((call) => formBodyOf(call)),
    [
      { media_type: "IMAGE", is_carousel_item: "true", image_url: "https://media.test/one.png" },
      { media_type: "IMAGE", is_carousel_item: "true", image_url: "https://media.test/two.png" },
    ],
  );

  const carouselPost = containerPosts.find((call) => formBodyOf(call).media_type === "CAROUSEL");
  assert.ok(carouselPost, "a CAROUSEL container must be created");
  const carouselBody = formBodyOf(carouselPost);
  assert.equal(carouselBody.children, "item-1,item-2");
  assert.equal(carouselBody.text, "Carousel caption");
  assert.equal(carouselBody.reply_control, "followers_only");

  const statusPoll = calls.find(
    (call) => (call.init?.method ?? "GET").toUpperCase() === "GET" && call.url.includes("carousel-container?fields=status"),
  );
  assert.ok(statusPoll, "the carousel container must be polled until FINISHED");
  assert.ok(statusPoll.url.includes("fields=status,error_message"), "status polls must request error_message");

  for (const itemId of ["item-1", "item-2"]) {
    const itemPoll = calls.find(
      (call) =>
        (call.init?.method ?? "GET").toUpperCase() === "GET" &&
        call.url.includes(`${itemId}?fields=status,error_message`),
    );
    assert.ok(itemPoll, `image item ${itemId} must be polled until FINISHED`);
  }

  const publishCall = calls.find(
    (call) => (call.init?.method ?? "GET").toUpperCase() === "POST" && new URL(call.url).pathname.endsWith("/threads_publish"),
  );
  assert.deepEqual(formBodyOf(publishCall), { creation_id: "carousel-container" });

  assert.equal(result.platformPostId, "threads-post-1");
  assert.deepEqual(result.details.parts[0].carouselItemIds, ["item-1", "item-2"]);
  assert.equal(result.details.parts[0].mediaType, "CAROUSEL");
  assert.equal(result.details.parts[0].children, "item-1,item-2");
});

test("Threads rejects a carousel with more than 20 media items", async () => {
  const { ctx, calls } = makeContext({
    onFetch: () => {
      throw new Error("no provider calls should be made for an oversized carousel");
    },
  });
  const media = Array.from({ length: 21 }, (_, index) => ({
    kind: "image",
    url: `https://media.test/${index}.png`,
  }));

  await assert.rejects(
    new ThreadsAdapter().publish(ctx, threadsInput(media)),
    (error) => error.code === "threads_too_many_media" && /20/.test(error.message),
  );
  assert.equal(calls.length, 0);
});

test("Threads waits for a single image container before publishing", async () => {
  const { ctx, calls } = makeContext({
    onFetch: (call) => {
      const method = (call.init?.method ?? "GET").toUpperCase();
      const url = new URL(call.url);
      if (method === "POST" && url.pathname.endsWith("/threads")) return { id: "image-container" };
      if (method === "GET" && url.pathname.endsWith("/image-container")) return { status: "FINISHED" };
      if (method === "POST" && url.pathname.endsWith("/threads_publish")) return { id: "threads-image-post" };
      throw new Error(`Unexpected Threads request: ${method} ${call.url}`);
    },
  });

  const result = await new ThreadsAdapter().publish(
    ctx,
    threadsInput([{ kind: "image", url: "https://media.test/one.png" }]),
  );

  const pollIndex = calls.findIndex(
    (call) => (call.init?.method ?? "GET").toUpperCase() === "GET" && call.url.includes("image-container?fields=status"),
  );
  const publishIndex = calls.findIndex(
    (call) => (call.init?.method ?? "GET").toUpperCase() === "POST" && new URL(call.url).pathname.endsWith("/threads_publish"),
  );
  assert.ok(pollIndex >= 0, "single image containers must be polled");
  assert.ok(publishIndex > pollIndex, "the image must be FINISHED before threads_publish");
  assert.equal(result.platformPostId, "threads-image-post");
  assert.equal(result.details.parts[0].mediaType, "IMAGE");
});

test("Threads surfaces container error_message when processing fails", async () => {
  const { ctx } = makeContext({
    onFetch: (call) => {
      const method = (call.init?.method ?? "GET").toUpperCase();
      const url = new URL(call.url);
      if (method === "POST" && url.pathname.endsWith("/threads")) return { id: "bad-container" };
      if (method === "GET" && url.pathname.endsWith("/bad-container")) {
        return { status: "ERROR", error_message: "Media download failed" };
      }
      throw new Error(`Unexpected Threads request: ${method} ${call.url}`);
    },
  });

  await assert.rejects(
    new ThreadsAdapter().publish(ctx, threadsInput([{ kind: "image", url: "https://media.test/bad.png" }])),
    (error) =>
      error.code === "threads_media_processing_failed" &&
      /Media download failed/.test(error.message) &&
      error.details.error_message === "Media download failed",
  );
});

test("Threads includes every Graph error field and logs the provider error", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "relay-provider-errors-"));
  const graphError = {
    error: {
      message: "Invalid parameter",
      type: "OAuthException",
      code: 100,
      error_subcode: 33,
      error_user_title: "Invalid carousel item",
      error_user_msg: "The image URL could not be fetched",
      fbtrace_id: "trace-123",
    },
  };
  const { ctx } = makeContext({
    dataDir,
    onFetch: (call) => {
      const method = (call.init?.method ?? "GET").toUpperCase();
      if (method === "POST") return graphError;
      throw new Error(`Unexpected Threads request: ${method} ${call.url}`);
    },
  });

  await assert.rejects(
    new ThreadsAdapter().publish(
      ctx,
      threadsInput([
        { kind: "image", url: "https://media.test/one.png" },
        { kind: "image", url: "https://media.test/two.png" },
      ]),
    ),
    (error) => {
      for (const expected of [
        "Invalid parameter",
        "OAuthException",
        "100",
        "33",
        "Invalid carousel item",
        "The image URL could not be fetched",
        "trace-123",
      ]) {
        assert.match(error.message, new RegExp(expected));
      }
      assert.equal(error.details.provider.error_user_msg, "The image URL could not be fetched");
      assert.equal(error.details.body.error.fbtrace_id, "trace-123");
      return true;
    },
  );

  const logged = readFileSync(join(dataDir, "provider-errors.log"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(logged.length, 1);
  assert.equal(logged[0].label, "Threads create carousel item (part 1, item 1)");
  assert.equal(logged[0].body.error.code, 100);
});

test("Threads OAuth requests reply management and read-only comment scopes", async () => {
  const { ctx } = makeContext({ onFetch: () => ({}) });
  const result = await new ThreadsAdapter().authorize(ctx, {
    state: "state-1",
    codeVerifier: "v".repeat(43),
    redirectUri: "https://relay.test/auth/callback/threads",
  });
  assert.equal(result.kind, "redirect");
  assert.equal(
    new URL(result.url).searchParams.get("scope"),
    "threads_basic,threads_content_publish,threads_manage_replies,threads_read_replies",
  );
});

test("Threads readComments lists recent posts and excludes the account's own replies", async () => {
  const { ctx, calls } = makeContext({
    onFetch: (call) => {
      const url = new URL(call.url);
      if (url.pathname === "/v1.0/me/threads") {
        return {
          data: [
            {
              id: "post-1",
              text: "First post",
              timestamp: "2026-01-01T00:00:00.000Z",
              permalink: "https://www.threads.net/@relay_demo/post/post-1",
            },
            {
              id: "post-2",
              text: "Second post",
              timestamp: "2026-01-02T00:00:00.000Z",
              permalink: "https://www.threads.net/@relay_demo/post/post-2",
            },
          ],
        };
      }
      if (url.pathname === "/v1.0/post-1/conversation") {
        return {
          data: [
            { id: "post-1", text: "First post", username: "relay_demo", is_reply: false },
            {
              id: "comment-1",
              text: "A reader reply",
              username: "alice",
              timestamp: "2026-01-01T01:00:00.000Z",
              replied_to: "post-1",
              is_reply: true,
              hide_status: "NOT_HIDDEN",
            },
            {
              id: "comment-own",
              text: "The account's own reply",
              username: "relay_demo",
              timestamp: "2026-01-01T02:00:00.000Z",
              replied_to: "comment-1",
              is_reply: true,
            },
          ],
        };
      }
      if (url.pathname === "/v1.0/post-2/conversation") return { data: [] };
      throw new Error(`Unexpected Threads request: ${call.url}`);
    },
  });
  const input = threadsInput([]);
  input.tokens = { accessToken: "threads-token", scope: "threads_basic,threads_read_replies" };

  const result = await new ThreadsAdapter().readComments(ctx, {
    account: input.account,
    tokens: input.tokens,
    limitPosts: 2,
  });

  assert.deepEqual(result.posts.map((post) => post.id), ["post-1", "post-2"]);
  assert.deepEqual(result.posts[0].comments.map((comment) => comment.id), ["comment-1"]);
  assert.equal(result.posts[0].comments[0].username, "alice");
  assert.equal(result.posts[0].permalink, "https://www.threads.net/@relay_demo/post/post-1");

  const listCall = calls.find((call) => new URL(call.url).pathname === "/v1.0/me/threads");
  assert.ok(listCall, "the adapter must list recent Threads posts");
  assert.equal(listCall.url.includes("fields=id,text,timestamp,permalink"), true);
  assert.equal(listCall.url.includes("limit=2"), true);
  const conversationCall = calls.find((call) => new URL(call.url).pathname === "/v1.0/post-1/conversation");
  assert.ok(conversationCall, "the adapter must read each post's conversation");
  assert.equal(
    conversationCall.url.includes("fields=id,text,username,timestamp,replied_to,is_reply,hide_status"),
    true,
  );
  assert.equal(conversationCall.url.includes("reverse=false"), true);
});

test("Threads readComments fails with threads_scope_missing before calling the provider", async () => {
  const { ctx, calls } = makeContext({
    onFetch: () => {
      throw new Error("no provider call should be made without threads_read_replies");
    },
  });
  const input = threadsInput([]);
  input.tokens = { accessToken: "threads-token", scope: "threads_basic,threads_manage_replies" };

  await assert.rejects(
    new ThreadsAdapter().readComments(ctx, {
      account: input.account,
      tokens: input.tokens,
      limitPosts: 10,
    }),
    (error) => error.code === "threads_scope_missing" && /threads_read_replies/.test(error.message),
  );
  assert.equal(calls.length, 0);
});

function threadsReplyInput({ scopes = ["threads_basic", "threads_manage_replies"], tokens = { accessToken: "threads-token" } } = {}) {
  return {
    account: {
      id: "threads:user-1",
      platform: "threads",
      handle: "@relay_demo",
      mode: "live",
      connectedAt,
      scopes,
    },
    tokens,
  };
}

test("Threads replyToComment creates a TEXT reply container and publishes it", async () => {
  const { ctx, calls } = makeContext({
    onFetch: (call) => {
      const method = (call.init?.method ?? "GET").toUpperCase();
      const url = new URL(call.url);
      if (method === "POST" && url.pathname === "/v1.0/user-1/threads") return { id: "reply-container" };
      if (method === "POST" && url.pathname === "/v1.0/user-1/threads_publish") return { id: "threads-reply-1" };
      throw new Error(`Unexpected Threads request: ${method} ${call.url}`);
    },
  });

  const result = await new ThreadsAdapter().replyToComment(ctx, "comment-1", "  Thanks for the note!  ", threadsReplyInput());

  assert.equal(calls.length, 2, "one container call and one publish call");
  const containerCall = calls.find((call) => new URL(call.url).pathname === "/v1.0/user-1/threads");
  assert.ok(containerCall, "the adapter must create a reply container");
  assert.equal(containerCall.init.method, "POST");
  assert.equal(containerCall.init.headers.Authorization, "Bearer threads-token");
  assert.deepEqual(formBodyOf(containerCall), {
    media_type: "TEXT",
    text: "Thanks for the note!",
    reply_to_id: "comment-1",
  });

  const publishCall = calls.find((call) => new URL(call.url).pathname === "/v1.0/user-1/threads_publish");
  assert.ok(publishCall, "the adapter must publish the reply container");
  assert.equal(publishCall.init.method, "POST");
  assert.deepEqual(formBodyOf(publishCall), { creation_id: "reply-container" });

  assert.equal(result.id, "threads-reply-1");
  assert.equal(result.permalink, "https://www.threads.net/@relay_demo/post/threads-reply-1");
  assert.equal(result.mock, false);
});

test("Threads replyToComment fails with threads_scope_missing (403) before any provider call", async () => {
  const { ctx, calls } = makeContext({
    onFetch: () => {
      throw new Error("no provider call should be made without threads_manage_replies");
    },
  });

  await assert.rejects(
    new ThreadsAdapter().replyToComment(
      ctx,
      "comment-1",
      "A reply",
      threadsReplyInput({ scopes: ["threads_basic", "threads_read_replies"] }),
    ),
    (error) =>
      error.code === "threads_scope_missing" &&
      error.statusCode === 403 &&
      /threads_manage_replies/.test(error.message),
  );
  assert.equal(calls.length, 0);
});

test("Threads replyToComment validates comment id and text before any provider call", async () => {
  const { ctx, calls } = makeContext({
    onFetch: () => {
      throw new Error("no provider call should be made for invalid replies");
    },
  });
  const adapter = new ThreadsAdapter();
  const input = threadsReplyInput();

  await assert.rejects(
    adapter.replyToComment(ctx, "   ", "A reply", input),
    (error) => error.code === "threads_reply_comment_id_invalid" && error.statusCode === 400,
  );
  await assert.rejects(
    adapter.replyToComment(ctx, "comment-1", "   ", input),
    (error) => error.code === "threads_reply_text_required" && error.statusCode === 400,
  );
  await assert.rejects(
    adapter.replyToComment(ctx, "comment-1", "x".repeat(501), input),
    (error) => error.code === "threads_reply_text_too_long" && /500/.test(error.message),
  );
  assert.equal(calls.length, 0);
});

test("Threads replyToComment simulates in mock mode without calling fetch", async () => {
  const { ctx, calls } = makeContext({
    onFetch: () => {
      throw new Error("mock mode must not call the real Threads API");
    },
  });
  ctx.forceMock = true;

  const result = await new ThreadsAdapter().replyToComment(
    ctx,
    "comment-1",
    "A simulated reply",
    threadsReplyInput({ tokens: null }),
  );

  assert.equal(calls.length, 0);
  assert.equal(result.mock, true);
  assert.match(result.id, /^mock_threads_reply_/);
  assert.equal(result.permalink, `https://www.threads.net/@relay_demo/post/${result.id}`);
});

test("Threads reconciles an ambiguous publish error by matching a recent post", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "relay-threads-ambiguous-"));
  const nowIso = "2026-01-01T00:00:00.000Z";
  const { ctx, calls } = makeContext({
    dataDir,
    onFetch: (call) => {
      const method = (call.init?.method ?? "GET").toUpperCase();
      const url = new URL(call.url);
      if (method === "POST" && url.pathname.endsWith("/threads")) return { id: "ambiguous-container" };
      if (method === "POST" && url.pathname.endsWith("/threads_publish")) {
        return new Response(JSON.stringify({ error: { message: "Internal server error", code: 2 } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "GET" && url.pathname.endsWith("/ambiguous-container")) {
        return { status: "FINISHED", id: "ambiguous-container" };
      }
      if (method === "GET" && url.pathname.endsWith("/me/threads")) {
        return {
          data: [
            { id: "unrelated-post", text: "Something else", timestamp: "2026-01-01T00:00:00.000Z" },
            { id: "reconciled-post", text: "Carousel caption", timestamp: nowIso },
          ],
        };
      }
      throw new Error(`Unexpected Threads request: ${method} ${call.url}`);
    },
  });

  const result = await new ThreadsAdapter().publish(ctx, threadsInput([]));

  assert.equal(result.platformPostId, "reconciled-post");
  const listCall = calls.find(
    (call) => (call.init?.method ?? "GET").toUpperCase() === "GET" && new URL(call.url).pathname.endsWith("/me/threads"),
  );
  assert.ok(listCall, "the adapter must list recent Threads posts to reconcile");
  assert.equal(listCall.url.includes("fields=id,text,timestamp"), true);
  assert.equal(listCall.url.includes("limit=5"), true);
});

test("Threads calls onPartPublished for every published part", async () => {
  let containerCount = 0;
  let publishCount = 0;
  const { ctx } = makeContext({
    onFetch: (call) => {
      const method = (call.init?.method ?? "GET").toUpperCase();
      const url = new URL(call.url);
      if (method === "POST" && url.pathname.endsWith("/threads")) {
        containerCount += 1;
        return { id: `container-${containerCount}` };
      }
      if (method === "POST" && url.pathname.endsWith("/threads_publish")) {
        publishCount += 1;
        return { id: `threads-post-${publishCount}` };
      }
      if (method === "GET" && url.searchParams.get("fields") === "status,error_message") return { status: "FINISHED" };
      throw new Error(`Unexpected Threads request: ${method} ${call.url}`);
    },
  });
  const events = [];
  ctx.onPartPublished = async (event) => {
    events.push(event);
  };
  const input = threadsInput([]);
  input.post.parts = [{ text: "first part", media: [] }, { text: "second part", media: [] }];

  const result = await new ThreadsAdapter().publish(ctx, input);

  assert.deepEqual(events.map((event) => event.postId), ["threads-post-1", "threads-post-2"]);
  assert.equal(events[0].part, 1);
  assert.equal(events[0].platform, "threads");
  assert.equal(events[0].url, "https://www.threads.net/@relay_demo/post/threads-post-1");
  assert.equal(result.platformPostId, "threads-post-1");
});

test("X calls onPartPublished for every tweet before continuing the thread", async () => {
  let tweetCount = 0;
  const { ctx } = makeContext({
    onFetch: (call) => {
      const url = new URL(call.url);
      if ((call.init?.method ?? "GET").toUpperCase() === "POST" && url.pathname.endsWith("/2/tweets")) {
        tweetCount += 1;
        return { data: { id: `tweet-${tweetCount}` } };
      }
      throw new Error(`Unexpected X request: ${call.url}`);
    },
  });
  const events = [];
  ctx.onPartPublished = async (event) => {
    events.push(event);
  };
  const result = await new XAdapter().publish(ctx, {
    account: {
      id: "x:user-1",
      platform: "x",
      handle: "@relay_demo",
      mode: "live",
      connectedAt,
    },
    tokens: { accessToken: "x-token" },
    post: {
      platform: "x",
      parts: [{ text: "first tweet", media: [] }, { text: "second tweet", media: [] }],
      options: {},
    },
  });

  assert.deepEqual(events.map((event) => event.postId), ["tweet-1", "tweet-2"]);
  assert.equal(events[0].url, "https://x.com/relay_demo/status/tweet-1");
  assert.equal(result.platformPostId, "tweet-1");
});

function tiktokFetch(call) {
  const url = new URL(call.url);
  const method = (call.init?.method ?? "GET").toUpperCase();
  if (method === "POST" && url.pathname.endsWith("/publish/creator_info/query/")) {
    return {
      data: {
        comment_disabled: false,
        privacy_level_options: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"],
      },
    };
  }
  if (method === "POST" && url.pathname.endsWith("/publish/content/init/")) {
    return { data: { publish_id: "photo-publish-1" } };
  }
  if (method === "POST" && url.pathname.endsWith("/publish/video/init/")) {
    return { data: { publish_id: "video-publish-1", upload_url: "https://upload.test/video" } };
  }
  if (method === "POST" && url.pathname.endsWith("/publish/status/fetch/")) {
    return { data: { status: "PUBLISH_COMPLETE" } };
  }
  return {};
}

function photoInitCall(calls) {
  const call = calls.find((entry) => new URL(entry.url).pathname.endsWith("/publish/content/init/"));
  assert.ok(call, "TikTok photo init must be called");
  return call;
}

test("TikTok photo init enables auto_add_music by default", async () => {
  const { ctx, calls } = makeContext({ onFetch: tiktokFetch });
  await new TikTokAdapter().publish(
    ctx,
    tiktokInput([{ kind: "image", url: "https://media.test/photo.png" }]),
  );

  const body = jsonBodyOf(photoInitCall(calls));
  assert.equal(body.post_info.auto_add_music, true);
});

test("TikTok photo init honors tiktokAutoAddMusic: false", async () => {
  const { ctx, calls } = makeContext({ onFetch: tiktokFetch });
  await new TikTokAdapter().publish(
    ctx,
    tiktokInput([{ kind: "image", url: "https://media.test/photo.png" }], { tiktokAutoAddMusic: false }),
  );

  const body = jsonBodyOf(photoInitCall(calls));
  assert.equal(body.post_info.auto_add_music, false);
});

test("TikTok video init never sends auto_add_music", async () => {
  const { ctx, calls } = makeContext({
    onFetch: tiktokFetch,
    readMedia: async () => ({ buffer: Buffer.from("video-bytes"), mimeType: "video/mp4", filename: "video.mp4" }),
  });
  await new TikTokAdapter().publish(ctx, tiktokInput([{ kind: "video", path: "video.mp4" }], { tiktokAutoAddMusic: true }));

  const initCall = calls.find((call) => new URL(call.url).pathname.endsWith("/publish/video/init/"));
  assert.ok(initCall, "TikTok video init must be called");
  const body = jsonBodyOf(initCall);
  assert.equal(Object.prototype.hasOwnProperty.call(body.post_info, "auto_add_music"), false);
});

test("TikTok calls onPartPublished with the publish id before status polling", async () => {
  const { ctx } = makeContext({ onFetch: tiktokFetch });
  let statusCalls = 0;
  const events = [];
  ctx.onPartPublished = async (event) => {
    events.push({ event, statusCalls });
  };
  const originalFetch = ctx.fetch;
  ctx.fetch = async (url, init) => {
    if (new URL(String(url)).pathname.endsWith("/publish/status/fetch/")) statusCalls += 1;
    return originalFetch(url, init);
  };

  await new TikTokAdapter().publish(
    ctx,
    tiktokInput([{ kind: "image", url: "https://media.test/photo.png" }]),
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].event.platform, "tiktok");
  assert.equal(events[0].event.part, 1);
  assert.equal(events[0].event.postId, "photo-publish-1");
  assert.equal(events[0].statusCalls, 0, "the publish id must be persisted before polling status");
});

test("TikTok photo init uses a 90-char first-line title and the full description", async () => {
  const firstLine = `First line ${"a".repeat(120)}`;
  const caption = `${firstLine}\n\n${"b".repeat(300)}`;
  const { ctx, calls } = makeContext({ onFetch: tiktokFetch });
  const input = tiktokInput([{ kind: "image", url: "https://media.test/photo.png" }]);
  input.post.parts[0].text = caption;

  await new TikTokAdapter().publish(ctx, input);

  const body = jsonBodyOf(photoInitCall(calls));
  assert.equal(body.post_info.title, firstLine.slice(0, 90));
  assert.equal(Array.from(body.post_info.title).length, 90);
  assert.equal(body.post_info.description, caption);
  assert.equal(body.post_info.brand_content_toggle, false);
  assert.equal(body.post_info.brand_organic_toggle, false);
  assert.equal(body.source_info.source, "PULL_FROM_URL");
  assert.equal(body.source_info.photo_cover_index, 0);
  assert.deepEqual(body.source_info.photo_images, ["https://media.test/photo.png"]);
  assert.equal(body.post_mode, "DIRECT_POST");
  assert.equal(body.media_type, "PHOTO");

  const creatorInfoIndex = calls.findIndex((call) =>
    new URL(call.url).pathname.endsWith("/publish/creator_info/query/"),
  );
  const initIndex = calls.findIndex((call) => new URL(call.url).pathname.endsWith("/publish/content/init/"));
  assert.ok(creatorInfoIndex >= 0, "creator_info must be queried before init");
  assert.ok(initIndex > creatorInfoIndex, "creator_info must be queried before photo init");
});

test("TikTok falls back to SELF_ONLY privacy and honors creator comment settings", async () => {
  const { ctx, calls } = makeContext({
    onFetch: (call) => {
      const url = new URL(call.url);
      if (url.pathname.endsWith("/publish/creator_info/query/")) {
        return {
          data: {
            comment_disabled: true,
            privacy_level_options: ["SELF_ONLY"],
          },
        };
      }
      return tiktokFetch(call);
    },
  });
  const result = await new TikTokAdapter().publish(
    ctx,
    tiktokInput([{ kind: "image", url: "https://media.test/photo.png" }], {
      tiktokPrivacy: "PUBLIC_TO_EVERYONE",
      disableComment: false,
    }),
  );

  const body = jsonBodyOf(photoInitCall(calls));
  assert.equal(body.post_info.privacy_level, "SELF_ONLY");
  assert.equal(body.post_info.disable_comment, true);
  assert.equal(result.details.privacy, "SELF_ONLY");
  assert.equal(result.details.requestedPrivacy, "PUBLIC_TO_EVERYONE");
  assert.equal(result.details.privacyFallback, true);
});

test("TikTok maps url_ownership_unverified to an actionable error", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "relay-tiktok-errors-"));
  const { ctx } = makeContext({
    dataDir,
    onFetch: (call) => {
      const url = new URL(call.url);
      if (url.pathname.endsWith("/publish/creator_info/query/")) {
        return { data: { privacy_level_options: ["SELF_ONLY"] } };
      }
      if (url.pathname.endsWith("/publish/content/init/")) {
        return {
          error: {
            code: "url_ownership_unverified",
            message: "Please verify the URL ownership",
            log_id: "tiktok-log-1",
          },
        };
      }
      return tiktokFetch(call);
    },
  });

  await assert.rejects(
    new TikTokAdapter().publish(
      ctx,
      tiktokInput([{ kind: "image", url: "https://media.test/photo.png" }]),
    ),
    (error) =>
      error.code === "tiktok_url_ownership_unverified" &&
      /developer portal/i.test(error.message) &&
      /verify the media domain/i.test(error.message) &&
      error.details.provider.log_id === "tiktok-log-1",
  );
});
