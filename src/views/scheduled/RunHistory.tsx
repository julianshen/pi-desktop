import { useMemo, useState } from "react";
import type { ScheduledRunRecord } from "./types.js";
import { formatDuration } from "./format.js";

type JournalFilter = "all" | "failed" | "files";

function when(run: Omit<ScheduledRunRecord, "finalText">): string {
  const value = run.startedAt ?? run.scheduledFor;
  if (!value) return "Start time unavailable";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

const runLabel: Record<ScheduledRunRecord["status"], string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  skipped: "Skipped",
};

export function RunHistory({
  runs,
  hasMore,
  onLoadMore,
  onSelectRun,
}: {
  runs: Array<Omit<ScheduledRunRecord, "finalText">>;
  hasMore: boolean;
  onLoadMore: () => Promise<unknown>;
  onSelectRun: (run: Omit<ScheduledRunRecord, "finalText">) => void;
}) {
  const [filter, setFilter] = useState<JournalFilter>("all");
  const filtered = useMemo(() => runs.filter((run) => {
    if (filter === "failed") return run.status === "failed";
    if (filter === "files") return run.files.length > 0;
    return true;
  }), [filter, runs]);

  return (
    <section className="scheduled-runs" aria-label="Run history">
      <div className="scheduled-runs-header">
        <div>
          <div className="scheduled-eyebrow">Execution journal</div>
          <h3>Run history</h3>
        </div>
        <div className="seg" aria-label="Filter run history">
          <FilterButton active={filter === "all"} label="All runs" onClick={() => setFilter("all")} />
          <FilterButton active={filter === "failed"} label="Failed runs" onClick={() => setFilter("failed")} />
          <FilterButton active={filter === "files"} label="Runs with files" onClick={() => setFilter("files")} />
        </div>
      </div>

      <div className="scheduled-run-list">
        {filtered.map((run) => (
          <button type="button" key={run.id} className={`scheduled-run-row scheduled-run-${run.status}`} onClick={() => onSelectRun(run)} aria-label={`Open run ${run.id}, ${runLabel[run.status]}`}>
            <span className="scheduled-run-line" aria-hidden="true" />
            <div>
              <strong>{run.id}</strong>
              <span>{when(run)} · {run.trigger === "manual" ? "Manual" : "Scheduled"}</span>
            </div>
            <div className="scheduled-run-output">
              {run.error?.message ?? (run.files.length ? `${run.files.length} generated file${run.files.length === 1 ? "" : "s"}` : "No generated files")}
            </div>
            <div className="scheduled-run-facts">
              <span>{formatDuration(run.durationMs)}</span>
              <span className={`scheduled-run-status scheduled-run-status-${run.status}`}>{runLabel[run.status]}</span>
              {run.unread && <span className="scheduled-unread-dot" aria-label="Unread run">●</span>}
            </div>
          </button>
        ))}
        {filtered.length === 0 && (
          <div className="scheduled-inline-empty">
            <strong>{runs.length ? "No runs in this filter" : "No runs yet"}</strong>
            <span>{runs.length ? "Choose another journal filter." : "Run the task now or wait for its next schedule."}</span>
          </div>
        )}
      </div>
      {hasMore && <button type="button" className="btn btn-secondary scheduled-load-more" onClick={() => void onLoadMore()}>Load older runs</button>}
    </section>
  );
}

const shortFilterLabel: Record<string, string> = {
  "All runs": "All",
  "Failed runs": "Failed",
  "Runs with files": "Files",
};

function FilterButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" className={active ? "seg-opt active" : "seg-opt"} aria-pressed={active} aria-label={label} onClick={onClick}>
      {shortFilterLabel[label] ?? label}
    </button>
  );
}
