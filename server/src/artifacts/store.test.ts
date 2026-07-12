import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * store.ts imports conversationCwd() from ../agent/conversations.js, and
 * conversations.ts reads env.ts into a module-level constant at import time — so
 * (mirroring agent/conversations.test.ts's existing pattern) the scratch
 * PI_DESKTOP_* dirs are set before either module is ever loaded, via a dynamic
 * import() in beforeAll rather than a static top-of-file import.
 *
 * Deliberately never calls conversations.createConversation()/listConversations():
 * this file's own env vars only win the race to initialize env.js's module-level
 * singleton if this file's dynamic import happens to run first among the test
 * files in the same `bun test` invocation (env.ts bakes in process.env once,
 * process-wide, and Bun does not give each test file its own isolated module
 * registry) -- so any *other* file's dataDir could just as easily end up backing
 * conversationCwd() here. saveArtifact()/getLatestArtifact() only need a valid,
 * writable conversationCwd(id), not a registered ConversationMeta, so using
 * randomUUID()-generated ids straight from conversationCwd() (rather than
 * conversations.createConversation()'s default "New conversation" title) keeps
 * this file from ever writing into the conversations registry that
 * agent/conversations.test.ts's own tests assert exact emptiness against.
 */
let store: typeof import("./store.js");
let conversationCwd: typeof import("../agent/conversations.js").conversationCwd;
let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-artifacts-store-test-"));
  process.env.PI_DESKTOP_AGENT_DIR = path.join(tmpRoot, "agent");
  process.env.PI_DESKTOP_DATA_DIR = path.join(tmpRoot, "data");
  process.env.PI_DESKTOP_WORKSPACE_DIR = path.join(tmpRoot, "workspace");
  delete process.env.PI_DESKTOP_MODEL;

  ({ conversationCwd } = await import("../agent/conversations.js"));
  store = await import("./store.js");
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("artifacts store", () => {
  // AC-7.1: Given an artifact, when saveArtifact(conversationId, artifact) then
  // getLatestArtifact(conversationId), then the round-tripped artifact matches
  // what was saved.
  test("AC-7.1: saveArtifact() then getLatestArtifact() round-trips the saved artifact", () => {
    const conversationId = randomUUID();
    const artifact = {
      id: "chart-1",
      title: "WAU chart",
      language: "tsx",
      code: "export const Chart = () => null;",
      publishedAt: new Date().toISOString(),
    };

    store.saveArtifact(conversationId, artifact);
    const latest = store.getLatestArtifact(conversationId);

    expect(latest).toEqual(artifact);
  });

  // AC-7.2 [R]: Given an artifact already saved with id "x", when saveArtifact is
  // called again with the same id "x" but different code, then getLatestArtifact
  // returns the new content, and the store contains no duplicate entry for "x".
  // Protects the explicit no-versioning contract from PRD non-goals.
  test("AC-7.2: re-publishing the same id overwrites content without creating a duplicate entry", () => {
    const conversationId = randomUUID();
    const first = {
      id: "x",
      title: "V1",
      language: "tsx",
      code: "const v1 = true;",
      publishedAt: new Date(Date.now() - 1000).toISOString(),
    };
    const second = {
      id: "x",
      title: "V2",
      language: "tsx",
      code: "const v2 = true;",
      publishedAt: new Date().toISOString(),
    };

    store.saveArtifact(conversationId, first);
    store.saveArtifact(conversationId, second);

    const latest = store.getLatestArtifact(conversationId);
    expect(latest).toEqual(second);
    expect(latest?.code).toBe("const v2 = true;");

    const raw = JSON.parse(
      fs.readFileSync(path.join(conversationCwd(conversationId), "artifacts.json"), "utf8"),
    ) as Array<{ id: string }>;
    expect(raw.filter((entry) => entry.id === "x")).toHaveLength(1);
  });

  test("getLatestArtifact() returns undefined for a conversation with no published artifacts", () => {
    const conversationId = randomUUID();
    expect(store.getLatestArtifact(conversationId)).toBeUndefined();
  });

  test("getLatestArtifact() returns the entry with the greatest publishedAt, not the last-inserted one", () => {
    const conversationId = randomUUID();
    const older = { id: "a", title: "A", language: "text", code: "a", publishedAt: "2020-01-01T00:00:00.000Z" };
    const newer = { id: "b", title: "B", language: "text", code: "b", publishedAt: "2030-01-01T00:00:00.000Z" };

    // Insert the newer-timestamped one first to prove recency (publishedAt), not
    // insertion order, decides "latest".
    store.saveArtifact(conversationId, newer);
    store.saveArtifact(conversationId, older);

    expect(store.getLatestArtifact(conversationId)?.id).toBe("b");
  });
});
