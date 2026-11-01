#!/usr/bin/env node
/**
 * Relay smoke test (`npm run smoke`):
 *   1. runs `npm run build` from the repo root,
 *   2. verifies the build produced the expected dist artifacts,
 *   3. exercises the critical simulated publishing path against the built code:
 *      connect an account, publish immediately, schedule a post, wait for the
 *      scheduler, and confirm the history.
 *
 * Prints a PASS/FAIL summary and exits non-zero on any failure.
 */
import { spawn } from "node:child_process";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { cleanupTempDir, isoIn, makeTempDir, repoRoot, waitFor } from "./helpers.mjs";

/** Locates npm's JS entry point so the build can run without a shell. */
async function resolveNpmCli() {
  const candidates = [];
  if (process.env.npm_execpath) candidates.push(process.env.npm_execpath);
  const nodeDir = path.dirname(process.execPath);
  if (process.platform === "win32") {
    candidates.push(path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"));
  } else {
    candidates.push(path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"));
  }
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next location.
    }
  }
  return null;
}

async function runBuild() {
  const npmCli = await resolveNpmCli();
  return new Promise((resolve) => {
    const child = npmCli
      ? spawn(process.execPath, [npmCli, "run", "build"], {
          cwd: repoRoot,
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
          windowsHide: true,
        })
      : spawn("npm", ["run", "build"], {
          cwd: repoRoot,
          shell: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
          windowsHide: true,
        });
    let output = "";
    const capture = (chunk) => {
      output = (output + chunk.toString()).slice(-20000);
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      resolve({ code: "timeout", output });
    }, 300000);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: "spawn-error", output: `${output}\n${error.message}` });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

let passed = 0;
let failed = 0;

function pass(name) {
  passed += 1;
  console.log(`PASS  ${name}`);
}

function fail(name, error) {
  failed += 1;
  const message = error instanceof Error ? error.message : String(error);
  const indented = message.split("\n").map((line) => `      ${line}`).join("\n");
  console.log(`FAIL  ${name}\n${indented}`);
}

function tail(text, limit = 4000) {
  return text.length > limit ? `...${text.slice(-limit)}` : text;
}

async function checkBuildArtifacts() {
  const expected = [
    "packages/core/dist/index.js",
    "packages/platforms/dist/index.js",
    "apps/mcp/dist/index.js",
    "apps/web/dist/index.js",
  ];
  for (const relative of expected) {
    const info = await stat(path.join(repoRoot, relative));
    if (!info.isFile() || info.size === 0) throw new Error(`${relative} is missing or empty after the build`);
  }
  return expected.length;
}

async function runCriticalPath() {
  const dataDir = await makeTempDir("relay-smoke-");
  let relay;
  try {
    const { createRelay } = await import("@relay/platforms");
    relay = await createRelay({ dataDir, forceMock: true, env: {}, logger: () => {} });

    const connect = await relay.beginConnect("x");
    if (connect.mode !== "connected" || connect.account.mode !== "mock") {
      throw new Error(`expected a simulated X connection, got ${JSON.stringify(connect)}`);
    }
    pass(`connect mock account (@${connect.account.handle})`);

    const immediateText = `smoke immediate ${Date.now()}`;
    const immediate = await relay.createPost({ platforms: ["x"], text: immediateText });
    if (!immediate.report.ok) throw new Error(`draft rejected: ${JSON.stringify(immediate.report.issues)}`);
    if (immediate.results.length !== 1 || !immediate.results[0].ok) {
      throw new Error(`immediate publish failed: ${JSON.stringify(immediate.results)}`);
    }
    if (immediate.results[0].mode !== "mock") throw new Error(`expected mock mode, got ${immediate.results[0].mode}`);
    pass("publish a post immediately in mock mode");

    const scheduledText = `smoke scheduled ${Date.now()}`;
    const scheduled = await relay.createPost({
      platforms: ["x"],
      text: scheduledText,
      scheduleAt: isoIn(1500),
    });
    if (!scheduled.scheduled || !scheduled.jobId) {
      throw new Error(`expected a queued job, got ${JSON.stringify(scheduled)}`);
    }
    pass("schedule a post ~1.5s ahead");

    const job = await waitFor(
      async () => {
        await relay.runDueJobs();
        const jobs = await relay.listQueue();
        const current = jobs.find((entry) => entry.id === scheduled.jobId);
        if (current?.status === "failed") throw new Error(`scheduled job failed: ${current.lastError}`);
        return current?.status === "done" ? current : null;
      },
      { timeoutMs: 20000, intervalMs: 100, label: "scheduled job to fire" },
    );
    if (!job.results?.[0]?.ok || job.results[0].mode !== "mock") {
      throw new Error(`scheduled publish result was not a successful mock publish: ${JSON.stringify(job.results)}`);
    }
    pass("scheduler fired the scheduled post");

    const history = await relay.history(20);
    const immediateRecord = history.find((record) => record.draft.text === immediateText);
    const scheduledRecord = history.find((record) => record.draft.text === scheduledText);
    if (!immediateRecord) throw new Error("history is missing the immediately published post");
    if (!scheduledRecord) throw new Error("history is missing the scheduled post");
    if (!scheduledRecord.results?.[0]?.ok || scheduledRecord.results[0].mode !== "mock") {
      throw new Error(`scheduled history record is not a successful mock publish: ${JSON.stringify(scheduledRecord.results)}`);
    }
    pass("history contains both posts (mock mode)");
  } finally {
    await relay?.close();
    await cleanupTempDir(dataDir);
  }
}

async function main() {
  console.log("Relay smoke test\n");

  console.log("-> npm run build");
  const build = await runBuild();
  if (build.code === 0) {
    pass("npm run build");
  } else {
    fail("npm run build", new Error(`exit code ${build.code}\n${tail(build.output)}`));
  }

  if (build.code === 0) {
    try {
      const count = await checkBuildArtifacts();
      pass(`build artifacts present (${count} dist entries)`);
    } catch (error) {
      fail("build artifacts present", error);
    }

    try {
      await runCriticalPath();
    } catch (error) {
      fail("critical mock publishing path", error);
    }
  } else {
    failed += 1;
    console.log("FAIL  critical mock publishing path (skipped: build failed)");
  }

  console.log(`\nSMOKE ${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

await main();
