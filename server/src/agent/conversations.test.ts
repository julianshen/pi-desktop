import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * env.ts reads process.env into a module-level constant at import time, so the
 * scratch PI_DESKTOP_* dirs must be set before conversations.ts (and its
 * transitive env.js import) is ever loaded — hence the dynamic import() in
 * beforeAll rather than a static top-of-file import.
 */
let conversations: typeof import("./conversations.js");
let env: typeof import("../config/env.js").env;
let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-conversations-test-"));
  process.env.PI_DESKTOP_AGENT_DIR = path.join(tmpRoot, "agent");
  process.env.PI_DESKTOP_DATA_DIR = path.join(tmpRoot, "data");
  process.env.PI_DESKTOP_WORKSPACE_DIR = path.join(tmpRoot, "workspace");
  delete process.env.PI_DESKTOP_MODEL;

  ({ env } = await import("../config/env.js"));
  conversations = await import("./conversations.js");
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("conversations registry", () => {
  // AC-1.1: Given an empty registry, when createConversation() is called with no
  // title, then it returns a ConversationMeta with a generated id, title "New
  // conversation", both timestamps set, and listConversations() includes it.
  test("AC-1.1: createConversation() with no title generates a default entry visible in listConversations()", () => {
    const before = conversations.listConversations();
    expect(before.find((c) => c.title === "New conversation")).toBeUndefined();

    const meta = conversations.createConversation();

    expect(meta.id).toBeTruthy();
    expect(meta.title).toBe("New conversation");
    expect(meta.createdAt).toBeTruthy();
    expect(meta.updatedAt).toBeTruthy();
    expect(new Date(meta.createdAt).toString()).not.toBe("Invalid Date");
    expect(new Date(meta.updatedAt).toString()).not.toBe("Invalid Date");

    const after = conversations.listConversations();
    expect(after.some((c) => c.id === meta.id)).toBe(true);
  });

  // AC-1.2 [R]: Given the registry, when conversationCwd("default") is called,
  // then it returns exactly env.workspaceDir (not a subdirectory of
  // dataDir/conversations) — the load-bearing invariant that keeps the
  // pre-existing shared session's history from being orphaned (see Task 2).
  test("AC-1.2: conversationCwd(\"default\") returns env.workspaceDir verbatim", () => {
    expect(conversations.conversationCwd("default")).toBe(env.workspaceDir);
    expect(conversations.conversationCwd("default")).not.toBe(
      path.join(env.dataDir, "conversations", "default"),
    );
  });

  test("AC-1.2 (contrast): conversationCwd(id) for a non-default id nests under dataDir/conversations", () => {
    const meta = conversations.createConversation("some conversation");
    expect(conversations.conversationCwd(meta.id)).toBe(path.join(env.dataDir, "conversations", meta.id));
  });

  // AC-1.3: Given a conversation id, when touchConversation(id, { title: "New
  // title" }) is called, then getConversationMeta(id).title reflects the new
  // value and updatedAt advances.
  test("AC-1.3: touchConversation() updates title and advances updatedAt", async () => {
    const meta = conversations.createConversation();
    const originalUpdatedAt = meta.updatedAt;

    await new Promise((resolve) => setTimeout(resolve, 5));
    conversations.touchConversation(meta.id, { title: "New title" });

    const updated = conversations.getConversationMeta(meta.id);
    expect(updated?.title).toBe("New title");
    expect(updated?.updatedAt).not.toBe(originalUpdatedAt);
    expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThan(new Date(originalUpdatedAt).getTime());
  });

  // AC-1.4: Given two calls to getOrCreateSession(id) for the same id, when both
  // resolve, then they return the same AgentSession instance (memoization holds
  // per-id, matching session.ts's existing single-promise pattern).
  test("AC-1.4: getOrCreateSession(id) memoizes the same AgentSession instance per id", async () => {
    const meta = conversations.createConversation();

    const [first, second] = await Promise.all([
      conversations.getOrCreateSession(meta.id),
      conversations.getOrCreateSession(meta.id),
    ]);

    expect(first).toBe(second);
  });
});
