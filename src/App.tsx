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
          />

          <div style={{ flex: 1, display: "flex", minWidth: 0 }}>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
              <MainHeader state={state} actions={actions} />

              {state.view === "chat" && <ChatView model={state.model} />}
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
              <ArtifactCanvas tab={state.canvasTab} onSetTab={actions.setCanvasTab} onClose={actions.toggleArtifact} />
            )}
          </div>
        </div>
      </div>
    </CopilotKit>
  );
}

export default App;
