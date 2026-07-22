import { randomUUID } from "node:crypto";
import { schedule, validate } from "node-cron";
import type { RunStore } from "./run-store.js";
import type { TaskStore } from "./task-store.js";
import type { ScheduledRunRecord, ScheduledRunTrigger, ScheduledTaskRecord } from "./types.js";
import type { ScheduledRunFile } from "./types.js";
import type { ScheduledRunStart } from "./session.js";
import { trackServerEvent } from "../analytics/events.js";

export interface ScheduledHandle {
  stop(): void;
  getNextRun(): Date | null;
}

export interface ScheduledTaskRunner {
  run(
    task: ScheduledTaskRecord,
    trigger: ScheduledRunTrigger,
    scheduledFor?: string,
  ): Promise<ScheduledRunRecord>;
  start?(
    task: ScheduledTaskRecord,
    trigger: ScheduledRunTrigger,
    scheduledFor?: string,
  ): ScheduledRunStart;
  isActive(taskId: string): boolean;
}

export interface ScheduledTaskSummary extends ScheduledTaskRecord {
  status: "running" | "failed" | "active" | "paused";
  lastRun: Omit<ScheduledRunRecord, "finalText"> | null;
  nextRun: string | null;
  scheduleLabel: string;
  unreadCount: number;
}

export interface ScheduledTaskStats {
  successRate: number;
  averageDurationMs: number;
}

export type CreateScheduledTaskInput = {
  name: string;
  prompt: string;
  cron: string;
  timezone?: string;
  enabled: boolean;
  modelId?: string | null;
};

export type UpdateScheduledTaskInput = Partial<CreateScheduledTaskInput>;

export class SchedulerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "SchedulerError";
  }
}

type ScheduleTask = (task: ScheduledTaskRecord, callback: () => void) => ScheduledHandle;

interface SchedulerServiceOptions {
  taskStore: TaskStore;
  runStore: RunStore;
  runner: ScheduledTaskRunner;
  scheduleTask?: ScheduleTask;
  resolveModel?: (id: string) => Promise<boolean>;
  now?: () => Date;
  id?: () => string;
}

function defaultScheduleTask(task: ScheduledTaskRecord, callback: () => void): ScheduledHandle {
  return schedule(task.cron, callback, { timezone: task.timezone });
}

function hostTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function validTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

export class SchedulerService {
  private tasks = new Map<string, ScheduledTaskRecord>();
  private handles = new Map<string, ScheduledHandle>();
  private mutationTail: Promise<void> = Promise.resolve();
  private started = false;
  private readonly taskStore: TaskStore;
  private readonly runStore: RunStore;
  private readonly runner: ScheduledTaskRunner;
  private readonly scheduleTask: ScheduleTask;
  private readonly resolveModel: (id: string) => Promise<boolean>;
  private readonly now: () => Date;
  private readonly id: () => string;

  constructor(options: SchedulerServiceOptions) {
    this.taskStore = options.taskStore;
    this.runStore = options.runStore;
    this.runner = options.runner;
    this.scheduleTask = options.scheduleTask ?? defaultScheduleTask;
    this.resolveModel = options.resolveModel ?? (async () => false);
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.runStore.reconcileInterrupted();
    const loaded = this.taskStore.load();
    this.tasks = new Map(loaded.map((task) => [task.id, task]));
    for (const task of loaded) {
      try {
        await this.validateTask(task);
        if (task.enabled) this.handles.set(task.id, this.register(task));
      } catch (error) {
        console.error(`[scheduler] task "${task.id}" is invalid and was not registered`, error);
      }
    }
    this.started = true;
  }

  stop(): void {
    for (const handle of this.handles.values()) handle.stop();
    this.handles.clear();
    this.started = false;
  }

  listTasks(): ScheduledTaskRecord[] {
    return [...this.tasks.values()];
  }

  listTaskSummaries(): ScheduledTaskSummary[] {
    return this.listTasks().map((task) => this.summary(task));
  }

  unreadCount(): number {
    return this.listTasks().reduce(
      (total, task) => total + this.runStore.list(task.id).filter((run) => run.unread).length,
      0,
    );
  }

  getTask(taskId: string): ScheduledTaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  nextRun(taskId: string): Date | null {
    return this.handles.get(taskId)?.getNextRun() ?? null;
  }

