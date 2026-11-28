import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { cleanupTempDir, makeTempDir } from "../helpers.mjs";

const gate = new URL("../../deploy/vm-repair-gate.sh", import.meta.url).pathname;

function runGate(env) {
  return spawnSync("bash", [gate], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

test("vm-repair-gate pauses when flag is 1", async () => {
  const dir = await makeTempDir("relay-vm-gate-");
  const relayEnv = path.join(dir, "relay.env");
  await writeFile(relayEnv, "RELAY_VM_REPAIR_PAUSED=1\n");
  const out = runGate({ RELAY_ENV: relayEnv, RELAY_VM_REPAIR_PAUSED: "" });
  assert.equal(out.status, 2, out.stdout);
  assert.match(out.stdout, /PAUSED/);
  await cleanupTempDir(dir);
});

test("vm-repair-gate proceeds when flag is 0", async () => {
  const dir = await makeTempDir("relay-vm-gate-run-");
  const relayEnv = path.join(dir, "relay.env");
  await writeFile(relayEnv, "RELAY_VM_REPAIR_PAUSED=0\n");
  const out = runGate({ RELAY_ENV: relayEnv });
  assert.equal(out.status, 0, out.stderr || out.stdout);
  assert.match(out.stdout, /proceeding/);
  await cleanupTempDir(dir);
});

test("vm-repair-gate allows deliberate VM_REPAIR_RUN=1 while paused", async () => {
  const dir = await makeTempDir("relay-vm-gate-force-");
  const relayEnv = path.join(dir, "relay.env");
  await writeFile(relayEnv, "RELAY_VM_REPAIR_PAUSED=1\n");
  const out = runGate({ RELAY_ENV: relayEnv, VM_REPAIR_RUN: "1" });
  assert.equal(out.status, 0);
  assert.match(out.stdout, /deliberate repair/);
  await cleanupTempDir(dir);
});