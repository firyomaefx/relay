/**
 * Unit tests for the local Threads auto-reply feature.
 *
 * No real Threads or DeepSeek API is called: the Threads adapter is a fake,
 * the reply generator is injected (or the DeepSeek generator is given a mocked
 * fetch), and time is advanced with node:test fake timers.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAdapters, createRelay, ThreadsAdapter } from "@relay/platforms";
import { createDeepSeekReplyGenerator, stripReplyDisclaimers } from "@relay/core";
import { cleanupTempDir, makeTempDir } from "../helpers.mjs";

const START = Date.parse("2026-01-01T00:00:00.000Z");
const MINUTE = 60 * 1000;

function useFakeClock(t) {
  t.mock.timers.enable({ apis: ["Date"], now: START });
}

function advance(t, ms) {
  t.mock.timers.tick(ms);
}

class FakeThreadsAdapter extends ThreadsAdapter {
  constructor({ ownPosts = [], commentsByPost = {} } = {}) {
    super();
    this.ownPosts = ownPosts.map((post) => ({ ...post }));
    this.commentsByPost = commentsByPost;
    this.replies = [];
    this.readCalls = 0;
    this.failReadWith = null;
    this.failReplyWith = null;
  }

  async publish(ctx, input) {
    const postId = `published-${this.ownPosts.length + 1}`;
    const text = input.post.parts[0]?.text;
    this.ownPosts.unshift({ id: postId, text, timestamp: ctx.now().toISOString() });
    this.commentsByPost[postId] = this.commentsByPost[postId] ?? [];
    await ctx.onPartPublished?.({
      platform: "threads",
      part: 1,
      postId,
      url: `https://www.threads.net/@relay.demo/post/${postId}`,
    });
    return {
      platformPostId: postId,
      url: `https://www.threads.net/@relay.demo/post/${postId}`,
      mock: true,
    };
  }

  async readComments(_ctx, _input) {
    this.readCalls += 1;
    if (this.failReadWith) throw this.failReadWith;
    return {
      posts: this.ownPosts.map((post) => ({
        ...post,
        comments: (this.commentsByPost[post.id] ?? []).map((comment) => ({ ...comment })),
      })),
    };
  }

  async listOwnPosts() {
    return this.ownPosts.map((post) => ({ ...post }));
  }

  async replyToComment(_ctx, commentId, text) {
    if (this.failReplyWith) throw this.failReplyWith;
    const id = `reply-${this.replies.length + 1}`;
    this.replies.push({ commentId, text, id });
    return { id, permalink: `https://www.threads.net/@relay.demo/post/${id}`, mock: true };
  }
}

function fakeGenerator(decide) {
  const calls = [];
  return {
    calls,
    async generate(input) {
      calls.push(input);
      return decide(input);
    },
  };
}

async function makeRelay({
  dataDir,
  adapter,
  generator,
  env = {},
  logger = () => undefined,
  forceMock = true,
}) {
  const adapters = createAdapters().map((entry) => (entry.platform === "threads" ? adapter : entry));
  return createRelay({
    dataDir,
    forceMock,
    env: { THREADS_AUTOREPLY_ENABLED: "true", ...env },
    adapters,
    replyGenerator: generator,
    autoReplyPollIntervalMs: 2 * MINUTE,
    autoReplyWindowMs: 30 * MINUTE,
    logger,
  });
}

async function connectThreads(relay) {
  const result = await relay.beginConnect("threads");
  assert.equal(result.mode, "connected");
}

function comment(id, username, text) {
  return { id, username, text, timestamp: new Date(START).toISOString() };
}

test("publishing a Threads post opens a persisted 30-minute window", async (t) => {
  useFakeClock(t);
  const dataDir = await makeTempDir("relay-autoreply-trigger-");
  const adapter = new FakeThreadsAdapter();
  let relay;
  try {
    relay = await makeRelay({ dataDir, adapter, generator: fakeGenerator(() => ({ classification: "spam" })) });
    await connectThreads(relay);

    const created = await relay.createPost({ platforms: ["threads"], text: "KWSP atau ASB?" });
    assert.equal(created.results[0].ok, true);

    const log = await relay.threadsAutoReplyLog();
    assert.equal(log.windows.length, 1);
    assert.equal(log.windows[0].postId, "published-1");
    assert.equal(log.windows[0].status, "open");
    assert.equal(Date.parse(log.windows[0].expiresAt) - Date.parse(log.windows[0].publishedAt), 30 * MINUTE);

    // The window is in the relay store, not just in memory.
    relay = null;
    const reopened = await makeRelay({ dataDir, adapter, generator: fakeGenerator(() => ({ classification: "spam" })) });
    const persisted = await reopened.threadsAutoReplyLog();
    assert.equal(persisted.windows.length, 1);
    assert.equal(persisted.windows[0].postId, "published-1");
    await reopened.close();
  } finally {
    await relay?.close();
    await cleanupTempDir(dataDir);
  }
});

test("polling /me/threads discovers a new own post and opens its window", async (t) => {
  useFakeClock(t);
  const dataDir = await makeTempDir("relay-autoreply-discover-");
  const adapter = new FakeThreadsAdapter({
    ownPosts: [{ id: "post-discovered", text: "ASB vs ETF", timestamp: new Date(START).toISOString() }],
    commentsByPost: {
      "post-discovered": [comment("comment-discovered", "aina", "ETF lebih untung kan?")],
    },
  });
  const generator = fakeGenerator(() => ({
    classification: "genuine",
    reply: "ETF boleh untung, tapi ASB lebih stabil. Kena ikut toleransi risiko.",
  }));
  let relay;
  try {
    relay = await makeRelay({ dataDir, adapter, generator });
    await connectThreads(relay);

    const result = await relay.runThreadsAutoReplyTick();
    assert.equal(result.discovered, 1);
    assert.equal(result.replied, 1);

    const log = await relay.threadsAutoReplyLog();
    assert.equal(log.windows.length, 1);
    assert.equal(log.windows[0].postId, "post-discovered");
    assert.equal(log.replies.length, 1);
    assert.equal(adapter.replies[0].commentId, "comment-discovered");
  } finally {
    await relay?.close();
    await cleanupTempDir(dataDir);
  }
});

test("a genuine comment is replied to exactly once, including after restart", async (t) => {
  useFakeClock(t);
  const dataDir = await makeTempDir("relay-autoreply-once-");
  const adapter = new FakeThreadsAdapter({
    ownPosts: [{ id: "post-1", text: "KWSP, ASB dan ETF", timestamp: new Date(START).toISOString() }],
    commentsByPost: {
      "post-1": [comment("comment-1", "ali", "Saya lebih suka ASB sebab senang.")],
    },
  });
  const generator = fakeGenerator(() => ({
    classification: "genuine",
    reply: "Setuju, ASB memang mudah. Tapi KWSP pulabagus untuk jangka panjang.",
  }));
  let relay;
  let reopened;
  try {
    relay = await makeRelay({ dataDir, adapter, generator });
    await connectThreads(relay);
    await relay.openThreadsAutoReplyWindow("post-1", new Date(START).toISOString(), "KWSP, ASB dan ETF");

    const first = await relay.runThreadsAutoReplyTick();
    assert.equal(first.replied, 1);
    assert.equal(adapter.replies.length, 1);
    assert.equal(adapter.replies[0].commentId, "comment-1");
    assert.equal(generator.calls.length, 1);

    const log = await relay.threadsAutoReplyLog();
    assert.equal(log.replies.length, 1);
    assert.equal(log.replies[0].postId, "post-1");
    assert.equal(log.replies[0].commentId, "comment-1");
    assert.equal(log.replies[0].commenter, "ali");
    assert.equal(log.replies[0].replyId, "reply-1");
    assert.ok(log.replies[0].replyText.includes("ASB"));

    // Same tick again: the persisted comment id is de-duplicated.
    await relay.runThreadsAutoReplyTick();
    assert.equal(adapter.replies.length, 1);

    // Restart with the same data directory. Even after a new poll, no re-reply.
    await relay.close();
    relay = null;
    advance(t, 3 * MINUTE);
    reopened = await makeRelay({ dataDir, adapter, generator });
    const second = await reopened.runThreadsAutoReplyTick();
    assert.equal(second.replied, 0);
    assert.equal(adapter.replies.length, 1);
    assert.equal((await reopened.threadsAutoReplyLog()).replies.length, 1);
  } finally {
    await relay?.close();
    await reopened?.close();
    await cleanupTempDir(dataDir);
  }
});

test("comments from the connected account itself are skipped", async (t) => {
  useFakeClock(t);
  const dataDir = await makeTempDir("relay-autoreply-own-");
  const adapter = new FakeThreadsAdapter({
    ownPosts: [{ id: "post-own", timestamp: new Date(START).toISOString() }],
    commentsByPost: {
      "post-own": [comment("comment-own", "@relay.demo", "This is my own reply")],
    },
  });
  const generator = fakeGenerator(() => ({ classification: "genuine", reply: "should never post" }));
  let relay;
  try {
    relay = await makeRelay({ dataDir, adapter, generator });
    await connectThreads(relay);
    await relay.openThreadsAutoReplyWindow("post-own", new Date(START).toISOString());
    await relay.runThreadsAutoReplyTick();

    assert.equal(generator.calls.length, 0, "own comments must not reach the generator");
    assert.equal(adapter.replies.length, 0);
    assert.equal((await relay.threadsAutoReplyLog()).replies.length, 0);
  } finally {
    await relay?.close();
    await cleanupTempDir(dataDir);
  }
});

test("spam and hostile comments are flagged and never replied to", async (t) => {
  useFakeClock(t);
  const dataDir = await makeTempDir("relay-autoreply-flag-");
  const adapter = new FakeThreadsAdapter({
    ownPosts: [{ id: "post-flags", timestamp: new Date(START).toISOString() }],
    commentsByPost: {
      "post-flags": [
        comment("comment-spam", "promo", "Click my link for guaranteed returns!"),
        comment("comment-hostile", "troll", "You are an idiot."),
        comment("comment-real", "siti", "ASB atau Tabung Haji lebih baik?"),
      ],
    },
  });
  const generator = fakeGenerator((input) => {
    if (input.comment.id === "comment-spam") return { classification: "spam", reply: "buy now" };
    if (input.comment.id === "comment-hostile") return { classification: "hostile", reply: "no" };
    return { classification: "genuine", reply: "Dua-dua ada tempat. ASB untuk fleksibiliti, Tabung Haji untuk haji." };
  });
  let relay;
  try {
    relay = await makeRelay({ dataDir, adapter, generator });
    await connectThreads(relay);
    await relay.openThreadsAutoReplyWindow("post-flags", new Date(START).toISOString());
    const result = await relay.runThreadsAutoReplyTick();

    assert.equal(result.flagged, 2);
    assert.equal(result.replied, 1);
    assert.equal(adapter.replies.length, 1);
    assert.equal(adapter.replies[0].commentId, "comment-real");

    const log = await relay.threadsAutoReplyLog();
    assert.deepEqual(
      log.flagged.map((entry) => [entry.commentId, entry.classification]).sort(),
      [
        ["comment-hostile", "hostile"],
        ["comment-spam", "spam"],
      ],
    );
    assert.equal(log.replies.length, 1);

    // Flagged ids are persisted too: another tick never reclassifies them.
    advance(t, 3 * MINUTE);
    const before = generator.calls.length;
    await relay.runThreadsAutoReplyTick();
    assert.equal(generator.calls.length, before);
    assert.equal((await relay.threadsAutoReplyLog()).flagged.length, 2);
  } finally {
    await relay?.close();
    await cleanupTempDir(dataDir);
  }
});

test("hard stop: no reply is posted when the 30-minute window ends during generation", async (t) => {
  useFakeClock(t);
  const dataDir = await makeTempDir("relay-autoreply-hardstop-");
  const adapter = new FakeThreadsAdapter({
    ownPosts: [{ id: "post-late", timestamp: new Date(START).toISOString() }],
    commentsByPost: {
      "post-late": [comment("comment-late", "ahmad", "Macam mana nak mula dengan ETF?")],
    },
  });
  const generator = fakeGenerator(() => {
    // Simulate a slow model/network call that pushes us past the deadline.
    advance(t, 31 * MINUTE);
    return { classification: "genuine", reply: "Mula dengan ETF luas dan kos rendah." };
  });
  let relay;
  try {
    relay = await makeRelay({ dataDir, adapter, generator });
    await connectThreads(relay);
    await relay.openThreadsAutoReplyWindow("post-late", new Date(START).toISOString());
    await relay.runThreadsAutoReplyTick();

    assert.equal(adapter.replies.length, 0, "the hard stop must be checked immediately before posting");
    const log = await relay.threadsAutoReplyLog();
    assert.equal(log.replies.length, 0);
    assert.equal(log.windows[0].status, "closed");
    assert.equal(log.windows[0].closeReason, "window_expired");
  } finally {
    await relay?.close();
    await cleanupTempDir(dataDir);
  }
});

test("toggle off does nothing, and the settings flag is exposed", async (t) => {
  useFakeClock(t);
  const dataDir = await makeTempDir("relay-autoreply-off-");
  const adapter = new FakeThreadsAdapter({
    ownPosts: [{ id: "post-off", timestamp: new Date(START).toISOString() }],
    commentsByPost: { "post-off": [comment("comment-off", "mei", "KWSP cukup ke?")] },
  });
  const generator = fakeGenerator(() => ({ classification: "genuine", reply: "Tidak sepenuhnya, perlu simpanan lain." }));
  let relay;
  try {
    relay = await makeRelay({ dataDir, adapter, generator });
    await connectThreads(relay);

    assert.equal((await relay.getSettings()).threadsAutoReplyEnabled, true);
    const enabled = await relay.setThreadsAutoReplyEnabled(false);
    assert.equal(enabled, false);
    assert.equal((await relay.getSettings()).threadsAutoReplyEnabled, false);

    const opened = await relay.openThreadsAutoReplyWindow("post-off", new Date(START).toISOString());
    assert.equal(opened, false);
    const result = await relay.runThreadsAutoReplyTick();
    assert.equal(result.replied, 0);
    assert.equal(generator.calls.length, 0);
    assert.equal(adapter.replies.length, 0);
    assert.equal((await relay.threadsAutoReplyLog()).windows.length, 0);
  } finally {
    await relay?.close();
    await cleanupTempDir(dataDir);
  }
});

test("env toggle THREADS_AUTOREPLY_ENABLED=false disables the feature", async (t) => {
  useFakeClock(t);
  const dataDir = await makeTempDir("relay-autoreply-env-off-");
  const adapter = new FakeThreadsAdapter({
    ownPosts: [{ id: "post-env-off", timestamp: new Date(START).toISOString() }],
    commentsByPost: { "post-env-off": [comment("comment-env-off", "lina", "ASB atau ETF?")] },
  });
  const generator = fakeGenerator(() => ({ classification: "genuine", reply: "Both can fit different goals." }));
  let relay;
  try {
    relay = await makeRelay({
      dataDir,
      adapter,
      generator,
      env: { THREADS_AUTOREPLY_ENABLED: "false" },
    });
    await connectThreads(relay);
    const opened = await relay.openThreadsAutoReplyWindow("post-env-off", new Date(START).toISOString());
    assert.equal(opened, false);
    await relay.runThreadsAutoReplyTick();
    assert.equal(adapter.replies.length, 0);
    assert.equal(generator.calls.length, 0);
  } finally {
    await relay?.close();
    await cleanupTempDir(dataDir);
  }
});

test("a missing DEEPSEEK_API_KEY logs and skips without posting a fallback", async (t) => {
  useFakeClock(t);
  const dataDir = await makeTempDir("relay-autoreply-nokey-");
  const adapter = new FakeThreadsAdapter({
    ownPosts: [{ id: "post-nokey", timestamp: new Date(START).toISOString() }],
    commentsByPost: { "post-nokey": [comment("comment-nokey", "raj", "Apa pendapat pasal Tabung Haji?")] },
  });
  const logs = [];
  let fetchCalls = 0;
  const generator = createDeepSeekReplyGenerator({
    env: {},
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("fetch must not be called without a key");
    },
    logger: (message) => logs.push(message),
  });
  let relay;
  try {
    relay = await makeRelay({ dataDir, adapter, generator, logger: (message) => logs.push(message) });
    await connectThreads(relay);
    await relay.openThreadsAutoReplyWindow("post-nokey", new Date(START).toISOString());
    const result = await relay.runThreadsAutoReplyTick();

    assert.equal(result.replied, 0);
    assert.equal(adapter.replies.length, 0);
    assert.equal(fetchCalls, 0);
    assert.equal((await relay.threadsAutoReplyLog()).replies.length, 0);
    assert.ok(
      logs.some((line) => /DEEPSEEK_API_KEY is missing/.test(line)),
      `expected a missing-key log, got: ${logs.join("\n")}`,
    );
  } finally {
    await relay?.close();
    await cleanupTempDir(dataDir);
  }
});

test("disclaimers are stripped from generated replies before posting", async (t) => {
  useFakeClock(t);
  const dataDir = await makeTempDir("relay-autoreply-disclaimer-");
  const adapter = new FakeThreadsAdapter({
    ownPosts: [{ id: "post-disclaimer", timestamp: new Date(START).toISOString() }],
    commentsByPost: {
      "post-disclaimer": [comment("comment-disclaimer", "faiz", "ETF lagi bagus daripada ASB.")],
    },
  });
  const generator = fakeGenerator(() => ({
    classification: "genuine",
    reply:
      "Setuju, ETF memang patut ada. Tapi ASB masih berguna untuk kestabilan. Bukan nasihat kewangan, ini pandangan peribadi.",
  }));
  let relay;
  try {
    relay = await makeRelay({ dataDir, adapter, generator });
    await connectThreads(relay);
    await relay.openThreadsAutoReplyWindow("post-disclaimer", new Date(START).toISOString());
    await relay.runThreadsAutoReplyTick();

    assert.equal(adapter.replies.length, 1);
    assert.doesNotMatch(adapter.replies[0].text, /bukan nasihat kewangan|pandangan peribadi/i);
    const log = await relay.threadsAutoReplyLog();
    assert.doesNotMatch(log.replies[0].replyText, /bukan nasihat kewangan/i);
    assert.match(log.replies[0].replyText, /ETF memang patut ada/);
  } finally {
    await relay?.close();
    await cleanupTempDir(dataDir);
  }
});

test("missing Threads read/manage scope logs and stops the window", async (t) => {
  useFakeClock(t);
  const dataDir = await makeTempDir("relay-autoreply-scope-");
  const { RelayError } = await import("@relay/core");
  const adapter = new FakeThreadsAdapter({
    ownPosts: [{ id: "post-scope", timestamp: new Date(START).toISOString() }],
  });
  adapter.failReadWith = new RelayError("missing threads_read_replies", "threads_scope_missing", undefined, 403);
  const logs = [];
  const generator = fakeGenerator(() => ({ classification: "genuine", reply: "no" }));
  let relay;
  try {
    relay = await makeRelay({ dataDir, adapter, generator, logger: (message) => logs.push(message) });
    await connectThreads(relay);
    await relay.openThreadsAutoReplyWindow("post-scope", new Date(START).toISOString());
    await relay.runThreadsAutoReplyTick();

    const log = await relay.threadsAutoReplyLog();
    assert.equal(log.windows[0].status, "stopped");
    assert.equal(log.windows[0].closeReason, "threads_scope_missing");
    assert.equal(adapter.replies.length, 0);
    assert.ok(logs.some((line) => /scope is missing/.test(line)), logs.join("\n"));
  } finally {
    await relay?.close();
    await cleanupTempDir(dataDir);
  }
});

test("DeepSeek generator uses the OpenAI-compatible endpoint and mocked fetch", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                classification: "genuine",
                reply: "Setuju, KWSP penting. Tapi jangan lupa ASB. Bukan nasihat kewangan.",
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const generator = createDeepSeekReplyGenerator({
    env: { DEEPSEEK_API_KEY: "test-key" },
    fetchImpl,
  });
  const result = await generator.generate({
    post: { id: "post-1", text: "KWSP atau ASB?" },
    comment: { id: "comment-1", username: "ali", text: "Saya pilih ASB." },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.deepseek.com/chat/completions");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers.Authorization, "Bearer test-key");
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.model, "deepseek-chat");
  assert.match(body.messages[0].content, /bukan nasihat kewangan/i);
  assert.equal(result.classification, "genuine");
  assert.doesNotMatch(result.reply, /bukan nasihat kewangan/i);
});

test("stripReplyDisclaimers removes Malay and English advice warnings", () => {
  assert.equal(stripReplyDisclaimers("Setuju. Bukan nasihat kewangan."), "Setuju.");
  assert.equal(stripReplyDisclaimers("Good point. This is not financial advice."), "Good point.");
  assert.equal(stripReplyDisclaimers("Bukan nasihat kewangan."), "");
});
