import fs from "node:fs";
import { createAgentSession, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { env } from "../config/env.js";
import { getAgentDeps } from "./deps.js";

let sessionPromise: Promise<AgentSession> | undefined;

/**
 * The pi-desktop server hosts a single long-lived, persisted AgentSession shared
 * by the chat UI (over AG-UI), distinct from the per-task sessions used by the
 * scheduler (see scheduler/index.ts), so live chat history stays its own thread.
 */
export function getSharedSession(): Promise<AgentSession> {
  if (!sessionPromise) {
    sessionPromise = createSession();
  }
  return sessionPromise;
}

async function createSession(): Promise<AgentSession> {
  fs.mkdirSync(env.workspaceDir, { recursive: true });

  const { authStorage, modelRegistry, model, customTools } = await getAgentDeps();

  const { session } = await createAgentSession({
    cwd: env.workspaceDir,
    agentDir: env.agentDir,
    model,
    authStorage,
    modelRegistry,
    customTools,
    sessionManager: SessionManager.continueRecent(env.workspaceDir),
  });

  return session;
}
