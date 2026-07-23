import fs from "node:fs";
import path from "node:path";
import type { ScheduledRunRecord } from "./types.js";
import type { ScheduledRunFile } from "./types.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RUN_STATUSES = new Set(["running", "completed", "failed", "skipped"]);
const RUN_TRIGGERS = new Set(["cron", "manual"]);
const ERROR_CODES = new Set(["execution_failed", "process_interrupted", "model_unavailable", "invalid_definition"]);

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`Invalid ${label}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isRunFile(value: unknown): boolean {
  return isObject(value)
    && typeof value.id === "string"
    && SAFE_ID.test(value.id)
    && typeof value.name === "string"
    && typeof value.mediaType === "string"
    && typeof value.byteSize === "number"
    && Number.isFinite(value.byteSize)
    && value.byteSize >= 0
    && (value.state === "available" || value.state === "missing");
}

function isTaskSnapshot(value: unknown): boolean {
  return isObject(value)
    && typeof value.name === "string"
    && typeof value.prompt === "string"
    && typeof value.cron === "string"
    && typeof value.timezone === "string"
    && typeof value.enabled === "boolean"
    && isOptionalString(value.modelId);
}

function isRunError(value: unknown): boolean {
  return value === undefined || (
    isObject(value)
    && typeof value.code === "string"
    && ERROR_CODES.has(value.code)
    && typeof value.message === "string"
    && typeof value.retryable === "boolean"
  );
}

function isScheduledRunRecord(value: unknown, taskId: string, runId: string): value is ScheduledRunRecord {
  return isObject(value)
    && value.id === runId
    && value.taskId === taskId
    && typeof value.trigger === "string"
    && RUN_TRIGGERS.has(value.trigger)
    && typeof value.status === "string"
    && RUN_STATUSES.has(value.status)
    && isOptionalString(value.scheduledFor)
    && isOptionalString(value.startedAt)
    && isOptionalString(value.completedAt)
    && (value.durationMs === undefined
      || (typeof value.durationMs === "number" && Number.isFinite(value.durationMs) && value.durationMs >= 0))
    && isOptionalString(value.modelId)
    && isOptionalString(value.finalText)
    && isRunError(value.error)
    && (value.skipReason === undefined || value.skipReason === "already_running")
    && Array.isArray(value.files)
    && value.files.every(isRunFile)
    && typeof value.unread === "boolean"
    && isTaskSnapshot(value.definition);
}

function timestamp(run: ScheduledRunRecord): number {
  return Date.parse(run.completedAt ?? run.startedAt ?? "") || 0;
}

export class RunStore {
  readonly root: string;

  constructor(private readonly dataDir: string, private readonly now: () => Date = () => new Date()) {
    this.root = path.join(dataDir, "scheduler-runs");
  }

  runDir(taskId: string, runId: string): string {
    assertSafeId(taskId, "task id");
    assertSafeId(runId, "run id");
    return path.join(this.root, taskId, runId);
  }

  filesDir(taskId: string, runId: string): string {
    return path.join(this.runDir(taskId, runId), "files");
  }

  save(run: ScheduledRunRecord): void {
    const directory = this.runDir(run.taskId, run.id);
    fs.mkdirSync(directory, { recursive: true });
    const destination = path.join(directory, "run.json");
    const temporary = path.join(directory, "run.json.tmp");
    const descriptor = fs.openSync(temporary, "w", 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(run, null, 2)}\n`, "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, destination);
    try {
      const directoryDescriptor = fs.openSync(directory, "r");
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    } catch {
      // The manifest is committed; some platforms do not support directory fsync.
    }
  }

  get(taskId: string, runId: string): ScheduledRunRecord | undefined {
    const directory = this.runDir(taskId, runId);
    if (!fs.existsSync(directory) || fs.lstatSync(directory).isSymbolicLink()) return undefined;
    const manifest = path.join(directory, "run.json");
    if (!fs.existsSync(manifest) || fs.lstatSync(manifest).isSymbolicLink()) return undefined;
    try {
      const document: unknown = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (!isScheduledRunRecord(document, taskId, runId)) {
        throw new Error("Run manifest has an invalid structure.");
      }
      return document;
    } catch (error) {
      console.error(`[scheduler] run manifest "${taskId}/${runId}" could not be loaded and was ignored`, error);
      return undefined;
    }
  }

  list(taskId: string): ScheduledRunRecord[] {
    assertSafeId(taskId, "task id");
    const taskRoot = path.join(this.root, taskId);
    if (!fs.existsSync(taskRoot) || fs.lstatSync(taskRoot).isSymbolicLink()) return [];

    const runs: ScheduledRunRecord[] = [];
    for (const entry of fs.readdirSync(taskRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !SAFE_ID.test(entry.name)) continue;
      const run = this.get(taskId, entry.name);
      if (run) runs.push(run);
    }
    return runs.sort((left, right) => timestamp(right) - timestamp(left) || right.id.localeCompare(left.id));
  }

  reconcileInterrupted(): number {
    if (!fs.existsSync(this.root)) return 0;
    let count = 0;

    for (const taskEntry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!taskEntry.isDirectory() || taskEntry.isSymbolicLink() || !SAFE_ID.test(taskEntry.name)) continue;
      for (const run of this.list(taskEntry.name)) {
        if (run.status !== "running") continue;
        const completedAt = this.now().toISOString();
        const startedAt = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
        this.save({
          ...run,
          status: "failed",
          completedAt,
          ...(Number.isFinite(startedAt) ? { durationMs: Math.max(0, Date.parse(completedAt) - startedAt) } : {}),
          error: {
            code: "process_interrupted",
            message: "The app process stopped before this run reached a terminal state.",
            retryable: true,
          },
          unread: true,
        });
        count += 1;
      }
    }
    return count;
  }

  prune(taskId: string, keep = 100): number {
    const obsolete = this.list(taskId).slice(Math.max(0, keep));
    for (const run of obsolete) {
      fs.rmSync(this.runDir(taskId, run.id), { recursive: true, force: true });
    }
    return obsolete.length;
  }

  resolveFile(taskId: string, runId: string, fileId: string): {
    path: string;
    file: ScheduledRunFile;
  } | undefined {
    assertSafeId(fileId, "file id");
    const run = this.get(taskId, runId);
    const file = run?.files.find((candidate) => candidate.id === fileId);
    if (!file || file.state !== "available") return undefined;
    const root = this.filesDir(taskId, runId);
    const candidate = path.join(root, fileId);
    if (!fs.existsSync(root) || !fs.existsSync(candidate)) return undefined;
    if (fs.lstatSync(root).isSymbolicLink() || fs.lstatSync(candidate).isSymbolicLink()) return undefined;
    if (!fs.statSync(candidate).isFile()) return undefined;
    const realRoot = fs.realpathSync(root);
    const realCandidate = fs.realpathSync(candidate);
    if (!realCandidate.startsWith(`${realRoot}${path.sep}`)) return undefined;
    return { path: realCandidate, file };
  }
}
