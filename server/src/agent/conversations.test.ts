import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Model, Api } from "@earendil-works/pi-ai";

/**
 * env.ts reads process.env into a module-level constant at import time, so the
 * scratch PI_DESKTOP_* dirs must be set before conversations.ts (and its
 * transitive env.js import) is ever loaded — hence the dynamic import() in
 * beforeAll rather than a static top-of-file import.
 */
let conversations: typeof import("./conversations.js");
let env: typeof import("../config/env.js").env;
let tmpRoot: string;

/**
 * Task 1 fix regression test seam: conversations.ts's createSession() resolves a
 * conversation's model via models.ts's resolveModelById(modelId, modelRegistry). The
 * real modelRegistry built from a scratch agentDir has no configured provider auth,
 * so resolveCliModel would never resolve anything real — following this test file's
 * existing dynamic-import-after-env-setup pattern, mock.module() swaps out
 * "./models.js"'s resolveModelById for a stub *before* conversations.js is imported,
 * so createSession's real (non-injectable) call site can still be exercised.
 */
const STUB_MODEL_ID = "test-provider/test-model";
const STUB_MODEL = {
  id: "test-model",
  provider: "test-provider",
  name: "Test Model",
  api: "anthropic-messages",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0 },
  contextWindow: 100_000,
  maxTokens: 4096,
} as Model<Api>;

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-conversations-test-"));
  process.env.PI_DESKTOP_AGENT_DIR = path.join(tmpRoot, "agent");
  process.env.PI_DESKTOP_DATA_DIR = path.join(tmpRoot, "data");
  process.env.PI_DESKTOP_WORKSPACE_DIR = path.join(tmpRoot, "workspace");
  delete process.env.PI_DESKTOP_MODEL;

  mock.module("./models.js", () => ({
    resolveModelById: async (id: string) => (id === STUB_MODEL_ID ? STUB_MODEL : undefined),
    listAvailableModels: async () => [],
  }));

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

  // Task 1 fix (model-sourcing gap): createSession() must resolve a conversation's
  // stored modelId via models.ts's resolveModelById rather than always falling back
  // to getAgentDeps()'s env-var default. Verified end-to-end through
  // getOrCreateSession() -> AgentSession#model, using the mock.module() stub for
  // "./models.js" installed in beforeAll (no real provider auth is configured in
  // this scratch environment, so the real resolution path would never resolve
  // anything to assert against).
  test("Task 1 fix: getOrCreateSession() resolves a conversation's modelId via models.ts, not the env-var default", async () => {
    const meta = conversations.createConversation("model-scoped conversation");
    conversations.touchConversation(meta.id, { modelId: STUB_MODEL_ID });

    const session = await conversations.getOrCreateSession(meta.id);

    expect(session.model?.id).toBe(STUB_MODEL.id);
    expect(session.model?.provider).toBe(STUB_MODEL.provider);
  });

  // Task 1 fix (model-sourcing gap), fallback branch: an unresolvable modelId must
  // never throw (matches Task 5's AC-5.3 contract) and must fall back to
  // getAgentDeps()'s default model instead of leaving session creation broken.
  test("Task 1 fix: getOrCreateSession() falls back to the default model when modelId is unresolvable", async () => {
    // Control: a conversation with no modelId at all gets whatever getAgentDeps()'s
    // default model resolution yields in this scratch env (no configured provider
    // auth, so createAgentSession's own findInitialModel fallback applies).
    const control = conversations.createConversation("no modelId conversation");
    const controlSession = await conversations.getOrCreateSession(control.id);

    const meta = conversations.createConversation("unresolvable model conversation");
    conversations.touchConversation(meta.id, { modelId: "nonexistent/does-not-exist" });
    const session = await conversations.getOrCreateSession(meta.id);

    // An unresolvable modelId must never throw and must never resolve to the stub
    // model — it should fall back to exactly the same default the control got.
    expect(session.model?.id).not.toBe(STUB_MODEL.id);
    expect(session.model).toEqual(controlSession.model);
  });

  // Task 1 fix (path-traversal guard): conversationCwd(id)/getOrCreateSession(id)
  // must reject ids that aren't safe path segments, since Task 3 will feed
  // client-controlled input.threadId straight into these functions.
  test("Task 1 fix: conversationCwd() rejects a path-traversal-style id", () => {
    expect(() => conversations.conversationCwd("../../etc")).toThrow();
    expect(() => conversations.conversationCwd("../../../tmp/evil")).toThrow();
  });

  test("Task 1 fix: getOrCreateSession() rejects a path-traversal-style id instead of escaping dataDir/conversations", async () => {
    // Rejection must happen before any mkdir/session-creation side effect — i.e.
    // conversationCwd()'s guard runs first, so the malicious id never gets a chance
    // to create a directory outside dataDir/conversations in the first place.
    await expect(conversations.getOrCreateSession("../../../tmp/evil")).rejects.toThrow();
  });
});

