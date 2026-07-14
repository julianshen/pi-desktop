import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Request, Response } from "express";
import type { RunAgentInput } from "@ag-ui/core";

/**
 * handleAguiRun (Task 3) now sources sessions from agent/conversations.js instead of
 * the retired agent/session.js. mock.module() swaps that dependency for an in-memory
 * stub *before* adapter.js is ever imported, mirroring the dynamic-import-after-mock
 * pattern conversations.test.ts and models.test.ts already establish in this repo —
 * so we never spin up a real AgentSession (auth, MCP subprocesses, etc.) just to
 * exercise routing/bookkeeping logic.
 */

interface StubSessionEvent {
  type: string;
  [key: string]: unknown;
}

interface StubSession {
  isStreaming: boolean;
  unsubscribed: boolean;
  subscribe(cb: (event: StubSessionEvent) => void): () => void;
  prompt(text: string, opts?: unknown): Promise<void>;
}

function makeStubSession(): StubSession {
  const listeners = new Set<(event: StubSessionEvent) => void>();
  const session: StubSession = {
    isStreaming: false,
    unsubscribed: false,
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
        session.unsubscribed = true;
      };
    },
    async prompt() {
      const emit = (event: StubSessionEvent) => listeners.forEach((cb) => cb(event));
      emit({ type: "message_start", message: { role: "assistant" } });
      emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "hi" },
      });
      emit({ type: "message_end", message: { role: "assistant" } });
      emit({ type: "agent_end" });
    },
  };
  return session;
}

/**
 * Reproduces a live-observed bug: pi emits a message_start/message_end pair with
 * zero text_delta in between for the assistant "turn" where the model decides to
 * call a tool (no user-visible text, just a tool call), before a second, real
 * assistant message with the actual answer. Confirmed via a raw /agui SSE capture
 * against the real running app. Used to prove the empty pair never produces a
 * TEXT_MESSAGE_START/END on the wire.
 */
function makeStubSessionWithEmptyThenRealAssistantMessage(): StubSession {
  const listeners = new Set<(event: StubSessionEvent) => void>();
  const session: StubSession = {
    isStreaming: false,
    unsubscribed: false,
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
        session.unsubscribed = true;
      };
    },
    async prompt() {
      const emit = (event: StubSessionEvent) => listeners.forEach((cb) => cb(event));
      emit({ type: "message_start", message: { role: "assistant" } });
      emit({ type: "message_end", message: { role: "assistant" } });
      emit({ type: "message_start", message: { role: "assistant" } });
      emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "the answer" },
      });
      emit({ type: "message_end", message: { role: "assistant" } });
      emit({ type: "agent_end" });
    },
  };
  return session;
}

/**
 * Reproduces a live-observed bug: a chat turn against openrouter (real account,
 * insufficient credits — a genuine 402 from OpenRouter, not a code bug) produced
 * RUN_STARTED immediately followed by RUN_FINISHED with zero content and no
 * error. Root-caused via a raw /agui capture against the real running app with
 * temporary event logging: a failed model call does NOT go through
 * message_update's assistantMessageEvent stream at all — pi instead goes
 * straight message_start -> message_end with the SAME AssistantMessage object
 * carrying `stopReason: "error"` and a populated `errorMessage`. This handler
 * only checked message_update's "text_delta", never message_end's stopReason,
 * so a failed turn rendered as total silence instead of a visible error.
 */
function makeStubSessionWithFailingTurn(errorMessage: string): StubSession {
  const listeners = new Set<(event: StubSessionEvent) => void>();
  const session: StubSession = {
    isStreaming: false,
    unsubscribed: false,
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
        session.unsubscribed = true;
      };
    },
    async prompt() {
      const emit = (event: StubSessionEvent) => listeners.forEach((cb) => cb(event));
      const failedMessage = { role: "assistant", content: [], stopReason: "error", errorMessage };
      emit({ type: "message_start", message: failedMessage });
      emit({ type: "message_end", message: failedMessage });
      emit({ type: "agent_end" });
    },
  };
  return session;
}

/**
 * Task 3 fix (review finding): id that makes the mocked touchConversation() below
 * throw, simulating a registry write failure during the agent_end bookkeeping step.
 */
const THROW_ON_TOUCH_ID = "conv-touch-throws";

const sessionsById = new Map<string, StubSession>();
const metaById = new Map<string, { title: string }>();
let getOrCreateSessionCalls: string[] = [];
let touchConversationCalls: Array<[string, unknown]> = [];

