import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE } from "../state/apiBase.js";
import type {
  ScheduledRunRecord,
  ScheduledTaskInput,
  ScheduledTaskPatch,
  ScheduledTaskStats,
  ScheduledTaskSummary,
} from "../views/scheduled/types.js";

interface ScheduledTasksOptions {
  visible?: boolean;
  pollMs?: number;
  runningPollMs?: number;
}

interface TaskListResponse {
  tasks: ScheduledTaskSummary[];
  unreadCount: number;
}

interface TaskDetailResponse {
  task: ScheduledTaskSummary;
  stats: ScheduledTaskStats;
  recentRuns: Array<Omit<ScheduledRunRecord, "finalText">>;
}

interface RunListResponse {
  runs: Array<Omit<ScheduledRunRecord, "finalText">>;
  nextCursor?: string;
}

interface ApiErrorBody {
  error?: { message?: string };
}

function mergeRunHistory(
  refreshed: Array<Omit<ScheduledRunRecord, "finalText">>,
  current: Array<Omit<ScheduledRunRecord, "finalText">>,
): Array<Omit<ScheduledRunRecord, "finalText">> {
  const refreshedIds = new Set(refreshed.map((run) => run.id));
  return [...refreshed, ...current.filter((run) => !refreshedIds.has(run.id))];
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init);
  if (!response.ok) {
    let message = `Scheduled Tasks request failed (${response.status})`;
    try {
      const body = await response.json() as ApiErrorBody;
      if (body.error?.message) message = body.error.message;
    } catch {
      // Keep the status-based fallback for non-JSON failures.
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

async function apiEmpty(path: string, init?: RequestInit): Promise<void> {
  const response = await fetch(`${API_BASE}${path}`, init);
  if (!response.ok) {
    let message = `Scheduled Tasks request failed (${response.status})`;
    try {
      const body = await response.json() as ApiErrorBody;
      if (body.error?.message) message = body.error.message;
    } catch {
      // Keep the status-based fallback for non-JSON failures.
    }
    throw new Error(message);
  }
}

function jsonRequest(method: "POST" | "PATCH", body?: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

export function useScheduledTasks(options: ScheduledTasksOptions = {}) {
  const { visible = true, pollMs = 10_000, runningPollMs = 1_000 } = options;
  const [tasks, setTasks] = useState<ScheduledTaskSummary[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<ScheduledTaskSummary | null>(null);
  const [stats, setStats] = useState<ScheduledTaskStats | null>(null);
  const [runs, setRuns] = useState<Array<Omit<ScheduledRunRecord, "finalText">>>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [detailRefreshRevision, setDetailRefreshRevision] = useState(0);
  const mountedRef = useRef(true);
  const listRequestRef = useRef(0);
  const loadedHistoryTaskRef = useRef<string | null>(null);

  useEffect(() => () => {
    mountedRef.current = false;
    listRequestRef.current += 1;
  }, []);

  const reconcileList = useCallback((payload: TaskListResponse) => {
    setTasks(payload.tasks);
    setUnreadCount(payload.unreadCount);
    setSelectedTaskId((current) => {
      if (current && payload.tasks.some((task) => task.id === current)) return current;
      return payload.tasks[0]?.id ?? null;
    });
  }, []);

  const refresh = useCallback(async () => {
    const requestId = ++listRequestRef.current;
    try {
      const payload = await apiJson<TaskListResponse>("/api/scheduled-tasks");
      if (!mountedRef.current || requestId !== listRequestRef.current) return;
      reconcileList(payload);
      setDetailRefreshRevision((current) => current + 1);
      setError(null);
    } catch (cause) {
      if (mountedRef.current && requestId === listRequestRef.current) {
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      }
    } finally {
      if (mountedRef.current && requestId === listRequestRef.current) setLoading(false);
    }
  }, [reconcileList]);

  const selectedIsRunning = useMemo(
    () => tasks.some((task) => task.id === selectedTaskId && task.status === "running"),
    [selectedTaskId, tasks],
  );

  useEffect(() => {
    if (!visible) {
      setLoading(false);
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await refresh();
      if (!stopped) timer = setTimeout(() => void poll(), selectedIsRunning ? runningPollMs : pollMs);
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [pollMs, refresh, runningPollMs, selectedIsRunning, visible]);

  useEffect(() => {
    if (!visible || !selectedTaskId) {
      loadedHistoryTaskRef.current = null;
      setSelectedTask(null);
      setStats(null);
      setRuns([]);
      setNextCursor(null);
      setDetailLoading(false);
      return;
    }
    const controller = new AbortController();
    let stopped = false;
    setDetailLoading(true);
    Promise.all([
      apiJson<TaskDetailResponse>(`/api/scheduled-tasks/${encodeURIComponent(selectedTaskId)}`, {
        signal: controller.signal,
      }),
      apiJson<RunListResponse>(`/api/scheduled-tasks/${encodeURIComponent(selectedTaskId)}/runs?limit=25`, {
        signal: controller.signal,
      }),
    ]).then(([detail, history]) => {
      if (stopped) return;
      const isInitialTaskLoad = loadedHistoryTaskRef.current !== selectedTaskId;
      loadedHistoryTaskRef.current = selectedTaskId;
      setSelectedTask(detail.task);
      setStats(detail.stats);
      if (isInitialTaskLoad) {
        setRuns(history.runs);
        setNextCursor(history.nextCursor ?? null);
      } else {
        setRuns((current) => mergeRunHistory(history.runs, current));
        setNextCursor((current) => current ?? history.nextCursor ?? null);
      }
      setError(null);
    }).catch((cause: unknown) => {
      if (!stopped && !(cause instanceof DOMException && cause.name === "AbortError")) {
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      }
    }).finally(() => {
      if (!stopped) setDetailLoading(false);
    });
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [detailRefreshRevision, selectedTaskId, visible]);

  const mutate = useCallback(async <T,>(operation: () => Promise<T>): Promise<T> => {
    setMutating(true);
    setError(null);
    try {
      return await operation();
    } catch (cause) {
      const nextError = cause instanceof Error ? cause : new Error(String(cause));
      if (mountedRef.current) setError(nextError);
      throw nextError;
    } finally {
      if (mountedRef.current) setMutating(false);
    }
  }, []);

  const create = useCallback((input: ScheduledTaskInput) => mutate(async () => {
    const payload = await apiJson<{ task: ScheduledTaskSummary }>(
      "/api/scheduled-tasks",
      jsonRequest("POST", input),
    );
    if (mountedRef.current) {
      setTasks((current) => [...current.filter((task) => task.id !== payload.task.id), payload.task]);
      setSelectedTaskId(payload.task.id);
    }
    return payload.task;
  }), [mutate]);

  const update = useCallback((id: string, patch: ScheduledTaskPatch) => mutate(async () => {
    const payload = await apiJson<{ task: ScheduledTaskSummary }>(
      `/api/scheduled-tasks/${encodeURIComponent(id)}`,
      jsonRequest("PATCH", patch),
    );
    if (mountedRef.current) {
      setTasks((current) => current.map((task) => task.id === id ? payload.task : task));
      setSelectedTask((current) => current?.id === id ? payload.task : current);
    }
    return payload.task;
  }), [mutate]);

  const remove = useCallback((id: string) => mutate(async () => {
    await apiEmpty(`/api/scheduled-tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (mountedRef.current) {
      const remaining = tasks.filter((task) => task.id !== id);
      setTasks(remaining);
      setSelectedTaskId((current) => current === id ? remaining[0]?.id ?? null : current);
    }
  }), [mutate, tasks]);

  const runNow = useCallback((id: string) => mutate(async () => {
    const payload = await apiJson<{ run: ScheduledRunRecord }>(
      `/api/scheduled-tasks/${encodeURIComponent(id)}/runs`,
      jsonRequest("POST"),
    );
    if (mountedRef.current) {
      setRuns((current) => [payload.run, ...current.filter((run) => run.id !== payload.run.id)]);
      setTasks((current) => current.map((task) => task.id === id
        ? { ...task, status: payload.run.status === "running" ? "running" : task.status }
        : task));
    }
    return payload.run;
  }), [mutate]);

  const loadMoreRuns = useCallback(async () => {
    if (!selectedTaskId || !nextCursor) return;
    try {
      const payload = await apiJson<RunListResponse>(
        `/api/scheduled-tasks/${encodeURIComponent(selectedTaskId)}/runs?limit=25&cursor=${encodeURIComponent(nextCursor)}`,
      );
      if (!mountedRef.current) return;
      setRuns((current) => {
        const byId = new Map(current.map((run) => [run.id, run]));
        for (const run of payload.runs) byId.set(run.id, run);
        return [...byId.values()];
      });
      setNextCursor(payload.nextCursor ?? null);
    } catch (cause) {
      if (mountedRef.current) setError(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }, [nextCursor, selectedTaskId]);

  const markRunRead = useCallback(async (taskId: string, runId: string) => {
    await apiEmpty(
      `/api/scheduled-tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}/read`,
      { method: "POST" },
    );
    if (!mountedRef.current) return;
    setRuns((current) => current.map((run) => run.id === runId ? { ...run, unread: false } : run));
    setTasks((current) => current.map((task) => task.id === taskId
      ? { ...task, unreadCount: Math.max(0, task.unreadCount - 1) }
      : task));
    setUnreadCount((current) => Math.max(0, current - 1));
    window.dispatchEvent(new Event("scheduled-runs-read"));
  }, []);

  const getRun = useCallback(async (taskId: string, runId: string) => {
    const payload = await apiJson<{ run: ScheduledRunRecord }>(
      `/api/scheduled-tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}`,
    );
    return payload.run;
  }, []);

  const markAllRead = useCallback(async () => {
    await apiEmpty("/api/scheduled-tasks/read-all", { method: "POST" });
    if (!mountedRef.current) return;
    setRuns((current) => current.map((run) => ({ ...run, unread: false })));
    setTasks((current) => current.map((task) => ({ ...task, unreadCount: 0 })));
    setUnreadCount(0);
    window.dispatchEvent(new Event("scheduled-runs-read"));
  }, []);

  return {
    tasks,
    unreadCount,
    selectedTaskId,
    selectedTask,
    stats,
    runs,
    nextCursor,
    loading,
    detailLoading,
    mutating,
    error,
    selectTask: setSelectedTaskId,
    refresh,
    create,
    update,
    remove,
    runNow,
    loadMoreRuns,
    markRunRead,
    getRun,
    markAllRead,
  };
}