  create(input: CreateScheduledTaskInput): Promise<ScheduledTaskRecord> {
    return this.serialize(async () => {
      const timestamp = this.now().toISOString();
      const candidate = this.normalizeTask({
        ...input,
        modelId: input.modelId ?? undefined,
        id: this.id(),
        timezone: input.timezone || hostTimezone(),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      if (this.tasks.has(candidate.id)) {
        throw new SchedulerError("task_conflict", "A scheduled task with this ID already exists.", 409);
      }
      await this.validateTask(candidate);
      const previous = this.listTasks();
      this.taskStore.replaceAll([...previous, candidate]);

      try {
        if (candidate.enabled) this.handles.set(candidate.id, this.register(candidate));
        this.tasks.set(candidate.id, candidate);
        this.assertCommitted(candidate);
        trackServerEvent({ name: "scheduled_task_saved", properties: { operation: "create", enabled: candidate.enabled, model_mode: candidate.modelId ? "override" : "default" } });
        return candidate;
      } catch (error) {
        this.taskStore.replaceAll(previous);
        throw error;
      }
    });
  }

  update(taskId: string, patch: UpdateScheduledTaskInput): Promise<ScheduledTaskRecord> {
    return this.serialize(async () => {
      const existing = this.requireTask(taskId);
      const candidate = this.normalizeTask({
        ...existing,
        ...patch,
        modelId: patch.modelId === null ? undefined : patch.modelId ?? existing.modelId,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: this.now().toISOString(),
      });
      await this.validateTask(candidate);

      const previous = this.listTasks();
      const replacement = previous.map((task) => (task.id === taskId ? candidate : task));
      this.taskStore.replaceAll(replacement);
      const oldHandle = this.handles.get(taskId);
      oldHandle?.stop();
      this.handles.delete(taskId);

      try {
        if (candidate.enabled) this.handles.set(taskId, this.register(candidate));
        this.tasks.set(taskId, candidate);
        this.assertCommitted(candidate);
        trackServerEvent({ name: "scheduled_task_saved", properties: { operation: "update", enabled: candidate.enabled, model_mode: candidate.modelId ? "override" : "default" } });
        return candidate;
      } catch (error) {
        this.taskStore.replaceAll(previous);
        if (existing.enabled) this.handles.set(taskId, this.register(existing));
        throw error;
      }
    });
  }

  delete(taskId: string): Promise<void> {
    return this.serialize(async () => {
      this.requireTask(taskId);
      if (this.runner.isActive(taskId)) {
        throw new SchedulerError("task_running", "A running task cannot be deleted.", 409, true);
      }
      const replacement = this.listTasks().filter((task) => task.id !== taskId);
      this.taskStore.replaceAll(replacement);
      this.handles.get(taskId)?.stop();
      this.handles.delete(taskId);
      this.tasks.delete(taskId);
    });
  }

  runNow(taskId: string): Promise<ScheduledRunRecord> {
    const task = this.requireTask(taskId);
    const started = this.runner.start?.(task, "manual");
    return started ? Promise.resolve(started.run) : this.runner.run(task, "manual");
  }

  taskDetail(taskId: string): {
    task: ScheduledTaskSummary;
    stats: ScheduledTaskStats;
    recentRuns: Array<Omit<ScheduledRunRecord, "finalText">>;
  } {
    const task = this.requireTask(taskId);
    const runs = this.runStore.list(taskId);
    const measured = runs.filter(
      (run) => (run.status === "completed" || run.status === "failed") && run.durationMs !== undefined,
    );
    const successes = measured.filter((run) => run.status === "completed").length;
    const averageDurationMs = measured.length
      ? Math.round(measured.reduce((total, run) => total + (run.durationMs ?? 0), 0) / measured.length)
      : 0;
    return {
      task: this.summary(task),
      stats: {
        successRate: measured.length ? Math.round((successes / measured.length) * 1000) / 10 : 0,
        averageDurationMs,
      },
      recentRuns: runs.slice(0, 10).map(this.withoutFinalText),
    };
  }

  listRuns(taskId: string, cursor?: string, limit = 25): {
    runs: Array<Omit<ScheduledRunRecord, "finalText">>;
    nextCursor?: string;
  } {
    this.requireTask(taskId);
    const runs = this.runStore.list(taskId);
    let start = 0;
    if (cursor) {
      let id: string;
      try {
        id = Buffer.from(cursor, "base64url").toString("utf8");
      } catch {
        throw new SchedulerError("invalid_cursor", "Run cursor is invalid.", 400);
      }
      const index = runs.findIndex((run) => run.id === id);
      if (index < 0) throw new SchedulerError("invalid_cursor", "Run cursor is invalid.", 400);
      start = index + 1;
    }
    const bounded = Math.max(1, Math.min(100, limit));
    const page = runs.slice(start, start + bounded);
    const hasMore = start + bounded < runs.length;
    return {
      runs: page.map(this.withoutFinalText),
      ...(hasMore && page.length
        ? { nextCursor: Buffer.from(page.at(-1)!.id).toString("base64url") }
        : {}),
    };
  }

  getRun(taskId: string, runId: string): ScheduledRunRecord {
    this.requireTask(taskId);
    const run = this.runStore.get(taskId, runId);
    if (!run) throw new SchedulerError("run_not_found", "Scheduled run not found.", 404);
    return run;
  }

  markRunRead(taskId: string, runId: string): void {
    const run = this.getRun(taskId, runId);
    if (run.unread) this.runStore.save({ ...run, unread: false });
  }

  markAllRead(): void {
    for (const task of this.listTasks()) {
      for (const run of this.runStore.list(task.id)) {
        if (run.unread) this.runStore.save({ ...run, unread: false });
      }
    }
  }

  resolveRunFile(taskId: string, runId: string, fileId: string): {
    path: string;
    file: ScheduledRunFile;
  } {
    this.getRun(taskId, runId);
    const resolved = this.runStore.resolveFile(taskId, runId, fileId);
    if (!resolved) throw new SchedulerError("file_not_found", "Generated file is unavailable.", 404);
    return resolved;
  }

  private requireTask(taskId: string): ScheduledTaskRecord {
    const task = this.tasks.get(taskId);
    if (!task) throw new SchedulerError("task_not_found", "Scheduled task not found.", 404);
    return task;
  }

  private register(task: ScheduledTaskRecord): ScheduledHandle {
    const captured = { ...task };
    return this.scheduleTask(captured, () => {
      const started = this.runner.start?.(captured, "cron", this.now().toISOString());
      const completion = started?.completion
        ?? this.runner.run(captured, "cron", this.now().toISOString());
      completion.catch((error) => {
        console.error(`[scheduler] task "${captured.id}" failed`, error);
      });
    });
  }

  private summary(task: ScheduledTaskRecord): ScheduledTaskSummary {
    const runs = this.runStore.list(task.id);
    const latest = runs[0];
    const status = this.runner.isActive(task.id)
      ? "running"
      : !task.enabled
        ? "paused"
        : latest?.status === "failed"
          ? "failed"
          : "active";
    return {
      ...task,
      status,
      lastRun: latest ? this.withoutFinalText(latest) : null,
      nextRun: task.enabled ? this.nextRun(task.id)?.toISOString() ?? null : null,
      scheduleLabel: `${task.cron} · ${task.timezone}`,
      unreadCount: runs.filter((run) => run.unread).length,
    };
  }

  private withoutFinalText(run: ScheduledRunRecord): Omit<ScheduledRunRecord, "finalText"> {
    const { finalText: _finalText, ...summary } = run;
    return summary;
  }

  private normalizeTask(task: ScheduledTaskRecord): ScheduledTaskRecord {
    const modelId = typeof task.modelId === "string" ? task.modelId.trim() : undefined;
    return {
      ...task,
      name: task.name.trim(),
      prompt: task.prompt.trim(),
      cron: task.cron.trim().replace(/\s+/g, " "),
      timezone: task.timezone.trim(),
      enabled: task.enabled,
      ...(modelId ? { modelId } : { modelId: undefined }),
    };
  }

  private assertCommitted(task: ScheduledTaskRecord): void {
    const stored = this.taskStore.load().find((candidate) => candidate.id === task.id);
    const definitionMatches = stored
      && stored.id === task.id
      && stored.name === task.name
      && stored.prompt === task.prompt
      && stored.cron === task.cron
      && stored.timezone === task.timezone
      && stored.enabled === task.enabled
      && stored.modelId === task.modelId
      && stored.createdAt === task.createdAt
      && stored.updatedAt === task.updatedAt;
    if (!definitionMatches || task.enabled !== this.handles.has(task.id)) {
      throw new SchedulerError("commit_mismatch", "Scheduled task commit could not be verified.", 500, true);
    }
  }

  private async validateTask(task: ScheduledTaskRecord): Promise<void> {
    if (Array.from(task.name).length < 1 || Array.from(task.name).length > 120) {
      throw new SchedulerError("invalid_name", "Name must contain 1–120 characters.", 400);
    }
    if (Array.from(task.prompt).length < 1 || Array.from(task.prompt).length > 20_000) {
      throw new SchedulerError("invalid_prompt", "Instructions must contain 1–20,000 characters.", 400);
    }
    if (task.cron.split(" ").length !== 5 || !validate(task.cron)) {
      throw new SchedulerError("invalid_cron", "Cron must be a valid five-field expression.", 400);
    }
    if (!validTimezone(task.timezone)) {
      throw new SchedulerError("invalid_timezone", "Timezone must be a valid IANA name.", 400);
    }
    if (task.modelId && !(await this.resolveModel(task.modelId))) {
      throw new SchedulerError("model_unavailable", "The selected model is unavailable.", 400, true);
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}
