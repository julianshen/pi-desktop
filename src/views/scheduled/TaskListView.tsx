import { Blueprint } from "../../components/Blueprint";
import { StatusTag } from "../../components/StatusTag";
import { schedules } from "../../data/mockData";

export function TaskListView({ onOpenTask }: { onOpenTask: (index: number) => void }) {
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "22px 24px" }}>
      <Blueprint>
        <table className="table" style={{ margin: 0 }}>
          <thead>
            <tr>
              <th style={{ paddingLeft: 16 }}>Task</th>
              <th>Schedule</th>
              <th>Cadence</th>
              <th>Last run</th>
              <th>Next</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {schedules.map((s, i) => (
              <tr key={s.name} onClick={() => onOpenTask(i)} style={{ cursor: "pointer" }}>
                <td style={{ paddingLeft: 16, fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 14 }}>{s.name}</td>
                <td style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12, color: "var(--color-accent-700)" }}>{s.schedule}</td>
                <td style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>{s.cadence}</td>
                <td style={{ fontSize: 12 }}>{s.last}</td>
                <td style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>{s.next}</td>
                <td>
                  <StatusTag status={s.status} />
                </td>
                <td style={{ textAlign: "right", paddingRight: 14, color: "var(--color-accent)" }}>→</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Blueprint>
    </div>
  );
}
