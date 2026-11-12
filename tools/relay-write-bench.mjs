import { performance } from "node:perf_hooks";
import { rmSync } from "node:fs";

const root = process.env.RELAY_ROOT ?? "/opt/relay";
const { CloudStore } = await import(`${root}/packages/cloud/dist/index.js`);
const dir = process.env.RELAY_BENCH_DIR ?? "/tmp/relay-write-bench";
rmSync(dir, { recursive: true, force: true });
const store = CloudStore.open(`${dir}/cloud.db`);
const n = Number(process.argv[2] || 1000);
const started = performance.now();
const latencies = [];
for (let i = 0; i < n; i++) {
  const t0 = performance.now();
  store.createWaitlistEntry({ name: `Load ${i}`, email: `load-${i}@example.test`, phone: "" });
  latencies.push(performance.now() - t0);
}
const elapsed = performance.now() - started;
latencies.sort((a, b) => a - b);
const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))] ?? 0;
console.log(JSON.stringify({
  inserts: n, elapsedMs: Math.round(elapsed), insertsPerSecond: Math.round((n / elapsed) * 1000),
  p50: +pct(50).toFixed(2), p95: +pct(95).toFixed(2), p99: +pct(99).toFixed(2), max: +latencies.at(-1).toFixed(2),
  count: store.waitlistAcceptedCount(),
}, null, 2));
rmSync(dir, { recursive: true, force: true });
