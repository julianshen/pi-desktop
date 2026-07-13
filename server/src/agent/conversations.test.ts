import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
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

  // Task 7 review fix (AC-7.3 wiring gap): AC-7.3 in artifacts/tools.test.ts only
  // proves createArtifactTools(id)'s own execute() logic works in isolation -- it
  // never calls through createSession()'s actual wiring line
  // (`customTools: [...customTools, ...createArtifactTools(id)]`), so a regression
  // there (e.g. replacing instead of appending, or dropping either side) would pass
  // the whole suite undetected. This proves the *real* wiring using the SDK's own
  // introspection API (AgentSession#getActiveToolNames/getToolDefinition, see
  // node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts)
  // against a session built by getOrCreateSession() itself, not a hand-rolled copy
  // of createSession()'s internals.
  test("Task 7 review fix (AC-7.3 wiring gap): getOrCreateSession() appends publish_artifact onto getAgentDeps()'s customTools, not in place of them", async () => {
    const meta = conversations.createConversation("wiring-gap conversation");
    const session = await conversations.getOrCreateSession(meta.id);

    const activeToolNames = session.getActiveToolNames();

    // The artifact tool from Task 7 must be present.
    expect(activeToolNames).toContain("publish_artifact");
    expect(session.getToolDefinition("publish_artifact")).toBeDefined();

    // At least one tool from getAgentDeps()'s pre-existing customTools bundle
    // (memory/computer-use/MCP) must still be present too -- proving append, not
    // replace. In this scratch test env (no MCP servers configured, no real
    // computer-use dependency), that bundle is exactly the memory tools built
    // synchronously by createMemoryTools() (see agent/deps.ts), so "remember" and
    // "recall" are asserted directly rather than assumed generically.
    const { customTools } = await (await import("./deps.js")).getAgentDeps();
    const preExistingToolNames = customTools.map((tool) => tool.name);
    expect(preExistingToolNames).toEqual(expect.arrayContaining(["remember", "recall"]));

    for (const name of preExistingToolNames) {
      expect(activeToolNames).toContain(name);
      expect(session.getToolDefinition(name)).toBeDefined();
    }
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

  // Code-review finding (Important, /tgd-review): sessionPromises.set(id, promise)
  // used to run synchronously *before* the async createSession(id) body had a chance
  // to reject, so every subsequent call for the same id returned the exact same
  // permanently-rejected promise instance -- a malformed/attacker-supplied id (or a
  // transient failure) would "brick" that id forever and grow the map unboundedly.
  // Proves the fix: a second call for the same malformed id gets a genuinely fresh
  // rejected promise (not `===` the first), and that fresh call still correctly
  // rejects on retry rather than silently succeeding.
  test("getOrCreateSession() evicts a rejected promise so a repeated malformed id retries fresh instead of replaying a cached rejection", async () => {
    const id = "../../../tmp/evil-retry";

    const first = conversations.getOrCreateSession(id);
    await expect(first).rejects.toThrow();

    const second = conversations.getOrCreateSession(id);
    expect(second).not.toBe(first);
    await expect(second).rejects.toThrow();
  });

  // Same finding, transient-failure variant: unlike a permanently-invalid id, a
  // transient failure (e.g. a blip in fs.mkdirSync) must not permanently brick the
  // conversation either -- once the transient cause is gone, a retry for the same id
  // must succeed, proving the map entry was evicted rather than left caching the
  // earlier rejection.
  test("getOrCreateSession() recovers from a transient createSession() failure on retry instead of staying permanently rejected", async () => {
    const meta = conversations.createConversation("transient failure conversation");

    const mkdirSpy = spyOn(fs, "mkdirSync").mockImplementationOnce(() => {
      throw new Error("simulated transient failure");
    });

    await expect(conversations.getOrCreateSession(meta.id)).rejects.toThrow("simulated transient failure");

    mkdirSpy.mockRestore();

    // The transient cause is gone; a fresh retry for the same id must now succeed
    // rather than replaying the earlier cached rejection.
    const session = await conversations.getOrCreateSession(meta.id);
    expect(session).toBeDefined();
  });
});

/**
 * Critical fix (/tgd-review, found independently by code-reviewer and
 * test-engineer): PATCH /api/conversations/:id/model used to stop at
 * touchConversation() and never reach the already-cached AgentSession sitting in
 * this module's sessionPromises map -- so a conversation that had already sent a
 * message kept using its OLD model forever. setLiveSessionModel(id, model) is the
 * fix's unit boundary: called with the real live AgentSession when one exists, a
 * no-op when one doesn't (that path was already correct -- createSession() reads
 * fresh metadata on its own, proven by the "Task 1 fix" tests above).
 *
 * A second Model<Api> distinct from STUB_MODEL is needed here (rather than reusing
 * STUB_MODEL for both "old" and "new") so assertions can actually distinguish
 * "session still has its old model" from "session picked up the new one".
 */
