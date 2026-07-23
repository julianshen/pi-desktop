import { useEffect, useRef, useState } from "react";
import { useScheduledTasks } from "../hooks/useScheduledTasks.js";
import { TaskCreateView } from "./scheduled/TaskCreateView.js";
import { TaskDetailView } from "./scheduled/TaskDetailView.js";
import { TaskForm } from "./scheduled/TaskForm.js";
import { RunDetail } from "./scheduled/RunDetail.js";
import type { ScheduledRunRecord } from "./scheduled/types.js";
import { trackDesktopEvent } from "../lib/analytics.js";
import { TaskListView } from "./scheduled/TaskListView.js";

interface ScheduledTasksViewProps {
  taskOpen: number | null;
  taskCreate: boolean;
  onOpenTask: (index: number) => void;
  onBackToTasks: () => void;
  onCloseCreate: () => void;
  onCreateTask?: () => void;
}

export function ScheduledTasksView({ taskCreate, onCloseCreate, onCreateTask }: ScheduledTasksViewProps) {
  const scheduled = useScheduledTasks();
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [inspectedRun, setInspectedRun] = useState<ScheduledRunRecord | null>(null);
  const [inspectorLoading, setInspectorLoading] = useState(false);
  const [inspectorError, setInspectorError] = useState<string | null>(null);
  const inspectorRequest = useRef(0);
  const inspectedHistoryRun = inspectedRun
    ? scheduled.runs.find((run) => run.id === inspectedRun.id)
    : undefined;

  useEffect(() => {
    if (
      !inspectedRun
      || inspectedRun.status !== "running"
      || !inspectedHistoryRun
      || inspectedHistoryRun.status === "running"
    ) {
      return;
    }
    let cancelled = false;
    scheduled.getRun(inspectedRun.taskId, inspectedRun.id)
      .then(async (detail) => {
        if (cancelled) return;
        setInspectedRun(detail);
        setInspectorError(null);
        if (detail.unread) {
          await scheduled.markRunRead(detail.taskId, detail.id);
          if (!cancelled) {
            setInspectedRun((current) => current?.id === detail.id
              ? { ...current, unread: false }
              : current);
          }
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setInspectorError(cause instanceof Error ? cause.message : "Run evidence could not be refreshed.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    inspectedHistoryRun?.status,
    inspectedRun?.id,
    inspectedRun?.status,
    inspectedRun?.taskId,
    scheduled.getRun,
    scheduled.markRunRead,
  ]);

  const inspectRun = (run: Omit<ScheduledRunRecord, "finalText">) => {
    const request = ++inspectorRequest.current;
    setInspectorLoading(true);
    setInspectorError(null);
    scheduled.getRun(run.taskId, run.id)
      .then(async (detail) => {
        if (request !== inspectorRequest.current) return;
        setInspectedRun(detail);
        trackDesktopEvent({ name: "scheduled_task_run_opened", properties: { outcome: "success", run_status: detail.status, has_files: detail.files.length > 0 } });
        if (detail.unread) await scheduled.markRunRead(detail.taskId, detail.id);
      })
      .catch((cause: unknown) => {
        if (request !== inspectorRequest.current) return;
        const message = cause instanceof Error ? cause.message : "Run evidence could not be loaded.";
        setInspectorError(message);
        trackDesktopEvent({ name: "scheduled_task_run_opened", properties: { outcome: /not found/i.test(message) ? "not_found" : /unavailable|failed \(5\d\d\)/i.test(message) ? "unavailable" : "failed", run_status: run.status, has_files: run.files.length > 0 } });
      })
      .finally(() => {
        if (request === inspectorRequest.current) setInspectorLoading(false);
      });
  };

  const closeInspector = () => {
    inspectorRequest.current += 1;
    setInspectedRun(null);
    setInspectorLoading(false);
    setInspectorError(null);
  };

  if (taskCreate) return (
    <TaskCreateView
      onClose={onCloseCreate}
      onCreate={async (value) => {
        await scheduled.create(value);
        onCloseCreate();
      }}
    />
  );

  if (scheduled.loading && scheduled.tasks.length === 0) {
    return <div className="scheduled-full-state" role="status">Loading scheduled tasks…</div>;
  }

  if (scheduled.error && scheduled.tasks.length === 0) {
    return (
      <div className="scheduled-full-state" role="alert">
        <strong>Scheduled Tasks is unavailable</strong>
        <span>{scheduled.error.message}</span>
        <button type="button" className="btn btn-primary" onClick={() => void scheduled.refresh()}>Retry</button>
      </div>
    );
  }

  if (scheduled.tasks.length === 0) {
    return (
      <div className="scheduled-full-state">
        <strong>No scheduled tasks yet</strong>
        <span>Create a schedule to let the agent run work in the background.</span>
        <button type="button" className="btn btn-primary" onClick={onCreateTask}>Create scheduled task</button>
      </div>
    );
  }

  return (
    <div className="scheduled-console" data-min-width-safe="true">
      <TaskListView
        tasks={scheduled.tasks}
        selectedTaskId={scheduled.selectedTaskId}
        onSelectTask={scheduled.selectTask}
      />
      <TaskDetailView
        task={scheduled.selectedTask}
        stats={scheduled.stats}
        runs={scheduled.runs}
        loading={scheduled.detailLoading}
        mutating={scheduled.mutating}
        hasMoreRuns={scheduled.nextCursor !== null}
        onRunNow={() => scheduled.selectedTaskId ? scheduled.runNow(scheduled.selectedTaskId) : Promise.resolve()}
        onToggleEnabled={() => scheduled.selectedTask
          ? scheduled.update(scheduled.selectedTask.id, { enabled: !scheduled.selectedTask.enabled })
          : Promise.resolve()}
        onEdit={() => setEditing(true)}
        onDelete={() => setConfirmingDelete(true)}
        onLoadMore={scheduled.loadMoreRuns}
        onSelectRun={inspectRun}
      />
      {(inspectedRun || inspectorLoading || inspectorError) && (
        <RunDetail run={inspectedRun} loading={inspectorLoading} error={inspectorError} onClose={closeInspector} />
      )}
      {editing && scheduled.selectedTask && (
        <TaskForm
          mode="edit"
          task={scheduled.selectedTask}
          onCancel={() => setEditing(false)}
          onSubmit={async (value) => {
            await scheduled.update(scheduled.selectedTask!.id, value);
            setEditing(false);
          }}
        />
      )}
      {confirmingDelete && scheduled.selectedTask && (
        <div className="scheduled-confirm-backdrop">
          <section className="scheduled-confirm" role="alertdialog" aria-modal="true" aria-labelledby="scheduled-delete-title">
            <div className="scheduled-eyebrow">Destructive action</div>
            <h3 id="scheduled-delete-title">Delete {scheduled.selectedTask.name}?</h3>
            <p>The task definition will be removed. Existing run evidence remains on disk but is no longer shown here.</p>
            {scheduled.error && <div role="alert" className="scheduled-form-error">{scheduled.error.message}</div>}
            <div>
              <button type="button" className="btn btn-secondary" autoFocus onClick={() => setConfirmingDelete(false)}>Cancel</button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={scheduled.mutating}
                onClick={() => {
                  void scheduled.remove(scheduled.selectedTask!.id)
                    .then(() => setConfirmingDelete(false))
                    .catch(() => undefined);
                }}
              >Delete task</button>
            </div>
          </section>
        </div>
      )}
      {scheduled.error && <div className="scheduled-error-toast" role="alert">{scheduled.error.message}</div>}
    </div>
  );
}
