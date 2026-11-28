import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { cleanupTempDir, makeTempDir } from "../helpers.mjs";

const checker = new URL("../../tools/check-cloudflared-sleep-mode.mjs", import.meta.url).pathname;

test("check-cloudflared-sleep-mode passes when ingress maps cloud-mcp to 4321", async () => {
  const dir = await makeTempDir("relay-cf-check-");
  const config = path.join(dir, "config.yml");
  await writeFile(
    config,
    `ingress:
  - hostname: relay.example
    service: http://127.0.0.1:4317
  - hostname: cloud-mcp.duitpoket.fun
    service: http://127.0.0.1:4321
  - service: http_status:404
`,
  );
  const out = spawnSync(process.execPath, [checker], {
    env: { ...process.env, CLOUDFLARED_CONFIG: config },
    encoding: "utf8",
  });
  assert.equal(out.status, 0, out.stderr || out.stdout);
  await cleanupTempDir(dir);
});

test("check-cloudflared-sleep-mode fails when cloud-mcp points at 4320", async () => {
  const dir = await makeTempDir("relay-cf-check-bad-");
  const config = path.join(dir, "config.yml");
  await writeFile(
    config,
    `ingress:
  - hostname: cloud-mcp.duitpoket.fun
    service: http://127.0.0.1:4320
`,
  );
  const out = spawnSync(process.execPath, [checker], {
    env: { ...process.env, CLOUDFLARED_CONFIG: config },
    encoding: "utf8",
  });
  assert.equal(out.status, 1);
  await cleanupTempDir(dir);
});