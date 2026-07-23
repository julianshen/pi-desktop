import fs from "node:fs";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { env } from "../config/env.js";
import { getAgentDeps } from "../agent/deps.js";
import { resolveModelById } from "../agent/models.js";
import { RunStore } from "./run-store.js";
import { createScheduledTools, SCHEDULED_ALLOWED_TOOL_NAMES } from "./tools.js";
import type {
  ScheduledRunFile,
  ScheduledRunRecord,
  ScheduledRunTrigger,
  ScheduledTaskRecord,
  ScheduledTaskSnapshot,
} from "./types.js";
import { countBucket, durationBucket, trackServerEvent } from "../analytics/events.js";
import { assertSafeScheduledId } from "./ids.js";

export interface ScheduledSessionMessage {
  role: string;
  content?: string | Array<{ type: string; text?: string }>;
  stopReason?: string;
  errorMessage?: string;
}

export interface ScheduledSessionHandle {
  modelId?: string;
  prompt(text: string): Promise<void>;
  messages(): ScheduledSessionMessage[];
  getActiveToolNames?(): string[];
  getToolDefinition?(name: string): ToolDefinition | undefined;
  dispose(): void;
}

export interface ScheduledSessionContext {
  runId: string;
  publishFile(file: ScheduledRunFile): void;
}

export type ScheduledSessionFactory = (
  task: ScheduledTaskRecord,
  context: ScheduledSessionContext,
) => Promise<ScheduledSessionHandle>;

export interface ScheduledRunStart {
  run: ScheduledRunRecord;
  completion: Promise<ScheduledRunRecord>;
}

function snapshot(task: ScheduledTaskRecord): ScheduledTaskSnapshot {
  return {
    name: task.name,
    prompt: task.prompt,
    cron: task.cron,
    timezone: task.timezone,
    enabled: task.enabled,
    ...(task.modelId ? { modelId: task.modelId } : {}),
  };
}

function finalAssistantText(messages: ScheduledSessionMessage[]): string {
  const message = [...messages].reverse().find((candidate) => candidate.role === "assistant");
  if (!message) return "";
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new Error(message.errorMessage || `Agent stopped with ${message.stopReason}`);
  }
  if (typeof message.content === "string") return message.content;
  return (message.content ?? [])
    .filter((part): part is { type: string; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

interface ScheduledRunExecutorOptions {
  runStore: RunStore;
  sessionFactory?: ScheduledSessionFactory;
  now?: () => Date;
  id?: () => string;
}

export class ScheduledRunExecutor {
  private readonly active = new Set<string>();
  private readonly runStore: RunStore;
  private readonly sessionFactory: ScheduledSessionFactory;
  private readonly now: () => Date;
  private readonly id: () => string;

  constructor(options: ScheduledRunExecutorOptions) {
    this.runStore = options.runStore;
    this.sessionFactory = options.sessionFactory
      ?? ((task, context) => createScheduledSession(task, context, this.runStore));
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? (() => crypto.randomUUID());
  }

  isActive(taskId: string): boolean {
    return this.active.has(taskId);
  }

  async run(
    task: ScheduledTaskRecord,
    trigger: ScheduledRunTrigger,
    scheduledFor?: string,
  ): Promise<ScheduledRunRecord> {
    return this.start(task, trigger, scheduledFor).completion;
  }

  start(
    task: ScheduledTaskRecord,
    trigger: ScheduledRunTrigger,
    scheduledFor?: string,
  ): ScheduledRunStart {
    assertSafeScheduledId(task.id, "task id");
    const runId = this.id();
    if (this.active.has(task.id)) {
      const skipped: ScheduledRunRecord = {
        id: runId,
        taskId: task.id,
        trigger,
        status: "skipped",
        ...(scheduledFor ? { scheduledFor } : {}),
        completedAt: this.now().toISOString(),
        skipReason: "already_running",
        files: [],
        unread: true,
        definition: snapshot(task),
      };
      this.runStore.save(skipped);
      this.runStore.prune(task.id);
      trackServerEvent({ name: "scheduled_task_run_terminal", properties: { outcome: "skipped", trigger, duration_bucket: "under_1s", reason_code: "already_running", file_count_bucket: "0" } });
      return { run: skipped, completion: Promise.resolve(skipped) };
    }

    const startedAt = this.now().toISOString();
    let record: ScheduledRunRecord = {
      id: runId,
      taskId: task.id,
      trigger,
      status: "running",
      ...(scheduledFor ? { scheduledFor } : {}),
      startedAt,
      files: [],
      unread: false,
      definition: snapshot(task),
    };
    this.runStore.save(record);
    this.active.add(task.id);
    try {
      const dispatchDelay = scheduledFor ? Math.max(0, Date.parse(startedAt) - Date.parse(scheduledFor)) : 0;
      trackServerEvent({ name: "scheduled_task_run_started", properties: { trigger, dispatch_delay_bucket: durationBucket(dispatchDelay), model_mode: task.modelId ? "override" : "default" } });
      const completion = this.complete(task, record);
      return { run: record, completion };
    } catch (error) {
      this.active.delete(task.id);
      throw error;
    }
  }

  private async complete(
    task: ScheduledTaskRecord,
    initialRecord: ScheduledRunRecord,
  ): Promise<ScheduledRunRecord> {
    let record = initialRecord;
    let session: ScheduledSessionHandle | undefined;

    try {
      session = await this.sessionFactory(task, {
        runId: initialRecord.id,
        publishFile: (file) => {
          if (record.files.some((candidate) => candidate.id === file.id)) return;
          record = { ...record, files: [...record.files, file] };
          this.runStore.save(record);
        },
      });
      if (session.modelId) {
        record = { ...record, modelId: session.modelId };
        this.runStore.save(record);
      }
      await session.prompt(task.prompt);
      const completedAt = this.now().toISOString();
      record = {
        ...record,
        status: "completed",
        completedAt,
        durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(initialRecord.startedAt ?? completedAt)),
        finalText: finalAssistantText(session.messages()),
        unread: true,
      };
    } catch (error) {
      const completedAt = this.now().toISOString();
      record = {
        ...record,
        status: "failed",
        completedAt,
        durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(initialRecord.startedAt ?? completedAt)),
        error: {
          code: "execution_failed",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        },
        unread: true,
      };
    } finally {
      this.active.delete(task.id);
      try {
        session?.dispose();
      } catch (disposeError) {
        console.error("[scheduled-tasks] session dispose failed", disposeError);
      }
      this.runStore.save(record);
      this.runStore.prune(task.id);
      trackServerEvent({
        name: "scheduled_task_run_terminal",
        properties: {
          outcome: record.status === "completed" ? "completed" : "failed",
          trigger: record.trigger,
          duration_bucket: durationBucket(record.durationMs ?? 0),
          ...(record.error ? { reason_code: record.error.code } : {}),
          file_count_bucket: countBucket(record.files.length),
        },
      });
    }
    return record;
  }
}

