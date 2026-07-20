import { useState } from "react";
import { PlusIcon, SearchIcon } from "./icons";
import { filterConfig } from "../data/mockData";
import type { SettingsSection, ViewKey } from "../state/useShellState";
import type { UseConversationsResult } from "../state/useConversations";
import { ConversationTree } from "./ConversationTree.js";

const SIDEBAR_TITLES: Record<ViewKey, string> = {
  chat: "Conversations",
  artifacts: "Artifacts",
  scheduled: "Tasks",
  coding: "Repositories",
  mcp: "Servers",
  skills: "Skills",
  settings: "Settings",
};

const SETTINGS_NAV: { key: SettingsSection; label: string }[] = [
  { key: "providers", label: "Providers" },
  { key: "models", label: "Model defaults" },
  { key: "search", label: "Web search" },
];

function Spinner({ size = 18 }: { size?: number }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        flex: "none",
        display: "inline-block",
        border: "2px solid var(--color-accent-300)",
        borderTopColor: "var(--color-accent-700)",
        borderRadius: "50%",
        animation: "spin 0.7s linear infinite",
      }}
    />
  );
}

/**
 * DESIGN.md's empty-state badge icon (Sidebar + Canvas share the same visual
 * treatment: circular `--color-accent-100` bg, `--color-accent-700` icon).
 */
function EmptyBadgeIcon() {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
      <path d="M21 11.5a8.4 8.4 0 0 1-1.1 4.1L21 20l-4.4-1a8.5 8.5 0 1 1 4.4-7.5Z" />
    </svg>
  );
}

/** AC-10.1: DESIGN.md's `ConversationListLoading` — spinner + text, not a skeleton. */
function ConversationListLoading() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        padding: "40px 20px",
        color: "color-mix(in srgb, var(--color-text) 55%, transparent)",
        fontSize: 13,
      }}
    >
      <Spinner size={18} />
      <span>Loading conversations…</span>
    </div>
  );
}

/** AC-10.2: DESIGN.md's `ConversationListEmpty` — badge + message + primary CTA. */
function ConversationListEmpty({ onCreate, creating }: { onCreate: () => void; creating: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 10, padding: "46px 20px" }}>
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: "50%",
          background: "var(--color-accent-100)",
          display: "grid",
          placeItems: "center",
          color: "var(--color-accent-700)",
        }}
      >
        <EmptyBadgeIcon />
      </div>
      <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
        No conversations yet — start one to begin.
      </div>
      <button
        onClick={onCreate}
        disabled={creating}
        style={{
          marginTop: 4,
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontFamily: "var(--font-heading)",
          fontWeight: 600,
          fontSize: 13,
          padding: "8px 16px",
          background: "var(--color-accent)",
          color: "var(--color-bg)",
          border: "none",
          cursor: creating ? "default" : "pointer",
        }}
      >
        {creating && <Spinner size={13} />}+ New conversation
      </button>
    </div>
  );
}

/**
 * DESIGN.md States table: "Sidebar searching, zero matches" — not separately
 * mocked in the prototype, so this reuses the empty-state badge/copy pattern with
 * matching-specific copy instead of inventing a new treatment.
 */
function ConversationListNoMatches({ query }: { query: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 10, padding: "46px 20px" }}>
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: "50%",
          background: "var(--color-accent-100)",
          display: "grid",
          placeItems: "center",
          color: "var(--color-accent-700)",
        }}
      >
        <EmptyBadgeIcon />
      </div>
      <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
        No conversations match &quot;{query}&quot;
      </div>
    </div>
  );
}

