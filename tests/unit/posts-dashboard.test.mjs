// Static contracts for the Posts dashboard, week calendar, previews and retry UI.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const read = (name) => readFile(path.join(process.cwd(), "apps", "web", "public", name), "utf8");

test("Posts has accessible Scheduled, Published and Failed tabs with visible counts", async () => {
  const html = await read("index.html");

  assert.match(html, /role="tablist" aria-label="Post status"/);
  for (const tab of ["scheduled", "published", "failed"]) {
    assert.match(html, new RegExp(`role="tab" aria-selected="(true|false)"[^>]+data-queue-tab="${tab}"`));
  }
  assert.match(html, /id="postsCountScheduled"/);
  assert.match(html, /id="postsCountPublished"/);
  assert.match(html, /id="postsCountFailed"/);
  assert.match(html, /role="tabpanel"/);
});

test("calendar supports month and week modes and labels the navigation by scale", async () => {
  const html = await read("index.html");
  const js = await read("app.js");

  assert.match(html, /id="calendarModeMonth"[^>]+aria-pressed="true"/);
  assert.match(html, /id="calendarModeWeek"[^>]+aria-pressed="false"/);
  assert.match(js, /state\.calendarMode === "week"/);
  assert.match(js, /for \(let index = 0; index < 7; index \+= 1\)/);
  assert.match(js, /setAttribute\("aria-label", "Previous week"\)/);
  assert.match(js, /setAttribute\("aria-label", "Next week"\)/);
  assert.match(js, /setAttribute\("aria-label", "Previous month"\)/);
});

test("previews are approximate platform mockups, not a plain text card", async () => {
  const js = await read("app.js");

  for (const platform of ["mock-x", "mock-threads", "mock-tiktok", "mock-youtube", "mock-instagram", "mock-linkedin"]) {
    assert.match(js, new RegExp(platform));
  }
  assert.match(js, /Approximate preview/);
  assert.match(js, /previewMediaHtml/);
});

test("retry warns before sending and only calls the failed-platform endpoint", async () => {
  const js = await read("app.js");

  assert.match(js, /Only failed platforms will be retried\. Check the platform first if the first attempt may have gone through\./);
  assert.match(js, /api\("\/api\/retry", \{ method: "POST"/);
  assert.match(js, /data-retry-record/);
  assert.match(js, /data-retry-job/);
  assert.match(js, /jobHasHistory/);
});
