import { Blueprint } from "../../components/Blueprint";
import { ChevronLeftIcon, CheckIcon, PlusIcon } from "../../components/icons";

const sectionLabelStyle = {
  fontSize: 10,
  letterSpacing: "0.1em",
  textTransform: "uppercase" as const,
  color: "var(--color-accent)",
  marginBottom: 14,
};

const preselectedTools = ["postgres-prod", "chart-builder", "filesystem"];
const availableTools = ["github", "slack"];

export function TaskCreateView({ onClose }: { onClose: () => void }) {
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "16px 24px 26px" }}>
      <button
        onClick={onClose}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          border: "none",
          background: "transparent",
          color: "var(--color-accent)",
          cursor: "pointer",
          fontSize: 12,
          padding: "4px 0",
          fontFamily: "var(--font-heading)",
          fontWeight: 600,
        }}
      >
        <ChevronLeftIcon size={14} />
        All tasks
      </button>
      <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 26, lineHeight: 1.1, margin: "12px 0 3px" }}>
        New scheduled task
      </div>
      <p style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 55%, transparent)", margin: "0 0 20px" }}>
        Define what pi should do, then set when it runs. Everything here is editable later.
      </p>

      <div style={{ maxWidth: 820, display: "flex", flexDirection: "column", gap: 16 }}>
        <Blueprint style={{ padding: 18, background: "transparent" }}>
          <div style={sectionLabelStyle}>Task</div>
          <div className="field" style={{ marginBottom: 14 }}>
            <label>Name</label>
            <input className="input" placeholder="e.g. Daily metrics digest" />
          </div>
          <div className="field">
            <label>Instructions</label>
            <textarea
              className="input"
              style={{ minHeight: 96 }}
              placeholder="Query the warehouse for yesterday's core metrics, build the WAU chart, and write a one-page digest. Flag anything that moved more than 10% week-over-week."
            />
          </div>
        </Blueprint>

        <Blueprint style={{ padding: 18, background: "transparent" }}>
          <div style={sectionLabelStyle}>Schedule</div>
          <div className="field" style={{ marginBottom: 14 }}>
            <label>Runs</label>
            <div className="seg" style={{ width: "100%" }}>
              {["Hourly", "Daily", "Weekly", "Custom cron"].map((label) => (
                <label key={label} className="seg-opt" style={{ flex: 1, justifyContent: "center" }}>
                  <input type="radio" name="cadence" defaultChecked={label === "Daily"} />
                  {label}
                </label>
              ))}
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
            <div className="field">
              <label>Cron expression</label>
              <input className="input" defaultValue="0 8 * * *" style={{ fontFamily: "ui-monospace,Menlo,monospace" }} />
            </div>
            <div className="field">
              <label>Time</label>
              <input className="input" defaultValue="08:00" />
            </div>
            <div className="field">
              <label>Timezone</label>
              <select className="input">
                <option>America/New_York</option>
                <option>America/Los_Angeles</option>
                <option>UTC</option>
                <option>Europe/London</option>
              </select>
            </div>
          </div>
          <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)", marginTop: 10 }}>
            Next run: <strong style={{ color: "var(--color-accent-700)" }}>Tomorrow · 08:00 EDT</strong>
          </div>
        </Blueprint>

        <Blueprint style={{ padding: 18, background: "transparent" }}>
          <div style={sectionLabelStyle}>Agent</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
            <div className="field">
              <label>Model</label>
              <select className="input">
                <option>pi-2 Sonnet</option>
                <option>pi-2 Opus</option>
                <option>pi-2 Mini</option>
                <option>pi-code-1</option>
              </select>
            </div>
            <div className="field">
              <label>Fallback</label>
              <select className="input">
                <option>pi-2 Mini</option>
                <option>pi-2 Sonnet</option>
                <option>None</option>
              </select>
            </div>
          </div>
          <div className="field" style={{ marginBottom: 14 }}>
            <label>Tools &amp; skills</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
              {preselectedTools.map((name) => (
                <button
                  key={name}
                  style={{
                    border: "1px solid var(--color-accent)",
                    background: "var(--color-accent-100)",
                    color: "var(--color-accent-800)",
                    padding: "4px 11px",
                    fontSize: 12,
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                  }}
                >
                  <CheckIcon size={11} />
                  {name}
                </button>
              ))}
              {availableTools.map((name) => (
                <button
                  key={name}
                  style={{
                    border: "1px solid var(--color-divider)",
                    background: "transparent",
                    color: "color-mix(in srgb, var(--color-text) 60%, transparent)",
                    padding: "4px 11px",
                    fontSize: 12,
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                  }}
                >
                  <PlusIcon size={11} />
                  {name}
                </button>
              ))}
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 14 }}>
            <div className="field">
              <label>Output</label>
              <select className="input">
                <option>Artifact file</option>
                <option>Slack channel</option>
                <option>Email</option>
                <option>Webhook</option>
              </select>
            </div>
            <div className="field">
              <label>Destination</label>
              <input className="input" defaultValue="metrics_digest.md · #metrics" style={{ fontFamily: "ui-monospace,Menlo,monospace" }} />
            </div>
          </div>
        </Blueprint>

        <Blueprint style={{ padding: 18, background: "transparent" }}>
          <div style={sectionLabelStyle}>Reliability</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
            <div className="field">
              <label>Retry attempts</label>
              <select className="input">
                <option>None</option>
                <option>2 attempts</option>
                <option>5 attempts</option>
              </select>
            </div>
            <div className="field">
              <label>Backoff</label>
              <select className="input">
                <option>1 min</option>
                <option>5 min</option>
                <option>30 min</option>
              </select>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 14, alignItems: "end" }}>
            <div className="field">
              <label>On failure, notify</label>
              <input className="input" defaultValue="#ops" />
            </div>
            <div className="field">
              <label>Enabled</label>
              <div className="seg" style={{ width: "100%" }}>
                <label className="seg-opt" style={{ flex: 1, justifyContent: "center" }}>
                  <input type="radio" name="newenabled" defaultChecked />
                  On
                </label>
                <label className="seg-opt" style={{ flex: 1, justifyContent: "center" }}>
                  <input type="radio" name="newenabled" />
                  Off
                </label>
              </div>
            </div>
          </div>
        </Blueprint>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button onClick={onClose} className="btn btn-secondary" style={{ height: 34, padding: "0 16px" }}>
            Cancel
          </button>
          <button onClick={onClose} className="btn btn-primary" style={{ height: 34, padding: "0 16px" }}>
            <CheckIcon size={14} />
            Create schedule
          </button>
        </div>
      </div>
    </div>
  );
}
