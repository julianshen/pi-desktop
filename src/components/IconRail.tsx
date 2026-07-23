import type { ReactElement } from "react";
import { ChatIcon, ArtifactsIcon, ScheduledIcon, CodingIcon, McpIcon, SkillsIcon, GearIcon } from "./icons";
import type { ViewKey } from "../state/useShellState";

const ICONS: Record<ViewKey, (props: { size?: number }) => ReactElement> = {
  chat: ChatIcon,
  artifacts: ArtifactsIcon,
  scheduled: ScheduledIcon,
  coding: CodingIcon,
  mcp: McpIcon,
  skills: SkillsIcon,
  settings: GearIcon,
};

export function IconRail({
  items,
  view,
  onSelect,
  onSettings,
  scheduledUnreadCount = 0,
}: {
  items: { key: ViewKey; label: string }[];
  view: ViewKey;
  onSelect: (key: ViewKey) => void;
  onSettings: () => void;
  scheduledUnreadCount?: number;
}) {
  return (
    <div
      style={{
        width: 62,
        flex: "none",
        display: "flex",
        flexDirection: "column",
        background: "var(--color-surface)",
        borderRight: "1px solid var(--color-divider)",
      }}
    >
      <div style={{ flex: 1, display: "flex", flexDirection: "column", paddingTop: 6 }}>
        {items.map((item) => {
          const active = view === item.key;
          const Icon = ICONS[item.key];
          return (
            <button
              key={item.key}
              onClick={() => onSelect(item.key)}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 4,
                width: "100%",
                padding: "11px 0",
                border: "none",
                borderLeft: `2px solid ${active ? "var(--color-accent)" : "transparent"}`,
                background: active ? "var(--color-accent-100)" : "transparent",
                color: active ? "var(--color-accent-800)" : "color-mix(in srgb, var(--color-text) 55%, transparent)",
                cursor: "pointer",
                fontFamily: "var(--font-heading)",
                fontWeight: 600,
                fontSize: 9.5,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
              }}
            >
              <span style={{ position: "relative", display: "inline-flex" }}>
                <Icon size={20} />
                {item.key === "scheduled" && scheduledUnreadCount > 0 && (
                  <span
                    aria-label={`${scheduledUnreadCount} unread scheduled task outcomes`}
                    style={{ position: "absolute", top: -8, right: -12, minWidth: 16, height: 16, padding: "0 4px", display: "grid", placeItems: "center", borderRadius: 8, color: "white", background: "var(--color-danger)", fontSize: 9, lineHeight: 1 }}
                  >{scheduledUnreadCount > 99 ? "99+" : scheduledUnreadCount}</span>
                )}
              </span>
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 4,
          padding: "10px 0",
          borderTop: "1px solid var(--color-divider)",
        }}
      >
        <button
          onClick={onSettings}
          aria-label="Settings"
          style={{
            width: 34,
            height: 34,
            display: "grid",
            placeItems: "center",
            border: "none",
            background: "transparent",
            color: view === "settings" ? "var(--color-accent)" : "color-mix(in srgb, var(--color-text) 55%, transparent)",
            cursor: "pointer",
          }}
        >
          <GearIcon size={19} />
        </button>
      </div>
    </div>
  );
}
