import { CanvasIcon, CheckIcon, ChevronDownIcon, PlusIcon, SearchIcon } from "./icons";
import { filterConfig, models } from "../data/mockData";
import type { ShellActions, ShellState, ViewKey } from "../state/useShellState";

const CRUMBS: Record<ViewKey, string> = {
  chat: "Chat / July investor update",
  artifacts: "Workspace / Artifacts",
  scheduled: "Automation / Scheduled",
  coding: "Development / Agents",
  mcp: "Connections / MCP",
  skills: "Library / Skills",
  settings: "Account / Settings",
};

const MAIN_TITLES: Record<ViewKey, string> = {
  chat: "July investor update",
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

export function MainHeader({ state, actions }: { state: ShellState; actions: ShellActions }) {
  const { view } = state;
  const isChat = view === "chat";
  const isSettings = view === "settings";
  const isFiltered = !isChat && !isSettings;

  return (
    <div style={{ height: 52, flex: "none", display: "flex", alignItems: "center", gap: 14, padding: "0 20px", borderBottom: "1px solid var(--color-divider)" }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 11, letterSpacing: "0.02em", color: "color-mix(in srgb, var(--color-text) 45%, transparent)" }}>
          {CRUMBS[view]}
        </div>
        <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 17, lineHeight: 1.1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {MAIN_TITLES[view]}
        </div>
      </div>

      {isChat && (
        <>
          <div style={{ position: "relative" }}>
            <button
              onClick={actions.toggleModelMenu}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
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
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--color-accent)" }} />
              {state.model}
              <ChevronDownIcon size={13} />
            </button>
            {state.modelOpen && (
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
                  const on = m.name === state.model;
                  return (
                    <button
                      key={m.name}
                      onClick={() => actions.setModel(m.name)}
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
                        <span style={{ display: "block", fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 13 }}>{m.name}</span>
                        <span style={{ display: "block", fontSize: 11, color: "color-mix(in srgb, var(--color-text) 50%, transparent)" }}>{m.note}</span>
                      </span>
                      <span style={{ color: "var(--color-accent)", fontSize: 13, visibility: on ? "visible" : "hidden" }}>✓</span>
                    </button>
                  );
                })}
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
