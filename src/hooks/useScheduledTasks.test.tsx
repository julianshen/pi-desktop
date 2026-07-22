import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useScheduledTasks } from "./useScheduledTasks.js";
import type { ScheduledTaskSummary } from "../views/scheduled/types.js";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
});

function response(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function task(id: string, status: ScheduledTaskSummary["status"] = "active"): ScheduledTaskSummary {
  return {
    id,
    name: `Task ${id}`,
    prompt: "Do the work",
    cron: "0 9 * * 1",
    timezone: "UTC",
    enabled: status !== "paused",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    status,
    lastRun: null,
    nextRun: status === "paused" ? null : "2026-08-01T09:00:00.000Z",
    scheduleLabel: "0 9 * * 1 · UTC",
    unreadCount: 0,
  };
}

describe("useScheduledTasks", () => {
  test("AC-6.1: exposes real list/detail state and reconciles a create mutation without mock data", async () => {
    const calls: string[] = [];
    let tasks = [task("one")];
    global.fetch = mock((url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/api/scheduled-tasks") && init?.method === "POST") {
        const created = task("two");
        tasks = [...tasks, created];
        return Promise.resolve(response({ task: created }, 201));
      }
      if (url.endsWith("/api/scheduled-tasks")) {
        return Promise.resolve(response({ tasks, unreadCount: 0 }));
      }
      if (url.includes("/runs?limit=25")) return Promise.resolve(response({ runs: [] }));
      if (url.endsWith("/api/scheduled-tasks/one")) {
        return Promise.resolve(response({ task: tasks[0], stats: { successRate: 100, averageDurationMs: 1200 }, recentRuns: [] }));
      }
      if (url.endsWith("/api/scheduled-tasks/two")) {
        return Promise.resolve(response({ task: tasks[1], stats: { successRate: 0, averageDurationMs: 0 }, recentRuns: [] }));
      }
      return Promise.reject(new Error(`unexpected ${url}`));
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useScheduledTasks({ pollMs: 60_000, runningPollMs: 60_000 }));
    await waitFor(() => expect(result.current.tasks.map((item) => item.id)).toEqual(["one"]));
    await waitFor(() => expect(result.current.selectedTask?.id).toBe("one"));
    expect(result.current.stats).toEqual({ successRate: 100, averageDurationMs: 1200 });

    await act(async () => {
      await result.current.create({
        name: "Task two",
        prompt: "Do the work",
        cron: "0 9 * * 1",
        timezone: "UTC",
        enabled: true,
        modelId: null,
      });
    });
    await waitFor(() => expect(result.current.selectedTaskId).toBe("two"));
    await waitFor(() => expect(result.current.tasks.map((item) => item.id)).toEqual(["one", "two"]));
    expect(calls.some((call) => call.startsWith("POST "))).toBe(true);
  });

  test("AC-6.2: a late detail response cannot overwrite a newer task selection and unmount stops polling", async () => {
    let resolveOne!: (value: Response) => void;
    const one = new Promise<Response>((resolve) => {
      resolveOne = resolve;
    });
    let calls = 0;
    global.fetch = mock((url: string) => {
      calls += 1;
      if (url.endsWith("/api/scheduled-tasks")) {
        return Promise.resolve(response({ tasks: [task("one"), task("two")], unreadCount: 0 }));
      }
      if (url.includes("/runs?limit=25")) return Promise.resolve(response({ runs: [] }));
      if (url.endsWith("/api/scheduled-tasks/one")) return one;
      if (url.endsWith("/api/scheduled-tasks/two")) {
        return Promise.resolve(response({ task: task("two"), stats: { successRate: 50, averageDurationMs: 20 }, recentRuns: [] }));
      }
      return Promise.reject(new Error(`unexpected ${url}`));
    }) as unknown as typeof fetch;

    const { result, unmount } = renderHook(() => useScheduledTasks({ pollMs: 20, runningPollMs: 10 }));
    await waitFor(() => expect(result.current.selectedTaskId).toBe("one"));
    act(() => result.current.selectTask("two"));
    await waitFor(() => expect(result.current.selectedTask?.id).toBe("two"));
    resolveOne(response({ task: task("one"), stats: { successRate: 1, averageDurationMs: 1 }, recentRuns: [] }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current.selectedTask?.id).toBe("two");

    unmount();
    const atUnmount = calls;
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(calls).toBe(atUnmount);
  });

  test("AC-6.3: running tasks use the bounded fast poll then settle to normal state without duplicate mutations", async () => {
    let listCalls = 0;
    global.fetch = mock((url: string) => {
      if (url.endsWith("/api/scheduled-tasks")) {
        listCalls += 1;
        return Promise.resolve(response({
          tasks: [task("one", listCalls === 1 ? "running" : "active")],
          unreadCount: 0,
        }));
      }
      if (url.includes("/runs?limit=25")) return Promise.resolve(response({ runs: [] }));
      if (url.endsWith("/api/scheduled-tasks/one")) {
        return Promise.resolve(response({ task: task("one"), stats: { successRate: 100, averageDurationMs: 5 }, recentRuns: [] }));
      }
      return Promise.reject(new Error(`unexpected ${url}`));
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useScheduledTasks({ pollMs: 100, runningPollMs: 10 }));
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2), { timeout: 500 });
    await waitFor(() => expect(result.current.tasks[0]?.status).toBe("active"));
    expect(result.current.mutating).toBe(false);
  });

  test("review regression: polling refreshes the selected task detail and run history", async () => {
    let listCalls = 0;
    let detailCalls = 0;
    global.fetch = mock((url: string) => {
      if (url.endsWith("/api/scheduled-tasks")) {
        listCalls += 1;
        return Promise.resolve(response({
          tasks: [task("one", listCalls === 1 ? "running" : "active")],
          unreadCount: listCalls > 1 ? 1 : 0,
        }));
      }
      if (url.endsWith("/api/scheduled-tasks/one")) {
        detailCalls += 1;
        return Promise.resolve(response({
          task: task("one", detailCalls === 1 ? "running" : "active"),
          stats: { successRate: detailCalls === 1 ? 0 : 100, averageDurationMs: 5 },
          recentRuns: [],
        }));
      }
      if (url.includes("/runs?limit=25")) {
        return Promise.resolve(response({
          runs: detailCalls > 1 ? [{ id: "completed-run", status: "completed" }] : [],
        }));
      }
      return Promise.reject(new Error(`unexpected ${url}`));
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useScheduledTasks({ pollMs: 100, runningPollMs: 10 }));
    await waitFor(() => expect(detailCalls).toBeGreaterThanOrEqual(2), { timeout: 500 });
    await waitFor(() => expect(result.current.stats?.successRate).toBe(100));
    expect(result.current.runs[0]?.id).toBe("completed-run");
  });
});
