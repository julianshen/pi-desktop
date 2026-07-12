import { useEffect, useRef, useState } from "react";
import { useCopilotChat, useThreads } from "@copilotkit/react-core";
import { Role, TextMessage } from "@copilotkit/runtime-client-gql";
import { Blueprint } from "../components/Blueprint";
import { AttachIcon, SendIcon } from "../components/icons";

const GREETING =
  "Hi! I'm pi, your desktop agent. Ask me anything — I can use tools, skills, MCP servers, and remember things across conversations.";

export function ChatView({ model, conversationId }: { model: string; conversationId: string }) {
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
  // Known remaining gap (does NOT fully satisfy "switching back replays prior history"):
  // the installed `HttpAgent` has no `connect()` implementation (@ag-ui/client's
  // `AbstractAgent.connect()` throws `AGUIConnectNotImplementedError` unless a transport
  // overrides it), and this server exposes no message-history endpoint — so the
  // isFreshRestore clear above has nothing to refill from. Switching back to a
  // conversation resets the visible transcript to empty even though the server's pi
  // session still has full history and will use it correctly on the next turn. Fixing
  // that needs new backend surface (a history endpoint + a way to seed `agent.messages`),
  // tracked separately — out of scope for this routing fix.
  const { setThreadId } = useThreads();
  useEffect(() => {
    setThreadId(conversationId);
  }, [conversationId, setThreadId]);

  const { visibleMessages: rawMessages, appendMessage, isLoading } = useCopilotChat();
  const visibleMessages = rawMessages ?? [];
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [visibleMessages.length]);

  const submit = () => {
    const text = draft.trim();
    if (!text || isLoading) return;
    setDraft("");
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

            if (message.isTextMessage() && message.role === Role.Assistant) {
              return (
                <div key={message.id} style={{ display: "flex", gap: 14 }}>
                  <Avatar />
                  <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{message.content}</p>
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
                <span style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 42%, transparent)" }}>{model}</span>
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
