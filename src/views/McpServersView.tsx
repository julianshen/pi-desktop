import { Blueprint } from "../components/Blueprint";
import { StatusTag } from "../components/StatusTag";
import { McpIcon } from "../components/icons";
import { servers } from "../data/mockData";

export function McpServersView() {
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "22px 24px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 16 }}>
        {servers.map((s) => (
          <Blueprint key={s.name} style={{ padding: 15, background: "transparent" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <span
                style={{
                  width: 32,
                  height: 32,
                  flex: "none",
                  display: "grid",
                  placeItems: "center",
                  border: "1px solid var(--color-divider)",
                  color: "var(--color-accent)",
                }}
              >
                <McpIcon size={16} />
              </span>
              <span style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 14, fontWeight: 500, flex: 1 }}>{s.name}</span>
              <StatusTag status={s.status} />
            </div>
            <div style={{ display: "flex", gap: 20, fontSize: 12 }}>
              <div>
                <div style={{ color: "color-mix(in srgb, var(--color-text) 45%, transparent)", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                  Transport
                </div>
                <div style={{ fontFamily: "ui-monospace,Menlo,monospace" }}>{s.transport}</div>
              </div>
              <div>
                <div style={{ color: "color-mix(in srgb, var(--color-text) 45%, transparent)", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                  Tools
                </div>
                <div style={{ fontFamily: "ui-monospace,Menlo,monospace" }}>{s.tools}</div>
              </div>
              <div>
                <div style={{ color: "color-mix(in srgb, var(--color-text) 45%, transparent)", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                  Latency
                </div>
                <div style={{ fontFamily: "ui-monospace,Menlo,monospace" }}>{s.latency}</div>
              </div>
            </div>
          </Blueprint>
        ))}
      </div>
    </div>
  );
}
