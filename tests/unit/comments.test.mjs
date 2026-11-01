/**
 * Unit tests for relay_comments_new / relay_reply (service level).
 * All platform adapters are fakes; nothing talks to a real API and no LLM is involved.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAdapters, createRelay, InstagramAdapter, ThreadsAdapter, YouTubeAdapter } from "@relay/platforms";
import { allTemplates, classifyComment, replyTextWarnings, suggestedTemplate } from "@relay/core";
import { cleanupTempDir, makeTempDir } from "../helpers.mjs";

const NOW = Date.now();
const iso = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();

// ---- classifier -----------------------------------------------------------

test("classifyComment: spam, simple and needs_reply", () => {
  const spam = [
    "Join now https://t.me/cuan123",
    "visit www.rezeki-cepat.com",
    "WhatsApp saya 012-3456789 untung besar",
    "wahhhhhhhhhh bestnya",
    "gandakan duit anda sekarang",
    "free giveaway, follow back ya",
    "@a @b @c @d tengok ni",
  ];
  for (const text of spam) assert.equal(classifyComment(text).kind, "spam", `should be spam: ${text}`);

  const simple = ["thanks", "Thank you!", "tq bos", "Terima kasih", "mantap", "nice one", "thanks for sharing", "ok", "terbaik bos", "🔥🔥🔥", "🙏", "thankssss", "Alhamdulillah"];
  for (const text of simple) assert.equal(classifyComment(text).kind, "simple", `should be simple: ${text}`);
  assert.equal(classifyComment("").kind, "simple");

  const real = [
    "ASB atau KWSP dulu kalau baru mula kerja?",
    "Tak setuju, ETF lagi selamat pada saya",
    "ok tapi macam mana nak mula dengan RM100 sebulan",
    "nice, tapi dividend ASB tahun ni berapa?",
    "thanks? boleh terangkan lagi",
    "pinjaman PTPTN patut bayar dulu ke?",
    "tak betul la tu",
  ];
  for (const text of real) assert.equal(classifyComment(text).kind, "needs_reply", `should need a reply: ${text}`);
});

test("classifyComment: language guess and templates", () => {
  assert.equal(classifyComment("thanks for sharing").lang, "en");
  assert.equal(classifyComment("terima kasih bos").lang, "ms");
  // Templates: no em/en dashes, no emoji, short, and the cursor rotates them.
  for (const template of allTemplates()) {
    assert.ok(!/[\u2013\u2014]/.test(template), template);
    assert.ok(!/\p{Extended_Pictographic}/u.test(template), template);
    assert.ok(template.length <= 60, template);
  }
  assert.notEqual(suggestedTemplate("ms", 0), suggestedTemplate("ms", 1));
  assert.equal(suggestedTemplate("ms", 0), suggestedTemplate("ms", 6));
  assert.deepEqual(replyTextWarnings("fine, thanks"), []);
  assert.equal(replyTextWarnings("a \u2014 b").length, 1);
  assert.equal(replyTextWarnings("ini bukan nasihat kewangan").length, 1);
});

// ---- fakes ------------------------------------------------------------------

class FakeThreads extends ThreadsAdapter {
  constructor() {
    super();
    this.posts = [];
    this.replies = [];
    this.failReply = null;
  }
  async readComments(_ctx, input) {
    this.lastSince = input.sinceMs;
    return { posts: this.posts.map((p) => ({ ...p, comments: p.comments.map((c) => ({ ...c })) })) };
  }
  async replyToComment(_ctx, commentId, text) {
    if (this.failReply) throw this.failReply;
    const id = `th-reply-${this.replies.length + 1}`;
    this.replies.push({ commentId, text, id });
    return { id, mock: true };
  }
}

class FakeInstagram extends InstagramAdapter {
  constructor({ scopes } = {}) {
    super();
    this.comments = [];
    this.replies = [];
    this.scopes = scopes;
  }
  async authorize(ctx, req) {
    const base = await super.authorize(ctx, req);
    return this.scopes && base.kind === "mock" ? { ...base, scopes: this.scopes } : base;
  }
  async readOwnComments(_ctx, input) {
    this.lastInput = input;
    return this.comments.map((c) => ({ ...c }));
  }
  async replyToComment(_ctx, commentId, text) {
    const id = `ig-reply-${this.replies.length + 1}`;
    this.replies.push({ commentId, text, id });
    return { id, mock: true };
  }
}

class FakeYouTube extends YouTubeAdapter {
  constructor() {
    super();
    this.comments = [];
    this.replies = [];
    this.calls = 0;
  }
  async readOwnComments() {
    this.calls += 1;
    return this.comments.map((c) => ({ ...c }));
  }
  async replyToComment(_ctx, commentId, text) {
    const id = `yt-reply-${this.replies.length + 1}`;
    this.replies.push({ commentId, text, id });
    return { id, mock: true };
  }
}

function th(id, text, minutesAgo, author = "aina") {
  return { id, text, username: author, timestamp: iso(minutesAgo) };
}
function own(platform, postId, commentId, text, minutesAgo, author = "someone") {
  return { platform, postId, commentId, author, text, createdAt: iso(minutesAgo), postCaption: "KWSP vs ASB, mana dulu?" };
}

async function makeRelay(dataDir, { threads, instagram, youtube, env = {} } = {}) {
  const fakes = { threads, instagram, youtube };
  const adapters = createAdapters().map((entry) => fakes[entry.platform] ?? entry);
  return createRelay({ dataDir, forceMock: true, env: { THREADS_AUTOREPLY_ENABLED: "false", ...env }, adapters });
}

async function connectAll(relay) {
  for (const platform of ["threads", "instagram", "youtube"]) {
    const result = await relay.beginConnect(platform);
    assert.equal(result.mode, "connected");
  }
}

function fixtures() {
  const threads = new FakeThreads();
  threads.posts = [
    { id: "t-post-1", text: "Post Threads", comments: [th("t1", "ASB atau KWSP dulu?", 30), th("t2", "thanks bos", 20), th("t-old", "komen lama", 60 * 24 * 5)] },
  ];
  const instagram = new FakeInstagram();
  instagram.comments = [own("instagram", "ig-m1", "i1", "visit www.spam-site.com now", 15), own("instagram", "ig-m1", "i2", "🔥🔥", 10)];
  const youtube = new FakeYouTube();
  youtube.comments = [own("youtube", "yt-v1", "y1", "Macam mana nak mula dengan RM100?", 40)];
  return { threads, instagram, youtube };
}

// ---- relay_comments_new -----------------------------------------------------

test("newComments returns each comment once, flags kinds, and survives a restart", async () => {
  const dataDir = await makeTempDir("relay-comments-new-");
  try {
    const f = fixtures();
    let relay = await makeRelay(dataDir, f);
    await connectAll(relay);

    const first = await relay.newComments({ platform: "all", sinceHours: 48, limit: 20 });
    assert.equal(first.comments.length, 5, "the 5 day old Threads comment is outside the 48h window");
    assert.equal(first.mark_seen, true);
    assert.ok(first.platforms.every((p) => p.status === "ok"));
    const byId = Object.fromEntries(first.comments.map((c) => [c.comment_id, c]));
    assert.equal(byId.t1.kind, "needs_reply");
    assert.equal(byId.t1.platform, "threads");
    assert.equal(byId.t1.post_id, "t-post-1");
    assert.equal(byId.t1.author, "aina");
    assert.equal(byId.t1.post_caption_snippet, "Post Threads");
    assert.ok(byId.t1.created_at);
    assert.equal(byId.t2.kind, "simple");
    assert.ok(byId.t2.suggested_template);
    assert.equal(byId.i1.kind, "spam");
    assert.ok(byId.i1.spam_reason);
    assert.equal(byId.i1.suggested_template, undefined);
    assert.equal(byId.i2.kind, "simple");
    assert.equal(byId.y1.kind, "needs_reply");
    assert.equal(byId.y1.post_caption_snippet, "KWSP vs ASB, mana dulu?");
    assert.deepEqual(first.counts, { needs_reply: 2, simple: 2, spam: 1 });
    // Oldest first.
    const times = first.comments.map((c) => Date.parse(c.created_at));
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
    // The two simple comments got different templates (rotation).
    assert.notEqual(byId.t2.suggested_template, byId.i2.suggested_template);
    assert.ok(f.threads.lastSince > 0, "Threads is asked for the window only");

    const second = await relay.newComments({ platform: "all" });
    assert.equal(second.comments.length, 0, "already handed out");

    // Restart: a new service on the same data dir still remembers.
    await relay.close();
    relay = await makeRelay(dataDir, f);
    const third = await relay.newComments({});
    assert.equal(third.comments.length, 0, "seen ids persist across restarts");

    // A genuinely new comment shows up exactly once.
    f.threads.posts[0].comments.push(th("t3", "Boleh share sumber?", 1));
    const fourth = await relay.newComments({ platform: "threads" });
    assert.deepEqual(fourth.comments.map((c) => c.comment_id), ["t3"]);
    assert.equal((await relay.newComments({ platform: "threads" })).comments.length, 0);
    await relay.close();
  } finally {
    await cleanupTempDir(dataDir);
  }
});

test("newComments: mark_seen false is a read-only peek; limit and platform filter work", async () => {
  const dataDir = await makeTempDir("relay-comments-peek-");
  try {
    const f = fixtures();
    const relay = await makeRelay(dataDir, f);
    await connectAll(relay);

    const peek1 = await relay.newComments({ platform: "all", markSeen: false });
    const peek2 = await relay.newComments({ platform: "all", markSeen: false });
    assert.equal(peek1.comments.length, 5);
    assert.equal(peek2.comments.length, 5, "peeking marks nothing");
    assert.equal(peek1.mark_seen, false);

    const ig = await relay.newComments({ platform: "instagram", markSeen: false });
    assert.ok(ig.comments.every((c) => c.platform === "instagram"));
    assert.equal(ig.platforms.length, 1);
    assert.equal(f.youtube.calls, 2, "YouTube is only called when it is asked for");

    const page1 = await relay.newComments({ platform: "all", limit: 3 });
    assert.equal(page1.comments.length, 3);
    assert.equal(page1.more_available, true);
    const page2 = await relay.newComments({ platform: "all", limit: 3 });
    assert.equal(page2.comments.length, 2, "unreturned comments stay unseen for the next call");
    assert.equal(page2.more_available, false);
    const all = [...page1.comments, ...page2.comments].map((c) => c.comment_id).sort();
    assert.deepEqual(all, ["i1", "i2", "t1", "t2", "y1"]);

    await assert.rejects(() => relay.newComments({ platform: "tiktok" }), (e) => e.code === "comment_platform_unsupported");
    await relay.close();
  } finally {
    await cleanupTempDir(dataDir);
  }
});

test("newComments reports 'needs reconnect for comments' when the scope is missing, without failing", async () => {
  const dataDir = await makeTempDir("relay-comments-scope-");
  try {
    const f = fixtures();
    const oldInstagram = new FakeInstagram({ scopes: ["instagram_business_basic", "instagram_business_content_publish"] });
    oldInstagram.comments = f.instagram.comments;
    const relay = await makeRelay(dataDir, { threads: f.threads, instagram: oldInstagram, youtube: f.youtube });
    await connectAll(relay);

    const status = await relay.commentsStatus();
    const ig = status.find((s) => s.platform === "instagram");
    assert.equal(ig.ready, false);
    assert.equal(ig.status, "needs_reconnect");
    assert.match(ig.message, /needs reconnect for comments/);
    assert.deepEqual(ig.missing_scopes, ["instagram_business_manage_comments"]);
    assert.equal(status.find((s) => s.platform === "youtube").ready, true);

    const result = await relay.newComments({});
    const igReport = result.platforms.find((p) => p.platform === "instagram");
    assert.equal(igReport.status, "needs_reconnect");
    assert.match(igReport.message, /needs reconnect for comments/);
    assert.ok(result.comments.every((c) => c.platform !== "instagram"));
    assert.ok(result.comments.some((c) => c.platform === "threads"), "other platforms still work");
    assert.equal(oldInstagram.lastInput, undefined, "the adapter is not even called without the scope");

    await assert.rejects(
      () => relay.replyToComment({ platform: "instagram", commentId: "i2", text: "Terima kasih" }),
      (e) => e.code === "comments_scope_missing" && /needs reconnect for comments/.test(e.message),
    );
    await relay.close();
  } finally {
    await cleanupTempDir(dataDir);
  }
});

test("newComments: a platform that is not connected or errors does not break the others", async () => {
  const dataDir = await makeTempDir("relay-comments-errors-");
  try {
    const f = fixtures();
    const relay = await makeRelay(dataDir, f);
    await relay.beginConnect("threads");
    await relay.beginConnect("youtube");
    f.youtube.readOwnComments = async () => {
      throw new Error("boom");
    };
    const result = await relay.newComments({});
    assert.equal(result.platforms.find((p) => p.platform === "instagram").status, "not_connected");
    assert.equal(result.platforms.find((p) => p.platform === "youtube").status, "error");
    assert.ok(result.comments.length > 0);
    await relay.close();
  } finally {
    await cleanupTempDir(dataDir);
  }
});

// ---- relay_reply ------------------------------------------------------------

test("replyToComment routes to the right adapter and never replies twice", async () => {
  const dataDir = await makeTempDir("relay-comments-reply-");
  try {
    const f = fixtures();
    let relay = await makeRelay(dataDir, f);
    await connectAll(relay);

    const sent = await relay.replyToComment({ platform: "instagram", commentId: "i2", text: "Terima kasih sudi singgah.", postId: "ig-m1" });
    assert.equal(sent.ok, true);
    assert.equal(sent.dry_run, false);
    assert.equal(sent.reply_id, "ig-reply-1");
    assert.equal(sent.post_id, "ig-m1");
    assert.equal(f.instagram.replies.length, 1);
    assert.equal(f.threads.replies.length, 0);

    await assert.rejects(
      () => relay.replyToComment({ platform: "instagram", commentId: "i2", text: "lagi sekali" }),
      (e) => e.code === "comment_already_replied" && e.statusCode === 409,
    );
    assert.equal(f.instagram.replies.length, 1, "second reply was never sent");

    // Same id on another platform is a different comment.
    await relay.replyToComment({ platform: "youtube", commentId: "i2", text: "Sama-sama." });
    assert.equal(f.youtube.replies.length, 1);

    // Restart-safe.
    await relay.close();
    relay = await makeRelay(dataDir, f);
    await assert.rejects(
      () => relay.replyToComment({ platform: "instagram", commentId: "i2", text: "lagi" }),
      (e) => e.code === "comment_already_replied",
    );

    // A replied comment never comes back as "new".
    const fresh = await relay.newComments({ platform: "instagram", markSeen: false });
    assert.ok(!fresh.comments.some((c) => c.comment_id === "i2"));

    // Two parallel replies to the same comment: only one goes out.
    const results = await Promise.allSettled([
      relay.replyToComment({ platform: "threads", commentId: "t1", text: "Setuju." }),
      relay.replyToComment({ platform: "threads", commentId: "t1", text: "Setuju." }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(f.threads.replies.length, 1);
    await relay.close();
  } finally {
    await cleanupTempDir(dataDir);
  }
});

test("replyToComment: dry_run sends and records nothing; validation and failures are clear", async () => {
  const dataDir = await makeTempDir("relay-comments-dry-");
  try {
    const f = fixtures();
    const relay = await makeRelay(dataDir, f);
    await connectAll(relay);

    const dry = await relay.replyToComment({ platform: "threads", commentId: "t1", text: "Boleh, nanti saya kongsi.", dryRun: true });
    assert.equal(dry.dry_run, true);
    assert.equal(dry.would_send, true);
    assert.equal(dry.reply_id, undefined);
    assert.equal(dry.max_length, 500);
    assert.equal(f.threads.replies.length, 0);
    // Still replyable after a dry run, and a dry run after a real reply reports it.
    const real = await relay.replyToComment({ platform: "threads", commentId: "t1", text: "Boleh, nanti saya kongsi." });
    assert.equal(real.reply_id, "th-reply-1");
    await assert.rejects(
      () => relay.replyToComment({ platform: "threads", commentId: "t1", text: "x", dryRun: true }),
      (e) => e.code === "comment_already_replied",
    );

    // Length limits are per platform.
    const long501 = "a".repeat(501);
    await assert.rejects(() => relay.replyToComment({ platform: "threads", commentId: "t2", text: long501 }), (e) => e.code === "comment_text_too_long");
    await relay.replyToComment({ platform: "instagram", commentId: "i1", text: long501, dryRun: true });
    await assert.rejects(
      () => relay.replyToComment({ platform: "instagram", commentId: "i1", text: "b".repeat(2201), dryRun: true }),
      (e) => e.code === "comment_text_too_long" && e.details.maxLength === 2200,
    );
    await assert.rejects(
      () => relay.replyToComment({ platform: "youtube", commentId: "y1", text: "c".repeat(10001), dryRun: true }),
      (e) => e.code === "comment_text_too_long",
    );
    await assert.rejects(() => relay.replyToComment({ platform: "threads", commentId: "t2", text: "   " }), (e) => e.code === "comment_text_required");
    await assert.rejects(() => relay.replyToComment({ platform: "threads", commentId: " ", text: "ok" }), (e) => e.code === "comment_id_required");
    await assert.rejects(() => relay.replyToComment({ platform: "x", commentId: "1", text: "ok" }), (e) => e.code === "comment_platform_unsupported");

    // Soft warnings for the house rules (em dash).
    const warned = await relay.replyToComment({ platform: "threads", commentId: "t2", text: "Terima kasih \u2014 sama-sama", dryRun: true });
    assert.equal(warned.warnings.length, 1);

    // A failed send frees the reservation so it can be retried.
    f.threads.failReply = new Error("network down");
    await assert.rejects(() => relay.replyToComment({ platform: "threads", commentId: "t2", text: "Sama-sama." }), /network down/);
    f.threads.failReply = null;
    const retry = await relay.replyToComment({ platform: "threads", commentId: "t2", text: "Sama-sama." });
    assert.equal(retry.ok, true);

    // Not connected.
    await relay.disconnect("youtube");
    await assert.rejects(() => relay.replyToComment({ platform: "youtube", commentId: "y1", text: "ok" }), (e) => e.code === "youtube_not_connected");
    await relay.close();
  } finally {
    await cleanupTempDir(dataDir);
  }
});
