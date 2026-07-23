import { useMemo, useState } from "react";
import type { ScheduledTaskSummary } from "./types.js";

const statusLabel: Record<ScheduledTaskSummary["status"], string> = {
  active: "Active",
  paused: "Paused",
  running: "Running",
  failed: "Failed",
};

export function HealthBadge({ status }: { status: ScheduledTaskSummary["status"] }) {
  const symbol = status === "running" ? "◉" : status === "failed" ? "▲" : status === "paused" ? "Ⅱ" : "●";
  return (
    <span className={`scheduled-health scheduled-health-${status}`} aria-label={`Status: ${statusLabel[status]}`}>
      <span aria-hidden="true">{symbol}</span>
      {statusLabel[status]}
    </span>
  );
}

function compactDate(value: string | null): string {
  if (!value) return "Not scheduled";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function TaskListView({
  tasks,
  selectedTaskId,
  onSelectTask,
}: {
  tasks: ScheduledTaskSummary[];
  selectedTaskId: string | null;
  onSelectTask: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return tasks;
    return tasks.filter((task) => `${task.name} ${task.prompt} ${task.scheduleLabel}`.toLocaleLowerCase().includes(normalized));
  }, [query, tasks]);

  return (
    <aside className="scheduled-navigator" aria-label="Scheduled task navigator">
      <div className="scheduled-navigator-header">
        <label className="scheduled-search">
          <span className="sr-only">Search scheduled tasks</span>
          <span aria-hidden="true">⌕</span>
          <input
            aria-label="Search scheduled tasks"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search tasks"
          />
          {query && <button type="button" aria-label="Clear search input" onClick={() => setQuery("")}>×</button>}
        </label>
        <div className="scheduled-count">{filtered.length} / {tasks.length} tasks</div>
      </div>

      <div className="scheduled-task-list">
        {filtered.map((task) => (
          <button
            key={task.id}
            type="button"
            className="scheduled-task-row"
            aria-current={selectedTaskId === task.id ? "true" : undefined}
            aria-label={`${task.name}, ${statusLabel[task.status]}`}
            onClick={() => onSelectTask(task.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") onSelectTask(task.id);
            }}
          >
            <span className="scheduled-task-row-top">
              <strong>{task.name}</strong>
              {task.unreadCount > 0 && <span className="scheduled-unread">{task.unreadCount} unread</span>}
            </span>
            <span className="scheduled-task-row-meta">
              <HealthBadge status={task.status} />
              <code>{task.cron}</code>
            </span>
            <span className="scheduled-task-row-next">
              {task.status === "paused" ? "Paused" : `Next ${compactDate(task.nextRun)}`}
            </span>
          </button>
        ))}
        {filtered.length === 0 && (
          <div className="scheduled-inline-empty">
            <strong>No tasks match this search</strong>
            <span>Try a task name, prompt, or cron expression.</span>
            <button type="button" className="btn btn-secondary" onClick={() => setQuery("")}>Clear search</button>
          </div>
        )}
      </div>
    </aside>
  );
}
