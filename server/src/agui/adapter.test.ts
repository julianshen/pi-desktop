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
  subscribe(cb: (event: StubSessionEvent) => void): () => void;
  prompt(text: string, opts?: unknown): Promise<void>;
}

function makeStubSession(): StubSession {
  const listeners = new Set<(event: StubSessionEvent) => void>();
  return {
    isStreaming: false,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
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
}

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
});
