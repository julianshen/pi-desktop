import type { CSSProperties } from "react";
import { PlusIcon, SearchIcon } from "./icons";
import { convToday, convYesterday, filterConfig } from "../data/mockData";
import type { SettingsSection, ViewKey } from "../state/useShellState";

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
];

function convStyle(active: boolean): CSSProperties {
  return {
    width: "100%",
    textAlign: "left",
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 8px",
    margin: "1px 0",
    border: `1px solid ${active ? "var(--color-divider)" : "transparent"}`,
    background: active ? "var(--color-accent-100)" : "transparent",
    color: "var(--color-text)",
    cursor: "pointer",
  };
}

function convDot(active: boolean): CSSProperties {
  return {
    width: 6,
    height: 6,
    borderRadius: "50%",
    flex: "none",
    background: active ? "var(--color-accent)" : "color-mix(in srgb, var(--color-text) 22%, transparent)",
  };
}

export function Sidebar({
  view,
  activeConv,
  onSelectConv,
  activeFilter,
  onSelectFilter,
  settingsSection,
  onSelectSettingsSection,
}: {
  view: ViewKey;
  activeConv: string;
  onSelectConv: (id: string) => void;
  activeFilter: string;
  onSelectFilter: (label: string) => void;
  settingsSection: SettingsSection;
  onSelectSettingsSection: (section: SettingsSection) => void;
}) {
  const isChat = view === "chat";
  const isSettings = view === "settings";
  const isFiltered = !isChat && !isSettings;
  const cfg = filterConfig[view] ?? { heading: "", items: [] };

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
            style={{
              width: 28,
              height: 28,
              display: "grid",
              placeItems: "center",
              border: "1px solid var(--color-divider)",
              background: "transparent",
              color: "var(--color-text)",
              cursor: "pointer",
            }}
          >
            <PlusIcon size={15} />
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
                color: "color-mix(in srgb, var(--color-text) 55%, transparent)",
                fontSize: 12,
              }}
            >
              <SearchIcon size={13} />
              <span>Search conversations</span>
            </div>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "0 10px 14px" }}>
            <div style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--color-accent)", padding: "8px 6px 6px" }}>
              Pinned
            </div>
            <button
              style={{
                width: "100%",
                textAlign: "left",
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 8px",
                border: "none",
                background: "transparent",
                color: "var(--color-text)",
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth={1.6}>
                <path d="m12 2 3 7 7 .5-5.3 4.6L18 21l-6-4-6 4 1.3-6.9L2 9.5 9 9z" />
              </svg>
              Model eval rubric
            </button>
            <div style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "color-mix(in srgb, var(--color-text) 45%, transparent)", padding: "12px 6px 6px" }}>
              Today
            </div>
            {convToday.map((c) => {
              const active = c.id === activeConv;
              return (
                <button key={c.id} onClick={() => onSelectConv(c.id)} style={convStyle(active)}>
                  <span style={convDot(active)} />
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ display: "block", fontSize: 13, lineHeight: 1.25, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {c.title}
                    </span>
                    {c.preview && (
                      <span style={{ display: "block", fontSize: 11, color: "color-mix(in srgb, var(--color-text) 45%, transparent)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {c.preview}
                      </span>
                    )}
                  </span>
                  <span style={{ fontSize: 10, color: "color-mix(in srgb, var(--color-text) 40%, transparent)" }}>{c.time}</span>
                </button>
              );
            })}
            <div style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "color-mix(in srgb, var(--color-text) 45%, transparent)", padding: "12px 6px 6px" }}>
              Yesterday
            </div>
            {convYesterday.map((c) => {
              const active = c.id === activeConv;
              return (
                <button key={c.id} onClick={() => onSelectConv(c.id)} style={convStyle(active)}>
                  <span style={convDot(active)} />
                  <span style={{ minWidth: 0, flex: 1, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {c.title}
                  </span>
                  <span style={{ fontSize: 10, color: "color-mix(in srgb, var(--color-text) 40%, transparent)" }}>{c.time}</span>
                </button>
              );
            })}
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
