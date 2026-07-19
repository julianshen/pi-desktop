import { randomUUID } from "node:crypto";
import { ChatWorkspaceStore, type AgentRunRecord, type RunEventRecord, type RunStatus } from "./store.js";
import { durationBucket, trackServerEvent } from "../analytics/events.js";

export interface RunExecutionContext {
  signal: AbortSignal;
  emit(type: string, data: unknown): RunEventRecord;
}

export interface StartRunInput {
  conversationId: string;
  branchId?: string;
  model?: string;
  execute?: (context: RunExecutionContext) => Promise<void>;
  abort?: () => void | Promise<void>;
  steer?: (instruction: string) => void | Promise<void>;
}

const terminal = new Set<RunStatus>(["completed", "failed", "stopped", "interrupted"]);

export class RunManager {
  private readonly controllers = new Map<string, AbortController>();
  private readonly abortHandlers = new Map<string, () => void | Promise<void>>();
  private readonly steerHandlers = new Map<string, (instruction: string) => void | Promise<void>>();
  private readonly subscribers = new Map<string, Set<(event: RunEventRecord) => void>>();

  constructor(private readonly store: ChatWorkspaceStore) {
    store.interruptActiveRuns();
  }

  start(input: StartRunInput): AgentRunRecord {
    const now = new Date().toISOString();
    const run = this.store.createRun({
      id: randomUUID(), conversationId: input.conversationId, branchId: input.branchId,
      model: input.model, status: "running", createdAt: now, startedAt: now,
    });
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    if (input.abort) this.abortHandlers.set(run.id, input.abort);
    if (input.steer) this.steerHandlers.set(run.id, input.steer);
    this.emit(run.id, "run_started", { conversationId: input.conversationId, branchId: input.branchId, model: input.model });

    if (input.execute) {
      void input.execute({ signal: controller.signal, emit: (type, data) => this.emit(run.id, type, data) })
        .then(() => { this.finish(run.id, controller.signal.aborted ? "stopped" : "completed"); })
        .catch((error: unknown) => { this.finish(run.id, controller.signal.aborted ? "stopped" : "failed", error instanceof Error ? error.message : String(error)); });
    }
    return run;
  }

  get(runId: string): AgentRunRecord | undefined { return this.store.getRun(runId); }
  events(runId: string, after = 0): RunEventRecord[] { return this.store.listRunEvents(runId, after); }

  emit(runId: string, type: string, data: unknown): RunEventRecord {
    const event = this.store.appendRunEvent(runId, randomUUID(), type, data, new Date().toISOString());
    for (const subscriber of this.subscribers.get(runId) ?? []) subscriber(event);
    return event;
  }

  subscribe(runId: string, listener: (event: RunEventRecord) => void): () => void {
    const listeners = this.subscribers.get(runId) ?? new Set();
    listeners.add(listener);
    this.subscribers.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.subscribers.delete(runId);
    };
  }

  stop(runId: string): AgentRunRecord | undefined {
    this.controllers.get(runId)?.abort();
    void this.abortHandlers.get(runId)?.();
    return this.finish(runId, "stopped");
  }

  finish(runId: string, status: Extract<RunStatus, "completed" | "failed" | "stopped" | "interrupted">, error?: string): AgentRunRecord | undefined {
    const committed = this.store.finishRunWithEvent(runId, status, {
      id: randomUUID(), type: `run_${status}`, data: error ? { error } : {}, createdAt: new Date().toISOString(),
    }, error);
    if (!committed) return undefined;
    const started = Date.parse(committed.run.startedAt ?? committed.run.createdAt);
    const provider = committed.run.model?.split("/", 1)[0] || "unknown";
    trackServerEvent({
      name: "chat_turn_terminal",
      properties: {
        outcome: status === "interrupted" ? "failed" : status,
        retryable: status === "failed" || status === "interrupted",
        model_provider: provider,
        duration_bucket: durationBucket(Math.max(0, Date.now() - started)),
      },
    });
    this.controllers.delete(runId);
    this.abortHandlers.delete(runId);
    this.steerHandlers.delete(runId);
    for (const subscriber of this.subscribers.get(runId) ?? []) subscriber(committed.event);
    return committed.run;
  }

  hasActiveConversationRun(conversationId: string): boolean {
    return this.store.listRuns(conversationId).some((run) => !terminal.has(run.status));
  }

  updatePlan(runId: string, input: {
    explanation?: string;
    steps: Array<{ id: string; text: string; status: "pending" | "in_progress" | "completed" }>;
  }) {
    const run = this.store.getRun(runId);
    if (!run || terminal.has(run.status)) throw new Error("Cannot update a terminal or missing run");
    if (input.steps.length === 0) throw new Error("Plan must contain at least one step");
    if (new Set(input.steps.map((step) => step.id)).size !== input.steps.length) throw new Error("Plan step IDs must be unique");
    if (input.steps.filter((step) => step.status === "in_progress").length > 1) throw new Error("At most one plan step may be in progress");
    if (input.steps.some((step) => !step.id.trim() || !step.text.trim())) throw new Error("Plan step IDs and text are required");
    const existing = this.store.listPlanSteps(runId);
    if (existing.length > 0) {
      if (existing.length !== input.steps.length || existing.some((step, index) => step.id !== input.steps[index]?.id)) {
        throw new Error("Plan step identity and order cannot change");
      }
      const rank = { pending: 0, in_progress: 1, completed: 2, failed: 2 } as const;
      if (existing.some((step, index) => rank[input.steps[index]!.status] < rank[step.status])) {
        throw new Error("Plan step status cannot move backward");
      }
    }
    const data = { explanation: input.explanation, steps: input.steps };
    const committed = this.store.replacePlanWithEvent(runId, input.steps, {
      id: randomUUID(), type: "plan_updated", data, createdAt: new Date().toISOString(),
    });
    for (const subscriber of this.subscribers.get(runId) ?? []) subscriber(committed.event);
    return committed.steps;
  }

  plan(runId: string) { return this.store.listPlanSteps(runId); }

  listConversationRuns(conversationId: string) { return this.store.listRuns(conversationId); }

  async steer(runId: string, instruction: string): Promise<AgentRunRecord> {
    const run = this.store.getRun(runId);
    const handler = this.steerHandlers.get(runId);
    if (!run || run.status !== "running" || !handler) throw new Error("Run cannot be steered");
    if (!instruction.trim()) throw new Error("instruction is required");
    await handler(instruction.trim());
    this.emit(runId, "run_steered", { accepted: true });
    return run;
  }
}

export function journalRunStream<T extends { type: string }>(
  manager: RunManager,
  runId: string,
  source: ReadableStream<T>,
  onComplete?: () => void,
): ReadableStream<T> {
  let failed = false;
  const committed = source.pipeThrough(new TransformStream<T, T>({
    transform(chunk, controller) {
      manager.emit(runId, "ui_message_chunk", chunk);
      if (chunk.type === "error") failed = true;
      controller.enqueue(chunk);
    },
    flush() {
      manager.finish(runId, failed ? "failed" : "completed");
      onComplete?.();
    },
  }));
  const [response, keepAlive] = committed.tee();
  void (async () => {
    const reader = keepAlive.getReader();
    try {
      while (!(await reader.read()).done) { /* Drain independently of the HTTP client. */ }
    } catch (error) {
      manager.finish(runId, "failed", error instanceof Error ? error.message : String(error));
    } finally {
      reader.releaseLock();
    }
  })();
  return response;
}
