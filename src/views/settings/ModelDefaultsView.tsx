import { Blueprint } from "../../components/Blueprint";

export function ModelDefaultsView() {
  return (
    <div style={{ maxWidth: 780 }}>
      <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 21, marginBottom: 3 }}>Model defaults</div>
      <p style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 55%, transparent)", margin: "0 0 18px" }}>
        Applied to new conversations. Any chat can override these from the model picker.
      </p>
      <Blueprint style={{ padding: 20, background: "transparent" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
          <div className="field">
            <label>Default model</label>
            <select className="input">
              <option>pi-2 Sonnet</option>
              <option>pi-2 Opus</option>
              <option>pi-2 Mini</option>
              <option>pi-code-1</option>
            </select>
          </div>
          <div className="field">
            <label>Fallback model</label>
            <select className="input">
              <option>pi-2 Mini</option>
              <option>pi-2 Sonnet</option>
              <option>gpt-4o-mini</option>
            </select>
          </div>
          <div className="field">
            <label>Temperature</label>
            <div className="seg" style={{ width: "100%" }}>
              {["Precise", "Balanced", "Creative"].map((label) => (
                <label key={label} className="seg-opt" style={{ flex: 1, justifyContent: "center" }}>
                  <input type="radio" name="temp" defaultChecked={label === "Balanced"} />
                  {label}
                </label>
              ))}
            </div>
          </div>
          <div className="field">
            <label>Max output tokens</label>
            <input className="input" defaultValue="4096" />
          </div>
          <div className="field">
            <label>Top-p</label>
            <input className="input" defaultValue="1.0" />
          </div>
          <div className="field">
            <label>Context window</label>
            <input className="input" defaultValue="200,000" readOnly style={{ color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }} />
          </div>
          <div className="field">
            <label>Streaming</label>
            <div className="seg" style={{ width: "100%" }}>
              <label className="seg-opt" style={{ flex: 1, justifyContent: "center" }}>
                <input type="radio" name="stream" defaultChecked />
                On
              </label>
              <label className="seg-opt" style={{ flex: 1, justifyContent: "center" }}>
                <input type="radio" name="stream" />
                Off
              </label>
            </div>
          </div>
          <div className="field">
            <label>Tool use</label>
            <div className="seg" style={{ width: "100%" }}>
              {["Auto", "Manual", "Off"].map((label) => (
                <label key={label} className="seg-opt" style={{ flex: 1, justifyContent: "center" }}>
                  <input type="radio" name="tools" defaultChecked={label === "Auto"} />
                  {label}
                </label>
              ))}
            </div>
          </div>
          <div className="field" style={{ gridColumn: "1 / -1" }}>
            <label>System prompt</label>
            <textarea
              className="input"
              style={{ minHeight: 110 }}
              defaultValue="You are pi, a precise, tool-using agent. Prefer verified data from connected MCP servers. Cite sources. Ask before destructive or external actions."
            />
          </div>
        </div>
      </Blueprint>
    </div>
  );
}
