import { useEffect, useState } from "react";
import { CanvasIcon, CheckIcon, ChevronDownIcon, PlusIcon, SearchIcon } from "./icons";
import { filterConfig } from "../data/mockData";
import type { ShellActions, ShellState, ViewKey } from "../state/useShellState";
import type { UseConversationsResult } from "../state/useConversations";
import { API_BASE } from "../state/apiBase";

/** Mirrors server/src/agent/models.ts's ModelSummary exactly (Task 11). */
interface ModelSummary {
  id: string;
  label: string;
  provider: string;
}

// "chat" is intentionally absent here now — its crumb/title are derived from the
// active conversation's real title below (Task 11, AC-11.3), not a hardcoded string.
const CRUMBS: Partial<Record<ViewKey, string>> = {
  artifacts: "Workspace / Artifacts",
  scheduled: "Automation / Scheduled",
  coding: "Development / Agents",
  mcp: "Connections / MCP",
  skills: "Library / Skills",
  settings: "Account / Settings",
};

const MAIN_TITLES: Partial<Record<ViewKey, string>> = {
  artifacts: "Artifact Store",
  scheduled: "Scheduled Tasks",
  coding: "Coding Agents",
  mcp: "MCP Servers",
  skills: "Skills Library",
  settings: "Settings",
};

const SEARCH_HINTS: Partial<Record<ViewKey, string>> = {
  artifacts: "Filter artifacts",
  scheduled: "Filter tasks",
  coding: "Filter runs",
  mcp: "Filter servers",
  skills: "Search skills",
};

const PRIMARY_ACTIONS: Partial<Record<ViewKey, string>> = {
  artifacts: "New",
  scheduled: "New schedule",
  coding: "New task",
  mcp: "Add server",
  skills: "New skill",
};

