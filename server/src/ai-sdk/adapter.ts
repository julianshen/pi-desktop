import { randomUUID } from "node:crypto";
import { createUIMessageStream, type UIMessage } from "ai";

/**
 * Structural (duck-typed) shape of the subset of pi's own `AgentSessionEvent` union
 * (from `@earendil-works/pi-coding-agent`'s `core/agent-session.ts`) this adapter
 * translates. Deliberately NOT importing pi SDK's real `AgentSessionEvent`/
 * `AgentSession` types here -- that keeps this module testable against a plain stub
 * object (see adapter.test.ts) without constructing a real `AgentSession` (auth, MCP
 * subprocesses, etc.), mirroring `agui/adapter.test.ts`'s own established
 * `StubSession` convention. A real `AgentSession` (as returned by
 * `agent/conversations.ts#getOrCreateSession`) structurally satisfies
 * `AgentSessionEventSource` below, so wiring a real session in here (Task 5) needs no
 * adapter shape changes.
 *
 * Only the event types this adapter actually handles are modeled below. pi emits
 * several other `AgentSessionEvent` variants (`queue_update`, `compaction_start`,
 * `auto_retry_start`, etc.) that this translation table has no AI SDK equivalent for
 * (same as `agui/adapter.ts`, which also only switches on these same six types) --
 * they simply don't match any `case` in the `switch` below and are ignored.
 */
export interface AssistantMessage {
  role: string;
  /** Populated (`"error"`) on a failed model call -- see the `message_end` handling below. */
  stopReason?: string;
  /** Populated alongside `stopReason: "error"` with the real provider error text. */
  errorMessage?: string;
}

export interface AssistantMessageEvent {
  type: string;
  /** Only present when `type === "text_delta"`. */
  delta?: string;
}

export type PiSessionEvent =
  | { type: "message_start"; message: AssistantMessage }
  | { type: "message_update"; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AssistantMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args?: unknown }
  | { type: "tool_execution_end"; toolCallId: string; result?: unknown }
  | { type: "agent_end" };

export interface AgentSessionEventSource {
  readonly isStreaming?: boolean;
  subscribe(listener: (event: PiSessionEvent) => void): () => void;
  prompt(text: string, opts?: { streamingBehavior: "steer" }): Promise<void>;
}

function toErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Bridges an existing pi `AgentSession`'s event stream (`session.subscribe()`) to a
 * Vercel AI SDK UI message stream -- the AI-SDK-era equivalent of `agui/adapter.ts`'s
 * `handleAguiRun`, translating the exact same pi events into a different wire format.
 *
 * Deliberately does NOT call `streamText()`: Pi Agent already owns the model-calling
 * and tool-execution loop (SPEC.md's "Never" boundary, `agui/adapter.ts`'s own
 * precedent) -- this function only re-speaks pi's own already-happened events as AI
 * SDK `UIMessageChunk`s via `writer.write()`.
 *
 * Deliberately takes an already-resolved `session` rather than a `conversationId` +
 * doing the session lookup itself: routing a conversation id to its `AgentSession`
 * (`agent/conversations.ts#getOrCreateSession`) and piping this function's returned
 * stream to a real HTTP response (`pipeUIMessageStreamToResponse`) is Task 5's job,
 * once this adapter is wired into a real Express route -- this module's job is pure
 * event-to-stream-part translation, testable with no HTTP server and no real
 * `AgentSession` at all (mirrors `agui/adapter.ts`/`adapter.test.ts`'s existing
 * separation, per TASKS.md's Task 3 technical design).
 *
 * Returns the `ReadableStream` `createUIMessageStream` produces directly (not wrapped
 * in a `Promise`): `createUIMessageStream` itself is synchronous -- it returns the
 * stream immediately and runs `execute` in the background, closing the stream once
 * `execute`'s returned promise settles (confirmed against the installed `ai@6.0.224`
 * package's own implementation, `node_modules/ai/dist/index.js`'s
 * `createUIMessageStream` body). Wrapping a value that's already synchronous in a
 * `Promise` would only add a needless microtask hop for Task 5's caller.
 */
