import { useCallback, useState } from "react";

export type ViewKey = "chat" | "artifacts" | "scheduled" | "coding" | "mcp" | "skills" | "settings";
export type SettingsSection = "providers" | "models" | "search";
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
  /**
   * Which artifact the Canvas is pinned to, or null to show the conversation's
   * latest published artifact (the pre-existing default behavior). Set by clicking
   * a `publish_artifact` attachment chip in the chat transcript (ChatView.tsx) so
   * the Canvas opens to the exact artifact that chip represents, even if a newer
   * one has since been published in the same conversation.
   */
  canvasArtifactId: string | null;
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
  /** Opens the Canvas. Pass an artifact id to pin it to that specific artifact; omit to show the latest. */
  openArtifact: (artifactId?: string) => void;
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
    // "default" is always a safe, correct initial conversation id: it maps 1:1 to
    // env.workspaceDir (server/src/agent/conversations.ts's conversationCwd()) and is
    // lazily registered by ensureDefaultConversation() on first touch regardless of
    // whether GET /api/conversations has returned yet. It must NEVER be a mock id like
    // "c1" (src/data/mockData.ts) — that was a real production bug (AC-12.2 regression):
    // App.tsx renders ChatView/ArtifactCanvas keyed on this value before any real fetch
    // completes, and the server has no registry-membership check, so an unrecognized id
    // silently spins up a brand-new empty session instead of resolving to the user's
    // real history.
    activeConv: "default",
    // Closed by default: most turns don't publish an artifact, so opening the
    // Canvas unconditionally on every launch showed "Nothing published to the
    // canvas yet" far more often than real content. Users open it explicitly via
    // MainHeader's Canvas button, or implicitly by clicking a publish_artifact
    // chat attachment chip (ChatView.tsx's onOpenArtifact -> actions.openArtifact).
    artifactOpen: false,
    canvasArtifactId: null,
    canvasTab: "code",
    modelOpen: false,
    // Empty, not a fake name like the old "pi-2 Sonnet" mock leftover: there is no
    // server-exposed "default model" concept (GET /api/models's ModelSummary is just
    // { id, label, provider } — no current/default flag), so the only real "current
    // model" is MainHeader's own per-conversation `modelId` lookup, which it already
    // owns and renders locally. Until a real switch happens (MainHeader.tsx's
    // handleSelectModel success path calls actions.setModel), this must stay honestly
    // empty rather than show a name nothing configured. ChatView.tsx's composer
    // footer renders nothing when this is falsy instead of ever showing a fake label
    // (bug found live via /tgd-verify: the real MainHeader picker showed "Select
    // model" while this composer footer simultaneously showed the fake
    // "pi-2 Sonnet" underneath it).
    model: "",
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
    // Switching conversations invalidates any pinned artifact id — it belongs to
    // the conversation being left, and the new one should default to showing its
    // own latest artifact rather than silently carrying over a stale pin.
    setActiveConv: (id) => setState((s) => ({ ...s, activeConv: id, canvasArtifactId: null })),
    // Only clears the pin when actually reopening a closed Canvas (s.artifactOpen
    // was false) — this is the generic Canvas toggle button in MainHeader, which
    // should always land on "latest", not whatever a previous chip click pinned.
    // Closing an already-open, pinned Canvas leaves the pin alone since it's not
    // visible either way.
    toggleArtifact: () =>
      setState((s) => ({
        ...s,
        artifactOpen: !s.artifactOpen,
        canvasArtifactId: s.artifactOpen ? s.canvasArtifactId : null,
      })),
    openArtifact: (artifactId) => setState((s) => ({ ...s, artifactOpen: true, canvasArtifactId: artifactId ?? null })),
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
