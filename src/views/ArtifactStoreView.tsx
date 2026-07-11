import { Blueprint } from "../components/Blueprint";
import { StatusTag } from "../components/StatusTag";
import { artifacts } from "../data/mockData";

export function ArtifactStoreView() {
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "22px 24px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(288px, 1fr))", gap: 18 }}>
        {artifacts.map((a) => (
          <Blueprint key={a.title} style={{ padding: 15, display: "flex", flexDirection: "column", gap: 9, background: "transparent" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--color-accent)" }}>
                {a.type}
              </span>
              <StatusTag status={a.status} />
            </div>
            <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 18, lineHeight: 1.15 }}>{a.title}</div>
            <div style={{ fontSize: 13, lineHeight: 1.5, color: "color-mix(in srgb, var(--color-text) 62%, transparent)", flex: 1 }}>
              {a.desc}
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                fontSize: 11,
                color: "color-mix(in srgb, var(--color-text) 45%, transparent)",
                paddingTop: 4,
                borderTop: "1px solid var(--color-divider)",
              }}
            >
              <span>{a.meta}</span>
              <span style={{ color: "var(--color-accent)" }}>Open →</span>
            </div>
          </Blueprint>
        ))}
      </div>
    </div>
  );
}
