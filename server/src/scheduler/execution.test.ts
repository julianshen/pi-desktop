import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunStore } from "./run-store.js";
import {
  createScheduledSession,
  ScheduledRunExecutor,
  type ScheduledSessionFactory,
  type ScheduledSessionHandle,
} from "./session.js";
import { SCHEDULED_ALLOWED_TOOL_NAMES, scheduledCustomToolNames } from "./tools.js";
import type { ScheduledTaskRecord } from "./types.js";
import { setServerAnalyticsSink, type DispatchedServerAnalyticsEvent } from "../analytics/events.js";

afterEach(() => setServerAnalyticsSink());

function task(id: string): ScheduledTaskRecord {
  return {
    id,
    name: id,
    prompt: `Run ${id}`,
    cron: "0 9 * * 1",
    timezone: "UTC",
    enabled: true,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("ScheduledRunExecutor", () => {
  test("AC-12.1: start and terminal events follow their durable manifests exactly once", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-scheduled-analytics-"));
    const runStore = new RunStore(dataDir);
    const events: DispatchedServerAnalyticsEvent[] = [];
    setServerAnalyticsSink((event) => events.push(event));
    const executor = new ScheduledRunExecutor({
      runStore,
      id: () => "analytics-run",
      now: () => new Date("2026-07-22T00:00:02.000Z"),
      sessionFactory: async () => ({ prompt: async () => {}, messages: () => [{ role: "assistant", content: "Done" }], dispose: () => {} }),
    });
    const completed = await executor.run(task("analytics"), "cron", "2026-07-22T00:00:00.000Z");
    expect(runStore.get("analytics", completed.id)?.status).toBe("completed");
    expect(events).toEqual([
      { name: "scheduled_task_run_started", platform: "server", properties: { trigger: "cron", dispatch_delay_bucket: "1_10s", model_mode: "default" } },
      { name: "scheduled_task_run_terminal", platform: "server", properties: { outcome: "completed", trigger: "cron", duration_bucket: "under_1s", file_count_bucket: "0" } },
    ]);
  });
  test("AC-3.1: same-task overlap is skipped while a different task may run concurrently", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-scheduled-execution-"));
    const runStore = new RunStore(dataDir);
    const firstGate = deferred<void>();
    const createdSessions: string[] = [];
    const sessionFactory: ScheduledSessionFactory = async (scheduledTask): Promise<ScheduledSessionHandle> => {
      createdSessions.push(scheduledTask.id);
      return {
        modelId: "test/model",
        prompt: async () => {
          if (scheduledTask.id === "one") await firstGate.promise;
        },
        messages: () => [{
          role: "assistant",
          content: [{ type: "text", text: `Finished ${scheduledTask.id}` }],
          stopReason: "stop",
        }],
        dispose: () => {},
      };
    };
    let nextId = 0;
    const executor = new ScheduledRunExecutor({
      runStore,
      sessionFactory,
      id: () => `run-${++nextId}`,
      now: (() => {
        let tick = 0;
        return () => new Date(Date.UTC(2026, 6, 22, 0, 0, tick++));
      })(),
    });

    const first = executor.run(task("one"), "manual");
    await Promise.resolve();
    const overlap = await executor.run(task("one"), "cron");
    const other = await executor.run(task("two"), "cron");
    firstGate.resolve();
    const completed = await first;

    expect(overlap).toMatchObject({ taskId: "one", status: "skipped", skipReason: "already_running" });
    expect(other).toMatchObject({ taskId: "two", status: "completed", finalText: "Finished two" });
    expect(completed).toMatchObject({ taskId: "one", status: "completed", finalText: "Finished one" });
    expect(createdSessions).toEqual(["one", "two"]);
  });

  test("AC-3.2: the scheduled allowlist contains safe workspace/public tools and excludes computer, MCP, and approval tools", () => {
    expect(SCHEDULED_ALLOWED_TOOL_NAMES).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "remember",
      "recall",
      "web_fetch",
      "web_search",
      "publish_generated_file",
    ]);
    expect(scheduledCustomToolNames()).toEqual([
      "remember",
      "recall",
      "web_fetch",
      "web_search",
      "publish_generated_file",
    ]);
    expect(SCHEDULED_ALLOWED_TOOL_NAMES.some((name) => name.startsWith("computer_") || name.startsWith("mcp_"))).toBe(false);
  });

  test("AC-3.3: terminal text, failures, files, and definition snapshots persist and release the task guard", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-scheduled-terminal-"));
    const runStore = new RunStore(dataDir);
    let shouldFail = false;
    const sessionFactory: ScheduledSessionFactory = async (_scheduledTask, context) => ({
      modelId: "anthropic/test",
      prompt: async () => {
        if (shouldFail) throw new Error("provider unavailable");
        context.publishFile({
          id: "file-1",
          name: "report.md",
          mediaType: "text/markdown",
          byteSize: 12,
          state: "available",
        });
      },
      messages: () => [{
        role: "assistant",
        content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "Final report" }],
        stopReason: "stop",
      }],
      dispose: () => {},
    });
    let nextId = 0;
    const executor = new ScheduledRunExecutor({
      runStore,
      sessionFactory,
      id: () => `terminal-${++nextId}`,
      now: () => new Date("2026-07-22T00:00:00.000Z"),
    });

    const completed = await executor.run(task("reports"), "manual");
    expect(completed).toMatchObject({
      status: "completed",
      modelId: "anthropic/test",
      finalText: "Final report",
      files: [{ id: "file-1", name: "report.md" }],
      definition: { name: "reports", prompt: "Run reports" },
    });
    expect(runStore.get("reports", completed.id)).toEqual(completed);
    expect(executor.isActive("reports")).toBe(false);

    shouldFail = true;
    const failed = await executor.run(task("reports"), "manual");
    expect(failed).toMatchObject({
      status: "failed",
      error: { code: "execution_failed", message: "provider unavailable", retryable: false },
    });
    expect(executor.isActive("reports")).toBe(false);
  });

  test("review regression: a dispose failure is non-fatal and cannot leave the task guard wedged", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-scheduled-dispose-"));
    const runStore = new RunStore(dataDir);
    let nextId = 0;
    const executor = new ScheduledRunExecutor({
      runStore,
      id: () => `dispose-${++nextId}`,
      sessionFactory: async () => ({
        prompt: async () => {},
        messages: () => [{ role: "assistant", content: "Done" }],
        dispose: () => {
          throw new Error("dispose failed");
        },
      }),
    });

    await expect(executor.run(task("dispose-task"), "manual")).resolves.toMatchObject({ status: "completed" });
    expect(executor.isActive("dispose-task")).toBe(false);
    await expect(executor.run(task("dispose-task"), "manual")).resolves.toMatchObject({ status: "completed" });
  });

  test("review regression: malformed task IDs are rejected before a scheduled workspace path is created", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-scheduled-id-"));
    const runStore = new RunStore(dataDir);
    const malformed = task("../escape");

    expect(() => new ScheduledRunExecutor({ runStore }).start(malformed, "manual")).toThrow("Invalid task id");
    await expect(createScheduledSession(
      malformed,
      { runId: "run", publishFile: () => {} },
      runStore,
    )).rejects.toThrow("Invalid task id");
  });

  test("review regression: an initial manifest write failure cannot leave the task guard active", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-scheduled-initial-save-"));
    const runStore = new RunStore(dataDir);
    const save = runStore.save.bind(runStore);
    let failInitialSave = true;
    runStore.save = (record) => {
      if (failInitialSave) {
        failInitialSave = false;
        throw new Error("disk full");
      }
      save(record);
    };
    const executor = new ScheduledRunExecutor({
      runStore,
      sessionFactory: async () => ({
        prompt: async () => {},
        messages: () => [{ role: "assistant", content: "Recovered" }],
        dispose: () => {},
      }),
      id: (() => {
        let nextId = 0;
        return () => `initial-save-${++nextId}`;
      })(),
    });

    expect(() => executor.start(task("save-task"), "manual")).toThrow("disk full");
    expect(executor.isActive("save-task")).toBe(false);
    await expect(executor.run(task("save-task"), "manual")).resolves.toMatchObject({
      status: "completed",
      finalText: "Recovered",
    });
  });
});
