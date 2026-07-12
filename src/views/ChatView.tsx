import { useEffect, useRef, useState } from "react";
import { useCopilotChat } from "@copilotkit/react-core";
import { Role, TextMessage } from "@copilotkit/runtime-client-gql";
import { Blueprint } from "../components/Blueprint";
import { AttachIcon, SendIcon } from "../components/icons";

const GREETING =
  "Hi! I'm pi, your desktop agent. Ask me anything — I can use tools, skills, MCP servers, and remember things across conversations.";

export function ChatView({ model }: { model: string }) {
  // Task 12: verified against the installed @copilotkit/react-core (1.62.3) dist/index.mjs
  // that `useCopilotChat`'s runtime implementation destructures/returns only
  // { visibleMessages, appendMessage, reloadMessages, stopGeneration, reset, isLoading,
  // isAvailable, runChatCompletion, mcpServers, setMcpServers } — `UseCopilotChatOptions.id`
  // is declared in the .d.ts but is never read by useCopilotChatInternal, and neither
  // `agent` nor `threadId` are exposed on this hook's return despite appearing on the
  // richer UseCopilotChatReturn$1 type (that's the Enterprise `useCopilotChatHeadless_c`
  // hook's shape, not this one's). So there is no real thread-scoping parameter to pass
  // here; App.tsx instead remounts this component via `key={state.activeConv}` so at
  // least this component's own local UI state (draft text, scroll position) resets per
  // conversation switch. See Task 12's completion report for the caveat this doesn't
  // fully guarantee: with the installed CopilotKit version, the underlying agent handle
  // is a singleton owned above this component (registered once per `agentId` in
  // CopilotKit core), so it isn't itself recreated by this remount.
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
