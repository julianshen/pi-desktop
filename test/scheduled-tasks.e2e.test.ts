import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunStore } from "../server/src/scheduler/run-store.js";
import { TaskStore } from "../server/src/scheduler/task-store.js";
import { ScheduledRunExecutor, type ScheduledSessionFactory } from "../server/src/scheduler/session.js";
import { SchedulerService, type ScheduledHandle } from "../server/src/scheduler/service.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function handle(): ScheduledHandle {
  return { stop: () => {}, getNextRun: () => new Date("2026-08-01T00:00:00.000Z") };
}

describe("scheduled tasks representative workflow", () => {
  test("AC-13.2 and AC-13.3: create, run, retain file/unread evidence, restart without catch-up, reconcile interruption, and delete", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scheduled-e2e-")); roots.push(root);
    const agentDir = path.join(root, "agent");
    const dataDir = path.join(root, "data");
    const taskStore = new TaskStore(agentDir);
    const runStore = new RunStore(dataDir);
    let scheduledCallbacks = 0;
    let nextId = 0;
    const sessionFactory: ScheduledSessionFactory = async (_task, context) => ({
      modelId: "test/stub",
      prompt: async () => {
        const fileId = "artifact";
        fs.mkdirSync(runStore.filesDir("daily", context.runId), { recursive: true });
        fs.writeFileSync(path.join(runStore.filesDir("daily", context.runId), fileId), "# Durable report\n");
        context.publishFile({ id: fileId, name: "report.md", mediaType: "text/markdown", byteSize: 17, state: "available" });
      },
      messages: () => [{ role: "assistant", content: "Report complete", stopReason: "stop" }],
      dispose: () => {},
    });
    const executor = new ScheduledRunExecutor({ runStore, sessionFactory, id: () => `run-${++nextId}` });
    const service = new SchedulerService({
      taskStore, runStore, runner: executor, id: () => "daily",
      scheduleTask: (_task, _callback) => { scheduledCallbacks += 1; return handle(); },
    });
    await service.start();
    const created = await service.create({ name: "Daily report", prompt: "Build report", cron: "0 8 * * *", timezone: "UTC", enabled: true });
    expect(created.id).toBe("daily");
    const accepted = await service.runNow(created.id);
    expect(accepted.status).toBe("running");
    while (executor.isActive(created.id)) await new Promise((resolve) => setTimeout(resolve, 0));
    const terminal = service.getRun(created.id, accepted.id);
    expect(terminal).toMatchObject({ status: "completed", unread: true, finalText: "Report complete", files: [{ id: "artifact", name: "report.md" }] });
    expect(fs.readFileSync(service.resolveRunFile(created.id, terminal.id, "artifact").path, "utf8")).toContain("Durable report");
    service.stop();

    // A stale running manifest models explicit process termination. Startup reconciles it;
    // registering the cron handle does not execute a missed schedule (no catch-up).
    runStore.save({ ...terminal, id: "interrupted", status: "running", completedAt: undefined, durationMs: undefined, finalText: undefined, unread: false, files: [] });
    const restartedExecutor = new ScheduledRunExecutor({ runStore, sessionFactory, id: () => "unused" });
    const restarted = new SchedulerService({
      taskStore, runStore, runner: restartedExecutor,
      scheduleTask: (_task, _callback) => { scheduledCallbacks += 1; return handle(); },
    });
    await restarted.start();
    expect(scheduledCallbacks).toBe(2);
    expect(restarted.getRun("daily", "interrupted")).toMatchObject({ status: "failed", error: { code: "process_interrupted" }, unread: true });
    expect(restarted.listRuns("daily").runs.some((run) => run.id === terminal.id)).toBe(true);
    await restarted.delete("daily");
    expect(taskStore.load()).toEqual([]);
  });
});
