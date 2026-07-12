import { CopilotKit } from "@copilotkit/react-core";
import "./styles/design-system.css";
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
import { useShellState, type ViewKey } from "./state/useShellState";
import { useConversations } from "./state/useConversations";

const RUNTIME_URL = import.meta.env.VITE_COPILOTKIT_RUNTIME_URL ?? "http://127.0.0.1:4319/copilotkit";

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

  return (
    <CopilotKit runtimeUrl={RUNTIME_URL} showDevConsole={false} enableInspector={false}>
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

          <div style={{ flex: 1, display: "flex", minWidth: 0 }}>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
              <MainHeader state={state} actions={actions} conversations={conversations} />

              {/* Task 12 critical-bug fix: `key={state.activeConv}` alone does NOT scope which
                  server-side thread ChatView talks to — CopilotKit's `agent` singleton (owned by
                  the un-remounted <CopilotKit> above) previously kept sending the SAME threadId
                  for every conversation. ChatView now also receives `conversationId` and pushes it
                  onto that singleton via `useThreads().setThreadId()` (see ChatView.tsx's call-site
                  comment for the full mechanism). The `key` remount is kept alongside it — it still
                  usefully resets ChatView's own local UI state (draft text, scroll position) and the
                  connect-effect's ref bookkeeping per switch. */}
              {state.view === "chat" && <ChatView key={state.activeConv} model={state.model} conversationId={state.activeConv} />}
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
              // `refreshSignal` intentionally left unwired here (Task 13 follow-up): it
              // should fire when ChatView's isLoading transitions true -> false, but
              // ChatView.tsx's isLoading is owned by the concurrently-landing Task 12.
              <ArtifactCanvas
                tab={state.canvasTab}
                onSetTab={actions.setCanvasTab}
                onClose={actions.toggleArtifact}
                conversationId={state.activeConv}
              />
            )}
          </div>
        </div>
      </div>
    </CopilotKit>
  );
}

export default App;
