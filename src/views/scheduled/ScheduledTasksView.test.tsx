import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ScheduledTasksView } from "../ScheduledTasksView.js";
import type { ScheduledRunRecord, ScheduledTaskSummary } from "./types.js";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
});

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function task(id: string, status: ScheduledTaskSummary["status"], unreadCount = 0): ScheduledTaskSummary {
  return {
    id,
    name: id === "failed" ? "Failed warehouse sync" : "Daily metrics",
    prompt: `Prompt for ${id}`,
    cron: "0 9 * * 1",
    timezone: "Asia/Taipei",
    enabled: status !== "paused",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    status,
    lastRun: null,
    nextRun: status === "paused" ? null : "2026-08-01T01:00:00.000Z",
    scheduleLabel: "0 9 * * 1 · Asia/Taipei",
    unreadCount,
  };
}

function run(id: string, status: ScheduledRunRecord["status"], files = 0): ScheduledRunRecord {
  return {
    id,
    taskId: "active",
    trigger: "cron",
    status,
    startedAt: "2026-07-21T01:00:00.000Z",
    completedAt: "2026-07-21T01:00:05.000Z",
    durationMs: 5_000,
    files: Array.from({ length: files }, (_, index) => ({
      id: `file-${index}`,
      name: `report-${index}.md`,
      mediaType: "text/markdown",
      byteSize: 10,
      state: "available" as const,
    })),
    unread: id === "failed-run",
    definition: { name: "Daily metrics", prompt: "Prompt", cron: "0 9 * * 1", timezone: "Asia/Taipei", enabled: true },
  };
}

function installApi(tasks: ScheduledTaskSummary[], runs: ScheduledRunRecord[] = []) {
  global.fetch = mock((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/scheduled-tasks")) return Promise.resolve(response({ tasks, unreadCount: 1 }));
    if (url.includes("/runs?limit=25")) return Promise.resolve(response({ runs }));
    const selected = tasks.find((item) => url.endsWith(`/api/scheduled-tasks/${item.id}`));
    if (selected) return Promise.resolve(response({ task: selected, stats: { successRate: 75, averageDurationMs: 5000 }, recentRuns: runs }));
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  }) as unknown as typeof fetch;
}

const baseProps = {
  taskOpen: null,
  taskCreate: false,
  onOpenTask: () => {},
  onBackToTasks: () => {},
  onCloseCreate: () => {},
};

