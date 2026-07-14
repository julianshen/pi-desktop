import { useEffect, useRef, useState } from "react";
import { useCopilotChatInternal, useThreads } from "@copilotkit/react-core";
import { Role, TextMessage, aguiToGQL } from "@copilotkit/runtime-client-gql";
import { Blueprint } from "../components/Blueprint";
import { AttachIcon, FileIcon, SendIcon } from "../components/icons";
import { API_BASE } from "../state/apiBase.js";

const GREETING =
  "Hi! I'm pi, your desktop agent. Ask me anything — I can use tools, skills, MCP servers, and remember things across conversations.";

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

export function ChatView({
  model,
  conversationId,
  onTurnComplete,
  onOpenArtifact,
}: {
  model: string;
  conversationId: string;
  /**
   * Task 13 follow-up (App.tsx previously flagged this as unwired pending both Task 12
   * and Task 13 landing — both have now landed): called once per turn, exactly when
   * `isLoading` transitions true -> false. Deliberately NOT called on initial mount
   * (where isLoading starts false) or on every false render — only on the true->false
   * edge, via the ref-tracked comparison below — so App.tsx can drive
   * ArtifactCanvas's `refreshSignal` off real turn completions instead of firing an
   * extra spurious refetch on first render.
   */
  onTurnComplete?: () => void;
  /**
   * Artifacts-as-chat-attachments: called with an artifact id when the user clicks
   * a `publish_artifact` attachment chip in the transcript below, so App.tsx can
   * open the Canvas pinned to that exact artifact (useShellState's
   * `actions.openArtifact`).
   */
  onOpenArtifact?: (artifactId: string) => void;
}) {
  // Task 12 CRITICAL BUG FIX (found via live E2E reproduction, not just static review):
  // `useCopilotChat()` (verified against the installed @copilotkit/react-core 1.62.3,
  // dist/index.mjs) returns only { visibleMessages, appendMessage, reloadMessages,
  // stopGeneration, reset, isLoading, isAvailable, runChatCompletion, mcpServers,
  // setMcpServers } — no `agent`/`threadId`. Task 12's original implementation concluded
  // from that gap that there was "no real thread-scoping parameter to pass" and relied
  // solely on App.tsx's `key={state.activeConv}` remount. That's insufficient: the
  // underlying `agent` object is a singleton owned by the un-remounted <CopilotKit> in
  // App.tsx (`copilotkit.getAgent(agentId)`, see node_modules/@copilotkit/react-core/dist
  // /copilotkit-ympAovXs.mjs's `useAgent`), and `@ag-ui/client`'s `HttpAgent` sends
  // whatever `agent.threadId` currently holds on every request — remounting ChatView does
  // not touch that field. Live-verified impact: two different conversations both sent the
  // identical threadId to /agui, so every conversation funneled into ONE shared
  // server-side session (server/src/agui/adapter.ts's `input.threadId ?? "default"`).
  //
  // The fix: `useThreads()` (ThreadsContext, installed once at the top of the <CopilotKit>
  // tree by the library itself) IS exported publicly from @copilotkit/react-core — it's
  // just not part of `useCopilotChat`'s own return type, so Task 12 missed it. Its
  // `setThreadId()` marks the id "explicit" on that same top-level context; that value
  // flows CopilotKitInternal -> CopilotChatConfigurationProvider -> `useAgent()`'s own
  // effect, which pushes it onto `agent.threadId`, and because
  // `useCopilotChatInternal`'s connect-effect also depends on that same config threadId,
  // the id change forces a reconnect whose `isFreshRestore` branch
  // (@copilotkit/core's RunHandler.connectAgent) clears the previous thread's stale
  // messages. Net effect: distinct conversations now get distinct, correctly-routed
  // threadIds, and switching away from a conversation no longer leaves its messages
  // bleeding into the next one.
  //
  // Critical fix (/tgd-review code-reviewer finding — closes US-03's P0 acceptance
  // criterion / TASKS.md's AC-12.2), closing what used to be documented here as a
  // "known remaining gap": the installed `HttpAgent` genuinely has no working
  // `connect()` (@ag-ui/client's `AbstractAgent.connect()` throws
  // `AGUIConnectNotImplementedError` unless a transport overrides it — confirmed in
  // node_modules/@ag-ui/client/dist/index.d.ts, and swallowed internally by
  // @copilotkit/core's RunHandler.connectAgent, which is why no console error was ever
  // visible for this). So the `isFreshRestore` clear above (`agent.setMessages([])`,
  // @copilotkit/core's RunHandler.connectAgent) really does leave the transcript with
  // nothing to refill from via the AG-UI connect path — the server previously exposed no
  // other way to fetch a conversation's history.
  //
  // Fix: server/src/index.ts now exposes `GET /api/conversations/:id/messages` (SPEC.md's
  // own anticipated contingency for exactly this gap), returning the conversation's
  // AgentSession#messages mapped to `@ag-ui/core`'s `Message[]` wire shape
  // (agent/conversations.ts's `toAGUIHistory`/`getConversationMessages`). On the frontend,
  // `useCopilotChatInternal()` already returns a public, sanctioned way to seed history —
  // `setMessages()` (confirmed in node_modules/@copilotkit/react-core/dist/index.mjs;
  // it wraps `agent.setMessages()`, which both replaces `agent.messages` AND notifies the
  // `onMessagesChanged` subscription `useAgent()` sets up, so assigning through it,
  // unlike a bare `agent.messages = [...]`, actually triggers a re-render) — no need to
  // reach for the internal, non-exported `useAgent()` hook.
  //
  // Sequencing matters here (this feature has already been bitten twice by exactly this
  // kind of CopilotKit lifecycle subtlety — see the Task 12 fix above and the stale-
  // initial-state bug). `agent.setMessages([])` inside the isFreshRestore clear happens
  // asynchronously, *inside* the same `connectAgent()` call whose failure this file's own
  // `useCopilotChatInternal` effect swallows before flipping `isAvailable` from false back
  // to true (see @copilotkit/react-core's `useCopilotChatInternal`: `setAgentAvailable(false)`
  // synchronously at the start of every (re)connect, `setAgentAvailable(true)` only after
  // `copilotkit.connectAgent()` — which performs the clear — settles). Seeding on
  // `conversationId` change alone would race that clear and could get wiped out
  // immediately after; gating the fetch+seed on `isAvailable` (below) guarantees it only
  // runs once the clear has already happened for this thread.
  const { setThreadId } = useThreads();
  useEffect(() => {
    setThreadId(conversationId);
  }, [conversationId, setThreadId]);

  // Pre-existing bug fix (unrelated to Task 12's thread-routing work above, found while
  // verifying that fix live): `useCopilotChat()` in this installed
  // @copilotkit/react-core@1.62.3 destructures `visibleMessages` from its internal hook
  // (dist/index.mjs's `useCopilotChat`), but that internal hook (`useCopilotChatInternal`)
  // only ever returns a key named `messages` — it never computes or returns
  // `visibleMessages` at all. So `useCopilotChat().visibleMessages` is unconditionally
  // `undefined`, and the old `rawMessages ?? []` fallback silently rendered an empty
  // transcript regardless of real chat content.
  //
  // `messages` (what the internal hook actually returns, aliased to its own
  // `resolvedMessages`, itself sourced from `agent.messages`) is real AG-UI-format data —
  // but it's a *different shape* than what this file's render logic below expects: plain
  // `@ag-ui/core` `Message` objects (`{ role, content, toolCalls? }`), not the
  // `@copilotkit/runtime-client-gql` `Message` classes (`TextMessage`/
  // `ActionExecutionMessage`, with `.isTextMessage()`/`.isActionExecutionMessage()`
  // methods) this file's `.map()` below relies on. `visibleMessages`'s own doc comment
  // (`UseCopilotChatReturn$1` in the package's `.d.mts`) confirms that's exactly what it
  // was supposed to be: "the visible messages, not the raw messages from the runtime
  // client" — i.e. the GQL-shaped conversion of `messages`, which this version of the
  // library forgot to actually produce.
  //
  // Fix: call `useCopilotChatInternal()` directly (also exported from
  // `@copilotkit/react-core`, and the same hook `useCopilotChat()` wraps) to get the real,
  // working `messages` field, then reconstruct the missing conversion ourselves via
  // `aguiToGQL()` — a public export of `@copilotkit/runtime-client-gql` that performs
  // exactly this AG-UI-to-GQL mapping (confirmed in
  // node_modules/@copilotkit/runtime-client-gql/dist/message-conversion/agui-to-gql.mjs).
  // This keeps every downstream `.isTextMessage()`/`.isActionExecutionMessage()` call
  // below unchanged, since `aguiToGQL()` returns real `TextMessage`/`ActionExecutionMessage`
  // instances.
  const {
    messages: rawMessages,
    appendMessage,
    isLoading,
    isAvailable,
    setMessages,
  } = useCopilotChatInternal();
  const visibleMessages = aguiToGQL(rawMessages ?? []);
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  // See the seeding-effect comment above (Critical /tgd-review fix, US-03/AC-12.2):
  // once `isAvailable` flips true for this thread — meaning the isFreshRestore clear
  // has already happened — fetch this conversation's real history and seed it in. A
  // brand-new/never-messaged conversation legitimately returns [], in which case there
  // is nothing to seed (the clear already left `agent.messages` empty) and setMessages
  // is deliberately not called, to avoid an extra no-op notify on every mount/switch.
  useEffect(() => {
    if (!isAvailable) return;
    let cancelled = false;

    fetch(`${API_BASE}/api/conversations/${conversationId}/messages`)
      .then((res) => {
        if (!res.ok) throw new Error(`GET conversations/:id/messages failed: ${res.status}`);
        return res.json();
      })
      .then((history: unknown) => {
        if (cancelled || !Array.isArray(history) || history.length === 0) return;
        setMessages(history as Parameters<typeof setMessages>[0]);
      })
      .catch((error: unknown) => {
        // Honest fallback (matches ArtifactCanvas.tsx's convention): a failed history
        // fetch leaves the transcript exactly as the isFreshRestore clear left it
        // (empty) rather than inventing content — the next turn still works correctly
        // regardless, since the server's pi session has the real history either way.
        console.error("[ChatView] failed to load conversation history", error);
      });

    return () => {
      cancelled = true;
    };
  }, [conversationId, isAvailable, setMessages]);

  // Bug fix (live-usage report: a failed turn — real OpenRouter 402
  // "insufficient credits" — was completely invisible in the UI). adapter.ts
  // now emits a real RUN_ERROR over the AG-UI stream, but the installed
  // CopilotKit version's `<CopilotKit onError>` prop silently no-ops without a
  // `publicApiKey` configured (confirmed by reading the installed package's
  // own source, node_modules/@copilotkit/react-core/dist/copilotkit-ympAovXs.mjs's
  // `handleErrors`: `if (copilotApiConfig.publicApiKey && onErrorRef.current)`)
  // — this app is deliberately self-hosted with no license key, so that's a
  // dead end, not a viable way to observe agent errors client-side. Polling
  // the new GET /api/conversations/:id/last-error on the same turn-completion
  // signal below is an independent, backend-owned check that doesn't depend
  // on it.
  const [error, setError] = useState<string | null>(null);

  // Task 13 follow-up: fire `onTurnComplete` exactly on the true -> false edge of
  // `isLoading`, not merely "whenever isLoading is false" (which would also fire on
  // initial mount for a conversation that loads with isLoading already false).
  const wasLoadingRef = useRef(isLoading);
  // Bug fix (found in review): the last-error fetch had no ordering guard, unlike
  // the sibling history-seeding effect's `cancelled` flag. If the user sends a
  // follow-up message before a failed turn's last-error fetch resolves, `submit()`
  // clears `error` immediately — but the still-in-flight fetch from the PRIOR turn
  // would later call `setError()` unconditionally, and if it happens to resolve
  // after the new turn's own last-error check, it clobbers the fresh state with a
  // stale error banner for a turn that already succeeded (or is still running).
  // A monotonic request id, bumped by both a new turn's check and `submit()`,
  // lets each fetch's `.then()` recognize it's no longer the latest request and
  // discard its result instead of applying it.
  const lastErrorRequestIdRef = useRef(0);
  useEffect(() => {
    if (wasLoadingRef.current && !isLoading) {
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
    wasLoadingRef.current = isLoading;
  }, [isLoading, onTurnComplete, conversationId]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [visibleMessages.length]);

  const submit = () => {
    const text = draft.trim();
    if (!text || isLoading) return;
    setDraft("");
    setError(null);
    // Invalidates any last-error fetch still in flight from the turn just left
    // behind — see the request-id guard above.
    lastErrorRequestIdRef.current += 1;
    void appendMessage(new TextMessage({ content: text, role: Role.User }));
  };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div ref={listRef} style={{ flex: 1, overflowY: "auto", padding: "26px 0" }}>
        <div style={{ maxWidth: 780, width: "100%", margin: "0 auto", padding: "0 28px", display: "flex", flexDirection: "column", gap: 26 }}>
          {visibleMessages.length === 0 && (
            <div style={{ display: "flex", gap: 14 }}>
              <Avatar />
              <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6 }}>{GREETING}</p>
            </div>
          )}

          {visibleMessages.map((message) => {
            if (message.isTextMessage() && message.role === Role.User) {
              return (
                <div key={message.id} style={{ display: "flex", gap: 14, justifyContent: "flex-end" }}>
                  <div
                    style={{
                      maxWidth: "78%",
                      background: "var(--color-accent-100)",
                      border: "1px solid var(--color-divider)",
                      padding: "11px 14px",
                      fontSize: 14,
                      lineHeight: 1.5,
                    }}
                  >
                    {message.content}
                  </div>
                  <span
                    style={{
                      width: 30,
                      height: 30,
                      flex: "none",
                      display: "grid",
                      placeItems: "center",
                      background: "var(--color-neutral-800)",
                      color: "var(--color-bg)",
                      fontFamily: "var(--font-heading)",
                      fontSize: 12,
                    }}
                  >
                    AK
                  </span>
                </div>
              );
            }

            // Bug fix (live-usage report: real conversations doing multi-step bash
            // tool use — e.g. generating a PDF — showed a stack of empty chat
            // bubbles). Root-caused via direct DOM/data inspection (confirmed
            // backend data was correct and identical in shape for both working and
            // broken cases): @copilotkit/runtime-client-gql's own aguiToGQL()
            // unconditionally synthesizes a TextMessage for every assistant message
            // that has toolCalls — `content: message.content || ""` — even when
            // that message carries no text at all (a normal shape for a pure
            // tool-call turn, e.g. bash commands with no accompanying explanation).
            // ChatView has no control over that library-level behavior; skipping an
            // empty-content text bubble here is the fix, matching the same "never
            // render a bubble with nothing in it" rule adapter.ts and
            // toAGUIHistory() already apply server-side (which cover different
            // cases — this is a third, client-side-library-specific one).
            if (message.isTextMessage() && message.role === Role.Assistant && message.content.trim()) {
              return (
                <div key={message.id} style={{ display: "flex", gap: 14 }}>
                  <Avatar />
                  <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{message.content}</p>
                </div>
              );
            }

            // Artifacts-as-chat-attachments: render a publish_artifact tool call as a
            // clickable attachment chip instead of the generic "tool: {name}" chip
            // below — the tool's own args already carry everything needed to render
            // it (id/title/language, see server/src/artifacts/tools.ts's
            // defineTool parameters), no extra fetch required just to show the chip.
            // Clicking it opens the Canvas pinned to this exact artifact id
            // (App.tsx wires onOpenArtifact -> useShellState's actions.openArtifact),
            // even if a newer artifact has since become "latest" in this conversation.
            if (message.isActionExecutionMessage() && message.name === PUBLISH_ARTIFACT_TOOL_NAME) {
              const args = message.arguments as { id?: string; title?: string; language?: string };
              const artifactId = typeof args.id === "string" ? args.id : undefined;
              return (
                <div key={message.id} style={{ display: "flex", gap: 14 }}>
                  <Avatar />
                  <Blueprint
                    style={{ background: "transparent", cursor: artifactId ? "pointer" : "default" }}
                    onClick={artifactId ? () => onOpenArtifact?.(artifactId) : undefined}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px" }}>
                      <FileIcon size={14} />
                      <span style={{ fontFamily: "ui-monospace,'SF Mono',Menlo,monospace", fontSize: 12.5 }}>
                        {args.title ?? "Untitled artifact"}
                      </span>
                      {args.language && <span className="tag tag-accent">{args.language}</span>}
                    </div>
                  </Blueprint>
                </div>
              );
            }

            if (message.isActionExecutionMessage()) {
              return (
                <div key={message.id} style={{ display: "flex", gap: 14 }}>
                  <Avatar />
                  <Blueprint style={{ background: "transparent" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px" }}>
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--color-accent)", flex: "none" }} />
                      <span className="tag tag-accent">tool</span>
                      <span style={{ fontFamily: "ui-monospace,'SF Mono',Menlo,monospace", fontSize: 12.5 }}>{message.name}</span>
                    </div>
                  </Blueprint>
                </div>
              );
            }

            return null;
          })}

          {isLoading && (
            <div style={{ display: "flex", gap: 14 }}>
              <Avatar />
              <p style={{ margin: 0, fontSize: 15, color: "color-mix(in srgb, var(--color-text) 50%, transparent)" }}>Thinking…</p>
            </div>
          )}

          {!isLoading && error && (
            <div style={{ display: "flex", gap: 14 }}>
              <Avatar />
              <div
                style={{
                  maxWidth: "78%",
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
            </div>
          )}
        </div>
      </div>

      <div style={{ flex: "none", padding: "14px 28px 18px" }}>
        <div style={{ maxWidth: 780, margin: "0 auto" }}>
          <Blueprint style={{ background: "var(--color-surface)" }}>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="Message pi · @ to mention a skill, / for commands"
              style={{
                width: "100%",
                border: "none",
                background: "transparent",
                resize: "none",
                outline: "none",
                padding: "14px 14px 4px",
                font: "inherit",
                fontSize: 15,
                lineHeight: 1.5,
                color: "var(--color-text)",
                minHeight: 46,
              }}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px 10px" }}>
              <button className="btn btn-icon" disabled title="Attach a file (coming soon)">
                <AttachIcon size={16} />
              </button>
              <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
                {/* Bug found live via /tgd-verify: `model` used to default to a hardcoded
                 * fake name ("pi-2 Sonnet", src/state/useShellState.ts's old mock leftover)
                 * that rendered here verbatim even before any real model was ever selected —
                 * visibly inconsistent with MainHeader's own picker, which correctly showed
                 * the honest "Select model" empty state right above it. Now that the shared
                 * `model` value starts empty and only becomes real once a switch actually
                 * happens, render nothing rather than ever showing a fake label. */}
                {model && (
                  <span style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 42%, transparent)" }}>{model}</span>
                )}
                <button onClick={submit} disabled={isLoading || !draft.trim()} className="btn btn-primary btn-icon">
                  <SendIcon size={17} />
                </button>
              </div>
            </div>
          </Blueprint>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", marginTop: 9, padding: "0 2px" }}>
            <span style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 42%, transparent)" }}>
              Powered by <strong style={{ fontFamily: "var(--font-heading)", color: "var(--color-accent-800)" }}>CopilotKit</strong>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Avatar() {
  return (
    <span
      style={{
        width: 30,
        height: 30,
        flex: "none",
        display: "grid",
        placeItems: "center",
        background: "var(--color-accent)",
        color: "var(--color-bg)",
        fontFamily: "var(--font-heading)",
        fontWeight: 600,
        fontSize: 15,
      }}
    >
      π
    </span>
  );
}
