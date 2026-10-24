#!/usr/bin/env node
/**
 * grok-research — ask Grok (xAI) for a structured research brief and write it
 * to content/research/. The API key is read from XAI_API_KEY only; it is never
 * written to disk or passed on the command line.
 *
 * Usage:
 *   $env:XAI_API_KEY = "xai-..."          # user environment variable
 *   node tools/grok-research.mjs --topic "Malaysian personal finance trends" \
 *     --out content/research/2026-10-27-finance.json
 *
 * Optional env:
 *   XAI_BASE_URL  default https://api.x.ai/v1
 *   XAI_MODEL     default grok-4
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const topic = argValue("--topic");
if (!topic) {
  console.error('Usage: node tools/grok-research.mjs --topic "..." --out content/research/brief.json');
  process.exit(2);
}

const apiKey = process.env.XAI_API_KEY?.trim();
if (!apiKey) {
  console.error(
    "XAI_API_KEY is not set.\n" +
      'Set it as a user environment variable, then reopen the terminal:\n' +
      '  setx XAI_API_KEY "xai-..."\n' +
      "Do not paste the key into a content pack, prompt, or the repo.",
  );
  process.exit(2);
}

const baseUrl = (process.env.XAI_BASE_URL?.trim() || "https://api.x.ai/v1").replace(/\/+$/, "");
const model = process.env.XAI_MODEL?.trim() || "grok-4";
const out = argValue("--out", `content/research/${new Date().toISOString().slice(0, 10)}-brief.json`);

const system = [
  "You are a research analyst for a Malaysian personal-finance publisher.",
  "Use current, verifiable information. Prefer primary sources and official data.",
  "Return ONLY a JSON object with this shape:",
  '{"topic":string,"summary":string,"insights":[string],"keywords":[string],',
  '"hooks":[string],"sources":[{"title":string,"url":string}]}',
  "No markdown, no code fences, no commentary.",
].join("\n");

let response;
try {
  response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      max_tokens: 1600,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Research brief request: ${topic}` },
      ],
    }),
  });
} catch (error) {
  console.error(`Grok request failed: ${error.message ?? error}`);
  process.exit(1);
}

const body = await response.text();
if (!response.ok) {
  console.error(`Grok API ${response.status}: ${body.slice(0, 500)}`);
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(body);
} catch {
  console.error(`Grok returned non-JSON: ${body.slice(0, 300)}`);
  process.exit(1);
}

const content = payload.choices?.[0]?.message?.content ?? "";
const cleaned = String(content).replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
let brief;
try {
  brief = JSON.parse(cleaned);
} catch {
  console.error("Grok did not return valid JSON. Raw output follows:\n");
  console.error(cleaned.slice(0, 2000));
  process.exit(1);
}

await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(brief, null, 2)}\n`, "utf8");
const count = (value) => (Array.isArray(value) ? value.length : 0);
console.log(
  `wrote ${out} — ${count(brief.insights)} insights, ${count(brief.keywords)} keywords, ` +
    `${count(brief.sources)} sources (model: ${model})`,
);
process.exitCode = 0;
