import { Blueprint } from "../components/Blueprint";
import { StatusTag } from "../components/StatusTag";
import { CodingIcon } from "../components/icons";
import { codeRuns } from "../data/mockData";

export function CodingAgentsView() {
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "22px 24px" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {codeRuns.map((r) => (
          <Blueprint key={r.task} style={{ padding: 16, background: "transparent" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
              <span
                style={{
                  width: 36,
                  height: 36,
                  flex: "none",
                  display: "grid",
                  placeItems: "center",
                  border: "1px solid var(--color-divider)",
                  color: "var(--color-accent)",
                }}
              >
                <CodingIcon size={18} />
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15 }}>{r.task}</div>
                <div style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                  {r.repo} · {r.branch}
                </div>
              </div>
              <StatusTag status={r.status} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
              <span style={{ fontFamily: "ui-monospace,Menlo,monospace", color: "var(--color-accent-700)" }}>{r.added}</span>
              <span style={{ fontFamily: "ui-monospace,Menlo,monospace", color: "#b4463f" }}>{r.removed}</span>
              <span style={{ width: 1, height: 14, background: "var(--color-divider)" }} />
              <span>{r.step}</span>
            </div>
          </Blueprint>
        ))}
      </div>
    </div>
  );
}
