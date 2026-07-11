import { Blueprint } from "../components/Blueprint";
import { CloseIcon } from "../components/icons";
import { bars } from "../data/mockData";
import type { CanvasTab } from "../state/useShellState";

const KW = "color:var(--color-accent-700)";
const ST = "color:#5f7a52";
const CM = "color:color-mix(in srgb,var(--color-text) 38%,transparent)";

const CODE_LINES = [
  `<span style="${KW}">import</span> { useMemo } <span style="${KW}">from</span> <span style="${ST}">"react"</span>;`,
  `<span style="${KW}">import</span> { Bar } <span style="${KW}">from</span> <span style="${ST}">"./charts"</span>;`,
  ``,
  `<span style="${CM}">// WAU pulled live from postgres-prod</span>`,
  `<span style="${KW}">export function</span> WAUDashboard({ rows }) {`,
  `  <span style="${KW}">const</span> total = useMemo(`,
  `    () =&gt; rows.at(-1).wau, [rows]`,
  `  );`,
  `  <span style="${KW}">return</span> (`,
  `    &lt;<span style="${KW}">section</span> className=<span style="${ST}">"card"</span>&gt;`,
  `      &lt;<span style="${KW}">h3</span>&gt;Weekly Active Users&lt;/<span style="${KW}">h3</span>&gt;`,
  `      &lt;<span style="${KW}">strong</span>&gt;{total.toLocaleString()}&lt;/<span style="${KW}">strong</span>&gt;`,
  `      &lt;<span style="${KW}">Bar</span> data={rows} x=<span style="${ST}">"wk"</span> y=<span style="${ST}">"wau"</span> /&gt;`,
  `    &lt;/<span style="${KW}">section</span>&gt;`,
  `  );`,
  `}`,
];

const MAX_BAR = 55;

export function ArtifactCanvas({
  tab,
  onSetTab,
  onClose,
}: {
  tab: CanvasTab;
  onSetTab: (tab: CanvasTab) => void;
  onClose: () => void;
}) {
  return (
    <div
      style={{
        width: 466,
        flex: "none",
        display: "flex",
        flexDirection: "column",
        borderLeft: "1px solid var(--color-divider)",
        background: "var(--color-surface)",
        minHeight: 0,
      }}
    >
      <div style={{ height: 52, flex: "none", display: "flex", alignItems: "center", gap: 10, padding: "0 14px", borderBottom: "1px solid var(--color-divider)" }}>
        <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth={1.6}>
          <path d="M3 3h18v18H3z" />
          <path d="M8 17v-5M12 17V8M16 17v-3" />
        </svg>
        <span style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 13 }}>WAU_dashboard.tsx</span>
        <span className="tag tag-accent" style={{ padding: "1px 6px" }}>v3</span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 2 }}>
          <button
            onClick={onClose}
            style={{ width: 28, height: 28, display: "grid", placeItems: "center", border: "none", background: "transparent", color: "color-mix(in srgb, var(--color-text) 55%, transparent)", cursor: "pointer" }}
          >
            <CloseIcon size={16} />
          </button>
        </div>
      </div>

      <div style={{ flex: "none", display: "flex", gap: 2, padding: "8px 12px", borderBottom: "1px solid var(--color-divider)" }}>
        <button
          onClick={() => onSetTab("code")}
          style={{
            padding: "6px 14px",
            border: "none",
            cursor: "pointer",
            fontFamily: "var(--font-heading)",
            fontWeight: 600,
            fontSize: 13,
            background: tab === "code" ? "var(--color-accent)" : "transparent",
            color: tab === "code" ? "var(--color-bg)" : "color-mix(in srgb, var(--color-text) 55%, transparent)",
          }}
        >
          Code
        </button>
        <button
          onClick={() => onSetTab("preview")}
          style={{
            padding: "6px 14px",
            border: "none",
            cursor: "pointer",
            fontFamily: "var(--font-heading)",
            fontWeight: 600,
            fontSize: 13,
            background: tab === "preview" ? "var(--color-accent)" : "transparent",
            color: tab === "preview" ? "var(--color-bg)" : "color-mix(in srgb, var(--color-text) 55%, transparent)",
          }}
        >
          Preview
        </button>
      </div>

      {tab === "code" ? (
        <div style={{ flex: 1, overflow: "auto", padding: "12px 0", fontFamily: "ui-monospace,'SF Mono',Menlo,monospace", fontSize: 12, lineHeight: 1.7 }}>
          {CODE_LINES.map((html, i) => (
            <div key={i} style={{ display: "flex" }}>
              <span style={{ width: 38, flex: "none", textAlign: "right", paddingRight: 12, color: "color-mix(in srgb, var(--color-text) 30%, transparent)", userSelect: "none" }}>
                {i + 1}
              </span>
              {/* Source is a fixed, hand-authored constant above — not user/network-derived. */}
              <span style={{ whiteSpace: "pre", paddingRight: 16 }} dangerouslySetInnerHTML={{ __html: html }} />
            </div>
          ))}
        </div>
      ) : (
        <div style={{ flex: 1, overflow: "auto", padding: 22 }}>
          <Blueprint style={{ padding: 18, background: "var(--color-bg)" }}>
            <div style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--color-accent)" }}>Weekly Active Users</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, margin: "4px 0 16px" }}>
              <span style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 30 }}>51,904</span>
              <span style={{ fontSize: 12, color: "var(--color-accent-700)" }}>▲ 22.7%</span>
            </div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 10, height: 130 }}>
              {bars.map((b) => (
                <div key={b.label} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6, height: "100%", justifyContent: "flex-end" }}>
                  <div
                    style={{
                      width: "100%",
                      height: `${(b.value / MAX_BAR) * 100}%`,
                      background: b.isLast ? "var(--color-accent)" : "var(--color-accent-400)",
                    }}
                  />
                  <span style={{ fontSize: 9, color: "color-mix(in srgb, var(--color-text) 45%, transparent)" }}>{b.label}</span>
                </div>
              ))}
            </div>
          </Blueprint>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 14 }}>
            <Blueprint style={{ padding: 12 }}>
              <div style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "color-mix(in srgb, var(--color-text) 45%, transparent)" }}>
                Retention 4-wk
              </div>
              <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 22 }}>68.4%</div>
            </Blueprint>
            <Blueprint style={{ padding: 12 }}>
              <div style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "color-mix(in srgb, var(--color-text) 45%, transparent)" }}>
                New this week
              </div>
              <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 22 }}>+3,182</div>
            </Blueprint>
          </div>
        </div>
      )}
    </div>
  );
}
