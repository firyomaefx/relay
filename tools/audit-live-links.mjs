#!/usr/bin/env node
/**
 * Audit the public Relay Cloud surface for broken links.
 * Exits 1 if any fetched link returns 4xx/5xx or cannot be reached.
 */
const PAGES = [
  "https://relay.duitpoket.fun/pricing",
  "https://relay.duitpoket.fun/connect",
  "https://relay.duitpoket.fun/contact",
  "https://relay.duitpoket.fun/billing/success",
  "https://relay.duitpoket.fun/billing/cancel",
  "https://relay.duitpoket.fun/login",
];

const seen = new Set();
const broken = [];
let checked = 0;

for (const page of PAGES) {
  let response;
  try {
    response = await fetch(page, { redirect: "manual", headers: { "user-agent": "RelayLinkAudit/1.0" } });
  } catch (error) {
    broken.push({ status: "ERR", url: page, message: error.message });
    continue;
  }
  console.log(page, response.status);
  if (response.status >= 400) {
    broken.push({ status: response.status, url: page });
    continue;
  }
  const html = await response.text();
  for (const match of html.matchAll(/(?:href|src|action)="([^"]+)"/g)) {
    const raw = match[1];
    if (/^(#|mailto:|data:|javascript:|cursor:)/.test(raw)) continue;
    const target = new URL(raw, page).href;
    if (seen.has(target)) continue;
    seen.add(target);
    checked += 1;
    try {
      const result = await fetch(target, { redirect: "manual", headers: { "user-agent": "RelayLinkAudit/1.0" } });
      console.log(" ", result.status, target);
      if (result.status >= 400) broken.push({ status: result.status, url: target });
    } catch (error) {
      broken.push({ status: "ERR", url: target, message: error.message });
    }
  }
}

console.log(`\nChecked ${checked} unique links. Broken: ${broken.length}.`);
if (broken.length) {
  for (const item of broken) console.error(item.status, item.url, item.message ?? "");
  process.exit(1);
}