const OTHER_STUB_MODEL_ID = "test-provider/other-test-model";
const OTHER_STUB_MODEL = {
  ...STUB_MODEL,
  id: "other-test-model",
  name: "Other Test Model",
} as Model<Api>;

describe("setLiveSessionModel (Critical /tgd-review fix)", () => {
  // (a) No live session yet for the conversation: setLiveSessionModel() must
  // resolve as a no-op and must NOT force-create a session as a side effect of
  // what should be a metadata-only update (the next getOrCreateSession() call is
  // what picks up the freshly-touched metadata, per createSession()'s modelId
  // resolution above).
  test("setLiveSessionModel() is a no-op when the conversation has no live cached session yet", async () => {
    const meta = conversations.createConversation("no live session yet");

    await expect(conversations.setLiveSessionModel(meta.id, OTHER_STUB_MODEL)).resolves.toBeUndefined();
  });

  // (b) A conversation WITH an already-live cached session: setLiveSessionModel()
  // must call setModel() on that real, already-cached AgentSession instance (not
  // a fresh one), and the session must reflect the new model afterward. The real
  // SDK setModel() validates configured auth via the session's own modelRegistry
  // (see node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js)
  // which this scratch test env never configures for any provider -- so the spy's
  // mockImplementation reproduces setModel()'s actual documented effect (assigning
  // the new model onto session.state, which session.model reads from, per
  // agent-session.js's `get model()`) while skipping the auth check that's
  // orthogonal to what this test is proving.
  test("setLiveSessionModel() calls setModel() on the real live session and the session reflects the new model afterward", async () => {
    const meta = conversations.createConversation("live session model switch");
    conversations.touchConversation(meta.id, { modelId: STUB_MODEL_ID });

    const session = await conversations.getOrCreateSession(meta.id);
    expect(session.model?.id).toBe(STUB_MODEL.id);

    const setModelSpy = spyOn(session, "setModel").mockImplementation(async (model) => {
      session.state.model = model;
    });

    await conversations.setLiveSessionModel(meta.id, OTHER_STUB_MODEL);

    expect(setModelSpy).toHaveBeenCalledTimes(1);
    expect(setModelSpy).toHaveBeenCalledWith(OTHER_STUB_MODEL);
    expect(session.model?.id).toBe(OTHER_STUB_MODEL.id);

    setModelSpy.mockRestore();
  });

  // (c) The live session's setModel() rejecting (e.g. no auth configured for the
  // target model, per the SDK's own doc comment) must propagate rather than be
  // swallowed -- callers (index.ts's PATCH handler) rely on this rejection to
  // avoid updating stored metadata to a model the live session never actually
  // adopted.
  test("setLiveSessionModel() propagates a rejection from the live session's setModel() instead of swallowing it", async () => {
    const meta = conversations.createConversation("live session model switch failure");

    const session = await conversations.getOrCreateSession(meta.id);
    const originalModel = session.model;

    const setModelSpy = spyOn(session, "setModel").mockRejectedValueOnce(
      new Error("No API key for other-provider/unavailable-model"),
    );

    await expect(conversations.setLiveSessionModel(meta.id, OTHER_STUB_MODEL)).rejects.toThrow(
      "No API key for other-provider/unavailable-model",
    );

    // The session must not have silently adopted the new model despite the
    // rejection -- it should still report whatever model it had before.
    expect(session.model).toEqual(originalModel);

    setModelSpy.mockRestore();
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

  // Task 3 fix (review finding): "default" was never createConversation()'d, so
  // without ensureDefaultConversation() (called lazily from getOrCreateSession()),
  // getConversationMeta("default") stays undefined and touchConversation("default",
  // ...) silently no-ops forever, and "default" never shows up in
  // listConversations() -- breaking Task 10's sidebar wiring later. Proves the
  // registry bookkeeping gap is closed once "default" has been touched at least once
  // (getOrCreateSession("default") was already exercised above in AC-2.1).
  test('Task 3 fix: getOrCreateSession("default") registers a real "default" entry in the registry', async () => {
    await conversations.getOrCreateSession("default");

    const meta = conversations.getConversationMeta("default");
    expect(meta).toBeDefined();
    expect(meta?.id).toBe("default");
    expect(meta?.title).toBeTruthy();
    expect(meta?.createdAt).toBeTruthy();
    expect(meta?.updatedAt).toBeTruthy();

    expect(conversations.listConversations().some((c) => c.id === "default")).toBe(true);

    // touchConversation("default", ...) must now actually persist, not silently no-op.
    conversations.touchConversation("default", { title: "Renamed default" });
    expect(conversations.getConversationMeta("default")?.title).toBe("Renamed default");
  });
});

/**
 * Critical fix (/tgd-review code-reviewer finding — closes US-03's P0 acceptance
 * criterion / TASKS.md's AC-12.2): "switching to a previously-open conversation
 * shows an empty transcript instead of its real prior messages." Backend half of
 * the fix — see index.test.ts for the route-level (GET
 * /api/conversations/:id/messages) coverage, and src/views/ChatView.test.tsx for
 * the frontend seeding-effect coverage.
 */
describe("toAGUIHistory (pi AgentMessage -> @ag-ui/core Message mapping)", () => {
  test("maps a user message (string content) to an AG-UI user message", () => {
    const result = conversations.toAGUIHistory([
      { role: "user", content: "What's the weather API key stored as?", timestamp: 1 },
    ]);

    expect(result).toEqual([
      { id: "history-0", role: "user", content: "What's the weather API key stored as?" },
    ]);
  });

  test("maps an assistant text message, extracting text and dropping non-text parts", () => {
    const result = conversations.toAGUIHistory([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "let me check" },
          { type: "text", text: "It's WEATHER_API_KEY in your .env." },
        ],
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
        timestamp: 2,
      },
    ]);

    expect(result).toEqual([
      { id: "history-0", role: "assistant", content: "It's WEATHER_API_KEY in your .env." },
    ]);
  });

  test("maps an assistant message with a tool call to AG-UI toolCalls, with no content key when there's no text", () => {
    const result = conversations.toAGUIHistory([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "a.txt" } }],
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
        stopReason: "toolUse",
        timestamp: 3,
      },
    ]);

    expect(result).toEqual([
      {
        id: "history-0",
        role: "assistant",
        toolCalls: [{ type: "function", id: "call-1", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }],
      },
    ]);
    expect(result[0]).not.toHaveProperty("content");
  });

  test("maps a toolResult message to an AG-UI tool message", () => {
    const result = conversations.toAGUIHistory([
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read_file",
        content: [{ type: "text", text: "file contents" }],
        isError: false,
        timestamp: 4,
      },
    ]);

    expect(result).toEqual([{ id: "history-0", role: "tool", toolCallId: "call-1", content: "file contents" }]);
  });

  // Known, documented simplification (see conversations.ts's own comment): pi's
  // non-chat AgentMessage roles have no AG-UI/ChatView representation and are
  // dropped, not mapped to an invented shape. Indices in the returned array are
  // NOT expected to line up with the input array once a message is dropped —
  // only uniqueness within the response matters (see toAGUIHistory's doc
  // comment), so this asserts the dropped-count and surviving content, not a
  // specific id.
  test("drops pi-internal message roles with no AG-UI representation (e.g. bashExecution)", () => {
    const result = conversations.toAGUIHistory([
      {
        role: "bashExecution",
        command: "ls",
        output: "a.txt",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: 1,
      } as unknown as Parameters<typeof conversations.toAGUIHistory>[0][number],
      { role: "user", content: "hello", timestamp: 2 },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ role: "user", content: "hello" });
  });
});