export function Sidebar({
  view,
  activeConv,
  onSelectConv,
  activeFilter,
  onSelectFilter,
  settingsSection,
  onSelectSettingsSection,
  conversations,
}: {
  view: ViewKey;
  /** Canonical "active conversation id", owned by App.tsx's useShellState (unchanged
   * prop shape) so ArtifactCanvas/MainHeader's own wiring to the same field keeps
   * working — Sidebar just makes sure real conversation ids flow through it now. */
  activeConv: string;
  onSelectConv: (id: string) => void;
  activeFilter: string;
  onSelectFilter: (label: string) => void;
  settingsSection: SettingsSection;
  onSelectSettingsSection: (section: SettingsSection) => void;
  /** Task 9's hook result, lifted to App.tsx so it fetches once and can be shared. */
  conversations: UseConversationsResult;
}) {
  const isChat = view === "chat";
  const isSettings = view === "settings";
  const isFiltered = !isChat && !isSettings;
  const cfg = filterConfig[view] ?? { heading: "", items: [] };

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  // AC-10.3: "+" creates a new conversation and it becomes active. `create()`'s
  // Promise rejects on failure (network error/non-2xx) without touching the
  // hook's own `error` state (see useConversations.ts) — so this is the one
  // place responsible for catching that rejection and surfacing it. On success
  // we route the new id through `onSelectConv` (App.tsx's shared "active
  // conversation" state), not the hook's own `activeId`, to keep working the
  // way ArtifactCanvas/MainHeader already read active-conversation state.
  function handleCreate() {
    setCreating(true);
    setCreateError(null);
    conversations
      .create()
      .then((created) => {
        onSelectConv(created.id);
      })
      .catch((err: unknown) => {
        setCreateError(err instanceof Error ? err.message : "Failed to create conversation.");
      })
      .finally(() => {
        setCreating(false);
      });
  }

  return (
    <div
      style={{
        width: 266,
        flex: "none",
        display: "flex",
        flexDirection: "column",
        borderRight: "1px solid var(--color-divider)",
        minHeight: 0,
      }}
    >
      <div
        style={{
          height: 52,
          flex: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 16px",
          borderBottom: "1px solid var(--color-divider)",
        }}
      >
        <span style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 16 }}>
          {SIDEBAR_TITLES[view]}
        </span>
        {view !== "settings" && (
          <button
            onClick={isChat ? handleCreate : undefined}
            disabled={isChat ? creating : undefined}
            aria-label={isChat ? "New conversation" : undefined}
            title={isChat ? "New conversation" : undefined}
            style={{
              width: 28,
              height: 28,
              display: "grid",
              placeItems: "center",
              border: "1px solid var(--color-divider)",
              background: "transparent",
              color: "var(--color-text)",
              cursor: isChat && creating ? "default" : "pointer",
            }}
          >
            {isChat && creating ? <Spinner size={13} /> : <PlusIcon size={15} />}
          </button>
        )}
      </div>

      {isChat && (
        <>
          <div style={{ padding: "12px 14px", flex: "none" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                height: 32,
                padding: "0 10px",
                background: "var(--color-surface)",
                border: "1px solid var(--color-divider)",
              }}
            >
              <SearchIcon size={13} style={{ color: "color-mix(in srgb, var(--color-text) 55%, transparent)", flex: "none" }} />
              <input
                type="text"
                value={conversations.searchQuery}
                onChange={(e) => conversations.setSearchQuery(e.target.value)}
                placeholder="Search conversations"
                style={{
                  border: "none",
                  background: "transparent",
                  outline: "none",
                  font: "inherit",
                  fontSize: 12,
                  color: "var(--color-text)",
                  width: "100%",
                }}
              />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 6, marginTop: 6 }}>
              <button
                aria-pressed={showArchived}
                onClick={() => setShowArchived((value) => !value)}
                style={{ border: 0, background: "transparent", color: "var(--color-text-muted)", fontSize: 11, cursor: "pointer" }}
              >
                {showArchived ? "Show active" : "Show archived"}
              </button>
              <button
                onClick={() => {
                  const name = window.prompt("Project name");
                  if (name?.trim()) void conversations.createProject(name.trim());
                }}
                style={{ border: 0, background: "transparent", color: "var(--color-accent-700)", fontSize: 11, cursor: "pointer" }}
              >
                + Project
              </button>
            </div>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "0 10px 14px" }}>
            {conversations.loading ? (
              <ConversationListLoading />
            ) : conversations.conversations.length === 0 ? (
              <ConversationListEmpty onCreate={handleCreate} creating={creating} />
            ) : conversations.filtered.length === 0 ? (
              <ConversationListNoMatches query={conversations.searchQuery} />
            ) : (
              <ConversationTree
                items={conversations.filtered.filter((conversation) => showArchived ? Boolean(conversation.archivedAt) : !conversation.archivedAt)}
                projects={conversations.projects}
                folders={conversations.folders}
                activeId={activeConv}
                workspace={conversations}
                onSelect={onSelectConv}
              />
            )}
            {createError && (
              <div style={{ fontSize: 11, color: "#b4463f", padding: "8px 6px" }}>{createError}</div>
            )}
          </div>
        </>
      )}

      {isFiltered && (
        <div style={{ flex: 1, overflowY: "auto", padding: "12px 10px" }}>
          <div style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "color-mix(in srgb, var(--color-text) 45%, transparent)", padding: "4px 6px 8px" }}>
            {cfg.heading}
          </div>
          {cfg.items.map(([label, count]) => {
            const on = label === activeFilter;
            return (
              <button
                key={label}
                onClick={() => onSelectFilter(label)}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "8px 10px",
                  margin: "1px 0",
                  border: `1px solid ${on ? "var(--color-divider)" : "transparent"}`,
                  background: on ? "var(--color-accent-100)" : "transparent",
                  color: on ? "var(--color-accent-800)" : "var(--color-text)",
                  cursor: "pointer",
                  fontSize: 13,
                  fontFamily: "var(--font-heading)",
                  fontWeight: 600,
                }}
              >
                <span>{label}</span>
                <span style={{ fontSize: 11, fontFamily: "var(--font-body)", color: "color-mix(in srgb, var(--color-text) 45%, transparent)" }}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {isSettings && (
        <div style={{ flex: 1, overflowY: "auto", padding: "12px 10px" }}>
          <div style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "color-mix(in srgb, var(--color-text) 45%, transparent)", padding: "4px 6px 8px" }}>
            Settings
          </div>
          {SETTINGS_NAV.map((n) => {
            const on = settingsSection === n.key;
            return (
              <button
                key={n.key}
                onClick={() => onSelectSettingsSection(n.key)}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  padding: "8px 10px",
                  margin: "1px 0",
                  border: `1px solid ${on ? "var(--color-divider)" : "transparent"}`,
                  background: on ? "var(--color-accent-100)" : "transparent",
                  color: on ? "var(--color-accent-800)" : "var(--color-text)",
                  cursor: "pointer",
                  fontSize: 13,
                  fontFamily: "var(--font-heading)",
                  fontWeight: 600,
                }}
              >
                <span>{n.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
