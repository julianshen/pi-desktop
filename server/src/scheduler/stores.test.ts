import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskStore, type TaskStoreFileSystem } from "./task-store.js";
import { RunStore } from "./run-store.js";
import type { ScheduledRunRecord, ScheduledTaskRecord } from "./types.js";

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-scheduled-store-"));
}

function task(overrides: Partial<ScheduledTaskRecord> = {}): ScheduledTaskRecord {
  return {
    id: "weekly-report",
    name: "Weekly report",
    prompt: "Summarize the workspace.",
    cron: "0 9 * * 1",
    timezone: "Asia/Taipei",
    enabled: true,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function terminalRun(taskId: string, index: number): ScheduledRunRecord {
  const completedAt = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
  return {
    id: `run-${String(index).padStart(3, "0")}`,
    taskId,
    trigger: "cron",
    status: "completed",
    startedAt: completedAt,
    completedAt,
    durationMs: 10,
    files: [],
    unread: true,
    definition: {
      name: "Weekly report",
      prompt: "Summarize the workspace.",
      cron: "0 9 * * 1",
      timezone: "Asia/Taipei",
      enabled: true,
    },
  };
}

describe("TaskStore", () => {
  test("AC-1.1: imports a legacy task compatibly and persists the expanded shape", () => {
    const agentDir = scratch();
    const configPath = path.join(agentDir, "scheduled-agents.json");
    fs.writeFileSync(configPath, JSON.stringify([
      {
        id: "legacy",
        cron: "0 8 * * *",
        prompt: "Prepare the daily brief.",
        timezone: "UTC",
        enabled: false,
      },
    ]));
    const timestamp = new Date("2026-07-22T02:30:00.000Z");
    fs.utimesSync(configPath, timestamp, timestamp);

    const store = new TaskStore(agentDir);
    const [loaded] = store.load();

    expect(loaded).toMatchObject({
      id: "legacy",
      name: "legacy",
      cron: "0 8 * * *",
      prompt: "Prepare the daily brief.",
      timezone: "UTC",
      enabled: false,
      createdAt: timestamp.toISOString(),
      updatedAt: timestamp.toISOString(),
    });
    expect(loaded.modelId).toBeUndefined();

    store.replaceAll([loaded]);
    expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual([loaded]);
  });

  test("AC-1.2: a rename failure preserves the previous complete definition document", () => {
    const agentDir = scratch();
    const baseline = task();
    const real = fs as unknown as TaskStoreFileSystem;
    const store = new TaskStore(agentDir);
    store.replaceAll([baseline]);
    const before = fs.readFileSync(path.join(agentDir, "scheduled-agents.json"), "utf8");

    const failingFs: TaskStoreFileSystem = {
      ...real,
      renameSync: () => {
        throw new Error("simulated rename failure");
      },
    };
    const failingStore = new TaskStore(agentDir, failingFs);

    expect(() => failingStore.replaceAll([task({ name: "Changed" })])).toThrow("simulated rename failure");
    expect(fs.readFileSync(path.join(agentDir, "scheduled-agents.json"), "utf8")).toBe(before);
    expect(fs.existsSync(path.join(agentDir, "scheduled-agents.json.tmp"))).toBe(false);
  });

  test("review regression: malformed config entries are isolated without hiding valid tasks or aborting load", () => {
    const agentDir = scratch();
    const configPath = path.join(agentDir, "scheduled-agents.json");
    fs.writeFileSync(configPath, JSON.stringify([
      null,
      { id: "missing-prompt", cron: "0 8 * * *" },
      {
        id: "valid",
        cron: "0 9 * * *",
        prompt: "Run the valid task.",
        timezone: "UTC",
      },
    ]));

    const store = new TaskStore(agentDir);
    expect(store.load()).toEqual([
      expect.objectContaining({ id: "valid", prompt: "Run the valid task." }),
    ]);

    fs.writeFileSync(configPath, "{not-json");
    expect(store.load()).toEqual([]);
  });
});

describe("RunStore", () => {
  test("AC-1.3: reconciles interrupted runs and retains only the newest 100 app-owned run directories", () => {
    const dataDir = scratch();
    const store = new RunStore(dataDir);
    const interrupted: ScheduledRunRecord = {
      ...terminalRun("weekly-report", 200),
      id: "interrupted",
      status: "running",
      completedAt: undefined,
    };
    store.save(interrupted);

    const external = path.join(dataDir, "user-owned.txt");
    fs.writeFileSync(external, "keep me");
    for (let index = 0; index < 101; index += 1) {
      const run = terminalRun("retained-task", index);
      store.save(run);
      const ownedFile = path.join(store.filesDir(run.taskId, run.id), "result");
      fs.mkdirSync(path.dirname(ownedFile), { recursive: true });
      fs.writeFileSync(ownedFile, String(index));
    }

    expect(store.reconcileInterrupted()).toBe(1);
    expect(store.get("weekly-report", "interrupted")).toMatchObject({
      status: "failed",
      error: {
        code: "process_interrupted",
        retryable: true,
      },
    });

    store.prune("retained-task");
    const retained = store.list("retained-task");
    expect(retained).toHaveLength(100);
    expect(retained[0]?.id).toBe("run-100");
    expect(retained.at(-1)?.id).toBe("run-001");
    expect(store.get("retained-task", "run-000")).toBeUndefined();
    expect(fs.readFileSync(external, "utf8")).toBe("keep me");
  });
});