mock.module("../agent/conversations.js", () => ({
  getOrCreateSession: async (id: string) => {
    getOrCreateSessionCalls.push(id);
    let session = sessionsById.get(id);
    if (!session) {
      session = makeStubSession();
      sessionsById.set(id, session);
    }
    return session;
  },
  getConversationMeta: (id: string) => metaById.get(id) ?? { title: "New conversation" },
  touchConversation: (id: string, patch?: unknown) => {
    touchConversationCalls.push([id, patch]);
    if (id === THROW_ON_TOUCH_ID) {
      throw new Error("simulated registry write failure");
    }
    const existing = metaById.get(id) ?? { title: "New conversation" };
    metaById.set(id, { ...existing, ...(patch as { title?: string } | undefined) });
  },
}));

const { handleAguiRun } = await import("./adapter.js");

class MockResponse {
  headers: Record<string, string> = {};
  headersSent = false;
  chunks: string[] = [];
  ended = false;

  setHeader(name: string, value: string): void {
    this.headers[name] = value;
    this.headersSent = true;
  }

  write(chunk: string): void {
    this.chunks.push(chunk);
  }

  end(): void {
    this.ended = true;
  }
}

function makeInput(overrides: Partial<RunAgentInput>): RunAgentInput {
  return {
    threadId: undefined as unknown as string,
    runId: "run-1",
    state: undefined,
    messages: [{ id: "m1", role: "user", content: "hello there" }],
    tools: [],
    context: [],
    forwardedProps: undefined,
    ...overrides,
  } as unknown as RunAgentInput;
}

function makeReq(input: RunAgentInput): Request {
  return { body: input, headers: {} } as unknown as Request;
}

beforeEach(() => {
  sessionsById.clear();
  metaById.clear();
  getOrCreateSessionCalls = [];
  touchConversationCalls = [];
});

