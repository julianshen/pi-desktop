import { useCallback, useState } from "react";

export type ViewKey = "chat" | "artifacts" | "scheduled" | "coding" | "mcp" | "skills" | "settings";
export type SettingsSection = "providers" | "models";
export type CanvasTab = "code" | "preview";

const DEFAULT_FILTER: Partial<Record<ViewKey, string>> = {
  artifacts: "All",
  scheduled: "All",
  mcp: "All",
  skills: "All",
  coding: "pi-agent-web",
};

export interface ShellState {
  view: ViewKey;
  activeConv: string;
  artifactOpen: boolean;
  canvasTab: CanvasTab;
  modelOpen: boolean;
  model: string;
  activeFilter: string;
  settingsSection: SettingsSection;
  taskOpen: number | null;
  taskCreate: boolean;
}

export interface ShellActions {
  go: (view: ViewKey) => void;
  setActiveConv: (id: string) => void;
  toggleArtifact: () => void;
  openArtifact: () => void;
  setCanvasTab: (tab: CanvasTab) => void;
  toggleModelMenu: () => void;
  setModel: (name: string) => void;
  setActiveFilter: (label: string) => void;
  setSettingsSection: (section: SettingsSection) => void;
  openTask: (index: number) => void;
  backToTasks: () => void;
  openTaskCreate: () => void;
  closeTaskCreate: () => void;
}

const RAIL_VIEWS: { key: ViewKey; label: string }[] = [
  { key: "chat", label: "Chat" },
  { key: "artifacts", label: "Store" },
  { key: "scheduled", label: "Tasks" },
  { key: "coding", label: "Code" },
  { key: "mcp", label: "MCP" },
  { key: "skills", label: "Skills" },
];

export function useShellState(initialView: ViewKey = "chat") {
  const [state, setState] = useState<ShellState>({
    view: initialView,
    activeConv: "c1",
    artifactOpen: true,
    canvasTab: "code",
    modelOpen: false,
    model: "pi-2 Sonnet",
    activeFilter: DEFAULT_FILTER[initialView] ?? "All",
    settingsSection: "providers",
    taskOpen: null,
    taskCreate: false,
  });

  const go = useCallback((view: ViewKey) => {
    setState((s) => ({
      ...s,
      view,
      activeFilter: DEFAULT_FILTER[view] ?? "All",
      modelOpen: false,
      taskOpen: null,
      taskCreate: false,
    }));
  }, []);

  const actions: ShellActions = {
    go,
    setActiveConv: (id) => setState((s) => ({ ...s, activeConv: id })),
    toggleArtifact: () => setState((s) => ({ ...s, artifactOpen: !s.artifactOpen })),
    openArtifact: () => setState((s) => ({ ...s, artifactOpen: true })),
    setCanvasTab: (tab) => setState((s) => ({ ...s, canvasTab: tab })),
    toggleModelMenu: () => setState((s) => ({ ...s, modelOpen: !s.modelOpen })),
    setModel: (name) => setState((s) => ({ ...s, model: name, modelOpen: false })),
    setActiveFilter: (label) => setState((s) => ({ ...s, activeFilter: label })),
    setSettingsSection: (section) => setState((s) => ({ ...s, settingsSection: section })),
    openTask: (index) => setState((s) => ({ ...s, taskOpen: index })),
    backToTasks: () => setState((s) => ({ ...s, taskOpen: null })),
    openTaskCreate: () =>
      setState((s) => (s.view === "scheduled" ? { ...s, taskCreate: true, taskOpen: null } : s)),
    closeTaskCreate: () => setState((s) => ({ ...s, taskCreate: false })),
  };

  return { state, actions, railViews: RAIL_VIEWS };
}
