import fs from "node:fs";
import path from "node:path";
import { schedule } from "node-cron";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { env } from "../config/env.js";
import { getAgentDeps } from "../agent/deps.js";

interface ScheduledAgentConfig {
  id: string;
  cron: string;
  prompt: string;
  timezone?: string;
  enabled?: boolean;
}

function loadConfig(): ScheduledAgentConfig[] {
  const configPath = path.join(env.agentDir, "scheduled-agents.json");
  if (!fs.existsSync(configPath)) return [];
  return JSON.parse(fs.readFileSync(configPath, "utf8")) as ScheduledAgentConfig[];
}

function logDir(): string {
  const dir = path.join(env.dataDir, "scheduler-logs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function appendLog(taskId: string, entry: Record<string, unknown>): void {
  const file = path.join(logDir(), `${taskId}.jsonl`);
  fs.appendFileSync(file, `${JSON.stringify({ ...entry, timestamp: new Date().toISOString() })}\n`);
}

/**
 * Each scheduled task gets its own persisted session (keyed by task id under
 * dataDir), separate from the interactive chat session (agent/conversations.ts's
 * getOrCreateSession("default")), so a background run's history doesn't intermix
 * with the live conversation.
 */
async function runTask(task: ScheduledAgentConfig): Promise<void> {
  const taskCwd = path.join(env.dataDir, "scheduled", task.id);
  fs.mkdirSync(taskCwd, { recursive: true });

  const { authStorage, modelRegistry, model, customTools } = await getAgentDeps();
  const { session } = await createAgentSession({
    cwd: taskCwd,
    agentDir: env.agentDir,
    model,
    authStorage,
    modelRegistry,
    customTools,
    sessionManager: SessionManager.continueRecent(taskCwd),
  });

  try {
    await session.prompt(task.prompt);
    appendLog(task.id, { status: "ok" });
  } catch (error) {
    appendLog(task.id, { status: "error", error: error instanceof Error ? error.message : String(error) });
  } finally {
    session.dispose();
  }
}

export function startScheduler(): void {
  const tasks = loadConfig().filter((task) => task.enabled !== false);

  for (const task of tasks) {
    schedule(
      task.cron,
      () => {
        runTask(task).catch((error) => {
          console.error(`[scheduler] task "${task.id}" failed`, error);
        });
      },
      task.timezone ? { timezone: task.timezone } : undefined,
    );
    console.log(`[scheduler] registered task "${task.id}" (${task.cron})`);
  }

  if (tasks.length === 0) {
    console.log(
      `[scheduler] no scheduled agents configured (edit ${path.join(env.agentDir, "scheduled-agents.json")})`,
    );
  }
}
