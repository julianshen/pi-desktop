import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunStore } from "./run-store.js";
import {
  SchedulerError,
  SchedulerService,
  type ScheduledHandle,
  type ScheduledTaskRunner,
} from "./service.js";
import { TaskStore } from "./task-store.js";
import type { ScheduledRunRecord, ScheduledTaskRecord } from "./types.js";
import { setServerAnalyticsSink, type DispatchedServerAnalyticsEvent } from "../analytics/events.js";

afterEach(() => setServerAnalyticsSink());

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-scheduler-service-"));
  const taskStore = new TaskStore(path.join(root, "agent"));
  const runStore = new RunStore(path.join(root, "data"));
  const handles = new Map<string, { handle: ScheduledHandle; cron: string; timezone: string }>();
  const stopped: string[] = [];
  const registrations: string[] = [];
  const callbacks = new Map<string, () => void>();
  let failCron: string | undefined;
  const scheduleTask = (task: ScheduledTaskRecord, callback: () => void): ScheduledHandle => {
    if (task.cron === failCron) throw new Error("schedule failed");
    registrations.push(task.id);
    const handle: ScheduledHandle = {
      stop: () => {
        stopped.push(task.id);
        handles.delete(task.id);
      },
      getNextRun: () => new Date("2026-08-01T09:00:00.000Z"),
    };
    handles.set(task.id, { handle, cron: task.cron, timezone: task.timezone });
    callbacks.set(task.id, callback);
    return handle;
  };
  const executions: ScheduledTaskRecord[] = [];
  let activeTaskId: string | undefined;
  const runner: ScheduledTaskRunner = {
    run: async (task): Promise<ScheduledRunRecord> => {
      executions.push(task);
      return {
        id: "run",
        taskId: task.id,
        trigger: "manual",
        status: "completed",
        startedAt: "2026-07-22T00:00:00.000Z",
        completedAt: "2026-07-22T00:00:01.000Z",
        files: [],
        unread: true,
        definition: task,
      };
    },
    isActive: (taskId) => taskId === activeTaskId,
  };
  const resolvedModels: string[] = [];
  const service = new SchedulerService({
    taskStore,
    runStore,
    scheduleTask,
    runner,
    resolveModel: async (id) => {
      resolvedModels.push(id);
      return id === "anthropic/pinned";
    },
    now: () => new Date("2026-07-22T00:00:00.000Z"),
    id: () => "created-task",
  });
  return {
    root,
    taskStore,
    handles,
    stopped,
    registrations,
    callbacks,
    executions,
    resolvedModels,
    service,
    setFailCron: (cron?: string) => {
      failCron = cron;
    },
    setActiveTask: (id?: string) => {
      activeTaskId = id;
    },
  };
}

const validInput = {
  name: "Dependency watch",
  prompt: "Check public advisories.",
  cron: "0 9 * * 1",
  timezone: "Asia/Taipei",
  enabled: true,
};

