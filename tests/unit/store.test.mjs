/**
 * Unit tests for on-disk state: encrypted secrets at rest, credential storage,
 * and two service instances sharing one data directory.
 */
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { SecretBox } from "@relay/core";
import { createRelay } from "@relay/platforms";
import {
  cleanupTempDir,
  listFiles,
  makeTempDir,
  readJsonFileRetry,
} from "../helpers.mjs";

const relayOptions = (dataDir) => ({ dataDir, forceMock: true, env: {}, logger: () => {} });

async function openRelay(dataDir, opened) {
  const relay = await createRelay(relayOptions(dataDir));
  opened.push(relay);
  return relay;
}

test("mock connection stores no plaintext tokens and keeps the key material local", async () => {
  const dataDir = await makeTempDir("relay-store-secrets-");
  const opened = [];
  try {
    const relay = await openRelay(dataDir, opened);
    const begin = await relay.beginConnect("x");
    assert.equal(begin.mode, "connected");
    assert.equal(begin.account.mode, "mock");

    const keyPath = path.join(dataDir, "secret.key");
    const key = await stat(keyPath);
    assert.equal(key.size, 32, "secret.key must be a 32-byte AES-256 key");

    const dbRaw = await readFile(path.join(dataDir, "db.json"), "utf8");
    const db = JSON.parse(dbRaw);
    assert.ok(db.accounts.x, "connected X account must be persisted in db.json");
    assert.equal(db.accounts.x.account.handle, begin.account.handle);
    assert.equal(db.accounts.x.account.mode, "mock");
    assert.equal(db.accounts.x.secret, null, "a mock account has no OAuth token blob");
    for (const tokenName of ["accessToken", "refreshToken", "access_token", "refresh_token"]) {
      assert.equal(
        dbRaw.includes(tokenName),
        false,
        `db.json must not contain the token field ${tokenName} in plaintext`,
      );
    }
  } finally {
    await Promise.all(opened.map((relay) => relay.close()));
    await cleanupTempDir(dataDir);
  }
});

test("saveCredentials encrypts the client secret at rest", async () => {
  const dataDir = await makeTempDir("relay-store-credentials-");
  const opened = [];
  const clientId = "relay-test-client-id";
  const clientSecret = "relay-test-client-secret-2f9a";
  try {
    const relay = await openRelay(dataDir, opened);
    await relay.saveCredentials("x", { clientId, clientSecret });

    const credentialsPath = path.join(dataDir, "credentials.enc.json");
    const raw = await readFile(credentialsPath, "utf8");
    assert.equal(raw.includes(clientSecret), false, "credentials file must not contain the plaintext client secret");
    assert.equal(raw.includes(clientId), false, "credentials file must not contain the plaintext client id");

    const blob = JSON.parse(raw);
    assert.equal(blob.v, 1);
    assert.equal(blob.alg, "aes-256-gcm");
    assert.equal(blob.platforms, undefined, "the credentials document must not be readable JSON");
    assert.equal(blob.clientSecret, undefined);
    assert.equal(typeof blob.data, "string");
    assert.equal(typeof blob.iv, "string");
    assert.equal(typeof blob.tag, "string");

    // The encrypted document must round-trip with the data dir's own key...
    const box = await SecretBox.open(dataDir);
    const decrypted = box.decrypt(blob);
    assert.equal(decrypted.platforms.x.clientId, clientId);
    assert.equal(decrypted.platforms.x.clientSecret, clientSecret);

    // ...and the service must report the platform as configured from settings.
    const infos = relay.credentialInfos();
    const xInfo = infos.find((info) => info.platform === "x");
    assert.ok(xInfo);
    assert.equal(xInfo.configured, true);
    assert.equal(xInfo.source, "settings");
  } finally {
    await Promise.all(opened.map((relay) => relay.close()));
    await cleanupTempDir(dataDir);
  }
});

test("two service instances sharing one data dir see each other's accounts", async () => {
  const dataDir = await makeTempDir("relay-store-shared-");
  const opened = [];
  try {
    const relayA = await openRelay(dataDir, opened);
    await relayA.beginConnect("x");

    // A service opened after the connection must observe it.
    const relayB = await openRelay(dataDir, opened);
    assert.deepEqual(
      (await relayB.accounts()).map((account) => account.platform),
      ["x"],
      "the second instance must see the X account written by the first",
    );

    await relayB.beginConnect("threads");

    const relayC = await openRelay(dataDir, opened);
    assert.deepEqual(
      (await relayC.accounts()).map((account) => account.platform).sort(),
      ["threads", "x"],
      "a third instance must see accounts written by both earlier instances",
    );

    // A stale instance catches up on its next mutation (JsonStore reloads on mutate).
    await relayA.createPost({ platforms: ["x"], text: "shared data dir sync" });
    assert.deepEqual(
      (await relayA.accounts()).map((account) => account.platform).sort(),
      ["threads", "x"],
      "after a mutation the first instance must pick up the Threads account",
    );
  } finally {
    await Promise.all(opened.map((relay) => relay.close()));
    await cleanupTempDir(dataDir);
  }
});

test("concurrent writes from two instances keep db.json valid and complete", async () => {
  const dataDir = await makeTempDir("relay-store-concurrent-");
  const opened = [];
  try {
    const relayA = await openRelay(dataDir, opened);
    await relayA.beginConnect("x");
    const relayB = await openRelay(dataDir, opened);

    const texts = [];
    const posts = [];
    for (let index = 0; index < 5; index += 1) {
      texts.push(`instance-a-${index}`);
      texts.push(`instance-b-${index}`);
      posts.push(relayA.createPost({ platforms: ["x"], text: `instance-a-${index}` }));
      posts.push(relayB.createPost({ platforms: ["x"], text: `instance-b-${index}` }));
    }
    const results = await Promise.all(posts);
    for (const result of results) {
      assert.equal(result.scheduled, false);
      assert.equal(result.report.ok, true, JSON.stringify(result.report.issues));
      assert.equal(result.results.length, 1);
      assert.equal(result.results[0].ok, true);
    }

    const db = await readJsonFileRetry(path.join(dataDir, "db.json"));
    assert.equal(db.posts.length, 10, "all concurrent posts must be recorded exactly once");
    const recorded = db.posts.map((record) => record.draft.text).sort();
    assert.deepEqual(recorded, [...texts].sort());
    assert.equal(new Set(db.posts.map((record) => record.id)).size, 10, "post ids must be unique");

    const leftoverTempFiles = (await listFiles(dataDir)).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftoverTempFiles, [], "atomic writes must not leave temporary files behind");
    const lockFiles = (await listFiles(dataDir)).filter((name) => name.endsWith(".lock"));
    assert.deepEqual(lockFiles, [], "the store lock file must be released after writes");
  } finally {
    await Promise.all(opened.map((relay) => relay.close()));
    await cleanupTempDir(dataDir);
  }
});
