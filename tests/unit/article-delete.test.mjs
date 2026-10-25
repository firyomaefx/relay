/**
 * X Articles + relay_delete tests. Everything is mocked: adapters get a fake
 * fetch, the service runs in forced mock mode with a fetch that throws. No real
 * API is ever called and nothing is posted, deleted or pinned anywhere.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { AuthError, RelayError, SecretBox, parseArticleMarkdown, validateArticleDraft } from "@relay/core";
import { ThreadsAdapter, XAdapter, createAdapters, createRelay } from "@relay/platforms";
import { cleanupTempDir, isoIn, makeTempDir, writeTinyPng } from "../helpers.mjs";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const account = (platform, extra = {}) => ({
  id: `${platform}:1`, platform, handle: "@tengkolok_test", mode: "live", connectedAt: "2026-01-01T00:00:00.000Z", ...extra,
});

function ctxWith(fetchImpl, env = {}) {
  const calls = [];
  return {
    calls,
    ctx: {
      dataDir: process.cwd(), env, logger: () => {},
      fetch: async (url, init = {}) => {
        const call = { url: String(url), method: (init.method ?? "GET").toUpperCase(), init };
        calls.push(call);
        return fetchImpl(call);
      },
      readMedia: async () => ({ buffer: Buffer.from("png-bytes"), mimeType: "image/png", filename: "cover.png" }),
      mediaPublicUrl: () => null,
      credentials: () => ({ clientId: "c", clientSecret: "s" }),
      now: () => new Date(), forceMock: false, publicMediaBaseUrl: null,
    },
  };
}

const article = (extra = {}) => ({
  title: "Why I track ETFs",
  blocks: [
    { type: "header-two", text: "The setup" },
    { type: "unstyled", text: "First paragraph." },
    { type: "blockquote", text: "A quote." },
  ],
  ...extra,
});

// ---------------------------------------------------------------- validation

test("body sections and markdown both become the same blocks", async () => {
  const sections = await validateArticleDraft({
    title: "  T  ",
    body: [{ heading: "Intro", paragraphs: ["One.", "Two."] }, { paragraphs: ["Three."] }],
  });
  assert.equal(sections.ok, true, JSON.stringify(sections.issues));
  assert.equal(sections.normalized.title, "T");
  assert.deepEqual(sections.normalized.blocks.map((b) => b.type), ["header-two", "unstyled", "unstyled", "unstyled"]);
  assert.deepEqual(sections.stats, { blocks: 4, chars: 19, words: 4 });

  const md = parseArticleMarkdown("# Big\n\nLine one\nline two\n\n## Small\n> quote\n- a\n- b\n1. x\n2) y");
  assert.deepEqual(md.map((b) => [b.type, b.text]), [
    ["header-one", "Big"], ["unstyled", "Line one line two"], ["header-two", "Small"], ["blockquote", "quote"],
    ["unordered-list-item", "a"], ["unordered-list-item", "b"], ["ordered-list-item", "x"], ["ordered-list-item", "y"],
  ]);
});

test("validation reports clear issues and writes nothing", async () => {
  const codes = async (draft) => (await validateArticleDraft(draft)).issues.map((i) => i.code);
  assert.deepEqual(await codes({ title: "", body: [{ paragraphs: ["x"] }] }), ["article_title_required"]);
  assert.deepEqual(await codes({ title: "x".repeat(101), body: [{ paragraphs: ["x"] }] }), ["article_title_too_long"]);
  assert.deepEqual(await codes({ title: "t" }), ["article_body_required"]);
  assert.ok((await codes({ title: "t", body: [{ paragraphs: ["x"] }], bodyMarkdown: "y" })).includes("article_body_ambiguous"));
  assert.ok((await codes({ title: "t", body: [{ heading: "h", paragraphs: [] }] })).includes("article_no_paragraph"));
  assert.ok((await codes({ title: "t", body: [{ paragraphs: ["  "] }] })).includes("article_paragraph_empty"));
  assert.ok((await codes({ title: "t", body: [{ paragraphs: ["x"] }], scheduleAt: "tomorrow-ish" })).includes("schedule_invalid"));
  assert.ok((await codes({ title: "t", body: [{ paragraphs: ["x"] }], cover: { kind: "image", url: "https://x.test/a.png" } })).includes("article_cover_path_required"));
  assert.ok((await codes({ title: "t", body: [{ paragraphs: ["x"] }], cover: { kind: "image", path: "/nope/missing.png" } })).includes("article_cover_unreadable"));
  assert.ok((await codes({ title: "t", body: [{ paragraphs: ["x"] }], cover: { kind: "image", path: path.resolve("package.json") } })).includes("article_cover_type_unknown"));
});

// ------------------------------------------------------------- X adapter

test("X publishArticle: uploads cover, creates the draft, publishes it, in that order", async () => {
  const { ctx, calls } = ctxWith((call) => {
    if (call.url.endsWith("/2/media/upload")) return json({ data: { id: "m1" } });
    if (call.url.endsWith("/2/articles/draft")) return json({ data: { id: "900", title: "Why I track ETFs" } }, 201);
    if (call.url.endsWith("/2/articles/900/publish")) return json({ data: { post_id: "555" } });
    throw new Error(`unexpected ${call.method} ${call.url}`);
  });
  const result = await new XAdapter().publishArticle(ctx, {
    account: account("x"), tokens: { accessToken: "tok" },
    article: article({ cover: { kind: "image", path: "/tmp/cover.png" } }),
  });
  assert.deepEqual(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`), [
    "POST /2/media/upload", "POST /2/articles/draft", "POST /2/articles/900/publish",
  ]);
  for (const c of calls) assert.equal(c.init.headers.Authorization, "Bearer tok");
  const draftBody = JSON.parse(calls[1].init.body);
  assert.equal(draftBody.title, "Why I track ETFs");
  assert.deepEqual(draftBody.cover_media, { media_category: "tweet_image", media_id: "m1" });
  assert.deepEqual(draftBody.content_state.entities, []);
  assert.deepEqual(draftBody.content_state.blocks.map((b) => [b.type, b.text]), [
    ["header-two", "The setup"], ["unstyled", "First paragraph."], ["blockquote", "A quote."],
  ]);
  assert.equal(result.platformPostId, "555");
  assert.equal(result.url, "https://x.com/tengkolok_test/status/555");
  assert.equal(result.mock, false);
  assert.equal(result.details.articleDraftId, "900");
});

test("X publishArticle without a cover skips media upload", async () => {
  const { ctx, calls } = ctxWith((call) =>
    call.url.endsWith("/draft") ? json({ data: { id: "1" } }, 201) : json({ data: { post_id: "2" } }));
  await new XAdapter().publishArticle(ctx, { account: account("x"), tokens: { accessToken: "t" }, article: article() });
  assert.equal(calls.length, 2);
  assert.equal("cover_media" in JSON.parse(calls[0].init.body), false);
});

test("X publishArticle: a failed publish keeps the draft id in the error", async () => {
  const { ctx } = ctxWith((call) =>
    call.url.endsWith("/draft") ? json({ data: { id: "900" } }, 201)
      : json({ title: "Forbidden", detail: "Articles need Premium", type: "about:blank" }, 403));
  await assert.rejects(
    new XAdapter().publishArticle(ctx, { account: account("x"), tokens: { accessToken: "t" }, article: article() }),
    (error) => {
      assert.ok(error instanceof RelayError);
      assert.equal(error.code, "x_article_publish_failed");
      assert.equal(error.details.articleDraftId, "900");
      assert.match(error.message, /draft 900/);
      return true;
    },
  );
});

test("X publishArticle: a 401 on the draft call is an AuthError (safe to retry after refresh)", async () => {
  const { ctx, calls } = ctxWith(() => json({ title: "Unauthorized", detail: "expired" }, 401));
  await assert.rejects(
    new XAdapter().publishArticle(ctx, { account: account("x"), tokens: { accessToken: "t" }, article: article() }),
    (error) => error instanceof AuthError,
  );
  assert.equal(calls.length, 1);
});

test("X publishArticle is simulated without live credentials", async () => {
  const { ctx, calls } = ctxWith(() => { throw new Error("no network in mock mode"); });
  ctx.forceMock = true;
  const result = await new XAdapter().publishArticle(ctx, { account: account("x"), tokens: null, article: article() });
  assert.equal(result.mock, true);
  assert.match(result.platformPostId, /^mock_x_article_/);
  assert.equal(calls.length, 0);
});

test("X deletePost: DELETE /2/tweets/{id}, 404 means already gone, bad ids never hit the network", async () => {
  const ok = ctxWith(() => json({ data: { deleted: true } }));
  const done = await new XAdapter().deletePost(ok.ctx, "123", { account: account("x"), tokens: { accessToken: "tok" } });
  assert.deepEqual(done, { deleted: true, mock: false });
  assert.equal(ok.calls[0].method, "DELETE");
  assert.equal(ok.calls[0].url, "https://api.x.com/2/tweets/123");
  assert.equal(ok.calls[0].init.headers.Authorization, "Bearer tok");

  const gone = ctxWith(() => json({ title: "Not Found", detail: "Could not find tweet" }, 404));
  assert.equal((await new XAdapter().deletePost(gone.ctx, "123", { account: account("x"), tokens: { accessToken: "t" } })).alreadyGone, true);

  const unconfirmed = ctxWith(() => json({ data: { deleted: false } }));
  await assert.rejects(new XAdapter().deletePost(unconfirmed.ctx, "123", { account: account("x"), tokens: { accessToken: "t" } }), /confirm/);

  const forbidden = ctxWith(() => json({ title: "Forbidden", detail: "not yours" }, 403));
  await assert.rejects(new XAdapter().deletePost(forbidden.ctx, "123", { account: account("x"), tokens: { accessToken: "t" } }), /not yours/);

  const bad = ctxWith(() => json({}));
  await assert.rejects(new XAdapter().deletePost(bad.ctx, "abc", { account: account("x"), tokens: { accessToken: "t" } }), /numbers/);
  assert.equal(bad.calls.length, 0);
});

// ---------------------------------------------------------- Threads adapter

test("Threads deletePost: needs threads_delete, then DELETE /{id}", async () => {
  const noScope = ctxWith(() => json({ success: true }));
  await assert.rejects(
    new ThreadsAdapter().deletePost(noScope.ctx, "1789", {
      account: account("threads", { scopes: ["threads_basic"] }), tokens: { accessToken: "t", scope: "threads_basic" },
    }),
    (error) => error.code === "threads_scope_missing" && error.statusCode === 403,
  );
  assert.equal(noScope.calls.length, 0, "no provider call without the scope");

  const ok = ctxWith(() => json({ success: true, deleted_id: "1789" }));
  const result = await new ThreadsAdapter().deletePost(ok.ctx, "1789", {
    account: account("threads", { scopes: ["threads_basic", "threads_delete"] }), tokens: { accessToken: "tok" },
  });
  assert.deepEqual(result, { deleted: true, mock: false });
  assert.equal(ok.calls[0].method, "DELETE");
  assert.equal(ok.calls[0].url, "https://graph.threads.net/v1.0/1789");

  const notOk = ctxWith(() => json({ success: false }));
  await assert.rejects(
    new ThreadsAdapter().deletePost(notOk.ctx, "1789", { account: account("threads", { scopes: ["threads_delete"] }), tokens: { accessToken: "t" } }),
    /confirm/,
  );
  await assert.rejects(
    new ThreadsAdapter().deletePost(notOk.ctx, "container-1", { account: account("threads", { scopes: ["threads_delete"] }), tokens: { accessToken: "t" } }),
    /numbers/,
  );
});

test("Threads sign-in asks for threads_delete only when THREADS_REQUEST_DELETE_SCOPE=1", async () => {
  const run = async (env) => {
    const { ctx } = ctxWith(() => json({}), env);
    const result = await new ThreadsAdapter().authorize(ctx, { state: "s", codeVerifier: "v", redirectUri: "https://x.test/cb" });
    return new URL(result.url).searchParams.get("scope");
  };
  assert.equal((await run({})).includes("threads_delete"), false);
  assert.equal((await run({ THREADS_REQUEST_DELETE_SCOPE: "1" })).includes("threads_delete"), true);
});

// ------------------------------------------------------------ service level

function mockRelay(dataDir, extra = {}) {
  return createRelay({
    dataDir, forceMock: true, env: {}, logger: () => {},
    fetchImpl: async () => { throw new Error("network must not be used in these tests"); },
    ...extra,
  });
}

test("service: article publishes now, shows in history, and the duplicate guard works", async () => {
  const dataDir = await makeTempDir("relay-article-now-");
  let relay;
  try {
    relay = await mockRelay(dataDir);
    const missing = await relay.createArticle({ title: "T", body: [{ paragraphs: ["x"] }] });
    assert.equal(missing.report.ok, false);
    assert.equal(missing.report.issues[0].code, "x_not_connected");

    await relay.beginConnect("x");
    const draft = { title: "Why I track ETFs", bodyMarkdown: "## Setup\n\nFirst paragraph." };
    const bad = await relay.createArticle({ title: "", bodyMarkdown: "x" });
    assert.equal(bad.report.ok, false);
    assert.equal(bad.results.length, 0);

    const made = await relay.createArticle(draft);
    assert.equal(made.scheduled, false);
    assert.equal(made.results[0].ok, true);
    assert.equal(made.results[0].mode, "mock");
    assert.equal(made.results[0].details.kind, "article");

    const [record] = await relay.history(5);
    assert.equal(record.kind, "article");
    assert.equal(record.article.title, "Why I track ETFs");
    assert.equal(record.draft.text, "[X Article] Why I track ETFs");
    assert.equal(record.results[0].publishedParts.length, 1);

    await assert.rejects(relay.createArticle(draft), (e) => e.code === "duplicate_recent_post");
    const again = await relay.createArticle(draft, { force: true });
    assert.equal(again.results[0].ok, true);
  } finally {
    await relay?.close();
    await cleanupTempDir(dataDir);
  }
});

test("service: scheduled article is queued, listed, guarded against duplicates, removable, and runs once when due", async () => {
  const dataDir = await makeTempDir("relay-article-queue-");
  let relay;
  let clock = Date.now();
  try {
    relay = await mockRelay(dataDir, { now: () => new Date(clock) });
    await relay.beginConnect("x");
    const cover = await writeTinyPng(path.join(dataDir, "cover.png"));
    const draft = (title) => ({
      title, body: [{ heading: "H", paragraphs: ["P."] }], cover: { kind: "image", path: cover },
      scheduleAt: new Date(clock + 60_000).toISOString(),
    });

    const queued = await relay.createArticle(draft("Queued one"));
    assert.equal(queued.scheduled, true);
    assert.ok(queued.jobId);
    const jobs = await relay.listQueue();
    assert.equal(jobs[0].kind, "article");
    assert.equal(jobs[0].status, "pending");
    assert.equal(jobs[0].draft.text, "[X Article] Queued one");

    await assert.rejects(relay.createArticle(draft("Queued one")), (e) => e.code === "duplicate_queued_article");

    // remove a pending one: gone, nothing published
    const second = await relay.createArticle(draft("Removed one"));
    const removed = await relay.removeQueueJob(second.jobId);
    assert.equal(removed.removed, true);
    assert.equal((await relay.listQueue()).some((j) => j.id === second.jobId), false);
    assert.equal((await relay.removeQueueJob("job_missing")).found, false);

    // not due yet
    assert.equal(await relay.runDueJobs(), 0);
    clock += 120_000;
    assert.equal(await relay.runDueJobs(), 1);
    assert.equal(await relay.runDueJobs(), 0);
    const job = (await relay.listQueue()).find((j) => j.id === queued.jobId);
    assert.equal(job.status, "done");
    assert.equal(job.results[0].ok, true);
    const history = await relay.history(10);
    assert.equal(history.length, 1);
    assert.equal(history[0].kind, "article");
    assert.equal(history[0].scheduledFor, job.scheduleAt);

    // a done job can no longer be removed from the queue
    const refused = await relay.removeQueueJob(queued.jobId);
    assert.deepEqual([refused.found, refused.removed, refused.status], [true, false, "done"]);
  } finally {
    await relay?.close();
    await cleanupTempDir(dataDir);
  }
});

test("service: deletePublishedPost marks history; unsupported platforms say why; record plan lists every part", async () => {
  const dataDir = await makeTempDir("relay-delete-");
  let relay;
  try {
    relay = await mockRelay(dataDir);
    await relay.beginConnect("x");
    await relay.beginConnect("tiktok");
    const made = await relay.createPost({ platforms: ["x"], thread: [{ text: "one" }, { text: "two" }] });
    assert.equal(made.results[0].ok, true);
    const [record] = await relay.history(5);

    const plan = await relay.recordDeleteTargets(record.id);
    assert.equal(plan.found, true);
    assert.equal(plan.targets.length, record.results[0].publishedParts?.length || 1);

    const first = plan.targets[0];
    const outcome = await relay.deletePublishedPost(first.platform, first.postId);
    assert.equal(outcome.status, "deleted");
    assert.equal(outcome.mock, true);
    const after = (await relay.history(5))[0];
    assert.equal(after.results[0].deletions[0].postId, first.postId);
    const plan2 = await relay.recordDeleteTargets(record.id);
    assert.equal(plan2.targets.length, plan.targets.length - 1, "deleted parts leave the plan");

    for (const platform of ["tiktok", "instagram", "youtube"]) {
      const res = await relay.deletePublishedPost(platform, "123");
      assert.equal(res.status, "unsupported", platform);
      assert.match(res.error, /^Unsupported/);
    }
    assert.equal((await relay.deletePublishedPost("threads", "123")).status, "failed", "no Threads account connected");
    assert.equal((await relay.recordDeleteTargets("post_missing")).found, false);
  } finally {
    await relay?.close();
    await cleanupTempDir(dataDir);
  }
});

test("service: a delete retries once after a token refresh", async () => {
  // Stub X adapter, forced mock mode, no network.
  const dataDir = await makeTempDir("relay-delete-refresh-");
  const open = [];
  try {
    let deletes = 0;
    const x = new XAdapter();
    x.deletePost = async (_ctx, _postId, input) => {
      deletes += 1;
      if (input.tokens?.accessToken === "old") throw new AuthError("expired");
      return { deleted: true, mock: false };
    };
    x.refresh = async () => ({ accessToken: "new", refreshToken: "r" });
    const adapters = createAdapters().map((a) => (a.platform === "x" ? x : a));
    const options = { dataDir, forceMock: true, env: {}, logger: () => {}, adapters };

    const first = await createRelay(options);
    await first.beginConnect("x");
    await first.close();
    // Give the stored account real-looking tokens so the refresh path runs.
    const box = await SecretBox.open(dataDir);
    const dbPath = path.join(dataDir, "db.json");
    const db = JSON.parse(await readFile(dbPath, "utf8"));
    db.accounts.x.secret = box.encrypt({ accessToken: "old", refreshToken: "r" });
    await writeFile(dbPath, JSON.stringify(db));

    const relay = await createRelay(options);
    open.push(relay);
    const outcome = await relay.deletePublishedPost("x", "42");
    assert.equal(outcome.status, "deleted");
    assert.equal(deletes, 2);
  } finally {
    await Promise.all(open.map((r) => r.close()));
    await cleanupTempDir(dataDir);
  }
});

// ------------------------------------------------------- inline body images

function pngWithSize(width, height) {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

async function imageDir(prefix) {
  const dir = await makeTempDir(prefix);
  const a = path.join(dir, "a.png");
  const b = path.join(dir, "b.png");
  await writeFile(a, pngWithSize(1600, 900));
  await writeTinyPng(b);
  return { dir, a, b };
}

test("markdown images: three forms, URLs and Windows paths become atomic image blocks", () => {
  const blocks = parseArticleMarkdown(
    [
      "Before the picture.",
      "![Flow chart](C:\\Users\\User\\pics\\flow.png)",
      "![](<D:\\my pics\\two words.jpg> \"A caption\")",
      "![remote](https://example.com/a.png)",
      "After the picture.",
    ].join("\n"),
  );
  assert.deepEqual(blocks.map((b) => b.type), ["unstyled", "atomic", "atomic", "atomic", "unstyled"]);
  assert.equal(blocks[0].text, "Before the picture.");
  assert.deepEqual(blocks[1].image, { kind: "image", path: "C:\\Users\\User\\pics\\flow.png", altText: "Flow chart" });
  assert.deepEqual(blocks[2].image, { kind: "image", path: "D:\\my pics\\two words.jpg", caption: "A caption" });
  assert.deepEqual(blocks[3].image, { kind: "image", url: "https://example.com/a.png", altText: "remote" });
  assert.equal(blocks[4].text, "After the picture.");
});

test("validation: an image item sits between paragraphs, stats list each file, text counts ignore images", async () => {
  const { dir, a } = await imageDir("relay-article-img-ok-");
  try {
    const report = await validateArticleDraft({
      title: "T",
      body: [{ paragraphs: ["One.", "Two."] }, { image: { path: a, altText: "alt", caption: "cap" } }, { paragraphs: ["Three."] }],
    });
    assert.equal(report.ok, true, JSON.stringify(report.issues));
    assert.deepEqual(report.normalized.blocks.map((b) => b.type), ["unstyled", "unstyled", "atomic", "unstyled"]);
    assert.deepEqual(report.normalized.blocks[2].image, { kind: "image", path: a, altText: "alt", caption: "cap" });
    assert.equal(report.stats.blocks, 4);
    assert.equal(report.stats.chars, 14);
    assert.equal(report.stats.words, 3);
    assert.equal(report.stats.images, 1);
    assert.deepEqual(report.stats.imageFiles, [{ path: a, mimeType: "image/png", bytes: 33, width: 1600, height: 900 }]);

    const md = await validateArticleDraft({ title: "T", bodyMarkdown: `One.\n\n![alt](${a})\n\nTwo.` });
    assert.equal(md.ok, true, JSON.stringify(md.issues));
    assert.deepEqual(md.normalized.blocks.map((b) => b.type), ["unstyled", "atomic", "unstyled"]);

    // a section may also carry heading + paragraphs + image together
    const mixed = await validateArticleDraft({ title: "T", body: [{ heading: "H", paragraphs: ["P."], image: { path: a } }] });
    assert.deepEqual(mixed.normalized.blocks.map((b) => b.type), ["header-two", "unstyled", "atomic"]);

    // no images: stats keep the old shape
    const plain = await validateArticleDraft({ title: "T", body: [{ paragraphs: ["x"] }] });
    assert.deepEqual(plain.stats, { blocks: 1, chars: 1, words: 1 });
  } finally {
    await cleanupTempDir(dir);
  }
});

test("validation: bad inline images get clear codes and the image number", async () => {
  const { dir, a } = await imageDir("relay-article-img-bad-");
  try {
    const run = async (image) => validateArticleDraft({ title: "T", body: [{ paragraphs: ["x"] }, { image }] });
    const codes = async (image) => (await run(image)).issues.map((i) => i.code);

    assert.deepEqual(await codes({ url: "https://x.test/a.png" }), ["article_image_path_required"]);
    assert.deepEqual(await codes({ path: path.join(dir, "missing.png") }), ["article_image_unreadable"]);
    const gif = path.join(dir, "g.gif");
    await writeFile(gif, Buffer.from("GIF89a"));
    assert.deepEqual(await codes({ path: gif }), ["article_image_type_unsupported"]);
    assert.deepEqual(await codes({ path: path.resolve("package.json") }), ["article_image_type_unknown"]);
    const empty = path.join(dir, "empty.png");
    await writeFile(empty, Buffer.alloc(0));
    assert.deepEqual(await codes({ path: empty }), ["article_image_empty"]);
    const big = path.join(dir, "big.jpg");
    await writeFile(big, Buffer.alloc(5 * 1024 * 1024 + 1));
    const tooBig = await run({ path: big });
    assert.deepEqual(tooBig.issues.map((i) => i.code), ["article_image_too_large"]);
    assert.match(tooBig.issues[0].message, /Inline image 1/);
    assert.equal(tooBig.ok, false);
    assert.equal(tooBig.normalized, undefined);

    const eleven = await validateArticleDraft({
      title: "T", body: [{ paragraphs: ["x"] }, ...Array.from({ length: 11 }, () => ({ image: { path: a } }))],
    });
    assert.deepEqual(eleven.issues.map((i) => i.code), ["article_too_many_images"]);
    const ten = await validateArticleDraft({
      title: "T", body: [{ paragraphs: ["x"] }, ...Array.from({ length: 10 }, () => ({ image: { path: a } }))],
    });
    assert.equal(ten.ok, true);

    const onlyImage = await validateArticleDraft({ title: "T", body: [{ image: { path: a } }] });
    assert.ok(onlyImage.issues.some((i) => i.code === "article_no_paragraph"));
    const emptySection = await validateArticleDraft({ title: "T", body: [{}] });
    assert.ok(emptySection.issues.some((i) => i.code === "article_section_empty"));

    // second image bad: the message points at image 2
    const second = await validateArticleDraft({
      title: "T", body: [{ paragraphs: ["x"] }, { image: { path: a } }, { image: { path: path.join(dir, "nope.png") } }],
    });
    assert.match(second.issues[0].message, /Inline image 2/);
  } finally {
    await cleanupTempDir(dir);
  }
});

test("X publishArticle: cover + inline images upload first, then one draft with atomic image blocks", async () => {
  let uploads = 0;
  const { ctx, calls } = ctxWith((call) => {
    if (call.url.endsWith("/2/media/upload")) {
      uploads += 1;
      return json({ data: { id: `m${uploads}` } });
    }
    if (call.url.endsWith("/2/articles/draft")) return json({ data: { id: "900" } }, 201);
    if (call.url.endsWith("/2/articles/900/publish")) return json({ data: { post_id: "555" } });
    throw new Error(`unexpected ${call.method} ${call.url}`);
  });
  ctx.readMedia = async (item) => ({ buffer: Buffer.from("png-bytes"), mimeType: "image/png", filename: path.basename(item.path) });
  const img = (p, extra = {}) => ({ type: "atomic", text: " ", image: { kind: "image", path: p, ...extra } });
  const result = await new XAdapter().publishArticle(ctx, {
    account: account("x"), tokens: { accessToken: "tok" },
    article: {
      title: "T",
      cover: { kind: "image", path: "/pics/cover.png" },
      blocks: [
        { type: "unstyled", text: "One." },
        img("/pics/flow.png", { caption: "The flow", altText: "ignored by X" }),
        { type: "unstyled", text: "Two." },
        img("/pics/flow.png"),
        img("/pics/other.png"),
      ],
    },
  });
  assert.deepEqual(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`), [
    "POST /2/media/upload", "POST /2/media/upload", "POST /2/media/upload",
    "POST /2/articles/draft", "POST /2/articles/900/publish",
  ]);
  const draft = JSON.parse(calls[3].init.body);
  assert.deepEqual(draft.cover_media, { media_category: "tweet_image", media_id: "m1" });
  assert.deepEqual(draft.content_state.entities, [
    { key: "0", value: { type: "image", mutability: "immutable", data: { media_items: [{ media_category: "tweet_image", media_id: "m2" }], caption: "The flow" } } },
    { key: "1", value: { type: "image", mutability: "immutable", data: { media_items: [{ media_category: "tweet_image", media_id: "m2" }] } } },
    { key: "2", value: { type: "image", mutability: "immutable", data: { media_items: [{ media_category: "tweet_image", media_id: "m3" }] } } },
  ]);
  assert.deepEqual(draft.content_state.blocks, [
    { key: "b0", text: "One.", type: "unstyled" },
    { key: "b1", text: " ", type: "atomic", entity_ranges: [{ key: 0, offset: 0, length: 1 }], inline_style_ranges: [] },
    { key: "b2", text: "Two.", type: "unstyled" },
    { key: "b3", text: " ", type: "atomic", entity_ranges: [{ key: 1, offset: 0, length: 1 }], inline_style_ranges: [] },
    { key: "b4", text: " ", type: "atomic", entity_ranges: [{ key: 2, offset: 0, length: 1 }], inline_style_ranges: [] },
  ]);
  assert.equal(result.platformPostId, "555");
  assert.deepEqual(result.details.inlineMediaIds, ["m2", "m2", "m3"]);
});

test("X publishArticle: a failed inline upload names the image, creates no draft and publishes nothing", async () => {
  let uploads = 0;
  const { ctx, calls } = ctxWith((call) => {
    if (call.url.endsWith("/2/media/upload")) {
      uploads += 1;
      return uploads === 1 ? json({ data: { id: "m1" } }) : json({ title: "Server Error", detail: "boom" }, 500);
    }
    throw new Error(`must not reach ${call.url}`);
  });
  const img = (p) => ({ type: "atomic", text: " ", image: { kind: "image", path: p } });
  await assert.rejects(
    new XAdapter().publishArticle(ctx, {
      account: account("x"), tokens: { accessToken: "t" },
      article: { title: "T", blocks: [{ type: "unstyled", text: "x" }, img("/p/one.png"), img("/p/two.png")] },
    }),
    (error) => {
      assert.ok(error instanceof RelayError);
      assert.match(error.message, /Inline image 2 upload \(\/p\/two\.png\) failed/);
      assert.match(error.message, /boom/);
      return true;
    },
  );
  assert.equal(calls.some((c) => c.url.includes("/articles/")), false);

  // an unreadable file also names the step
  const unreadable = ctxWith(() => json({}));
  unreadable.ctx.readMedia = async () => { throw new Error("ENOENT nope"); };
  await assert.rejects(
    new XAdapter().publishArticle(unreadable.ctx, {
      account: account("x"), tokens: { accessToken: "t" },
      article: { title: "T", blocks: [{ type: "unstyled", text: "x" }, img("/p/gone.png")] },
    }),
    /Inline image 1 upload \(\/p\/gone\.png\) failed: ENOENT nope/,
  );
  assert.equal(unreadable.calls.length, 0);
});

test("X publishArticle: a 401 while uploading an inline image stays an AuthError (retry-safe, no draft yet)", async () => {
  const { ctx, calls } = ctxWith(() => json({ title: "Unauthorized", detail: "expired" }, 401));
  await assert.rejects(
    new XAdapter().publishArticle(ctx, {
      account: account("x"), tokens: { accessToken: "t" },
      article: { title: "T", blocks: [{ type: "unstyled", text: "x" }, { type: "atomic", text: " ", image: { kind: "image", path: "/p/a.png" } }] },
    }),
    (error) => error instanceof AuthError,
  );
  assert.equal(calls.length, 1);
});

test("service: article with inline images validates, queues and publishes in mock mode; bad image blocks it", async () => {
  const { dir, a, b } = await imageDir("relay-article-img-svc-");
  let relay;
  try {
    relay = await mockRelay(dir);
    await relay.beginConnect("x");
    const body = [{ paragraphs: ["One."] }, { image: { path: a } }, { paragraphs: ["Two."] }, { image: { path: b, caption: "c" } }];

    const report = await relay.validateArticle({ title: "With images", body });
    assert.equal(report.ok, true, JSON.stringify(report.issues));
    assert.equal(report.stats.images, 2);

    const bad = await relay.createArticle({ title: "Bad", body: [{ paragraphs: ["x"] }, { image: { path: path.join(dir, "no.png") } }] });
    assert.equal(bad.report.ok, false);
    assert.equal(bad.results.length, 0);
    assert.equal(bad.report.issues[0].code, "article_image_unreadable");

    const made = await relay.createArticle({ title: "With images", body, cover: { kind: "image", path: a } });
    assert.equal(made.results[0].ok, true);
    assert.equal(made.results[0].mode, "mock");

    // the duplicate guard sees the image list too
    await assert.rejects(relay.createArticle({ title: "With images", body, cover: { kind: "image", path: a } }), (e) => e.code === "duplicate_recent_post");
    const other = await relay.createArticle({ title: "With images", body: [...body, { image: { path: a } }], cover: { kind: "image", path: a } });
    assert.equal(other.results[0].ok, true);
  } finally {
    await relay?.close();
    await cleanupTempDir(dir);
  }
});