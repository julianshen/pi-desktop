import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE } from "../state/apiBase.js";
import { countBucket, trackDesktopEvent } from "../lib/analytics.js";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "stopped" | "interrupted";
export interface RunEventView { id: string; runId: string; cursor: number; type: string; data: unknown; createdAt: string }
export interface PlanStepView { id: string; position: number; title: string; status: "pending" | "in_progress" | "completed" | "failed" }
export interface ActiveRunView { id: string; conversationId: string; branchId?: string; status: RunStatus; model?: string; createdAt: string; startedAt?: string; completedAt?: string; plan?: PlanStepView[] }

const POLL_MS = 750;

export function useActiveRun(conversationId: string) {
  const [run, setRun] = useState<ActiveRunView | null>(null);
  const [events, setEvents] = useState<RunEventView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const cursorRef = useRef(0);
  const restoredRunIdsRef = useRef(new Set<string>());

  const mergeEvents = useCallback((incoming: RunEventView[]) => {
    setEvents((current) => {
      const byCursor = new Map(current.map((event) => [event.cursor, event]));
      for (const event of incoming) byCursor.set(event.cursor, event);
      const merged = [...byCursor.values()].sort((a, b) => a.cursor - b.cursor);
      cursorRef.current = merged.at(-1)?.cursor ?? 0;
      return merged;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    cursorRef.current = 0;
    setEvents([]);
    setRun(null);

    async function poll() {
      let attemptedRun: ActiveRunView | null = null;
      try {
        let currentRun = run;
        if (!currentRun) {
          const response = await fetch(`${API_BASE}/api/conversations/${conversationId}/runs`);
          if (!response.ok) throw new Error(`Could not load runs (${response.status})`);
          const list = await response.json() as ActiveRunView[];
          currentRun = list[0] ?? null;
          if (!cancelled) setRun(currentRun);
        }
        attemptedRun = currentRun;
        if (currentRun) {
          const [runResponse, eventsResponse] = await Promise.all([
            fetch(`${API_BASE}/api/runs/${currentRun.id}`),
            fetch(`${API_BASE}/api/runs/${currentRun.id}/events?after=${cursorRef.current}`),
          ]);
          if (!runResponse.ok || !eventsResponse.ok) throw new Error("Could not refresh run progress");
          const refreshed = await runResponse.json() as ActiveRunView;
          const nextEvents = await eventsResponse.json() as RunEventView[];
          if (!cancelled) {
            setRun(refreshed); mergeEvents(nextEvents); setError(null);
            if ((currentRun.status === "queued" || currentRun.status === "running") && !restoredRunIdsRef.current.has(currentRun.id)) {
              restoredRunIdsRef.current.add(currentRun.id);
              trackDesktopEvent({ name: "agent_run_restored", properties: { outcome: "success", prior_status: currentRun.status, replayed_event_count_bucket: countBucket(nextEvents.length) } });
            }
          }
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Run connection failed");
          const current = attemptedRun;
          if (current && (current.status === "queued" || current.status === "running") && !restoredRunIdsRef.current.has(current.id)) {
            restoredRunIdsRef.current.add(current.id);
            trackDesktopEvent({ name: "agent_run_restored", properties: { outcome: "failed", prior_status: current.status, replayed_event_count_bucket: "0" } });
          }
        }
      } finally {
        if (!cancelled) timer = setTimeout(() => void poll(), POLL_MS);
      }
    }
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
    // A run update intentionally arrives through polling, not this dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, mergeEvents]);

  const stop = useCallback(async () => {
    if (!run) return;
    const response = await fetch(`${API_BASE}/api/runs/${run.id}/stop`, { method: "POST" });
    if (!response.ok) throw new Error(`Could not stop run (${response.status})`);
    setRun(await response.json() as ActiveRunView);
  }, [run]);

  const steer = useCallback(async (instruction: string) => {
    if (!run) return;
    const response = await fetch(`${API_BASE}/api/runs/${run.id}/steer`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instruction }),
    });
    if (!response.ok) throw new Error(`Could not steer run (${response.status})`);
  }, [run]);

  const plan = useMemo(() => {
    const latest = [...events].reverse().find((event) => event.type === "plan_updated")?.data as { steps?: Array<{ id: string; text: string; status: PlanStepView["status"] }> } | undefined;
    return latest?.steps?.map((step, position) => ({ id: step.id, position, title: step.text, status: step.status })) ?? run?.plan ?? [];
  }, [events, run]);

  return { run, events, plan, error, stop, steer };
}
