import { Blueprint } from "../components/Blueprint";
import { SkillsIcon } from "../components/icons";
import { skillsList } from "../data/mockData";

export function SkillsLibraryView() {
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "22px 24px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 16 }}>
        {skillsList.map((k) => (
          <Blueprint key={k.name} style={{ padding: 15, display: "flex", flexDirection: "column", gap: 9, background: "transparent" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "ui-monospace,Menlo,monospace", fontSize: 14, fontWeight: 500 }}>
                <SkillsIcon size={15} />
                {k.name}
              </span>
              <span className="tag tag-neutral">{k.tag}</span>
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.5, color: "color-mix(in srgb, var(--color-text) 62%, transparent)", flex: 1 }}>
              {k.desc}
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
              <span>{k.trigger}</span>
              <span>{k.uses} runs</span>
            </div>
          </Blueprint>
        ))}
      </div>
    </div>
  );
}
