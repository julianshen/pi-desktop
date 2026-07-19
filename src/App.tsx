import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { AssistantChatTransport, useChatRuntime } from "@assistant-ui/react-ai-sdk";
import "./styles/design-system.css";
import "katex/dist/katex.min.css";
import { TitleBar } from "./components/TitleBar";
import { IconRail } from "./components/IconRail";
import { Sidebar } from "./components/Sidebar";
import { MainHeader } from "./components/MainHeader";
import { ArtifactCanvas } from "./views/ArtifactCanvas";
import { ChatView } from "./views/ChatView";
import { ArtifactStoreView } from "./views/ArtifactStoreView";
import { ScheduledTasksView } from "./views/ScheduledTasksView";
import { CodingAgentsView } from "./views/CodingAgentsView";
import { McpServersView } from "./views/McpServersView";
import { SkillsLibraryView } from "./views/SkillsLibraryView";
import { SettingsView } from "./views/SettingsView";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShellState, type ViewKey } from "./state/useShellState";
import { useConversations } from "./state/useConversations";
import { API_BASE } from "./state/apiBase.js";
import { renderUrlHeadless } from "./lib/headlessRender.js";
import { getResolveToken } from "./lib/resolveToken.js";
import { prepareAttachmentRequestBody } from "./state/attachmentDrafts.js";
import { useActiveRun } from "./hooks/useActiveRun.js";
import { AgentWorkSurface } from "./components/chat/AgentWorkSurface.js";

/**
 * Task 10 (SPEC.md's "Headless render bridge" section). Public shape returned
 * by `GET /api/conversations/:id/pending-interaction` (server/src/web-fetch/
 * pending-interactions.ts's `getPending()`) — only the fields this watcher
 * cares about. `host` (confirm-kind) is intentionally omitted: Task 8's
 * approval chip in ChatView.tsx owns that kind, this effect only ever reads
 * `url`/`timeoutMs` off a `kind: "render"` interaction.
 */
interface PendingInteractionPublic {
  id: string;
  kind: "confirm" | "render";
  url?: string;
  timeoutMs: number;
}

/**
 * Poll interval while this effect watches for a pending interaction.
 * SPEC.md's "Getting the pending interaction to the frontend — RESOLVED:
 * poll" section calls for "every 400-600ms... to keep the [interaction] flow
 * feeling responsive despite polling" for exactly this reason: a real tool
 * call (`web_fetch`) is synchronously blocked waiting on this endpoint's
 * answer for the whole time an interaction is pending, unlike the once-per-
 * turn `last-error` poll elsewhere in this app.
 */
const PENDING_INTERACTION_POLL_MS = 500;

/**
 * Task 10 (AC-10.1/AC-10.2): silently services `kind: "render"` pending
 * interactions for `conversationId` — no visible UI of its own, ever. Called
 * from `App()` below (not `ChatView.tsx`) so it keeps polling no matter which
 * view/tab is currently showing, per SPEC.md's "Headless render bridge"
 * section: a `web_fetch` tool call could be sitting blocked on this exact
 * interaction while the user is looking at Settings or any other view.
 *
 * `kind: "confirm"` interactions are deliberately left alone here — Task 8's
 * approval chip (ChatView.tsx) owns that path entirely; this effect only ever
 * acts when `interaction.kind === "render"` and otherwise no-ops.
 *
 * Exported (rather than kept as an inline effect) purely so App.test.tsx can
 * exercise it directly via `@testing-library/react`'s `renderHook()`, without
 * needing to mount the rest of the app shell (CopilotKit, every view, the
 * design-system CSS import aside) — this hook has no rendering output of its
 * own to assert against, only network side effects.
 */
