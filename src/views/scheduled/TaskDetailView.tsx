import { Blueprint } from "../../components/Blueprint.js";
import { PlayIcon } from "../../components/icons.js";
import { HealthBadge } from "./TaskListView.js";
import { RunHistory } from "./RunHistory.js";
import type { ScheduledRunRecord, ScheduledTaskStats, ScheduledTaskSummary } from "./types.js";
import { formatDuration } from "./format.js";

function timestamp(value: string | null | undefined): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function TaskDetailView({
  task,
  stats,
  runs,
  loading,
  mutating,
  hasMoreRuns,
  onRunNow,
  onToggleEnabled,
  onEdit,
  onDelete,
  onLoadMore,
  onSelectRun,
}: {
  task: ScheduledTaskSummary | null;
  stats: ScheduledTaskStats | null;
  runs: Array<Omit<ScheduledRunRecord, "finalText">>;
  loading: boolean;
  mutating: boolean;
  hasMoreRuns: boolean;
  onRunNow: () => Promise<unknown>;
  onToggleEnabled: () => Promise<unknown>;
  onEdit: () => void;
  onDelete: () => void;
  onLoadMore: () => Promise<unknown>;
  onSelectRun: (run: Omit<ScheduledRunRecord, "finalText">) => void;
}) {
  if (loading && !task) return <div className="scheduled-pane-state" role="status">Loading task details…</div>;
  if (!task) return <div className="scheduled-pane-state">Select a task to inspect its definition and runs.</div>;

  return (
    <section className="scheduled-journal" aria-label={`${task.name} execution journal`}>
      <header className="scheduled-detail-header">
        <div className="scheduled-detail-title">
          <div className="scheduled-eyebrow">Task definition / execution journal</div>
          <div className="scheduled-title-line">
            <h2>{task.name}</h2>
            <HealthBadge status={task.status} />
          </div>
          <code>{task.cron} · {task.timezone}</code>
        </div>
        <div className="scheduled-actions">
          <button className="btn btn-primary" type="button" disabled={mutating || task.status === "running"} onClick={() => void onRunNow()}>
            <PlayIcon size={12} />
            {task.status === "running" ? "Running" : "Run now"}
          </button>
          <button className="btn btn-secondary" type="button" disabled={mutating || task.status === "running"} onClick={() => void onToggleEnabled()}>
            {task.enabled ? "Pause" : "Resume"}
          </button>
          <button className="btn btn-secondary" type="button" disabled={mutating} onClick={onEdit}>Edit</button>
          <button className="btn btn-secondary" type="button" disabled={mutating} onClick={onDelete}>Delete</button>
        </div>
      </header>

      <div className="scheduled-health-strip">
        <Metric label="Next run" value={task.enabled ? timestamp(task.nextRun) : "Paused"} />
        <Metric label="Last run" value={timestamp(task.lastRun?.completedAt ?? task.lastRun?.startedAt)} />
        <Metric label="Success rate" value={stats ? `${stats.successRate}%` : "—"} />
        <Metric label="Avg duration" value={formatDuration(stats?.averageDurationMs)} />
      </div>

      <Blueprint className="scheduled-definition">
        <div>
          <div className="scheduled-eyebrow">Instructions</div>
          <p>{task.prompt}</p>
        </div>
        <dl>
          <div><dt>Timezone</dt><dd>{task.timezone}</dd></div>
          <div><dt>Model</dt><dd>{task.modelId ?? "Use app default"}</dd></div>
          <div><dt>Created</dt><dd>{timestamp(task.createdAt)}</dd></div>
        </dl>
      </Blueprint>

      <RunHistory runs={runs} hasMore={hasMoreRuns} onLoadMore={onLoadMore} onSelectRun={onSelectRun} />
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}
