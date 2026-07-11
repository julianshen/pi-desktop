import type { CSSProperties } from "react";
import { Blueprint } from "../../components/Blueprint";
import { StatusTag } from "../../components/StatusTag";
import { ChevronLeftIcon, PlayIcon } from "../../components/icons";
import { schedules, taskRuns } from "../../data/mockData";

const statLabelStyle: CSSProperties = {
  fontSize: 10,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "color-mix(in srgb, var(--color-text) 45%, transparent)",
};
const statValueStyle: CSSProperties = { fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 20 };

export function TaskDetailView({ taskIndex, onBack }: { taskIndex: number; onBack: () => void }) {
  const task = schedules[taskIndex];
  if (!task) return null;

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "16px 24px 26px" }}>
      <button
        onClick={onBack}
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

      <div style={{ display: "flex", alignItems: "flex-start", gap: 16, margin: "12px 0 20px" }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 26, lineHeight: 1.1 }}>{task.name}</span>
            <StatusTag status={task.status} />
          </div>
          <div style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)", marginTop: 4 }}>
            {task.schedule} · {task.cadence}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flex: "none" }}>
          <button
            className="btn btn-primary"
            style={{ height: 32 }}
          >
            <PlayIcon size={12} />
            Run now
          </button>
          <button className="btn btn-secondary" style={{ height: 32 }}>
            Pause
          </button>
          <button className="btn btn-secondary" style={{ height: 32 }}>
            Edit
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 18 }}>
        <Blueprint style={{ padding: 13 }}>
          <div style={statLabelStyle}>Next run</div>
          <div style={statValueStyle}>{task.next}</div>
        </Blueprint>
        <Blueprint style={{ padding: 13 }}>
          <div style={statLabelStyle}>Last run</div>
          <div style={statValueStyle}>{task.last}</div>
        </Blueprint>
        <Blueprint style={{ padding: 13 }}>
          <div style={statLabelStyle}>Success rate</div>
          <div style={statValueStyle}>98.2%</div>
        </Blueprint>
        <Blueprint style={{ padding: 13 }}>
          <div style={statLabelStyle}>Avg duration</div>
          <div style={statValueStyle}>4.3s</div>
        </Blueprint>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 16, marginBottom: 18 }}>
        <Blueprint style={{ padding: 16, background: "transparent" }}>
          <div style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--color-accent)", marginBottom: 8 }}>
            Definition
          </div>
          <p style={{ fontSize: 14, lineHeight: 1.6, margin: "0 0 14px" }}>
            Query the warehouse for yesterday's core metrics, build the WAU + revenue chart, and write a one-page
            digest. Flag any metric that moved more than 10% week-over-week.
          </p>
          <div style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "color-mix(in srgb, var(--color-text) 45%, transparent)", marginBottom: 6 }}>
            Tools &amp; skills
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
            <span className="tag tag-accent">postgres-prod</span>
            <span className="tag tag-accent">chart-builder</span>
            <span className="tag tag-accent">filesystem</span>
            <span className="tag tag-neutral">pi-2 Sonnet</span>
          </div>
          <div style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "color-mix(in srgb, var(--color-text) 45%, transparent)", marginBottom: 6 }}>
            Output
          </div>
          <div style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12 }}>→ metrics_digest.md · posts to Slack #metrics</div>
        </Blueprint>

        <Blueprint style={{ padding: 16, background: "transparent" }}>
          <div style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--color-accent)", marginBottom: 12 }}>
            Schedule
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 11, fontSize: 13 }}>
            <Row label="Cron" value={task.schedule} mono />
            <Row label="Cadence" value={task.cadence} />
            <Row label="Timezone" value="America/New_York" />
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
              <span style={{ color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>Enabled</span>
              <span className="seg">
                <label className="seg-opt" style={{ padding: "4px 12px" }}>
                  <input type="radio" name="enabled" defaultChecked />
                  On
                </label>
                <label className="seg-opt" style={{ padding: "4px 12px" }}>
                  <input type="radio" name="enabled" />
                  Off
                </label>
              </span>
            </div>
            <div style={{ height: 1, background: "var(--color-divider)", margin: "2px 0" }} />
            <Row label="Retry policy" value="2 attempts · 5m backoff" />
            <Row label="On failure" value="Notify #ops" />
          </div>
        </Blueprint>
      </div>

      <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 17, marginBottom: 10 }}>Run history</div>
      <Blueprint>
        <table className="table" style={{ margin: 0 }}>
          <thead>
            <tr>
              <th style={{ paddingLeft: 16 }}>When</th>
              <th>Duration</th>
              <th>Tokens</th>
              <th>Output</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {taskRuns.map((r) => (
              <tr key={r.time}>
                <td style={{ paddingLeft: 16, fontSize: 13 }}>{r.time}</td>
                <td style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12 }}>{r.dur}</td>
                <td style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
                  {r.tokens}
                </td>
                <td style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12, color: "var(--color-accent-700)" }}>{r.out}</td>
                <td>
                  <StatusTag status={r.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Blueprint>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
      <span style={{ color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>{label}</span>
      <span style={mono ? { fontFamily: "ui-monospace,Menlo,monospace", color: "var(--color-accent-700)" } : undefined}>{value}</span>
    </div>
  );
}
