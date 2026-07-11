import type { CSSProperties } from "react";
import { SearchIcon } from "./icons";

/** -webkit-app-region isn't in the standard CSSProperties typings; cast at the boundary. */
const dragStyle = { WebkitAppRegion: "drag" } as CSSProperties;
const noDragStyle = { WebkitAppRegion: "no-drag" } as CSSProperties;

export function TitleBar({ windowTitle }: { windowTitle: string }) {
  return (
    <div
      style={{
        height: 40,
        flex: "none",
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "0 14px",
        background: "var(--color-surface)",
        borderBottom: "1px solid var(--color-divider)",
        ...dragStyle,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 12, height: 12, borderRadius: "50%", background: "#ec6a5e" }} />
        <span style={{ width: 12, height: 12, borderRadius: "50%", background: "#f4bf50" }} />
        <span style={{ width: 12, height: 12, borderRadius: "50%", background: "#61c454" }} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: 6 }}>
        <span
          style={{
            width: 20,
            height: 20,
            display: "grid",
            placeItems: "center",
            background: "var(--color-accent)",
            color: "var(--color-bg)",
            fontFamily: "var(--font-heading)",
            fontWeight: 600,
            fontSize: 14,
          }}
        >
          π
        </span>
        <span style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 14, letterSpacing: "0.02em" }}>
          pi&nbsp;agent
        </span>
      </div>
      <div
        style={{
          flex: 1,
          textAlign: "center",
          fontSize: 12,
          letterSpacing: "0.03em",
          color: "color-mix(in srgb, var(--color-text) 50%, transparent)",
        }}
      >
        {windowTitle}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, ...noDragStyle }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            height: 26,
            padding: "0 10px",
            border: "1px solid var(--color-divider)",
            color: "color-mix(in srgb, var(--color-text) 55%, transparent)",
            fontSize: 12,
            minWidth: 180,
          }}
        >
          <SearchIcon size={13} />
          <span>Search everything</span>
          <span
            style={{
              marginLeft: "auto",
              fontSize: 10,
              border: "1px solid var(--color-divider)",
              padding: "0 4px",
              color: "color-mix(in srgb, var(--color-text) 45%, transparent)",
            }}
          >
            ⌘K
          </span>
        </div>
        <span
          style={{
            width: 26,
            height: 26,
            display: "grid",
            placeItems: "center",
            background: "var(--color-accent-800)",
            color: "var(--color-bg)",
            fontFamily: "var(--font-heading)",
            fontSize: 12,
          }}
        >
          AK
        </span>
      </div>
    </div>
  );
}
