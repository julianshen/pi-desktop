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

      // tgd-review (code-reviewer, Important) Finding 2: tracks every currently-open
      // tool call id for this conversation, not a single mutable "currentToolCallId"
      // value. The single-value version (this file's previous approach, mirroring
      // agui/adapter.ts:90-106's currentMessageId simplification) was broader-risk
      // than ADR-002 originally documented: pi's own installed SDK defaults
      // toolExecution to "parallel" (confirmed against
      // node_modules/@earendil-works/pi-coding-agent's own bundled pi-agent-core
      // types.d.ts -- "preflight tool calls sequentially, then execute allowed tools
      // concurrently"), and nothing in this codebase overrides that default. So ANY
      // two tool calls -- not just a hypothetical future one -- can already be open
      // at once in one conversation today (e.g. a non-gated publish_artifact running
      // alongside a gated web_fetch). Under the old single-value scheme, the
      // non-gated call's tool_execution_end unconditionally cleared
      // currentToolCallId to undefined, regardless of which tool it belonged to --
      // silently dropping the still-pending gated call's tool-approval-request chunk.
      //
      // Fix: add the id on tool_execution_start, remove that SPECIFIC id (never
      // "clear everything") on tool_execution_end. See openToolCallIdForApproval()
      // below for how a confirm notification correlates back to one of these ids --
      // pending-interactions.ts's PendingInteraction carries no toolCallId of its
      // own (Alternatives Considered in ADR-002: threading one through pi's
      // ExtensionUIContext.confirm() signature would be an SDK-facing change, out of
      // scope), so exact correlation is only unambiguous when exactly one tool call
      // is open at notification time. See ADR-002's updated residual-risk note for
      // the (narrower) remaining edge case: two or more tool calls simultaneously
      // open AND unresolved at the exact instant a confirm notification fires.
      const openToolCallIds = new Set<string>();

      // Best-effort correlation for the ambiguous multi-open case: the oldest
      // still-open call (Set preserves insertion order in JS) is used as the
      // approval-request's toolCallId. When exactly one call is open -- true for
      // every case this remediation's regression test exercises, and the common
      // case in general -- this is exact, not a heuristic at all.
      function openToolCallIdForApproval(): string | undefined {
        return openToolCallIds.values().next().value;
      }

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
        // so openToolCallIds is expected to be non-empty here. Still guarded rather
        // than cast, since "expected" isn't "guaranteed" (see the residual-risk
        // comment on openToolCallIds's declaration above).
        const toolCallId = openToolCallIdForApproval();
        if (!toolCallId) return;
        writer.write({
          type: "tool-approval-request",
          approvalId: interaction.id,
          toolCallId,
          signature: undefined,
        });
      });

      // tgd-review (test-engineer, Medium) Finding 3: cleanup() is declared here --
      // *before* session.subscribe() below, not after -- for the exact same reason
      // unsubscribeInteractions() above is subscribed before session.subscribe():
      // some event sources invoke their subscribe() listener synchronously, during
      // subscribe()'s own call, which would hit a temporal-dead-zone ReferenceError
      // on cleanup()/unsubscribe if either were declared afterward instead.
      // `unsubscribe` itself starts as `undefined` and is only assigned once
      // session.subscribe() actually returns below; cleanup() calls it optionally
      // so a hypothetical synchronous-during-subscribe invocation is a safe no-op
      // rather than a crash.
      //
      // Guarantees unsubscribe() and unsubscribeInteractions() each run exactly
      // once no matter how execute() exits -- normal agent_end, the message_end
      // stopReason:"error" path, a rejected session.prompt(), OR (the bug this
      // fixes) session.prompt() resolving cleanly without ever emitting agent_end or
      // any error at all (a malformed/unexpected event sequence -- not contractually
      // impossible even if unlikely). Without this, both subscriptions leak for the
      // process lifetime; onInteractionCreated's is especially costly to leak, since
      // it is a single module-level EventEmitter shared across ALL conversations,
      // not a per-request handle -- a leaked listener here retains a stale
      // writer/toolCallId closure that could misfire on a LATER, unrelated
      // interaction for the same conversation id.
      //
      // Idempotent by construction (the `cleanedUp` guard): the pre-existing early
      // calls inside the agent_end / message_end-error branches below still run
      // synchronously, mid-stream, so the adapter unsubscribes before any
      // still-queued events (e.g. a stub's own trailing agent_end after an error) can
      // reach it -- calling cleanup() again from the `finally` further below when
      // that already happened is then a safe no-op, not a double-unsubscribe.
      let unsubscribe: (() => void) | undefined;
      let cleanedUp = false;
      function cleanup(): void {
        if (cleanedUp) return;
        cleanedUp = true;
        unsubscribe?.();
        unsubscribeInteractions();
      }

      unsubscribe = session.subscribe((event) => {
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
                cleanup();
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
            // remember that this tool call is now open, so a later notification can
            // be correlated to it (tgd-review Finding 2: added to the open set, never
            // overwriting a single shared value).
            openToolCallIds.add(event.toolCallId);
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
            // tgd-review Finding 2: remove only THIS tool call's id, never every open
            // id -- an unrelated, concurrently-open tool call finishing must not
            // clobber a still-pending gated call's correlation.
            openToolCallIds.delete(event.toolCallId);
            writer.write({
              type: "tool-output-available",
              toolCallId: event.toolCallId,
              output: event.result ?? null,
            });
            break;
          }
          case "agent_end": {
            writer.write({ type: "finish" });
            cleanup();
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
      } finally {
        cleanup();
      }
    },
  });
}
