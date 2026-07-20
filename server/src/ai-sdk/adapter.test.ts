import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AgentSessionEventSource, PiSessionEvent } from "./adapter.js";
import { handleAiSdkRun } from "./adapter.js";
import { create as createPendingInteraction, interactionCreatedListenerCount } from "../web-fetch/pending-interactions.js";

/**
 * Stub `AgentSession`-shaped event source, mirroring `agui/adapter.test.ts`'s own
 * `StubSession` convention: `prompt()` synchronously emits a fixed sequence of pi
 * `AgentSessionEvent`s to every current subscriber, then resolves -- exactly how the
 * real `AgentSession.prompt()` drives its `subscribe()` listeners while a turn runs.
 */
function makeStubSession(events: PiSessionEvent[]): AgentSessionEventSource & { unsubscribed: boolean } {
  const listeners = new Set<(event: PiSessionEvent) => void>();
  const session = {
    isStreaming: false,
    unsubscribed: false,
    subscribe(cb: (event: PiSessionEvent) => void) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
        session.unsubscribed = true;
      };
    },
    async prompt() {
      for (const event of events) {
        for (const cb of listeners) cb(event);
      }
    },
  };
  return session;
}

/** Drains a `ReadableStream` into a plain array, proving it actually closes (a stream
 * that never completes its `execute` callback would hang this read loop forever --
 * the test runner's own timeout is the failure signal for a regression here). */