export function usePendingRenderInteractionWatcher(conversationId: string): void {
  const inFlightRenderIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;

    async function poll() {
      let interaction: PendingInteractionPublic | null;
      try {
        const res = await fetch(`${API_BASE}/api/conversations/${conversationId}/pending-interaction`);
        if (!res.ok) return;
        const body = (await res.json()) as { interaction: PendingInteractionPublic | null };
        interaction = body.interaction;
      } catch (error: unknown) {
        console.error("[App] failed to poll pending-interaction", error);
        return;
      }

      if (cancelled || !interaction || interaction.kind !== "render") return;

      // No-double-fire guard: once an interaction id has been picked up here,
      // don't dispatch a second renderUrlHeadless()/resolve() for it on a
      // later poll tick that fires before this one's resolve POST completes.
      if (inFlightRenderIdsRef.current.has(interaction.id)) return;
      inFlightRenderIdsRef.current.add(interaction.id);

      // renderUrlHeadless() never throws (see headlessRender.ts) — `html` is
      // always a definite `string | null`, so the resolve POST below always
      // fires with an honest answer, success or failure alike (AC-10.2).
      const html = await renderUrlHeadless(interaction.url ?? "", interaction.timeoutMs);
      if (cancelled) return;

      try {
        // ADR-001: attach the resolve-endpoint auth token this watcher shares with
        // ChatView.tsx's approval chip (both funnel through the same memoized
        // getResolveToken()). `token` may be `null` here (genuinely no token
        // available anywhere) — this silent background watcher has no UI to show a
        // degraded state in (per its own doc comment above), so it still sends the
        // request; the server will correctly 401 it in that case, matching the
        // "no header at all" behavior a missing/null token implies.
        const token = await getResolveToken();
        const res = await fetch(`${API_BASE}/api/conversations/${conversationId}/pending-interaction/${interaction.id}/resolve`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token !== null ? { "X-Resolve-Token": token } : {}),
          },
          body: JSON.stringify({ html }),
        });
        if (!res.ok) {
          // ADR-001: a 401 here means the render-kind pending interaction was
          // NEVER actually resolved (the web_fetch tool call it belongs to is
          // still blocked server-side) — distinguish it from other failures since
          // there's no chip anywhere to surface this to a human, only this log.
          console.error(
            res.status === 401
              ? "[App] resolve request rejected: missing/mismatched X-Resolve-Token (ADR-001) — render interaction was not resolved"
              : `[App] resolve request failed with status ${res.status} — render interaction was not resolved`,
          );
        }
      } catch (error: unknown) {
        console.error("[App] failed to resolve render interaction", error);
      }
    }

    void poll();
    const timer = setInterval(() => void poll(), PENDING_INTERACTION_POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [conversationId]);
}

/**
 * Task 6 (TASKS.md / AC-6.1 / AC-6.2): builds Assistant UI's runtime, replacing
 * the old `<CopilotKit runtimeUrl={RUNTIME_URL} ...>` wrapper. Points at Task
 * 5's new per-conversation route (`POST /api/conversations/:id/chat`,
 * `server/src/index.ts`) rather than a single global endpoint.
 *
 * Per-conversation routing mechanism, and why it differs from the
 * CopilotKit-era fix: the Task 12 critical-bug comment on `<ChatView>` in
 * `App()` below documents that CopilotKit's own `agent` singleton (owned by
 * the un-remounted `<CopilotKit>` provider that used to wrap this tree) kept
 * reusing ONE `threadId` across every conversation, which required both a
 * `key={state.activeConv}` remount of `ChatView` AND an explicit
 * `useThreads().setThreadId()` push to fix. That fix doesn't map 1:1 here,
 * and isn't needed here: the `AssistantChatTransport` below is reconstructed
 * fresh whenever `conversationId` changes (`useMemo`), and `useChatRuntime`
 * itself doesn't require a remount to pick that up — verified against the
 * installed `@assistant-ui/react-ai-sdk@1.3.40` source
 * (`node_modules/@assistant-ui/react-ai-sdk/dist/ui/use-chat/useChatRuntime.js`,
 * `useDynamicChatTransport`): it wraps whatever `transport` object is passed
 * in behind a `Proxy` backed by a `ref` that a `useEffect` updates to the
 * latest transport after every render, so the *next* HTTP request always
 * reads the current `.api` URL — no `key`/remount required. This is a
 * genuinely simpler situation than CopilotKit's: each conversation now gets
 * a distinct server ROUTE (not just a distinct `threadId` value sent to one
 * shared route), so there's no shared-singleton state for a stale `api`
 * string to leak through.
 *
 * Scope note: this only proves the transport points at the right ROUTE per
 * conversation (this task's actual responsibility — see AC-6.2's own doc
 * comment in App.test.tsx). Full end-to-end cross-conversation message-
 * content isolation also depends on Assistant UI's own thread-list/thread-
 * switching model inside `ChatView.tsx`, which this task deliberately does
 * not touch (Task 8 rebuilds `ChatView.tsx` and re-verifies the full
 * regression there).
 *
 * Exported (rather than kept as an inline call in `App()`) for the same
 * reason `usePendingRenderInteractionWatcher` above is exported: it lets
 * App.test.tsx exercise this wiring directly via `renderHook()` without
 * mounting the rest of the app shell. At the time this hook was written
 * (Task 6), `ChatView.tsx` still called `@copilotkit/react-core`'s hooks
 * directly and threw with no `<CopilotKit>` provider in the tree, which made
 * a full `render(<App />)` unusable as a test vehicle until Task 8 rebuilt
 * `ChatView.tsx` onto Assistant UI. Task 8 has since landed and
 * `ChatView.tsx` no longer has that dependency (deleted CopilotKit stack
 * confirmed by /tgd-review remediation), but the exported-hook test shape
 * established here was kept rather than churned just because the original
 * reason for it no longer applies.
 */