describe("getConversationMessages (US-03 P0 fix)", () => {
  test("a brand-new conversation with no turns yet returns an empty array", async () => {
    const meta = conversations.createConversation("fresh, no history yet");

    const messages = await conversations.getConversationMessages(meta.id);

    expect(messages).toEqual([]);
  });

  test("a conversation with real session history returns it mapped to AG-UI shape", async () => {
    const meta = conversations.createConversation("has real history");
    const session = await conversations.getOrCreateSession(meta.id);

    // AgentState#messages has a public setter (agent-session.d.ts's AgentState
    // interface) — same access pattern index.test.ts and this file's own
    // setLiveSessionModel tests already use for session.state.model, applied here
    // to session.state.messages instead of round-tripping through a real LLM turn.
    session.state.messages = [
      { role: "user", content: "What's the weather API key stored as?", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "It's WEATHER_API_KEY in your .env." }],
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
        timestamp: 2,
      },
    ];

    const messages = await conversations.getConversationMessages(meta.id);

    expect(messages).toEqual([
      { id: "history-0", role: "user", content: "What's the weather API key stored as?" },
      { id: "history-1", role: "assistant", content: "It's WEATHER_API_KEY in your .env." },
    ]);
  });

  test("a malformed/path-traversal-style id rejects instead of escaping dataDir/conversations", async () => {
    await expect(conversations.getConversationMessages("../../../tmp/evil")).rejects.toThrow(
      "Invalid conversation id",
    );
  });
});