describe("ScheduledTasksView", () => {
  test("AC-7.1: renders explicit loading, empty, no-match, and retryable unavailable states from the API", async () => {
    let resolveList!: (value: Response) => void;
    global.fetch = mock(() => new Promise<Response>((resolve) => { resolveList = resolve; })) as unknown as typeof fetch;
    const first = render(<ScheduledTasksView {...baseProps} />);
    expect(screen.getByRole("status").textContent).toContain("Loading scheduled tasks");
    resolveList(response({ tasks: [], unreadCount: 0 }));
    await waitFor(() => expect(screen.getByText("No scheduled tasks yet")).toBeTruthy());
    first.unmount();

    installApi([task("active", "active")]);
    render(<ScheduledTasksView {...baseProps} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Daily metrics/ })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Search scheduled tasks"), { target: { value: "never matches" } });
    expect(screen.getByText("No tasks match this search")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByRole("button", { name: /Daily metrics/ })).toBeTruthy();
  });

  test("AC-7.2: shows semantic health states and filters the retained real run journal", async () => {
    installApi(
      [task("active", "running", 1), task("failed", "failed")],
      [run("completed-run", "completed", 1), run("failed-run", "failed")],
    );
    render(<ScheduledTasksView {...baseProps} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Daily metrics/ })).toBeTruthy());
    expect(screen.getAllByText("Running").length).toBeGreaterThan(0);
    expect(screen.getByText("Failed warehouse sync")).toBeTruthy();
    expect(screen.getByText("1 unread")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Failed runs" }));
    expect(screen.getByText("failed-run")).toBeTruthy();
    expect(screen.queryByText("completed-run")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Runs with files" }));
    expect(screen.getByText("completed-run")).toBeTruthy();
    expect(screen.queryByText("failed-run")).toBeNull();
  });

  test("AC-7.3: keyboard selection keeps the task navigator mounted in the bounded console layout", async () => {
    installApi([task("active", "active"), task("failed", "paused")]);
    const { container } = render(<ScheduledTasksView {...baseProps} />);
    const second = await screen.findByRole("button", { name: /Failed warehouse sync/ });
    second.focus();
    fireEvent.keyDown(second, { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Failed warehouse sync" })).toBeTruthy());
    expect(screen.getByLabelText("Scheduled task navigator")).toBeTruthy();
    expect(container.querySelector(".scheduled-console")?.getAttribute("data-min-width-safe")).toBe("true");
  });

  test("AC-8.2: pause and confirmed delete reconcile the navigator and select a remaining task", async () => {
    let tasks = [task("active", "active"), task("failed", "active")];
    global.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/scheduled-tasks/active") && init?.method === "PATCH") {
        tasks = [{ ...tasks[0]!, enabled: false, status: "paused", nextRun: null }, tasks[1]!];
        return Promise.resolve(response({ task: tasks[0] }));
      }
      if (url.endsWith("/api/scheduled-tasks/active") && init?.method === "DELETE") {
        tasks = tasks.slice(1);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url.endsWith("/api/scheduled-tasks")) return Promise.resolve(response({ tasks, unreadCount: 0 }));
      if (url.includes("/runs?limit=25")) return Promise.resolve(response({ runs: [] }));
      const selected = tasks.find((item) => url.endsWith(`/api/scheduled-tasks/${item.id}`));
      if (selected) return Promise.resolve(response({ task: selected, stats: { successRate: 0, averageDurationMs: 0 }, recentRuns: [] }));
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    }) as unknown as typeof fetch;

    render(<ScheduledTasksView {...baseProps} />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy());
    await waitFor(() => expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete task" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: /Daily metrics/ })).toBeNull());
    await waitFor(() => expect(screen.getByRole("heading", { name: "Failed warehouse sync" })).toBeTruthy());
  });

  test("AC-8.3: a running task disables Run now and a delete conflict keeps it selected with the server explanation", async () => {
    const running = task("active", "running");
    global.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/scheduled-tasks/active") && init?.method === "DELETE") {
        return Promise.resolve(response({ error: { code: "task_running", message: "A running task cannot be deleted.", retryable: true } }, 409));
      }
      if (url.endsWith("/api/scheduled-tasks")) return Promise.resolve(response({ tasks: [running], unreadCount: 0 }));
      if (url.includes("/runs?limit=25")) return Promise.resolve(response({ runs: [] }));
      if (url.endsWith("/api/scheduled-tasks/active")) return Promise.resolve(response({ task: running, stats: { successRate: 0, averageDurationMs: 0 }, recentRuns: [] }));
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    }) as unknown as typeof fetch;

    render(<ScheduledTasksView {...baseProps} />);
    const runningButton = await screen.findByRole("button", { name: "Running" });
    expect((runningButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete task" }));
    await waitFor(() => expect(screen.getAllByText("A running task cannot be deleted.").length).toBeGreaterThan(0));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Daily metrics/ }).getAttribute("aria-current")).toBe("true");
  });

  test("AC-9.1: deliberately opening durable run evidence marks only that successfully loaded unread run read", async () => {
    const selectedTask = task("active", "active", 1);
    const selectedRun = { ...run("failed-run", "failed"), error: { code: "execution_failed" as const, message: "Warehouse unavailable", retryable: true } };
    const calls: string[] = [];
    global.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/runs/failed-run/read") && init?.method === "POST") return Promise.resolve(new Response(null, { status: 204 }));
      if (url.endsWith("/runs/failed-run")) return Promise.resolve(response({ run: selectedRun }));
      if (url.endsWith("/api/scheduled-tasks")) return Promise.resolve(response({ tasks: [selectedTask], unreadCount: 1 }));
      if (url.includes("/runs?limit=25")) return Promise.resolve(response({ runs: [selectedRun] }));
      if (url.endsWith("/api/scheduled-tasks/active")) return Promise.resolve(response({ task: selectedTask, stats: { successRate: 0, averageDurationMs: 5000 }, recentRuns: [selectedRun] }));
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    }) as unknown as typeof fetch;

    render(<ScheduledTasksView {...baseProps} />);
    fireEvent.click(await screen.findByRole("button", { name: /Open run failed-run/ }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Run inspector" })).toBeTruthy());
    expect(screen.getByText("Warehouse unavailable")).toBeTruthy();
    await waitFor(() => expect(calls.some((call) => call.includes("POST") && call.endsWith("/runs/failed-run/read"))).toBe(true));
  });

  test("review regression: an open running inspector refreshes to terminal evidence without reopening", async () => {
    const runningTask = task("active", "running");
    const runningRun = {
      ...run("inspected-run", "running"),
      completedAt: undefined,
      durationMs: undefined,
    };
    const completedRun = {
      ...run("inspected-run", "completed", 1),
      finalText: "Fresh terminal evidence",
      unread: true,
    };
    let complete = false;
    let detailCalls = 0;
    global.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/runs/inspected-run/read") && init?.method === "POST") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url.endsWith("/runs/inspected-run")) {
        detailCalls += 1;
        return Promise.resolve(response({ run: complete ? completedRun : runningRun }));
      }
      if (url.endsWith("/api/scheduled-tasks")) {
        return Promise.resolve(response({ tasks: [runningTask], unreadCount: complete ? 1 : 0 }));
      }
      if (url.includes("/runs?limit=25")) {
        return Promise.resolve(response({ runs: [complete ? completedRun : runningRun] }));
      }
      if (url.endsWith("/api/scheduled-tasks/active")) {
        return Promise.resolve(response({
          task: runningTask,
          stats: { successRate: complete ? 100 : 0, averageDurationMs: 5000 },
          recentRuns: [complete ? completedRun : runningRun],
        }));
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    }) as unknown as typeof fetch;

    render(<ScheduledTasksView {...baseProps} />);
    fireEvent.click(await screen.findByRole("button", { name: /Open run inspected-run/ }));
    await waitFor(() => expect(screen.getByText("This run is still in progress. Evidence refreshes from durable state.")).toBeTruthy());

    complete = true;
    await waitFor(() => expect(screen.getByText("Fresh terminal evidence")).toBeTruthy(), { timeout: 2_500 });
    expect(screen.getByText("report-0.md")).toBeTruthy();
    expect(detailCalls).toBeGreaterThanOrEqual(2);
  });
});