export function useAssistantChatRuntime(conversationId: string) {
  const transport = useMemo(
    () => new AssistantChatTransport({
      api: `${API_BASE}/api/conversations/${conversationId}/chat`,
      prepareSendMessagesRequest: (options) => ({
        body: prepareAttachmentRequestBody(conversationId, options),
      }),
    }),
    [conversationId],
  );
  return useChatRuntime({ transport });
}

const WINDOW_TITLES: Record<ViewKey, string> = {
  chat: "Chat",
  artifacts: "Artifact Store",
  scheduled: "Scheduled Tasks",
  coding: "Coding Agents",
  mcp: "MCP Servers",
  skills: "Skills Library",
  settings: "Settings",
};

function App() {
  const { state, actions, railViews } = useShellState();
  const showCanvas = state.view === "chat" && state.artifactOpen;
  // Task 10: single useConversations() call, lifted here (not called inside
  // Sidebar) so it can be shared by whichever other views end up needing the same
  // fetched conversation list/active id (MainHeader/ChatView/ArtifactCanvas are
  // landing concurrently) without triggering independent, out-of-sync fetches.
  // "Active conversation" itself stays driven by useShellState's existing
  // `activeConv`/`setActiveConv` (unchanged below) rather than this hook's own
  // `activeId` — Sidebar reconciles the two by calling `onSelectConv` whenever a
  // conversation is selected or created, so ArtifactCanvas's pre-existing
  // `conversationId={state.activeConv}` wiring keeps working unmodified.
  const conversations = useConversations();
  const activeRun = useActiveRun(state.activeConv);

  // Task 13 follow-up (now resolved): ArtifactCanvas's `refreshSignal` fires when
  // ChatView's isLoading transitions true -> false, i.e. once per completed chat turn.
  // A simple incrementing counter, bumped from ChatView's `onTurnComplete` callback and
  // passed straight through to ArtifactCanvas, is enough — ArtifactCanvas only cares
  // that the value *changed*, not what it is.
  const [turnCompleteCount, setTurnCompleteCount] = useState(0);

  const handleTurnComplete = () => {
    setTurnCompleteCount((n) => n + 1);
    // The backend auto-derives a conversation's title from its first message once a
    // turn completes (server/src/agui/adapter.ts's touchConversationAfterTurn) — but
    // useConversations() only fetches once on mount, so without this the Sidebar kept
    // showing "New conversation" forever. Same signal ArtifactCanvas already reacts to.
    void conversations.refetch();
  };

  // Task 10 (AC-10.1/AC-10.2): silently services `kind: "render"` pending
  // interactions for the ACTIVE conversation. Lives HERE, not ChatView.tsx,
  // because per SPEC.md this must keep running no matter which view/tab is
  // currently showing — a `web_fetch` tool call could be sitting blocked on
  // this exact interaction while the user is looking at Settings or any other
  // view, not just Chat.
  usePendingRenderInteractionWatcher(state.activeConv);

  const runtime = useAssistantChatRuntime(state.activeConv);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div
        style={{
          width: "100%",
          height: "100vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--color-bg)",
          color: "var(--color-text)",
          fontFamily: "var(--font-body)",
          overflow: "hidden",
        }}
      >
        <TitleBar windowTitle={WINDOW_TITLES[state.view]} />

        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <IconRail items={railViews} view={state.view} onSelect={actions.go} onSettings={() => actions.go("settings")} />

          <Sidebar
            view={state.view}
            activeConv={state.activeConv}
            onSelectConv={actions.setActiveConv}
            activeFilter={state.activeFilter}
            onSelectFilter={actions.setActiveFilter}
            settingsSection={state.settingsSection}
            onSelectSettingsSection={actions.setSettingsSection}
            conversations={conversations}
          />

          <div style={{ flex: 1, display: "flex", minWidth: 0, position: "relative" }}>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
              <MainHeader state={state} actions={actions} conversations={conversations} />

              {/* Task 12 critical-bug fix (historical, CopilotKit era): `key={state.activeConv}` alone
                  did NOT scope which server-side thread ChatView talked to — CopilotKit's `agent`
                  singleton (owned by the un-remounted <CopilotKit> that used to wrap this tree) kept
                  sending the SAME threadId for every conversation, requiring an explicit
                  `useThreads().setThreadId()` push alongside the `key` remount to fix (pre-Task-6
                  mechanism, no longer present in the code).
                  Task 6 (TASKS.md) replaced the `<CopilotKit>` provider above with
                  `<AssistantRuntimeProvider>` (see that construction's own doc comment above), and Task 8
                  rebuilt ChatView.tsx onto Assistant UI entirely — it no longer imports
                  `@copilotkit/react-core` at all. Per-conversation isolation is now handled by
                  `useAssistantChatRuntime()` routing each conversation to its own server route
                  (`POST /api/conversations/:id/chat`) rather than a shared threadId, so there is no
                  `setThreadId()`-equivalent push to make. The `key` remount here is kept regardless —
                  it still usefully resets ChatView's own local UI state (draft text, scroll position)
                  and effect ref bookkeeping per conversation switch. */}
              {state.view === "chat" && (
                <AgentWorkSurface
                  state={activeRun}
                  conversationId={state.activeConv}
                  renderChat={(composerBoundaryRef) => (
                    <ChatView
                      key={state.activeConv}
                      model={state.model}
                      conversationId={state.activeConv}
                      composerBoundaryRef={composerBoundaryRef}
                      onTurnComplete={handleTurnComplete}
                      onOpenArtifact={actions.openArtifact}
                    />
                  )}
                />
              )}
              {state.view === "artifacts" && <ArtifactStoreView />}
              {state.view === "scheduled" && (
                <ScheduledTasksView
                  taskOpen={state.taskOpen}
                  taskCreate={state.taskCreate}
                  onOpenTask={actions.openTask}
                  onBackToTasks={actions.backToTasks}
                  onCloseCreate={actions.closeTaskCreate}
                />
              )}
              {state.view === "coding" && <CodingAgentsView />}
              {state.view === "mcp" && <McpServersView />}
              {state.view === "skills" && <SkillsLibraryView />}
              {state.view === "settings" && <SettingsView section={state.settingsSection} />}
            </div>

            {showCanvas && (
              <ArtifactCanvas
                tab={state.canvasTab}
                onSetTab={actions.setCanvasTab}
                onClose={actions.toggleArtifact}
                conversationId={state.activeConv}
                refreshSignal={turnCompleteCount}
                pinnedArtifactId={state.canvasArtifactId}
              />
            )}
          </div>
        </div>
      </div>
    </AssistantRuntimeProvider>
  );
}

export default App;