async function collectChunks<T>(stream: ReadableStream<T>): Promise<T[]> {
  const chunks: T[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}

describe("handleAiSdkRun", () => {
  // AC-3.1: a message_update text delta produces text-start/text-delta/text-end
  // parts with a consistent id across all three.
  test("AC-3.1: a text_delta message_update produces text-start/text-delta/text-end with a consistent id", async () => {
    const session = makeStubSession([
      { type: "message_start", message: { role: "assistant" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " there" } },
      { type: "message_end", message: { role: "assistant" } },
      { type: "agent_end" },
    ]);

    const chunks = await collectChunks(handleAiSdkRun(session, "hello", "conv-1"));

    const starts = chunks.filter((c: any) => c.type === "text-start");
    const deltas = chunks.filter((c: any) => c.type === "text-delta");
    const ends = chunks.filter((c: any) => c.type === "text-end");

    expect(starts.length).toBe(1);
    expect(ends.length).toBe(1);
    expect(deltas.length).toBe(2);
    const id = (starts[0] as any).id;
    expect(id).toBeTruthy();
    expect((ends[0] as any).id).toBe(id);
    expect(deltas.every((d: any) => d.id === id)).toBe(true);
    expect(deltas.map((d: any) => d.delta).join("")).toBe("hi there");
  });

  // Replicates agui/adapter.ts's "empty assistant message" fix: a message_start/
  // message_end pair with zero text_delta events between them (pi's own
  // pre-tool-call "thinking" turn) must never produce a text-start/text-end pair.
  test("a tool-call-only turn (message_start/message_end with no text_delta) never emits text-start/text-end", async () => {
    const session = makeStubSession([
      { type: "message_start", message: { role: "assistant" } },
      { type: "message_end", message: { role: "assistant" } },
      { type: "agent_end" },
    ]);

    const chunks = await collectChunks(handleAiSdkRun(session, "call a tool", "conv-1"));

    expect(chunks.some((c: any) => c.type === "text-start")).toBe(false);
    expect(chunks.some((c: any) => c.type === "text-end")).toBe(false);
    expect(chunks.some((c: any) => c.type === "finish")).toBe(true);
  });

  // AC-3.2: tool_execution_start/tool_execution_end produce the correct tool-input/
  // tool-output parts (installed ai@6.0.224's real UIMessageChunk shapes: 'tool-
  // input-start' / 'tool-input-available' / 'tool-output-available').
  test("AC-3.2: tool_execution_start/tool_execution_end produce tool-input-start/tool-input-available/tool-output-available", async () => {
    const session = makeStubSession([
      {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "publish_artifact",
        args: { title: "demo" },
      },
      { type: "tool_execution_end", toolCallId: "call-1", result: { ok: true } },
      { type: "agent_end" },
    ]);

    const chunks = await collectChunks(handleAiSdkRun(session, "publish something", "conv-1"));

    const inputStart = chunks.find((c: any) => c.type === "tool-input-start") as any;
    const inputAvailable = chunks.find((c: any) => c.type === "tool-input-available") as any;
    const outputAvailable = chunks.find((c: any) => c.type === "tool-output-available") as any;

    expect(inputStart).toBeDefined();
    expect(inputStart.toolCallId).toBe("call-1");
    expect(inputStart.toolName).toBe("publish_artifact");

    expect(inputAvailable).toBeDefined();
    expect(inputAvailable.toolCallId).toBe("call-1");
    expect(inputAvailable.toolName).toBe("publish_artifact");
    expect(inputAvailable.input).toEqual({ title: "demo" });

    expect(outputAvailable).toBeDefined();
    expect(outputAvailable.toolCallId).toBe("call-1");
    expect(outputAvailable.output).toEqual({ ok: true });
  });

  test("AC-13.3: normalized search evidence emits typed source-url chunks", async () => {
    const session = makeStubSession([
      { type: "tool_execution_start", toolCallId: "search", toolName: "web_search", args: { query: "x" } },
      { type: "tool_execution_end", toolCallId: "search", result: { details: { citations: [
        { id: "citation-1", title: "Evidence", url: "https://example.com/evidence", source: "Brave Search" },
      ] } } },
      { type: "agent_end" },
    ]);
    const chunks = await collectChunks(handleAiSdkRun(session, "search", "conv-1"));
    expect(chunks.find((chunk: any) => chunk.type === "source-url")).toMatchObject({
      sourceId: "citation-1", title: "Evidence", url: "https://example.com/evidence",
    });
  });

  // AC-3.3: agent_end writes a finish part and the stream closes cleanly -- no
  // hanging writer, no unclosed text/tool parts, and nothing written after finish.
  test("AC-3.3: agent_end writes a finish part and the stream closes cleanly", async () => {
    const session = makeStubSession([{ type: "agent_end" }]);

    const chunks = await collectChunks(handleAiSdkRun(session, "hi", "conv-1"));

    expect(chunks.length).toBe(1);
    expect((chunks[0] as any).type).toBe("finish");
    expect(session.unsubscribed).toBe(true);
  });

  // Replicates agui/adapter.ts's failed-turn fix: message_end's SAME AssistantMessage
  // object carrying stopReason: "error" (not a distinct event type) must be treated
  // as terminal -- close any open text part, emit an error chunk with the real
  // message, and never hang or silently produce zero content.
  test("a failing model call (message_end's stopReason 'error') writes an error chunk, closing any open text part first", async () => {
    const failedMessage = {
      role: "assistant",
      stopReason: "error" as const,
      errorMessage: '402: {"message":"This request requires more credits..."}',
    };
    const session = makeStubSession([
      { type: "message_start", message: { role: "assistant" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } },
      { type: "message_end", message: failedMessage },
      // Emitted by the stub to prove the adapter already unsubscribed by this point --
      // if it were still listening, this would produce a spurious extra 'finish' chunk.
      { type: "agent_end" },
    ]);

    const chunks = await collectChunks(handleAiSdkRun(session, "hi", "conv-1"));

    const starts = chunks.filter((c: any) => c.type === "text-start");
    const ends = chunks.filter((c: any) => c.type === "text-end");
    const errors = chunks.filter((c: any) => c.type === "error");
    const finishes = chunks.filter((c: any) => c.type === "finish");

    expect(starts.length).toBe(1);
    expect(ends.length).toBe(1);
    expect(errors.length).toBe(1);
    expect((errors[0] as any).errorText).toContain("This request requires more credits");
    // No spurious finish -- the adapter unsubscribed before the stub's agent_end fired.
    expect(finishes.length).toBe(0);
    expect(session.unsubscribed).toBe(true);
  });

  // Failed-turn case with zero visible text before the failure: no text-start/
  // text-end pair should ever appear, only the error chunk.
  test("a failing model call with no prior text_delta writes only an error chunk, no text-start/text-end", async () => {
    const failedMessage = { role: "assistant", stopReason: "error" as const, errorMessage: "boom" };
    const session = makeStubSession([
      { type: "message_start", message: { role: "assistant" } },
      { type: "message_end", message: failedMessage },
    ]);

    const chunks = await collectChunks(handleAiSdkRun(session, "hi", "conv-1"));

    expect(chunks.some((c: any) => c.type === "text-start")).toBe(false);
    expect(chunks.some((c: any) => c.type === "text-end")).toBe(false);
    expect(chunks.filter((c: any) => c.type === "error").length).toBe(1);
    expect((chunks.find((c: any) => c.type === "error") as any).errorText).toBe("boom");
  });

  // A rejected session.prompt() call itself (as opposed to a message_end-carried
  // stopReason: "error") must also close any open text part and surface an error
  // chunk rather than leaving the stream open.
  test("a rejected session.prompt() call writes an error chunk and closes any open text part", async () => {
    const session: AgentSessionEventSource & { unsubscribed: boolean } = {
      isStreaming: false,
      unsubscribed: false,
      subscribe(cb) {
        cb({ type: "message_start", message: { role: "assistant" } });
        cb({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } });
        return () => {
          session.unsubscribed = true;
        };
      },
      async prompt() {
        throw new Error("network exploded");
      },
    };

    const chunks = await collectChunks(handleAiSdkRun(session, "hi", "conv-1"));

    const ends = chunks.filter((c: any) => c.type === "text-end");
    const errors = chunks.filter((c: any) => c.type === "error");
    expect(ends.length).toBe(1);
    expect(errors.length).toBe(1);
    expect((errors[0] as any).errorText).toBe("network exploded");
  });

  // AC-4.2 [R]: tool_execution_start for web_fetch followed by a kind: "confirm"
  // creation-notification (pending-interactions.ts's real create(), not a stub --
  // this is the actual cross-module signal the adapter subscribes to) for the SAME
  // conversation writes a tool-approval-request chunk correlated by toolCallId to the
  // earlier tool_execution_start, and writes no tool-output-available until the
  // separate, later tool_execution_end event fires.
  test("AC-4.2: a same-conversation kind:'confirm' creation-notification writes tool-approval-request correlated to the open tool call, with no premature tool-output-available", async () => {
    const conversationId = randomUUID();
    let createdInteractionId: string | undefined;
    const listeners = new Set<(event: PiSessionEvent) => void>();

    const session: AgentSessionEventSource = {
      isStreaming: false,
      subscribe(cb) {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      async prompt() {
        for (const cb of listeners) {
          cb({ type: "tool_execution_start", toolCallId: "call-1", toolName: "web_fetch", args: { url: "http://192.168.1.5/x" } });
        }
        // The real pending-interactions.ts create() -- this is what the adapter's
        // onInteractionCreated subscription actually reacts to, not a stub.
        const { id } = createPendingInteraction(conversationId, {
          conversationId,
          kind: "confirm",
          host: "192.168.1.5",
          timeoutMs: 20,
        });
        createdInteractionId = id;
        for (const cb of listeners) {
          cb({ type: "tool_execution_end", toolCallId: "call-1", result: { approved: true } });
        }
        for (const cb of listeners) {
          cb({ type: "agent_end" });
        }
      },
    };

    const chunks = await collectChunks(handleAiSdkRun(session, "fetch a private url", conversationId));

    const approvalIdx = chunks.findIndex((c: any) => c.type === "tool-approval-request");
    const outputIdx = chunks.findIndex((c: any) => c.type === "tool-output-available");

    expect(approvalIdx).toBeGreaterThanOrEqual(0);
    const approvalChunk = chunks[approvalIdx] as any;
    expect(approvalChunk.approvalId).toBe(createdInteractionId);
    expect(approvalChunk.toolCallId).toBe("call-1");
    expect(approvalChunk.signature).toBeUndefined();

    // No tool-output-available exists before the approval-request chunk -- it only
    // ever comes from the separate, later tool_execution_end event.
    expect(outputIdx).toBeGreaterThan(approvalIdx);
    expect(chunks.filter((c: any) => c.type === "tool-output-available").length).toBe(1);
  });

  // AC-4.3 [R]: a creation-notification for a DIFFERENT conversation than the one
  // currently being streamed must not leak a tool-approval-request chunk into this
  // stream. Stubs traffic for both conversation ids to prove the subscription is
  // actually scoped/filtered, not merely "never subscribes to anything."
  test("AC-4.3: a creation-notification for a different conversation is filtered out, while the matching conversation's still comes through", async () => {
    const streamConversationId = randomUUID();
    const otherConversationId = randomUUID();
    const listeners = new Set<(event: PiSessionEvent) => void>();
    let matchingId: string | undefined;

    const session: AgentSessionEventSource = {
      isStreaming: false,
      subscribe(cb) {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      async prompt() {
        for (const cb of listeners) {
          cb({ type: "tool_execution_start", toolCallId: "call-other", toolName: "web_fetch", args: {} });
        }
        // Notification for a DIFFERENT conversation than the one being streamed --
        // must be filtered out.
        createPendingInteraction(otherConversationId, {
          conversationId: otherConversationId,
          kind: "confirm",
          host: "10.0.0.9",
          timeoutMs: 20,
        });
        // Notification for THIS stream's own conversation -- must come through,
        // proving the filter is scoping (not just globally suppressing).
        matchingId = createPendingInteraction(streamConversationId, {
          conversationId: streamConversationId,
          kind: "confirm",
          host: "10.0.0.5",
          timeoutMs: 20,
        }).id;
        for (const cb of listeners) {
          cb({ type: "tool_execution_end", toolCallId: "call-other", result: {} });
        }
        for (const cb of listeners) {
          cb({ type: "agent_end" });
        }
      },
    };

    const chunks = await collectChunks(handleAiSdkRun(session, "fetch", streamConversationId));

    const approvalChunks = chunks.filter((c: any) => c.type === "tool-approval-request");
    expect(approvalChunks.length).toBe(1);
    expect((approvalChunks[0] as any).approvalId).toBe(matchingId);
  });

  // tgd-review (code-reviewer, Important) Finding 2: pi's installed SDK defaults
  // tool execution to parallel, so two tool calls can legitimately be open at once
  // in one conversation. A non-gated call's tool_execution_end must never clobber
  // correlation for a still-pending GATED call's tool-approval-request -- the old
  // single-value currentToolCallId scheme cleared unconditionally on every
  // tool_execution_end, regardless of which tool it belonged to. This test fails
  // against that old scheme (the approval chunk would never appear) and passes
  // against the current openToolCallIds Set-based tracking.
  test("Finding 2: a concurrently-open non-gated tool call finishing first does not drop a still-pending gated call's tool-approval-request", async () => {
    const conversationId = randomUUID();
    const listeners = new Set<(event: PiSessionEvent) => void>();
    let approvalInteractionId: string | undefined;

    const session: AgentSessionEventSource = {
      isStreaming: false,
      subscribe(cb) {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      async prompt() {
        // Two tool calls open concurrently: a gated web_fetch and a non-gated
        // publish_artifact.
        for (const cb of listeners) {
          cb({ type: "tool_execution_start", toolCallId: "call-gated", toolName: "web_fetch", args: { url: "http://192.168.1.9/x" } });
        }
        for (const cb of listeners) {
          cb({ type: "tool_execution_start", toolCallId: "call-other", toolName: "publish_artifact", args: {} });
        }
        // The NON-gated call finishes first, while the gated call is still open.
        for (const cb of listeners) {
          cb({ type: "tool_execution_end", toolCallId: "call-other", result: { ok: true } });
        }
        // Only now does the gated call's confirm notification fire.
        const { id } = createPendingInteraction(conversationId, {
          conversationId,
          kind: "confirm",
          host: "192.168.1.9",
          timeoutMs: 20,
        });
        approvalInteractionId = id;
        for (const cb of listeners) {
          cb({ type: "tool_execution_end", toolCallId: "call-gated", result: { approved: true } });
        }
        for (const cb of listeners) {
          cb({ type: "agent_end" });
        }
      },
    };

    const chunks = await collectChunks(handleAiSdkRun(session, "do two things", conversationId));

    const approvalChunk = chunks.find((c: any) => c.type === "tool-approval-request") as any;
    expect(approvalChunk).toBeDefined();
    expect(approvalChunk.approvalId).toBe(approvalInteractionId);
    expect(approvalChunk.toolCallId).toBe("call-gated");
  });

  // tgd-review (test-engineer, Medium) Finding 3: session.prompt() resolving
  // cleanly WITHOUT ever emitting agent_end (a malformed/unexpected event
  // sequence -- not contractually impossible even if unlikely) must still
  // unsubscribe both the session listener and the onInteractionCreated listener.
  // Without a `finally`-guaranteed cleanup, both leak for the process lifetime --
  // costly for onInteractionCreated specifically, since it is a single
  // module-level EventEmitter shared across ALL conversations, not a per-request
  // handle.
  test("Finding 3: session.prompt() resolving without ever emitting agent_end still unsubscribes both listeners (no leak)", async () => {
    const session = makeStubSession([
      { type: "message_start", message: { role: "assistant" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } },
      { type: "message_end", message: { role: "assistant" } },
      // Deliberately no agent_end.
    ]);

    const listenersBefore = interactionCreatedListenerCount();
    await collectChunks(handleAiSdkRun(session, "hi", "conv-1"));

    expect(session.unsubscribed).toBe(true);
    expect(interactionCreatedListenerCount()).toBe(listenersBefore);
  });
});