describe("handleAguiRun", () => {
  // AC-3.1 [R]: Given two different threadIds, when /agui is called with each, then
  // each routes to its own conversation's session — verified here by asserting
  // getOrCreateSession is invoked with each distinct threadId and returns distinct
  // session instances per id (Task 1's memoization contract, exercised through the
  // adapter rather than re-tested directly).
  test("AC-3.1: two different threadIds route to distinct conversations' sessions", async () => {
    const resA = new MockResponse();
    await handleAguiRun(makeReq(makeInput({ threadId: "conv-a" })), resA as unknown as Response);

    const resB = new MockResponse();
    await handleAguiRun(makeReq(makeInput({ threadId: "conv-b" })), resB as unknown as Response);

    expect(getOrCreateSessionCalls).toEqual(["conv-a", "conv-b"]);
    expect(sessionsById.get("conv-a")).toBeDefined();
    expect(sessionsById.get("conv-b")).toBeDefined();
    expect(sessionsById.get("conv-a")).not.toBe(sessionsById.get("conv-b"));
  });

  // AC-3.2 [R]: Given /agui is called with no threadId in the input, when the request
  // is handled, then it routes to conversation "default" (backward-compatible
  // fallback for any client that doesn't send one).
  test("AC-3.2: no threadId falls back to conversation \"default\"", async () => {
    const res = new MockResponse();
    await handleAguiRun(makeReq(makeInput({ threadId: undefined as unknown as string })), res as unknown as Response);

    expect(getOrCreateSessionCalls).toEqual(["default"]);
  });

  // AC-3.3: Given a successful turn completes (agent_end event), when the handler
  // finishes, then touchConversation(conversationId) was called (verified via a spy
  // on the conversations module).
  test("AC-3.3: touchConversation is called for the routed conversation after agent_end", async () => {
    const res = new MockResponse();
    await handleAguiRun(makeReq(makeInput({ threadId: "conv-touch" })), res as unknown as Response);

    expect(touchConversationCalls.length).toBe(1);
    expect(touchConversationCalls[0]![0]).toBe("conv-touch");
    expect(res.ended).toBe(true);
  });

  // Title-derivation behavior (Task 3 technical design): a conversation still on the
  // default title gets one derived from the first user message; a conversation that
  // already has a real title is only touched to bump updatedAt (no title patch).
  test("Task 3: derives a title from the first user message when the conversation still has the default title", async () => {
    const res = new MockResponse();
    await handleAguiRun(
      makeReq(makeInput({ threadId: "conv-derive", messages: [{ id: "m1", role: "user", content: "Plan the Q3 roadmap" }] })),
      res as unknown as Response,
    );

    expect(touchConversationCalls).toEqual([["conv-derive", { title: "Plan the Q3 roadmap" }]]);
  });

  test("Task 3: does not overwrite an already-renamed conversation's title, but still bumps updatedAt", async () => {
    metaById.set("conv-named", { title: "Sprint planning" });

    const res = new MockResponse();
    await handleAguiRun(makeReq(makeInput({ threadId: "conv-named" })), res as unknown as Response);

    expect(touchConversationCalls).toEqual([["conv-named", undefined]]);
  });

  // Task 3 fix (review finding): a bookkeeping failure inside the agent_end handler
  // (touchConversationAfterTurn -> touchConversation throwing, e.g. a registry write
  // failure) must not prevent the SSE stream from being torn down cleanly.
  // unsubscribe() and finish()/res.end() must still run, or the connection leaks.
  test("Task 3 fix: touchConversation throwing during agent_end still tears down the stream (unsubscribe + finish)", async () => {
    const res = new MockResponse();
    await handleAguiRun(makeReq(makeInput({ threadId: THROW_ON_TOUCH_ID })), res as unknown as Response);

    // touchConversation was attempted (and threw) rather than being skipped.
    expect(touchConversationCalls.length).toBe(1);
    expect(touchConversationCalls[0]![0]).toBe(THROW_ON_TOUCH_ID);

    // Despite the throw, teardown still happened: the stream was ended...
    expect(res.ended).toBe(true);
    // ...and the session's subscription was torn down (unsubscribe() ran).
    const session = sessionsById.get(THROW_ON_TOUCH_ID);
    expect(session?.unsubscribed).toBe(true);

    // The throw was caught locally within the agent_end case, not by prompt()'s
    // outer try/catch — proven by the absence of a spurious RUN_ERROR event after
    // RUN_FINISHED (a fallback via the outer catch would emit both).
    const allChunks = res.chunks.join("");
    expect(allChunks).toContain("RUN_FINISHED");
    expect(allChunks).not.toContain("RUN_ERROR");
  });

  // Bug fix (live-usage report: "empty lines in chat, seems thinking process"): a
  // message_start/message_end pair with no text_delta between them (pi's own
  // pre-tool-call "thinking" turn) must never produce a TEXT_MESSAGE_START/END pair
  // on the wire — that's what rendered as an empty chat bubble. The second, real
  // assistant message in the same turn must still render normally.
  test("an empty assistant message_start/message_end pair (no text_delta) never emits TEXT_MESSAGE_START/END", async () => {
    sessionsById.set("conv-empty-then-real", makeStubSessionWithEmptyThenRealAssistantMessage());

    const res = new MockResponse();
    await handleAguiRun(makeReq(makeInput({ threadId: "conv-empty-then-real" })), res as unknown as Response);

    const events = res.chunks
      .join("")
      .split("\n\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as { type: string; messageId?: string; delta?: string });

    const starts = events.filter((e) => e.type === "TEXT_MESSAGE_START");
    const ends = events.filter((e) => e.type === "TEXT_MESSAGE_END");

    // Exactly one START/END pair — for the real message, not the empty one.
    expect(starts.length).toBe(1);
    expect(ends.length).toBe(1);
    expect(starts[0]!.messageId).toBe(ends[0]!.messageId);

    // The real message's content arrived under that same messageId.
    const contentEvents = events.filter((e) => e.type === "TEXT_MESSAGE_CONTENT");
    expect(contentEvents.every((e) => e.messageId === starts[0]!.messageId)).toBe(true);
    expect(contentEvents.map((e) => e.delta).join("")).toBe("the answer");
  });

  // Bug fix (live-usage report: a chat turn produced RUN_STARTED immediately
  // followed by RUN_FINISHED with zero content — the model call had failed, but
  // nothing told the user). A failed turn must surface a real RUN_ERROR with the
  // actual error message, not silence, and must not also emit RUN_FINISHED (this
  // file's own established convention — see the "Task 3 fix" test above asserting
  // their absence together).
  test("a failing model call (message_end's stopReason 'error') surfaces RUN_ERROR with the real message, not silence", async () => {
    sessionsById.set(
      "conv-failing",
      makeStubSessionWithFailingTurn('402: {"message":"This request requires more credits..."}'),
    );

    const res = new MockResponse();
    await handleAguiRun(makeReq(makeInput({ threadId: "conv-failing" })), res as unknown as Response);

    const allChunks = res.chunks.join("");
    expect(allChunks).toContain("RUN_ERROR");
    expect(allChunks).toContain("This request requires more credits");
    expect(allChunks).not.toContain("RUN_FINISHED");

    // No dangling open message either — nothing was ever started for this turn.
    expect(allChunks).not.toContain("TEXT_MESSAGE_START");

    // The stream was still torn down cleanly (unsubscribe + finish), same as
    // every other terminal path in this handler.
    expect(res.ended).toBe(true);
    const session = sessionsById.get("conv-failing");
    expect(session?.unsubscribed).toBe(true);
  });
});
