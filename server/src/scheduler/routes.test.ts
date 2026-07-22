import { afterEach, describe, expect, test } from "bun:test";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { createScheduledTasksRouter } from "./routes.js";
import { RunStore } from "./run-store.js";
import { SchedulerService, type ScheduledHandle, type ScheduledTaskRunner } from "./service.js";
import { TaskStore } from "./task-store.js";
import type { ScheduledRunRecord } from "./types.js";

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-scheduled-routes-"));
  const taskStore = new TaskStore(path.join(root, "agent"));
  const runStore = new RunStore(path.join(root, "data"));
  let activeTaskId: string | undefined;
  const runner: ScheduledTaskRunner = {
    run: async (task, trigger): Promise<ScheduledRunRecord> => ({
      id: "manual-run",
      taskId: task.id,
      trigger,
      status: "completed",
      startedAt: "2026-07-22T00:00:00.000Z",
      completedAt: "2026-07-22T00:00:01.000Z",
      durationMs: 1000,
      files: [],
      unread: true,
      definition: task,
    }),
    isActive: (id) => id === activeTaskId,
  };
  const service = new SchedulerService({
    taskStore,
    runStore,
    runner,
    scheduleTask: () => ({
      stop: () => {},
      getNextRun: () => new Date("2026-08-01T09:00:00.000Z"),
    } satisfies ScheduledHandle),
    resolveModel: async (id) => id === "anthropic/pinned",
    id: () => "task-1",
    now: () => new Date("2026-07-22T00:00:00.000Z"),
  });
  await service.start();
  const app = express();
  app.use(createScheduledTasksRouter(service));
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    service,
    taskStore,
    runStore,
    setActive: (id?: string) => {
      activeTaskId = id;
    },
  };
}

const input = {
  name: "Dependency watch",
  prompt: "Check public advisories.",
  cron: "0 9 * * 1",
  timezone: "Asia/Taipei",
  enabled: true,
  modelId: null,
};

describe("scheduled task definition routes", () => {
  test("AC-4.1: CRUD responses reflect persisted registration immediately", async () => {
    const context = await setup();
    const createdResponse = await fetch(`${context.baseUrl}/api/scheduled-tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as { task: { id: string; enabled: boolean } };
    expect(created.task).toMatchObject({ id: "task-1", enabled: true });

    const listed = await (await fetch(`${context.baseUrl}/api/scheduled-tasks`)).json() as {
      tasks: Array<{ id: string; status: string; nextRun: string | null }>;
      unreadCount: number;
    };
    expect(listed.tasks).toEqual([expect.objectContaining({
      id: "task-1",
      status: "active",
      nextRun: "2026-08-01T09:00:00.000Z",
    })]);

    const pausedResponse = await fetch(`${context.baseUrl}/api/scheduled-tasks/task-1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(pausedResponse.status).toBe(200);
    expect((await pausedResponse.json()) as object).toMatchObject({ task: { enabled: false, status: "paused" } });

    expect((await fetch(`${context.baseUrl}/api/scheduled-tasks/task-1`, { method: "DELETE" })).status).toBe(204);
    expect(context.taskStore.load()).toEqual([]);
  });

  test("AC-4.2: invalid, unknown, and running mutations return typed envelopes without partial state", async () => {
    const context = await setup();
    await fetch(`${context.baseUrl}/api/scheduled-tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const before = fs.readFileSync(context.taskStore.configPath, "utf8");

    const invalid = await fetch(`${context.baseUrl}/api/scheduled-tasks/task-1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cron: "0 0 9 * * 1", unexpected: true }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: expect.objectContaining({ code: expect.any(String), message: expect.any(String), retryable: false }),
    });
    expect(fs.readFileSync(context.taskStore.configPath, "utf8")).toBe(before);

    const missing = await fetch(`${context.baseUrl}/api/scheduled-tasks/missing`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "task_not_found" } });

    context.setActive("task-1");
    const conflict = await fetch(`${context.baseUrl}/api/scheduled-tasks/task-1`, { method: "DELETE" });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: "task_running", retryable: true } });
  });

  test("AC-4.3: detail derives health, unread, success rate, and duration from real manifests", async () => {
    const context = await setup();
    await fetch(`${context.baseUrl}/api/scheduled-tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const definition = context.service.getTask("task-1")!;
    context.runStore.save({
      id: "completed",
      taskId: "task-1",
      trigger: "cron",
      status: "completed",
      startedAt: "2026-07-20T00:00:00.000Z",
      completedAt: "2026-07-20T00:00:02.000Z",
      durationMs: 2000,
      files: [],
      unread: true,
      definition,
    });
    context.runStore.save({
      id: "failed",
      taskId: "task-1",
      trigger: "cron",
      status: "failed",
      startedAt: "2026-07-21T00:00:00.000Z",
      completedAt: "2026-07-21T00:00:04.000Z",
      durationMs: 4000,
      error: { code: "execution_failed", message: "No credentials", retryable: false },
      files: [],
      unread: true,
      definition,
    });

    const response = await fetch(`${context.baseUrl}/api/scheduled-tasks/task-1`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      task: { id: "task-1", status: "failed", unreadCount: 2 },
      stats: { successRate: 50, averageDurationMs: 3000 },
      recentRuns: [{ id: "failed" }, { id: "completed" }],
    });
  });
});
