// Public landing and pricing: bilingual copy, RM estimates and no developer copy.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const publicFile = (name) => readFile(path.join(process.cwd(), "apps", "web", "public", name), "utf8");

test("every data-i18n key used by the public pages exists in both dictionaries", async () => {
  const [landing, pricing, js] = await Promise.all([publicFile("landing.html"), publicFile("pricing.html"), publicFile("site-i18n.js")]);
  const keys = new Set();
  for (const html of [landing, pricing]) {
    for (const match of html.matchAll(/data-i18n="([^"]+)"/g)) keys.add(match[1]);
  }
  assert.ok(keys.size > 80, "the pages should be fully keyed, not partly hard-coded");
  for (const key of keys) {
    const occurrences = (js.match(new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "g")) ?? []).length;
    assert.ok(occurrences >= 2, `${key} must exist in English and Bahasa Melayu`);
  }
});

test("Bahasa Melayu copy changes the hero and the pricing labels", async () => {
  const js = await publicFile("site-i18n.js");
  assert.match(js, /Jadual sekali\. Terbit di merata tempat\./);
  assert.match(js, /Bayar untuk kiriman yang keluar\. Tiada bayaran untuk kiriman yang gagal\./);
  assert.match(js, /Dokumen pembangun/);
  assert.match(js, /Kira-kira/);
});

test("seller pages do not use en or em dashes", async () => {
  const [landing, pricing, i18n] = await Promise.all([publicFile("landing.html"), publicFile("pricing.html"), publicFile("site-i18n.js")]);
  for (const [name, text] of [["landing", landing], ["pricing", pricing], ["site-i18n", i18n]]) {
    assert.doesNotMatch(text, /[\u2013\u2014]/, `${name} must not use en or em dashes`);
  }
});

test("pricing display marks RM as an estimate and computes from the configured rate", async () => {
  const js = await publicFile("pricing-display.js");
  const elements = {};
  for (const id of ["textUsd", "textRm", "videoUsd", "videoRm", "rm10Text", "rm10Video", "starterRm", "scaleRm", "compareLine", "rateNote"]) {
    elements[id] = { textContent: "" };
  }
  const context = {
    window: {
      relayPriceData: {
        usd_myr_rate: 4.7,
        rate_checked_at: "2026-11-12",
        prices: { threads: { text: 20, video: 40 } },
      },
      relayI18n: {
        t: (key, values) => (key === "dyn.compareLine" ? `about ${values.posts} text posts` : `checked on ${values.date}`),
      },
    },
    document: {
      readyState: "complete",
      documentElement: { lang: "en" },
      getElementById: (id) => elements[id] ?? null,
      addEventListener: () => {},
    },
    Intl,
    Date,
    Number,
    Math,
    String,
  };
  vm.runInNewContext(js, context);
  assert.equal(elements.textRm.textContent, "RM0.09");
  assert.equal(elements.videoRm.textContent, "RM0.19");
  assert.equal(elements.rm10Text.textContent, "106");
  assert.equal(elements.rm10Video.textContent, "53");
  assert.equal(elements.starterRm.textContent, "RM46.53");
  assert.equal(elements.scaleRm.textContent, "RM234.53");
  assert.match(elements.compareLine.textContent, /950/);
  assert.match(elements.rateNote.textContent, /12 Nov 2026/);
});