describe("SchedulerService definition lifecycle", () => {
  test("review regression: startup exposes only validated tasks with safe IDs", async () => {
    const context = setup();
    const timestamp = "2026-07-22T00:00:00.000Z";
    context.taskStore.replaceAll([
      { ...validInput, id: "valid-task", createdAt: timestamp, updatedAt: timestamp },
      { ...validInput, id: "invalid-cron", cron: "not a cron", createdAt: timestamp, updatedAt: timestamp },
      { ...validInput, id: "../unsafe", createdAt: timestamp, updatedAt: timestamp },
    ]);

    await context.service.start();

    expect(context.service.listTasks().map((task) => task.id)).toEqual(["valid-task"]);
    expect(context.handles.has("valid-task")).toBe(true);
    expect(context.handles.has("invalid-cron")).toBe(false);
    expect(context.handles.has("../unsafe")).toBe(false);
    expect(() => context.service.listTaskSummaries()).not.toThrow();
  });

  test("review regression: duplicate startup task IDs register only one cron handle", async () => {
    const context = setup();
    const timestamp = "2026-07-22T00:00:00.000Z";
    context.taskStore.replaceAll([
      { ...validInput, id: "duplicate", name: "First", createdAt: timestamp, updatedAt: timestamp },
      { ...validInput, id: "duplicate", name: "Second", createdAt: timestamp, updatedAt: timestamp },
    ]);

    await context.service.start();

    expect(context.registrations).toEqual(["duplicate"]);
    expect(context.service.listTasks()).toEqual([
      expect.objectContaining({ id: "duplicate", name: "First" }),
    ]);
    expect(context.handles.size).toBe(1);
  });

  test("AC-12.1: saved analytics emits once only after create/update durable registration matches", async () => {
    const events: DispatchedServerAnalyticsEvent[] = [];
    setServerAnalyticsSink((event) => events.push(event));
    const context = setup();
    await context.service.start();
    const created = await context.service.create(validInput);
    await context.service.update(created.id, { enabled: false, modelId: "anthropic/pinned" });
    expect(events.filter((event) => event.name === "scheduled_task_saved")).toEqual([
      { name: "scheduled_task_saved", platform: "server", properties: { operation: "create", enabled: true, model_mode: "default" } },
      { name: "scheduled_task_saved", platform: "server", properties: { operation: "update", enabled: false, model_mode: "override" } },
    ]);
  });
  test("AC-2.1: create, edit, pause, resume, and delete keep persisted definitions aligned with one handle", async () => {
    const context = setup();
    await context.service.start();

    const created = await context.service.create(validInput);
    expect(context.handles.get(created.id)).toMatchObject({ cron: "0 9 * * 1", timezone: "Asia/Taipei" });
    expect(context.taskStore.load()).toEqual([created]);

    const edited = await context.service.update(created.id, { cron: "30 10 * * 2" });
    expect(context.handles.get(created.id)?.cron).toBe("30 10 * * 2");
    expect(context.stopped).toEqual([created.id]);
    expect(context.taskStore.load()).toEqual([edited]);

    const paused = await context.service.update(created.id, { enabled: false });
    expect(paused.enabled).toBe(false);
    expect(context.handles.has(created.id)).toBe(false);
    expect(context.service.nextRun(created.id)).toBeNull();

    await context.service.update(created.id, { enabled: true });
    expect(context.handles.has(created.id)).toBe(true);
    expect(context.service.nextRun(created.id)?.toISOString()).toBe("2026-08-01T09:00:00.000Z");

    await context.service.delete(created.id);
    expect(context.taskStore.load()).toEqual([]);
    expect(context.handles.has(created.id)).toBe(false);
  });

  test("AC-2.2: invalid definitions and running deletion preserve the previous file and registration", async () => {
    const context = setup();
    await context.service.start();
    const created = await context.service.create(validInput);
    const before = fs.readFileSync(context.taskStore.configPath, "utf8");

    for (const patch of [
      { cron: "0 0 9 * * 1" },
      { timezone: "Not/AZone" },
      { modelId: "anthropic/missing" },
      { name: "" },
    ]) {
      await expect(context.service.update(created.id, patch)).rejects.toBeInstanceOf(SchedulerError);
      expect(fs.readFileSync(context.taskStore.configPath, "utf8")).toBe(before);
      expect(context.handles.get(created.id)?.cron).toBe(validInput.cron);
    }

    context.setFailCron("15 9 * * 1");
    await expect(context.service.update(created.id, { cron: "15 9 * * 1" })).rejects.toThrow("schedule failed");
    expect(fs.readFileSync(context.taskStore.configPath, "utf8")).toBe(before);
    expect(context.handles.get(created.id)?.cron).toBe(validInput.cron);

    context.setActiveTask(created.id);
    await expect(context.service.delete(created.id)).rejects.toMatchObject({ code: "task_running", status: 409 });
    expect(context.taskStore.load()).toHaveLength(1);
  });

  test("review regression: failed commit verification rolls back definitions, task maps, and cron handles", async () => {
    const createContext = setup();
    await createContext.service.start();
    createContext.taskStore.load = () => [];
    await expect(createContext.service.create(validInput)).rejects.toMatchObject({ code: "commit_mismatch" });
    expect(createContext.service.listTasks()).toEqual([]);
    expect(createContext.handles.size).toBe(0);

    const updateContext = setup();
    await updateContext.service.start();
    const existing = await updateContext.service.create(validInput);
    updateContext.taskStore.load = () => [];
    await expect(updateContext.service.update(existing.id, { cron: "30 10 * * 2" }))
      .rejects.toMatchObject({ code: "commit_mismatch" });
    expect(updateContext.service.listTasks()).toEqual([existing]);
    expect(updateContext.handles.get(existing.id)?.cron).toBe(validInput.cron);
  });

  test("AC-2.3: default-model tasks stay unpinned while explicit models validate and remain captured", async () => {
    const context = setup();
    await context.service.start();
    const defaultTask = await context.service.create(validInput);
    expect(context.resolvedModels).toEqual([]);

    await context.service.runNow(defaultTask.id);
    expect(context.executions[0]?.modelId).toBeUndefined();

    const pinned = await context.service.update(defaultTask.id, { modelId: "anthropic/pinned" });
    await context.service.runNow(pinned.id);
    expect(context.resolvedModels).toEqual(["anthropic/pinned"]);
    expect(context.executions[1]?.modelId).toBe("anthropic/pinned");

    const unpinned = await context.service.update(defaultTask.id, { modelId: null });
    expect(unpinned.modelId).toBeUndefined();
  });
});
