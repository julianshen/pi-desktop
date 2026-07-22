import fs from "node:fs";
import path from "node:path";
import type { ScheduledTaskRecord } from "./types.js";

export interface TaskStoreFileSystem {
  existsSync(path: fs.PathLike): boolean;
  mkdirSync(path: fs.PathLike, options: { recursive: true }): string | undefined;
  readFileSync(path: fs.PathOrFileDescriptor, encoding: BufferEncoding): string;
  statSync(path: fs.PathLike): { mtime: Date };
  openSync(path: fs.PathLike, flags: string, mode?: number): number;
  writeFileSync(fd: number, data: string, encoding: BufferEncoding): void;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  renameSync(oldPath: fs.PathLike, newPath: fs.PathLike): void;
  unlinkSync(path: fs.PathLike): void;
}

type StoredTask = Partial<ScheduledTaskRecord> & Pick<ScheduledTaskRecord, "id" | "cron" | "prompt">;

function asStoredTasks(value: unknown): StoredTask[] {
  if (!Array.isArray(value)) throw new Error("scheduled-agents.json must contain an array");
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== "object") throw new Error("Scheduled task must be an object");
    const task = candidate as Record<string, unknown>;
    if (typeof task.id !== "string" || typeof task.cron !== "string" || typeof task.prompt !== "string") {
      throw new Error("Scheduled task requires string id, cron, and prompt");
    }
    return task as unknown as StoredTask;
  });
}

export class TaskStore {
  readonly configPath: string;
  readonly temporaryPath: string;

  constructor(
    private readonly agentDir: string,
    private readonly fileSystem: TaskStoreFileSystem = fs as unknown as TaskStoreFileSystem,
  ) {
    this.configPath = path.join(agentDir, "scheduled-agents.json");
    this.temporaryPath = path.join(agentDir, "scheduled-agents.json.tmp");
  }

  load(): ScheduledTaskRecord[] {
    if (!this.fileSystem.existsSync(this.configPath)) return [];
    const timestamp = this.fileSystem.statSync(this.configPath).mtime.toISOString();
    const stored = asStoredTasks(JSON.parse(this.fileSystem.readFileSync(this.configPath, "utf8")));
    const hostTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    return stored.map((task) => ({
      id: task.id,
      name: typeof task.name === "string" && task.name.trim() ? task.name : task.id,
      prompt: task.prompt,
      cron: task.cron,
      timezone: typeof task.timezone === "string" && task.timezone ? task.timezone : hostTimezone,
      enabled: task.enabled !== false,
      ...(typeof task.modelId === "string" && task.modelId ? { modelId: task.modelId } : {}),
      createdAt: typeof task.createdAt === "string" ? task.createdAt : timestamp,
      updatedAt: typeof task.updatedAt === "string" ? task.updatedAt : timestamp,
    }));
  }

  replaceAll(tasks: ScheduledTaskRecord[]): void {
    this.fileSystem.mkdirSync(this.agentDir, { recursive: true });
    const document = `${JSON.stringify(tasks, null, 2)}\n`;
    let descriptor: number | undefined;

    try {
      descriptor = this.fileSystem.openSync(this.temporaryPath, "w", 0o600);
      this.fileSystem.writeFileSync(descriptor, document, "utf8");
      this.fileSystem.fsyncSync(descriptor);
      this.fileSystem.closeSync(descriptor);
      descriptor = undefined;
      this.fileSystem.renameSync(this.temporaryPath, this.configPath);
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          this.fileSystem.closeSync(descriptor);
        } catch {
          // Preserve the original persistence error.
        }
      }
      if (this.fileSystem.existsSync(this.temporaryPath)) {
        try {
          this.fileSystem.unlinkSync(this.temporaryPath);
        } catch {
          // Preserve the original persistence error.
        }
      }
      throw error;
    }

    try {
      const directory = this.fileSystem.openSync(this.agentDir, "r");
      this.fileSystem.fsyncSync(directory);
      this.fileSystem.closeSync(directory);
    } catch {
      // The rename is already committed; some platforms do not allow fsync on directories.
    }
  }
}
