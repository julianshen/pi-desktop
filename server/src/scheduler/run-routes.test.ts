import { afterEach, describe, expect, test } from "bun:test";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { createScheduledTasksRouter } from "./routes.js";
import { RunStore } from "./run-store.js";
import { SchedulerService } from "./service.js";
import { ScheduledRunExecutor, type ScheduledSessionFactory } from "./session.js";
import { TaskStore } from "./task-store.js";

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-scheduled-run-routes-"));
  const runStore = new RunStore(path.join(root, "data"));
  const gate = deferred<void>();
  let block = false;
  const sessionFactory: ScheduledSessionFactory = async (_task, context) => ({
    modelId: "test/model",
    prompt: async () => {
      if (block) await gate.promise;
      const filesDir = runStore.filesDir("task-1", context.runId);
      fs.mkdirSync(filesDir, { recursive: true });
      fs.writeFileSync(path.join(filesDir, "file-1"), "report body");
      context.publishFile({
        id: "file-1",
        name: "report.md",
        mediaType: "text/markdown",
        byteSize: 11,
        state: "available",
      });
    },
    messages: () => [{
      role: "assistant",
      content: [{ type: "text", text: "Final response" }],
      stopReason: "stop",
    }],
    dispose: () => {},
  });
  let nextRun = 0;
  const runner = new ScheduledRunExecutor({
    runStore,
    sessionFactory,
    id: () => `run-${++nextRun}`,
  });
  const service = new SchedulerService({
    taskStore: new TaskStore(path.join(root, "agent")),
    runStore,
    runner,
    scheduleTask: () => ({ stop: () => {}, getNextRun: () => null }),
    id: () => "task-1",
  });
  await service.start();
  await service.create({
    name: "Report",
    prompt: "Create report",
    cron: "0 9 * * 1",
    timezone: "UTC",
    enabled: false,
  });
  const app = express();
  app.use(createScheduledTasksRouter(service));
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    runStore,
    setBlocked: (value: boolean) => {
      block = value;
    },
    release: () => gate.resolve(),
  };
}

describe("scheduled run routes", () => {
  test("AC-5.1: Run now returns accepted running state and overlapping invocation returns durable skipped state", async () => {
    const context = await setup();
    context.setBlocked(true);
    const first = await fetch(`${context.baseUrl}/api/scheduled-tasks/task-1/runs`, { method: "POST" });
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ run: { id: "run-1", status: "running", trigger: "manual" } });

    const overlap = await fetch(`${context.baseUrl}/api/scheduled-tasks/task-1/runs`, { method: "POST" });
    expect(overlap.status).toBe(202);
    expect(await overlap.json()).toMatchObject({
      run: { id: "run-2", status: "skipped", skipReason: "already_running" },
    });
    context.release();
  });

  test("AC-5.2: history is stable, list omits final text, detail exposes it, and read state persists", async () => {
    const context = await setup();
    const accepted = await fetch(`${context.baseUrl}/api/scheduled-tasks/task-1/runs`, { method: "POST" });
    const { run } = await accepted.json() as { run: { id: string } };

    let detail: { run: { status: string; finalText?: string; unread: boolean } } | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      detail = await (await fetch(`${context.baseUrl}/api/scheduled-tasks/task-1/runs/${run.id}`)).json() as typeof detail;
      if (detail?.run.status === "completed") break;
      await Bun.sleep(5);
    }
    expect(detail).toMatchObject({ run: { status: "completed", finalText: "Final response", unread: true } });

    const page = await (await fetch(`${context.baseUrl}/api/scheduled-tasks/task-1/runs?limit=1`)).json() as {
      runs: Array<Record<string, unknown>>;
      nextCursor?: string;
    };
    expect(page.runs).toHaveLength(1);
    expect(page.runs[0]).not.toHaveProperty("finalText");

    expect((await fetch(`${context.baseUrl}/api/scheduled-tasks/task-1/runs/${run.id}/read`, { method: "POST" })).status).toBe(204);
    const restored = await (await fetch(`${context.baseUrl}/api/scheduled-tasks/task-1/runs/${run.id}`)).json() as {
      run: { unread: boolean };
    };
    expect(restored.run.unread).toBe(false);
  });

  test("AC-5.3: file download streams only canonical app-owned opaque-ID files with safe headers", async () => {
    const context = await setup();
    const accepted = await fetch(`${context.baseUrl}/api/scheduled-tasks/task-1/runs`, { method: "POST" });
    const { run } = await accepted.json() as { run: { id: string } };
    for (let attempt = 0; attempt < 20 && !context.runStore.get("task-1", run.id)?.files.length; attempt += 1) {
      await Bun.sleep(5);
    }

    const download = await fetch(`${context.baseUrl}/api/scheduled-tasks/task-1/runs/${run.id}/files/file-1`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain('attachment; filename="report.md"');
    expect(download.headers.get("content-type")).toContain("text/markdown");
    expect(await download.text()).toBe("report body");

    const missing = await fetch(`${context.baseUrl}/api/scheduled-tasks/task-1/runs/${run.id}/files/missing`);
    expect(missing.status).toBe(404);
    expect(JSON.stringify(await missing.json())).not.toContain(context.runStore.root);
  });
});
