import { useEffect, useMemo, useRef, useState } from "react";
import {
  useAssistantRuntime,
  useAssistantToolUI,
  useAuiState,
  type ThreadMessageLike,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import { Thread } from "../components/chat/Thread";
import { Blueprint } from "../components/Blueprint";
import { FileIcon } from "../components/icons";
import { API_BASE } from "../state/apiBase.js";

const ERROR_DISPLAY_MAX_LENGTH = 300;

/** Matches server/src/artifacts/tools.ts's defineTool({ name: "publish_artifact", ... }). */
const PUBLISH_ARTIFACT_TOOL_NAME = "publish_artifact";

/**
 * Provider error messages come through as whatever raw string the provider's own
 * API returned — live-verified with a real OpenRouter 402 response, whose raw
 * `errorMessage` is `"402: {\"message\": \"...\", \"code\": 402, \"metadata\": {
 * \"previous_errors\": [...] }}"` — an HTTP status prefix (`"402: "`) followed by
 * a JSON blob wrapping a human-readable `message` field inside a much longer
 * structure repeating the same text per retry attempt. Rendering that verbatim
 * produced a wall of raw JSON dominating the whole transcript. Strip a leading
 * `NNN: ` status prefix if present (a common pattern for HTTP-client-wrapped
 * errors, not specific to OpenRouter), then extract just the top-level `message`
 * when what's left parses as JSON shaped like that (a safe no-op for plain-text
 * errors from other providers/paths), then truncate regardless — no error
 * message should be allowed to dominate the viewport, whatever provider or shape
 * it came from.
 *
 * Preserved verbatim from the pre-migration ChatView.tsx (Task 8, item 2) — this
 * mechanism is independent of which chat library renders the messages.
 */
function summarizeError(raw: string): string {
  let text = raw;
  const withoutStatusPrefix = raw.replace(/^\d{3}:\s*/, "");
  try {
    const parsed: unknown = JSON.parse(withoutStatusPrefix);
    if (parsed && typeof parsed === "object" && "message" in parsed && typeof (parsed as { message: unknown }).message === "string") {
      text = (parsed as { message: string }).message;
    }
  } catch {
    // Not JSON — use the raw string as-is.
  }
  return text.length > ERROR_DISPLAY_MAX_LENGTH ? `${text.slice(0, ERROR_DISPLAY_MAX_LENGTH)}…` : text;
}

/**
 * Public shape of one entry returned by GET /api/conversations/:id/messages
 * (server/src/agent/conversations.ts's toAGUIHistory()/getConversationMessages()) —
 * the @ag-ui/core Message[] wire shape that endpoint was originally built to
 * hand the (now-removed) CopilotKit agent. Task 8 keeps consuming this same
 * endpoint/shape from the frontend (re-deriving the CONSUMPTION side onto
 * Assistant UI, not the server contract) rather than adding a second,
 * AI-SDK-native history endpoint — see this file's toThreadMessageLikeHistory()
 * below for the conversion.
 */
interface AGUIHistoryToolCall {
  type: "function";
  id: string;
  function: { name: string; arguments: string };
}
interface AGUIHistoryEntry {
  id: string;
  role: "user" | "assistant" | "tool";
  content?: string;
  toolCalls?: AGUIHistoryToolCall[];
  toolCallId?: string;
}

/**
 * Converts GET /api/conversations/:id/messages's AG-UI-shaped history into
 * Assistant UI's ThreadMessageLike[] — the shape threadRuntime.reset() accepts
 * (verified against the installed @assistant-ui/core's own type,
 * node_modules/@assistant-ui/core/src/runtime/utils/thread-message-like.ts:
 * `content` is either a plain string or an array of parts including a
 * `{ type: "tool-call", toolCallId?, toolName, args?, argsText?, result? }`
 * shape — a close structural match for @ag-ui/core's own toolCalls entries).
 *
 * "tool" role entries (a toolCall's result) are folded into the matching
 * assistant message's own tool-call part's `result` field here, rather than
 * becoming their own ThreadMessageLike — Assistant UI's `ThreadMessageLike`
 * has no standalone "tool" role (only "assistant" | "user" | "system"),
 * matching how @assistant-ui/react-ai-sdk's own AI SDK v6 UIMessage shape
 * nests tool results inside the assistant message that made the call.
 *
 * Assistant messages with neither text nor tool calls are skipped — same
 * "never render an empty bubble" fix toAGUIHistory() (server-side) and the
 * pre-migration ChatView both already applied, for the same underlying
 * root cause (pi records a content-free assistant message for a
 * tool-call-only turn).
 */
function toThreadMessageLikeHistory(history: AGUIHistoryEntry[]): ThreadMessageLike[] {
  const resultTextByToolCallId = new Map<string, string>();
  for (const entry of history) {
    if (entry.role === "tool" && entry.toolCallId && typeof entry.content === "string") {
      resultTextByToolCallId.set(entry.toolCallId, entry.content);
    }
  }

  const seeded: ThreadMessageLike[] = [];
  for (const entry of history) {
    if (entry.role === "user") {
      seeded.push({ id: entry.id, role: "user", content: entry.content ?? "" });
      continue;
    }

    if (entry.role === "assistant") {
      const parts: NonNullable<ThreadMessageLike["content"]> = [];
      if (entry.content) {
        (parts as Array<{ type: "text"; text: string }>).push({ type: "text", text: entry.content });
      }
      for (const call of entry.toolCalls ?? []) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments) as Record<string, unknown>;
        } catch {
          // Malformed args JSON — fall back to an empty object rather than dropping the call.
        }
        (
          parts as Array<{
            type: "tool-call";
            toolCallId: string;
            toolName: string;
            args: Record<string, unknown>;
            argsText: string;
            result?: string;
          }>
        ).push({
          type: "tool-call",
          toolCallId: call.id,
          toolName: call.function.name,
          args,
          argsText: call.function.arguments,
          result: resultTextByToolCallId.get(call.id),
        });
      }
      if (parts.length === 0) continue;
      seeded.push({ id: entry.id, role: "assistant", content: parts });
    }
    // "tool" entries are folded into their assistant message above, not seeded standalone.
  }
  return seeded;
}

