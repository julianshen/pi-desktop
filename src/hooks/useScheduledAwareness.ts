import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE } from "../state/apiBase.js";
import { trackDesktopEvent } from "../lib/analytics.js";

interface NotificationBridge {
  isPermissionGranted(): Promise<boolean>;
  requestPermission(): Promise<string>;
  sendNotification(options: { title: string; body: string }): void | Promise<void>;
}

interface AwarenessOptions {
  pollMs?: number;
  notification?: NotificationBridge;
}

interface AwarenessTask { id: string; name: string; unreadCount: number }
interface AwarenessRun { id: string; status: string; unread: boolean }

const handledFailureRunIds = new Set<string>();
const MAX_HANDLED_FAILURE_RUN_IDS = 500;
const nativeNotification: NotificationBridge = {
  isPermissionGranted: async () => (await import("@tauri-apps/plugin-notification")).isPermissionGranted(),
  requestPermission: async () => (await import("@tauri-apps/plugin-notification")).requestPermission(),
  sendNotification: async (options) => (await import("@tauri-apps/plugin-notification")).sendNotification(options),
};

async function notifyFailureOnce(task: AwarenessTask, run: AwarenessRun, bridge: NotificationBridge): Promise<void> {
  if (handledFailureRunIds.has(run.id)) return;
  handledFailureRunIds.add(run.id);
  if (handledFailureRunIds.size > MAX_HANDLED_FAILURE_RUN_IDS) {
    const oldest = handledFailureRunIds.values().next().value;
    if (oldest !== undefined) handledFailureRunIds.delete(oldest);
  }
  const appVisible = document.visibilityState === "visible";
  try {
    let granted = await bridge.isPermissionGranted();
    if (!granted) granted = (await bridge.requestPermission()) === "granted";
    if (!granted) {
      trackDesktopEvent({ name: "scheduled_task_failure_notified", properties: { outcome: "permission_denied", app_visible: appVisible } });
      return;
    }
    try {
      await bridge.sendNotification({ title: "Scheduled task failed", body: `${task.name} needs attention.` });
      trackDesktopEvent({ name: "scheduled_task_failure_notified", properties: { outcome: "requested", app_visible: appVisible } });
    } catch {
      trackDesktopEvent({ name: "scheduled_task_failure_notified", properties: { outcome: "failed", app_visible: appVisible } });
    }
  } catch {
    trackDesktopEvent({ name: "scheduled_task_failure_notified", properties: { outcome: "api_unavailable", app_visible: appVisible } });
    // Notifications are best-effort and must never change durable unread state.
  }
}

export function useScheduledAwareness(options: AwarenessOptions = {}) {
  const { pollMs = 5_000, notification = nativeNotification } = options;
  const [unreadCount, setUnreadCount] = useState(0);
  const [error, setError] = useState<Error | null>(null);
  const mountedRef = useRef(true);
  const requestRef = useRef(0);

  useEffect(() => () => { mountedRef.current = false; requestRef.current += 1; }, []);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const response = await fetch(`${API_BASE}/api/scheduled-tasks`);
      if (!response.ok) throw new Error(`Scheduled awareness failed (${response.status})`);
      const payload = await response.json() as { tasks: AwarenessTask[]; unreadCount: number };
      if (!mountedRef.current || request !== requestRef.current) return;
      setUnreadCount(payload.unreadCount);
      setError(null);
      const unreadTasks = payload.tasks.filter((task) => task.unreadCount > 0);
      await Promise.all(unreadTasks.map(async (task) => {
        try {
          const runsResponse = await fetch(`${API_BASE}/api/scheduled-tasks/${encodeURIComponent(task.id)}/runs?limit=100`);
          if (!runsResponse.ok) return;
          const body = await runsResponse.json() as { runs: AwarenessRun[] };
          for (const run of body.runs) {
            if (run.unread && run.status === "failed") await notifyFailureOnce(task, run, notification);
          }
        } catch {
          // One task's history must not prevent the durable total from surfacing.
        }
      }));
    } catch (cause) {
      if (mountedRef.current && request === requestRef.current) setError(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }, [notification]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await refresh();
      if (!stopped) timer = setTimeout(() => void poll(), pollMs);
    };
    void poll();
    const onRead = () => void refresh();
    window.addEventListener("scheduled-runs-read", onRead);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("scheduled-runs-read", onRead);
    };
  }, [pollMs, refresh]);

  return { unreadCount, error, refresh };
}
