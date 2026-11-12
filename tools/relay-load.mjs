import { performance } from "node:perf_hooks";

const base = process.argv[2];
const total = Number(process.argv[3] || 1000);
const concurrency = Number(process.argv[4] || 25);
const paths = process.argv.slice(5);
if (!base || paths.length === 0) {
  console.error("usage: node load.mjs <base> <total> <concurrency> <path...>");
  process.exit(2);
}
const results = [];
let next = 0;
const started = performance.now();
async function worker() {
  while (true) {
    const index = next++;
    if (index >= total) return;
    const path = paths[index % paths.length];
    const t0 = performance.now();
    let status = 0;
    let bytes = 0;
    let error = "";
    try {
      const res = await fetch(base + path, { headers: { accept: "*/*" } });
      status = res.status;
      const body = await res.arrayBuffer();
      bytes = body.byteLength;
      if (!res.ok) error = `HTTP ${res.status}`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    results.push({ ms: performance.now() - t0, status, bytes, error });
  }
}
await Promise.all(Array.from({ length: concurrency }, () => worker()));
const elapsed = performance.now() - started;
const ok = results.filter((r) => r.status >= 200 && r.status < 400 && !r.error);
const times = results.map((r) => r.ms).sort((a, b) => a - b);
const pct = (p) => times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))] ?? 0;
const totalBytes = results.reduce((sum, r) => sum + r.bytes, 0);
const summary = {
  base, total, concurrency, paths,
  elapsedMs: Math.round(elapsed),
  requestsPerSecond: Math.round((results.length / elapsed) * 1000),
  ok: ok.length,
  failed: results.length - ok.length,
  statuses: Object.fromEntries([...new Set(results.map((r) => r.status))].map((s) => [s, results.filter((r) => r.status === s).length])),
  errors: [...new Set(results.map((r) => r.error).filter(Boolean))].slice(0, 5),
  latencyMs: { min: Math.round(times[0] ?? 0), p50: Math.round(pct(50)), p95: Math.round(pct(95)), p99: Math.round(pct(99)), max: Math.round(times.at(-1) ?? 0) },
  bytes: totalBytes,
};
console.log(JSON.stringify(summary, null, 2));
