#!/usr/bin/env node
/** REQ-021, REQ-027: build the Connector SEA executable and optional installer. */
import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(appDir, "dist");
const exe = path.join(dist, "relay-connector.exe");
const bundle = path.join(dist, "relay-connector.cjs");
const blob = path.join(dist, "relay-connector.blob");
const sentinel = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function run(command, args, cwd = appDir) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}

mkdirSync(dist, { recursive: true });
await build({
  entryPoints: [path.join(appDir, "src", "main.ts")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  sourcemap: false,
  minify: false,
});
console.log(`bundled ${path.relative(appDir, bundle)}`);

const seaConfig = JSON.parse(readFileSync(path.join(appDir, "sea-config.json"), "utf8"));
seaConfig.main = bundle;
seaConfig.output = blob;
const generatedConfig = path.join(dist, "sea-config.generated.json");
writeFileSync(generatedConfig, JSON.stringify(seaConfig, null, 2));
run(process.execPath, ["--experimental-sea-config", generatedConfig]);

copyFileSync(process.execPath, exe);
run(process.execPath, [
  path.join(appDir, "..", "..", "node_modules", "postject", "dist", "cli.js"),
  exe,
  "NODE_SEA_BLOB",
  blob,
  "--sentinel-fuse",
  sentinel,
]);

const check = spawnSync(exe, ["--help"], { cwd: appDir, encoding: "utf8", windowsHide: true });
if (check.status !== 0) throw new Error(`SEA smoke test failed: ${check.stderr || check.stdout}`);
console.log(`built ${path.relative(appDir, exe)}`);

if (process.argv.includes("--installer")) {
  const candidates = [
    process.env.ISCC,
    path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Inno Setup 6", "ISCC.exe"),
    path.join(process.env.ProgramFiles ?? "", "Inno Setup 6", "ISCC.exe"),
  ].filter(Boolean);
  const iscc = candidates.find((candidate) => existsSync(candidate));
  if (!iscc) throw new Error("Inno Setup 6 ISCC.exe not found. Set ISCC or install Inno Setup 6.");
  run(iscc, ["relay.iss"], path.join(appDir, "installer"));
  console.log("built installer in dist/installer");
}