export function MainHeader({
  state,
  actions,
  conversations,
}: {
  state: ShellState;
  actions: ShellActions;
  /** Task 9's hook result, lifted to App.tsx (Task 10) so it fetches once and is
   * shared across Sidebar/MainHeader instead of each component re-fetching. */
  conversations: UseConversationsResult;
}) {
  const { view } = state;
  const isChat = view === "chat";
  const isSettings = view === "settings";
  const isFiltered = !isChat && !isSettings;

  // `state.activeConv` is App.tsx's canonical "active conversation id" (same field
  // Sidebar/ArtifactCanvas already key off of — see Sidebar.tsx's comment on its own
  // `activeConv` prop). Falling back to the first fetched conversation covers the
  // window before anything has been explicitly selected (useShellState's initial
  // `activeConv` is a mock id that won't match any real conversation).
  const activeConversation =
    conversations.conversations.find((c) => c.id === state.activeConv) ?? conversations.conversations[0];

  const [models, setModels] = useState<ModelSummary[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  // The provider-model-settings feature's Settings > Providers view lets a provider
  // be connected/disconnected from a completely separate component with no direct
  // channel back to this one. Without a refetch trigger, connecting a provider there
  // then returning to Chat left this model list stuck at whatever it was on first
  // mount (often empty, if no provider was connected yet when the app first loaded)
  // — the picker showed zero options until a full app reload. Re-fetching on every
  // `state.view` change is the same "refetch on a meaningful signal" pattern already
  // used for conversation titles/artifacts elsewhere in this app; cheap enough to run
  // on every navigation.
  const [defaultModelId, setDefaultModelId] = useState<string | null>(null);

  // AC-11.1: fetch the real model list instead of importing mockData's hardcoded
  // `models` array. Depends on `view` (see comment above `defaultModelId`) rather
  // than running once on mount only.
  useEffect(() => {
    let cancelled = false;
    setModelsLoading(true);

    Promise.all([
      fetch(`${API_BASE}/api/models`).then((res) => {
        if (!res.ok) throw new Error(`GET /api/models failed: ${res.status}`);
        return res.json() as Promise<ModelSummary[]>;
      }),
      fetch(`${API_BASE}/api/settings/default-model`).then((res) => {
        if (!res.ok) throw new Error(`GET /api/settings/default-model failed: ${res.status}`);
        return res.json() as Promise<{ provider: string | null; model: string | null }>;
      }),
    ])
      .then(([modelData, defaultModelData]) => {
        if (cancelled) return;
        setModels(modelData);
        // /api/settings/default-model returns { provider, model } as separate bare
        // fields (provider-model-settings' own convention), but /api/models' `id`
        // is the combined `${provider}/${model.id}` form (models.ts's
        // listAvailableModels()) — comparing the bare `model` field directly against
        // `models[].id` never matches. Reconstruct the combined form here.
        setDefaultModelId(
          defaultModelData.provider && defaultModelData.model ? `${defaultModelData.provider}/${defaultModelData.model}` : null,
        );
        setModelsLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error("[MainHeader] failed to load models", err);
        setModelsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [view]);

  // Once the model list and the active conversation are both available, show that
  // conversation's real model selection — falling back to the real global default
  // configured via Settings > Model Defaults (never an arbitrary `models[0]`, which
  // could display a different model than what a fresh conversation will actually
  // use). Skipped while a switch is in flight so it can't clobber the
  // optimistic-looking "Switching model…" state.
  useEffect(() => {
    if (modelsLoading || switching || models.length === 0) return;
    const fromConversation = activeConversation?.modelId;
    if (fromConversation && models.some((m) => m.id === fromConversation)) {
      setSelectedModelId(fromConversation);
    } else if (defaultModelId && models.some((m) => m.id === defaultModelId)) {
      setSelectedModelId(defaultModelId);
    } else {
      setSelectedModelId(null);
    }
  }, [modelsLoading, switching, models, activeConversation?.modelId, defaultModelId]);

  const selectedModel = models.find((m) => m.id === selectedModelId);

  // AC-11.2: selecting a different model shows the pulsing "Switching model…"
  // state, PATCHes the active conversation's model, then updates to the new
  // model id on success. On failure the selection reverts and an inline error is
  // shown (DESIGN.md: "do not silently revert without telling the user").
  function handleSelectModel(modelId: string) {
    actions.toggleModelMenu();
    if (!activeConversation || modelId === selectedModelId) return;

    const previous = selectedModelId;
    setSwitchError(null);
    setSwitching(true);

    fetch(`${API_BASE}/api/conversations/${activeConversation.id}/model`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`PATCH /api/conversations/:id/model failed: ${res.status}`);
        return res.json();
      })
      .then(() => {
        setSelectedModelId(modelId);
        setSwitching(false);
        // Bug fix (found in final review): this only ever updated MainHeader's own
        // local `selectedModelId`/`selectedModel` state, never useShellState's shared
        // `state.model` — so ChatView's composer footer (`<span>{model}</span>`, which
        // reads `state.model` directly) stayed stuck on the initial placeholder label
        // forever, even after a successful switch here. Push the newly active model's
        // display label into shell state too so every consumer of `state.model` agrees
        // with what MainHeader itself is now showing.
        const newModel = models.find((m) => m.id === modelId);
        actions.setModel(newModel?.label ?? modelId);
      })
      .catch((err: unknown) => {
        console.error("[MainHeader] failed to switch model", err);
        setSelectedModelId(previous);
        setSwitching(false);
        setSwitchError("Couldn't switch model — try again.");
      });
  }

  const modelLabel = modelsLoading ? "Loading models…" : switching ? "Switching model…" : (selectedModel?.label ?? "Select model");

  // AC-11.3: real active-conversation title, never the hardcoded "July investor update".
  const crumbText = isChat ? `Chat / ${activeConversation?.title ?? "Chat"}` : (CRUMBS[view] ?? "");
  const titleText = isChat ? (activeConversation?.title ?? "Chat") : (MAIN_TITLES[view] ?? "");

  return (
    <div style={{ height: 52, flex: "none", display: "flex", alignItems: "center", gap: 14, padding: "0 20px", borderBottom: "1px solid var(--color-divider)" }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 11, letterSpacing: "0.02em", color: "color-mix(in srgb, var(--color-text) 45%, transparent)" }}>
          {crumbText}
        </div>
        <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 17, lineHeight: 1.1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {titleText}
        </div>
      </div>

      {isChat && (
        <>
          <div style={{ position: "relative" }}>
            <button
              onClick={actions.toggleModelMenu}
              disabled={modelsLoading}
              aria-label="Model picker"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                height: 32,
                padding: "0 10px",
                border: "1px solid var(--color-divider)",
                background: "transparent",
                color: "var(--color-text)",
                cursor: modelsLoading ? "default" : "pointer",
                fontFamily: "var(--font-heading)",
                fontWeight: 600,
                fontSize: 13,
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: switching ? "var(--color-accent-300)" : "var(--color-accent)",
                  animation: switching ? "pulse 0.8s infinite" : undefined,
                }}
              />
              {modelLabel}
              <ChevronDownIcon size={13} />
            </button>
            {state.modelOpen && !modelsLoading && (
              <div
                style={{
                  position: "absolute",
                  top: 38,
                  right: 0,
                  width: 240,
                  background: "var(--color-bg)",
                  border: "1px solid var(--color-divider)",
                  boxShadow: "var(--shadow-lg)",
                  zIndex: 20,
                  padding: 5,
                }}
              >
                {models.map((m) => {
                  const on = m.id === selectedModelId;
                  return (
                    <button
                      key={m.id}
                      onClick={() => handleSelectModel(m.id)}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "8px 9px",
                        border: "none",
                        textAlign: "left",
                        background: on ? "var(--color-accent-100)" : "transparent",
                        color: "var(--color-text)",
                        cursor: "pointer",
                      }}
                    >
                      <span style={{ minWidth: 0, flex: 1 }}>
                        <span style={{ display: "block", fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 13 }}>{m.label}</span>
                        <span style={{ display: "block", fontSize: 11, color: "color-mix(in srgb, var(--color-text) 50%, transparent)" }}>{m.provider}</span>
                      </span>
                      <span style={{ color: "var(--color-accent)", fontSize: 13, visibility: on ? "visible" : "hidden" }}>✓</span>
                    </button>
                  );
                })}
              </div>
            )}
            {switchError && (
              <div
                style={{
                  position: "absolute",
                  top: 38,
                  right: 0,
                  width: 240,
                  fontSize: 11,
                  color: "color-mix(in srgb, var(--color-text) 55%, transparent)",
                  background: "var(--color-bg)",
                  border: "1px solid var(--color-divider)",
                  padding: "6px 9px",
                  zIndex: 20,
                }}
              >
                {switchError}
              </div>
            )}
          </div>
          <button
            onClick={actions.toggleArtifact}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              height: 32,
              padding: "0 10px",
              border: "1px solid var(--color-divider)",
              background: "transparent",
              color: "var(--color-text)",
              cursor: "pointer",
              fontFamily: "var(--font-heading)",
              fontWeight: 600,
              fontSize: 13,
            }}
          >
            <CanvasIcon size={14} />
            Canvas
          </button>
        </>
      )}

      {isFiltered && (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              height: 32,
              padding: "0 10px",
              border: "1px solid var(--color-divider)",
              color: "color-mix(in srgb, var(--color-text) 55%, transparent)",
              fontSize: 12,
              width: 220,
            }}
          >
            <SearchIcon size={13} />
            <span>{SEARCH_HINTS[view] ?? ""}</span>
          </div>
          <button
            onClick={view === "scheduled" ? actions.openTaskCreate : undefined}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              height: 32,
              padding: "0 12px",
              border: "1px solid var(--color-accent)",
              background: "var(--color-accent)",
              color: "var(--color-bg)",
              cursor: "pointer",
              fontFamily: "var(--font-heading)",
              fontWeight: 600,
              fontSize: 13,
            }}
          >
            <PlusIcon size={14} />
            {PRIMARY_ACTIONS[view] ?? filterConfig[view]?.heading ?? "New"}
          </button>
        </>
      )}

      {isSettings && (
        <>
          <button className="btn btn-secondary" style={{ height: 32 }}>
            Reset
          </button>
          <button className="btn btn-primary" style={{ height: 32 }}>
            <CheckIcon size={14} />
            Save changes
          </button>
        </>
      )}
    </div>
  );
}
