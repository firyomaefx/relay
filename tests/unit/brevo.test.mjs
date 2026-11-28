// Traceability: REQ-016
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createRelay } from "@relay/platforms";

test("Brevo transactional draft validates in mock mode", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "relay-brevo-"));
  try {
    const relay = await createRelay({ dataDir: dir, forceMock: true });
    await relay.connectWithApiKey("brevo", "xkeysib_mock_test_key_12345678");
    const draft = {
      platforms: ["brevo"],
      text: "Plain body",
      scheduleAt: "2030-01-01T09:00:00+08:00",
      options: {
        brevo: {
          brevoMode: "transactional",
          brevoSubject: "Hello",
          brevoTo: [{ email: "user@example.com", name: "User" }],
        },
      },
    };
    const report = await relay.validate(draft);
    assert.equal(report.ok, true, report.issues.map((i) => i.message).join("; "));
    const post = await relay.createPost(draft);
    assert.equal(post.scheduled, true);
    assert.ok(post.jobId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Brevo connectWithApiKey stores mock account", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "relay-brevo-"));
  try {
    const relay = await createRelay({ dataDir: dir, forceMock: true });
    const account = await relay.connectWithApiKey("brevo", "xkeysib_mock_test_key_12345678");
    assert.equal(account.platform, "brevo");
    assert.equal(account.mode, "mock");
    const statuses = await relay.platformStatuses();
    const brevo = statuses.find((entry) => entry.platform === "brevo");
    assert.ok(brevo?.connected);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Brevo campaign draft rejects missing audience", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "relay-brevo-"));
  try {
    const relay = await createRelay({ dataDir: dir, forceMock: true });
    const report = await relay.validate({
      platforms: ["brevo"],
      text: "News",
      options: {
        brevo: {
          brevoMode: "campaign",
          brevoSubject: "Weekly",
          brevoSender: { email: "hello@example.com", name: "Relay" },
        },
      },
    });
    assert.equal(report.ok, false);
    assert.ok(report.issues.some((issue) => issue.code === "brevo_audience_required"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});