/**
 * Task 2 (US-03 regression guard): the pre-existing shared session that this app's
 * real users already have on disk under env.workspaceDir becomes conversation id
 * "default" (AC-1.2 already pins conversationCwd("default") === env.workspaceDir).
 * This block is the dedicated, test-only proof that getOrCreateSession("default")
 * genuinely *resumes* that pre-existing session rather than silently starting a
 * fresh, empty one -- the single highest-risk gap named in the feature's PRD, and
 * the gate Task 3 (routing the live /agui endpoint through conversations.ts) is not
 * allowed to proceed without.
 */
describe("default conversation migration", () => {
  // AC-2.1 [R]: Given env.workspaceDir already contains a persisted session
  // directory (as it does today in any real install), when
  // getOrCreateSession("default") is called, then the resulting session's
  // persisted history is the pre-existing one -- not a fresh/empty session.
  test('AC-2.1: getOrCreateSession("default") resumes the pre-existing env.workspaceDir session, not a fresh one', async () => {
    const { createAgentSession, SessionManager } = await import("@earendil-works/pi-coding-agent");
    const { getAgentDeps } = await import("./deps.js");

    const cwd = conversations.conversationCwd("default");
    expect(cwd).toBe(env.workspaceDir);

    /**
     * Simulate "a real pre-existing install": build a session against
     * env.workspaceDir via the exact same createAgentSession() +
     * SessionManager.continueRecent(cwd) mechanism the now-deleted session.ts
     * used (and conversations.ts's createSession() still uses internally,
     * per Task 1's Technical Design) -- this stands in for the user's real
     * chat history already sitting on disk before "default" is ever routed
     * through conversations.ts.
     */
    const { authStorage, modelRegistry, model, customTools } = await getAgentDeps();
    const { session: preExisting } = await createAgentSession({
      cwd,
      agentDir: env.agentDir,
      model,
      authStorage,
      modelRegistry,
      customTools,
      sessionManager: SessionManager.continueRecent(cwd),
    });

    /**
     * Append directly through the SessionManager's own on-disk persistence --
     * this repo's own session persistence mechanism, not an LLM API call -- so
     * the "pre-existing" session ends up with identifiable, disk-persisted
     * history that a freshly-created session would never have. A *completed*
     * turn (user + assistant entry) is required here: SessionManager only
     * flushes entries to disk once an assistant message is present (see the
     * installed package's session-manager.js _persist()) -- a lone user
     * message stays in-memory-only, which would make this proof vacuous
     * against a genuinely fresh SessionManager.continueRecent(cwd) call.
     */
    preExisting.sessionManager.appendMessage({
      role: "user",
      content: "AC-2.1 pre-existing history marker",
      timestamp: Date.now(),
    });
    preExisting.sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "AC-2.1 pre-existing assistant reply" }],
      api: "anthropic-messages",
      provider: "test-provider",
      model: "test-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });

    const preExistingSessionId = preExisting.sessionManager.getSessionId();
    const preExistingSessionFile = preExisting.sessionManager.getSessionFile();
    const preExistingEntryCount = preExisting.sessionManager.getEntries().length;

    // Sanity: the "pre-existing" session really did reach disk (not just
    // in-memory state) before we ever touch conversations.ts.
    expect(preExistingSessionFile).toBeTruthy();
    expect(fs.existsSync(preExistingSessionFile!)).toBe(true);
    expect(preExistingEntryCount).toBeGreaterThanOrEqual(2);

    preExisting.dispose();

    // The real production path: exactly what Task 3 will call for a request
    // with no threadId (or an explicit threadId of "default").
    const resumed = await conversations.getOrCreateSession("default");

    // Proof of continuity, not a fresh session: same persisted session id,
    // same session file, and the same (non-empty) entry history -- including
    // the marker appended above. A brand-new SessionManager.continueRecent(cwd)
    // call against an empty/unseen cwd would instead generate a new random
    // session id with zero entries, which is exactly what this test would
    // catch if getOrCreateSession("default") silently started a fresh session.
    expect(resumed.sessionManager.getSessionId()).toBe(preExistingSessionId);
    expect(resumed.sessionManager.getSessionFile()).toBe(preExistingSessionFile);
    expect(resumed.sessionManager.getEntries().length).toBe(preExistingEntryCount);
    expect(
      resumed.sessionManager.getEntries().some((entry) => {
        if (entry.type !== "message") return false;
        const message = entry.message as { role?: string; content?: unknown };
        return message.role === "user" && message.content === "AC-2.1 pre-existing history marker";
      }),
    ).toBe(true);
  });
});