function canonicalModelId(session: AgentSession): string | undefined {
  const model = session.model;
  return model && model.provider !== "unknown" && model.id !== "unknown"
    ? `${model.provider}/${model.id}`
    : undefined;
}

export async function createScheduledSession(
  task: ScheduledTaskRecord,
  context: ScheduledSessionContext,
  runStore: RunStore,
): Promise<ScheduledSessionHandle> {
  assertSafeScheduledId(task.id, "task id");
  const cwd = path.join(env.dataDir, "scheduled", task.id);
  fs.mkdirSync(cwd, { recursive: true });
  const { authStorage, modelRegistry, model: defaultModel } = await getAgentDeps();
  const model = task.modelId
    ? await resolveModelById(task.modelId, modelRegistry)
    : defaultModel;
  if (task.modelId && !model) throw new Error(`Configured model "${task.modelId}" is unavailable`);

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: env.agentDir,
    noExtensions: true,
    noPromptTemplates: true,
  });
  await resourceLoader.reload();
  const customTools = createScheduledTools({
    taskId: task.id,
    runId: context.runId,
    cwd,
    runStore,
    publishFile: context.publishFile,
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir: env.agentDir,
    model,
    authStorage,
    modelRegistry,
    tools: [...SCHEDULED_ALLOWED_TOOL_NAMES],
    customTools,
    resourceLoader,
    // Keep scheduled history inside this task's app-owned data root instead of
    // pi's default ~/.pi/agent/sessions directory. The explicit directory also
    // makes task isolation independent of the user's global pi installation.
    sessionManager: SessionManager.continueRecent(cwd, path.join(cwd, "sessions")),
  });
  return {
    modelId: canonicalModelId(session),
    prompt: (text) => session.prompt(text, { expandPromptTemplates: false }),
    messages: () => session.messages as ScheduledSessionMessage[],
    getActiveToolNames: () => session.getActiveToolNames(),
    getToolDefinition: (name) => session.getToolDefinition(name),
    dispose: () => session.dispose(),
  };
}
