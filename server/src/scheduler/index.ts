import fs from "node:fs";
import path from "node:path";
import { schedule } from "node-cron";
import { createAgentSession, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { env } from "../config/env.js";
import { getAgentDeps } from "../agent/deps.js";
import { createWebFetchTools } from "../web-fetch/tools.js";

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
 *
 * Task 7 (AC-7.2, US-05): builds this session's tool set with
 * `createWebFetchTools(task.id, "scheduled")`, never `"interactive"` — a scheduled
 * run getting the interactive tool factory would let `web_fetch`'s private-target
 * gate call `ctx.ui.confirm()` and create a real pending interaction that nobody is
 * watching, hanging the background run forever instead of hard-blocking
 * immediately (see web-fetch/tools.ts's `sessionKind === "scheduled"` branch).
 * `createWebFetchTools` is conversationId-scoped like `createArtifactTools`
 * (agent/conversations.ts), so — mirroring that same reasoning — it's built here
 * per-task-session rather than folded into getAgentDeps()'s memoized,
 * task/conversation-agnostic bundle.
 *
 * Split out from runTask() below (which also fires the real session.prompt() LLM
 * call) so this construction step — the exact place `sessionKind` is threaded
 * through — is independently unit-testable without needing real model/auth
 * configuration or triggering a live agent turn.
 */
export async function createScheduledSession(taskId: string): Promise<AgentSession> {
  const taskCwd = path.join(env.dataDir, "scheduled", taskId);
  fs.mkdirSync(taskCwd, { recursive: true });

  const { authStorage, modelRegistry, model, customTools } = await getAgentDeps();
  const { session } = await createAgentSession({
    cwd: taskCwd,
    agentDir: env.agentDir,
    model,
    authStorage,
    modelRegistry,
    customTools: [...customTools, ...createWebFetchTools(taskId, "scheduled")],
    sessionManager: SessionManager.continueRecent(taskCwd),
  });
  return session;
}

async function runTask(task: ScheduledAgentConfig): Promise<void> {
  const session = await createScheduledSession(task.id);

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