export function handleAiSdkRun(session: AgentSessionEventSource, userText: string) {
  return createUIMessageStream<UIMessage>({
    execute: async ({ writer }) => {
      let currentTextId: string | undefined;
      // pi's own agentic loop routinely emits a message_start/message_end pair with
      // zero text_delta events between them (e.g. a turn where the model only calls a
      // tool, no visible text before it). Eagerly writing `text-start` on
      // `message_start` would render an empty text part in the UI. Fix (same one
      // `agui/adapter.ts` already carries, replicated here): defer writing
      // `text-start` until the first real `text_delta` arrives for this message, and
      // only write `text-end` if `text-start` was actually written.
      let textStarted = false;

      const unsubscribe = session.subscribe((event) => {
        switch (event.type) {
          case "message_start": {
            if (event.message.role === "assistant") {
              currentTextId = randomUUID();
              textStarted = false;
            }
            break;
          }
          case "message_update": {
            const assistantEvent = event.assistantMessageEvent;
            if (assistantEvent.type === "text_delta" && currentTextId && typeof assistantEvent.delta === "string") {
              if (!textStarted) {
                writer.write({ type: "text-start", id: currentTextId });
                textStarted = true;
              }
              writer.write({ type: "text-delta", id: currentTextId, delta: assistantEvent.delta });
            }
            break;
          }
          case "message_end": {
            if (event.message.role === "assistant" && currentTextId) {
              // Failed-turn detection (same live-observed bug `agui/adapter.ts` fixed
              // once already, replicated here): a failed model call does NOT surface
              // via any special event type in `message_update`'s stream -- pi instead
              // goes straight message_start -> message_end, where message_end's SAME
              // AssistantMessage object carries `stopReason: "error"` and a populated
              // `errorMessage`. Missing this check would render a failed turn as total
              // silence (RUN_STARTED-equivalent immediately followed by
              // RUN_FINISHED-equivalent, zero content) -- indistinguishable from a
              // hang. Treat it as terminal: close any open text part, emit an `error`
              // chunk, unsubscribe, and let `execute` return so the stream closes.
              if (event.message.stopReason === "error") {
                if (textStarted) {
                  writer.write({ type: "text-end", id: currentTextId });
                }
                currentTextId = undefined;
                textStarted = false;
                writer.write({
                  type: "error",
                  errorText: event.message.errorMessage ?? "The model call failed.",
                });
                unsubscribe();
                break;
              }
              if (textStarted) {
                writer.write({ type: "text-end", id: currentTextId });
              }
              currentTextId = undefined;
              textStarted = false;
            }
            break;
          }
          case "tool_execution_start": {
            // TODO(Task 4): tool-approval-request handling once ADR-002 resolves.
            // A gated tool call (e.g. web_fetch's private-target path) needs to
            // short-circuit here and write a `tool-approval-request` chunk instead of
            // `tool-input-available`, per Task 2's ADR -- the signal that
            // distinguishes a gated call from an ordinary one isn't decided yet, so
            // this task deliberately does not guess at its shape.
            writer.write({
              type: "tool-input-start",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
            });
            writer.write({
              type: "tool-input-available",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              input: event.args ?? {},
            });
            break;
          }
          case "tool_execution_end": {
            writer.write({
              type: "tool-output-available",
              toolCallId: event.toolCallId,
              output: event.result ?? null,
            });
            break;
          }
          case "agent_end": {
            writer.write({ type: "finish" });
            unsubscribe();
            break;
          }
        }
      });

      try {
        await session.prompt(userText, session.isStreaming ? { streamingBehavior: "steer" } : undefined);
      } catch (error) {
        // Mirrors `agui/adapter.ts`'s outer catch: a rejected `prompt()` call (as
        // opposed to a message_end-carried `stopReason: "error"`, handled above) must
        // still close any open text part and surface an `error` chunk rather than
        // leaving the stream to hang.
        if (textStarted && currentTextId) {
          writer.write({ type: "text-end", id: currentTextId });
        }
        writer.write({ type: "error", errorText: toErrorText(error) });
        unsubscribe();
      }
    },
  });
}
