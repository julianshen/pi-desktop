import fs from "node:fs";
import path from "node:path";
import type { ScheduledRunRecord } from "./types.js";
import type { ScheduledRunFile } from "./types.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`Invalid ${label}`);
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
    fs.writeFileSync(temporary, `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, destination);
  }

  get(taskId: string, runId: string): ScheduledRunRecord | undefined {
    const directory = this.runDir(taskId, runId);
    if (!fs.existsSync(directory) || fs.lstatSync(directory).isSymbolicLink()) return undefined;
    const manifest = path.join(directory, "run.json");
    if (!fs.existsSync(manifest) || fs.lstatSync(manifest).isSymbolicLink()) return undefined;
    return JSON.parse(fs.readFileSync(manifest, "utf8")) as ScheduledRunRecord;
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
