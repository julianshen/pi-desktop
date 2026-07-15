import { randomUUID } from "node:crypto";
import { createUIMessageStream, type UIMessage } from "ai";
import { onInteractionCreated, type PendingInteraction } from "../web-fetch/pending-interactions.js";

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
 * Deliberately takes an already-resolved `session` rather than doing the session
 * lookup itself: routing a conversation id to its `AgentSession`
 * (`agent/conversations.ts#getOrCreateSession`) and piping this function's returned
 * stream to a real HTTP response (`pipeUIMessageStreamToResponse`) is Task 5's job,
 * once this adapter is wired into a real Express route -- this module's job is pure
 * event-to-stream-part translation, testable with no HTTP server and no real
 * `AgentSession` at all (mirrors `agui/adapter.ts`/`adapter.test.ts`'s existing
 * separation, per TASKS.md's Task 3 technical design).
 *
 * `conversationId` (Task 4) is still needed even though `session` is already
 * resolved: it scopes this run's subscription to
 * `pending-interactions.ts#onInteractionCreated` so a `kind: "confirm"` interaction
 * created for a DIFFERENT conversation's `web_fetch` call never leaks a
 * `tool-approval-request` chunk into this stream (ADR-002-tool-approval-trust-
 * boundary.md, Decision point 4; AC-4.3).
 *
 * Returns the `ReadableStream` `createUIMessageStream` produces directly (not wrapped
 * in a `Promise`): `createUIMessageStream` itself is synchronous -- it returns the
 * stream immediately and runs `execute` in the background, closing the stream once
 * `execute`'s returned promise settles (confirmed against the installed `ai@6.0.224`
 * package's own implementation, `node_modules/ai/dist/index.js`'s
 * `createUIMessageStream` body). Wrapping a value that's already synchronous in a
 * `Promise` would only add a needless microtask hop for Task 5's caller.
 */
export function handleAiSdkRun(session: AgentSessionEventSource, userText: string, conversationId: string) {
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

      // Tracks "the currently-open tool call for this conversation" as a single
      // value -- the exact same simplification agui/adapter.ts:90-106 already uses
      // for currentMessageId. Set on tool_execution_start, cleared on
      // tool_execution_end. This is a deliberate, documented simplification (ADR-002's
      // residual-risk note): correct today because no tool in this codebase calls
      // ctx.ui.confirm() concurrently within one conversation, but it would
      // silently mis-correlate toolCallIds if a future tool ever did.
      let currentToolCallId: string | undefined;

      // Task 4 / ADR-002 Decision point 4 -- "Visualization-only bridge". Scoped to
      // this run's conversationId so a kind: "confirm" interaction created for a
      // DIFFERENT conversation's tool call never leaks a tool-approval-request chunk
      // into this stream (AC-4.3). On a match, writes a pure visualization signal --
      // the interaction's actual resolution happens entirely outside this stream
      // (Task 11's authenticated resolve endpoint); this adapter never writes a
      // tool-output-available part here, only the ordinary tool_execution_end case
      // below does that, once ctx.ui.confirm() unblocks (ADR-002 Finding 3).
      //
      // Subscribed BEFORE session.subscribe() below (not after): some event sources
      // invoke their subscribe() listener synchronously, during subscribe()'s own
      // call (e.g. immediately replaying already-buffered events), which would hit a
      // temporal-dead-zone ReferenceError on unsubscribeInteractions() below if this
      // were declared afterward instead.
      const unsubscribeInteractions = onInteractionCreated((interaction: PendingInteraction) => {
        if (interaction.conversationId !== conversationId) return;
        // A kind: "confirm" interaction is only ever created from inside a tool's
        // own execute() (e.g. web_fetch's ctx.ui.confirm() call), which only runs
        // after this adapter has already seen that tool's tool_execution_start --
        // so currentToolCallId is expected to always be set here. Still guarded
        // rather than cast, since "expected" isn't "guaranteed" (see the residual-
        // risk comment on currentToolCallId's declaration above).
        if (!currentToolCallId) return;
        writer.write({
          type: "tool-approval-request",
          approvalId: interaction.id,
          toolCallId: currentToolCallId,
          signature: undefined,
        });
      });

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
                unsubscribeInteractions();
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
            // Task 4 / ADR-002 Decision point 4: no separate "gated call" signal
            // exists on this event at all -- web_fetch's approval gate is entirely
            // invisible to this adapter until pending-interactions.ts's
            // onInteractionCreated hook (subscribed above) fires independently, mid-
            // execute(), for a kind: "confirm" interaction. This case only needs to
            // remember the currently-open tool call's id so that later notification
            // can be correlated to it.
            currentToolCallId = event.toolCallId;
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
            currentToolCallId = undefined;
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
            unsubscribeInteractions();
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
        unsubscribeInteractions();
      }
    },
  });
}
