export type ScheduledRunStatus = "running" | "completed" | "failed" | "skipped";
export type ScheduledRunTrigger = "cron" | "manual";

export interface ScheduledTaskRecord {
  id: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  modelId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledTaskSnapshot {
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  modelId?: string;
}

export interface ScheduledRunFile {
  id: string;
  name: string;
  mediaType: string;
  byteSize: number;
  state: "available" | "missing";
}

export interface ScheduledRunError {
  code: "execution_failed" | "process_interrupted" | "model_unavailable" | "invalid_definition";
  message: string;
  retryable: boolean;
}

export interface ScheduledRunRecord {
  id: string;
  taskId: string;
  trigger: ScheduledRunTrigger;
  status: ScheduledRunStatus;
  scheduledFor?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  modelId?: string;
  finalText?: string;
  error?: ScheduledRunError;
  skipReason?: "already_running";
  files: ScheduledRunFile[];
  unread: boolean;
  definition: ScheduledTaskSnapshot;
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

export interface ScheduledTaskInput {
  name: string;
  prompt: string;
  cron: string;
  timezone?: string;
  enabled: boolean;
  modelId?: string | null;
}

export type ScheduledTaskPatch = Partial<ScheduledTaskInput>;
