import { describe, expect, test } from "bun:test";
import type { AgentSessionEventSource, PiSessionEvent } from "./adapter.js";
import { handleAiSdkRun } from "./adapter.js";

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

    const chunks = await collectChunks(handleAiSdkRun(session, "hello"));

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

    const chunks = await collectChunks(handleAiSdkRun(session, "call a tool"));

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

    const chunks = await collectChunks(handleAiSdkRun(session, "publish something"));

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

  // AC-3.3: agent_end writes a finish part and the stream closes cleanly -- no
  // hanging writer, no unclosed text/tool parts, and nothing written after finish.
  test("AC-3.3: agent_end writes a finish part and the stream closes cleanly", async () => {
    const session = makeStubSession([{ type: "agent_end" }]);

    const chunks = await collectChunks(handleAiSdkRun(session, "hi"));

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

    const chunks = await collectChunks(handleAiSdkRun(session, "hi"));

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

    const chunks = await collectChunks(handleAiSdkRun(session, "hi"));

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

    const chunks = await collectChunks(handleAiSdkRun(session, "hi"));

    const ends = chunks.filter((c: any) => c.type === "text-end");
    const errors = chunks.filter((c: any) => c.type === "error");
    expect(ends.length).toBe(1);
    expect(errors.length).toBe(1);
    expect((errors[0] as any).errorText).toBe("network exploded");
  });
});