/** Args shape publish_artifact's tool call carries (server/src/artifacts/tools.ts's defineTool parameters). */
interface PublishArtifactArgs {
  id?: string;
  title?: string;
  language?: string;
}

export function ChatView({
  model,
  conversationId,
  onTurnComplete,
  onOpenArtifact,
}: {
  model: string;
  conversationId: string;
  /**
   * Called once per turn, exactly when the thread's `isRunning` transitions
   * true -> false. Deliberately NOT called on initial mount (where isRunning
   * starts false) or on every false render — only on the true->false edge,
   * via the ref-tracked comparison below — so App.tsx can drive
   * ArtifactCanvas's `refreshSignal` off real turn completions instead of firing an
   * extra spurious refetch on first render. Same contract as the
   * pre-migration ChatView (Task 8, item 4) — App.tsx's call site is unchanged.
   */
  onTurnComplete?: () => void;
  /**
   * Artifacts-as-chat-attachments: called with an artifact id when the user clicks
   * a `publish_artifact` attachment chip in the transcript below, so App.tsx can
   * open the Canvas pinned to that exact artifact (useShellState's
   * `actions.openArtifact`). Same contract as the pre-migration ChatView.
   */
  onOpenArtifact?: (artifactId: string) => void;
}) {
  // Task 8 (TASKS.md, AC-8.1 / cross-conversation isolation, item 1 & 5 of the
  // preserved-behavior list): the runtime App.tsx builds via useAssistantChatRuntime()
  // (useChatRuntime()) is a SINGLE long-lived instance for the whole app's
  // lifetime — App.tsx calls useChatRuntime({ transport }) once per render, not
  // once per conversation, and per that file's own doc comment only proves the
  // TRANSPORT routes to the right per-conversation server route, not that the
  // underlying message state resets on its own when conversationId changes.
  //
  // Confirmed by reading the installed package's own source (not assumed):
  // node_modules/@assistant-ui/react-ai-sdk/dist/ui/use-chat/useChatRuntime.js's
  // useChatThreadRuntime() keys useChat({id}) off `threadListItem.id` — the
  // CURRENT "main" thread in Assistant UI's own thread-list model, which nothing
  // in App.tsx ever switches on its own — so without this component explicitly
  // switching threads, a conversation switch would leave the PREVIOUS
  // conversation's messages (and, worse, its last-turn error/status — see below)
  // visible in the (fresh, key={conversationId}-remounted) ChatView.
  //
  // `runtime.threads.switchToNewThread()` (`useAssistantRuntime()`, both App.tsx's
  // real `useChatRuntime()` and this file's own test harness's `useLocalRuntime()`
  // share the exact same underlying thread-list core —
  // node_modules/@assistant-ui/core/dist/react/runtimes/useLocalRuntime.js also
  // calls `useRemoteThreadListRuntime()` — confirmed live in both) is the fix:
  // it gets a genuinely NEW local thread id, which flows into a genuinely NEW
  // `useChat({id})` instance on the AI-SDK-backed production runtime — fixing
  // not just stale MESSAGES but also stale STATUS/ERROR. A `.reset([])`-only
  // approach (an earlier version of this effect) was live-verified to leave a
  // stale error banner attached to an empty assistant message bubble after
  // switching to a brand-new conversation: `ThreadRuntime.reset()` replaces
  // `chatHelpers.messages` (confirmed:
  // node_modules/@assistant-ui/react-ai-sdk/src/ui/use-chat/useAISDKRuntime.ts's
  // `setMessages`/`onImport` both call `chatHelpers.setMessages(...)`) but the
  // underlying `ai` package's `Chat` class (`node_modules/ai/dist/index.js`)
  // keeps `status`/`error` on a SEPARATE field the `messages` setter never
  // touches — only `clearError()` (not exposed anywhere in Assistant UI's public
  // `ThreadRuntime` API) or starting a genuinely new request
  // (`this.setStatus({ status: "submitted", error: void 0 })` inside
  // `makeRequest()`) clears it. A brand-new thread id sidesteps this
  // entirely — it's a fresh `Chat` instance with no stale `status`/`error` to
  // begin with, not a reused one that needs clearing.
  const assistantRuntime = useAssistantRuntime();

  useEffect(() => {
    let cancelled = false;

    async function seedConversation() {
      await assistantRuntime.threads.switchToNewThread();
      if (cancelled) return;

      try {
        const res = await fetch(`${API_BASE}/api/conversations/${conversationId}/messages`);
        if (!res.ok) throw new Error(`GET conversations/:id/messages failed: ${res.status}`);
        const history: unknown = await res.json();
        if (cancelled || !Array.isArray(history) || history.length === 0) return;
        // `assistantRuntime.thread` (== `.threads.main`) dynamically resolves to
        // whichever thread is CURRENT — confirmed via
        // node_modules/@assistant-ui/core/dist/runtime/api/assistant-runtime.d.ts
        // (`readonly thread: ThreadRuntime`, a stable class-field wrapper, not a
        // snapshot) — so this correctly targets the just-created fresh thread
        // above, not whatever was current before this effect ran.
        assistantRuntime.thread.reset(toThreadMessageLikeHistory(history as AGUIHistoryEntry[]));
      } catch (error: unknown) {
        // Honest fallback (matches ArtifactCanvas.tsx's convention): a failed history
        // fetch leaves the transcript exactly as switchToNewThread() left it (empty)
        // rather than inventing content — the next turn still works correctly
        // regardless, since the server's pi session has the real history either way.
        console.error("[ChatView] failed to load conversation history", error);
      }
    }

    void seedConversation();

    return () => {
      cancelled = true;
    };
    // `assistantRuntime` deliberately excluded: it's the same stable object for
    // this ChatView instance's whole lifetime (App.tsx's own doc comment on
    // useAssistantChatRuntime() — the runtime itself is never recreated), so
    // omitting it doesn't risk staleness; this effect must run exactly once per
    // conversationId (App.tsx's `key={state.activeConv}` remount already
    // guarantees "once per mount").
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // Task 8 (item 2 — error banner). Bug fix originally found via live usage: a
  // failed turn — real OpenRouter 402 "insufficient credits" — was completely
  // invisible in the UI, because CopilotKit's client-side error surface silently
  // no-ops without a license key. Polling the backend-owned
  // GET /api/conversations/:id/last-error on the turn-completion signal below is
  // independent of whichever chat library renders the messages, so it's
  // preserved unchanged in mechanism — only the "turn completed" signal itself
  // changes, from CopilotKit's `isLoading` to Assistant UI's `thread.isRunning`.
  //
  // Edge detection is driven by `assistantRuntime.thread.subscribe()` (an
  // imperative callback that fires on every underlying state change), NOT a
  // `useEffect`/`useAuiState` render-observed comparison — live-verified while
  // writing ChatView.test.tsx that a fast-resolving turn (real network latency
  // masks this, but this codebase's own test harness, and potentially a very
  // quick real model response, can hit it too) can complete within a single
  // React commit, meaning a render with `isRunning === true` is never actually
  // observed in between; a comparison keyed off React's own render cycle can
  // silently miss both edges. `ThreadRuntime.subscribe()` mirrors the exact
  // pattern the installed `@assistant-ui/react-ai-sdk`'s own
  // useExternalHistory.ts uses for this same "detect a completed turn" need
  // (`runtimeRef.current.thread.subscribe(() => { const { isRunning } = ...;
  // ... })`) — re-deriving the same battle-tested approach rather than a
  // React-render-based one.
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const [error, setError] = useState<string | null>(null);
  const wasRunningRef = useRef(false);
  const lastErrorRequestIdRef = useRef(0);

  useEffect(() => {
    return assistantRuntime.thread.subscribe(() => {
      const running = assistantRuntime.thread.getState().isRunning;
      const wasRunning = wasRunningRef.current;
      wasRunningRef.current = running;

      if (!wasRunning && running) {
        // A new turn just started (the false -> true edge). Clear any stale
        // error banner from the previous turn and invalidate any last-error
        // fetch still in flight for it — same "new user action clears the old
        // error immediately" convention the pre-migration ChatView's submit()
        // applied, re-derived here since Task 7's Composer.tsx (not ChatView)
        // now owns the actual send action.
        setError(null);
        lastErrorRequestIdRef.current += 1;
        return;
      }

      if (wasRunning && !running) {
        // The true -> false edge: the turn just completed.
        onTurnComplete?.();
        const requestId = ++lastErrorRequestIdRef.current;
        fetch(`${API_BASE}/api/conversations/${conversationId}/last-error`)
          .then((res) => (res.ok ? (res.json() as Promise<{ message: string | null }>) : { message: null }))
          .then(({ message }) => {
            if (requestId !== lastErrorRequestIdRef.current) return;
            setError(message);
          })
          .catch((err: unknown) => {
            console.error("[ChatView] failed to check last-turn error", err);
          });
      }
    });
    // Intentionally an empty dep array (one subscription for this ChatView
    // instance's whole lifetime, matching the reset-effect's own "run once per
    // mount, App.tsx's key={conversationId} remount already guarantees that"
    // reasoning above) — onTurnComplete/conversationId are read via closure
    // from whichever render this effect's callback was created in, which is
    // fine since both are effectively fixed for the lifetime of a given mount
    // (conversationId always is, by the same key-remount guarantee; onTurnComplete
    // changing identity across an App.tsx re-render without remounting ChatView
    // still calls through to the same underlying behavior).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Task 8 (item 4 — artifacts-as-chat-attachments / onOpenArtifact): renders a
  // publish_artifact tool call as a clickable attachment chip, matching the
  // pre-migration ChatView's chip, instead of Task 7's Message.tsx generic
  // ToolFallback. Registered via useAssistantToolUI() rather than passing a
  // `components` override into MessagePrimitive.Parts — that prop is owned by
  // Task 7's Message.tsx, which this task's scope explicitly forbids modifying
  // ("USE these components, don't modify them"). useAssistantToolUI is
  // deprecated in the installed @assistant-ui/react version in favor of exactly
  // that `components` override (or a toolkit registration) — confirmed by
  // reading node_modules/@assistant-ui/core/src/react/model-context/
  // useAssistantToolUI.ts's own doc comment — but it is still fully functional,
  // and is the only registration mechanism reachable from a sibling/ancestor
  // component (ChatView) rather than Message.tsx itself.
  const publishArtifactToolUI = useMemo<ToolCallMessagePartComponent<PublishArtifactArgs, unknown>>(
    () =>
      function PublishArtifactToolUI({ args }) {
        const artifactId = typeof args.id === "string" ? args.id : undefined;
        return (
          <Blueprint style={{ background: "transparent", cursor: artifactId ? "pointer" : "default" }} onClick={artifactId ? () => onOpenArtifact?.(artifactId) : undefined}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px" }}>
              <FileIcon size={14} />
              <span style={{ fontFamily: "ui-monospace,'SF Mono',Menlo,monospace", fontSize: 12.5 }}>{args.title ?? "Untitled artifact"}</span>
              {args.language && <span className="tag tag-accent">{args.language}</span>}
            </div>
          </Blueprint>
        );
      },
    [onOpenArtifact],
  );
  useAssistantToolUI({ toolName: PUBLISH_ARTIFACT_TOOL_NAME, render: publishArtifactToolUI });

  // Task 8 (item 3): the old web_fetch approval chip — its own local "waiting for
  // approval" state, a poll of the interaction-resolution endpoint, and
  // Approve/Deny buttons posting a decision back — is deliberately NOT ported
  // here. It's replaced by Task 12's ApprovalRequest component (rendered from
  // Task 7's Message.tsx via its own `// TODO(Task 12)` marker), not this
  // file's job to rebuild.

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Thread />
      </div>

      {!isRunning && error && (
        <div
          style={{
            flex: "none",
            margin: "0 28px 14px",
            padding: "10px 14px",
            fontSize: 14,
            lineHeight: 1.5,
            color: "var(--color-danger)",
            background: "var(--color-danger-bg)",
            border: "1px solid var(--color-danger)",
          }}
        >
          {summarizeError(error)}
        </div>
      )}

      {/* Bug fix (live-verified, pre-migration): `model` used to default to a
       * hardcoded fake name that rendered here even before any real model was
       * ever selected. Now that the shared `model` value starts empty and only
       * becomes real once a switch actually happens, render nothing rather
       * than ever showing a fake label. */}
      {model && (
        <div style={{ flex: "none", textAlign: "right", padding: "0 28px 10px", fontSize: 11, color: "color-mix(in srgb, var(--color-text) 42%, transparent)" }}>{model}</div>
      )}
    </div>
  );
}
