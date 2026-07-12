import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createAgentSession, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { env } from "../config/env.js";
import { getAgentDeps } from "./deps.js";

export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  modelId?: string;
}

const sessionPromises = new Map<string, Promise<AgentSession>>();

function registryPath(): string {
  return path.join(env.dataDir, "conversations", "index.json");
}

function readRegistry(): ConversationMeta[] {
  const file = registryPath();
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf8")) as ConversationMeta[];
}

function writeRegistry(entries: ConversationMeta[]): void {
  const file = registryPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(entries, null, 2));
}

export function listConversations(): ConversationMeta[] {
  return readRegistry().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function createConversation(title?: string): ConversationMeta {
  const now = new Date().toISOString();
  const meta: ConversationMeta = {
    id: randomUUID(),
    title: title ?? "New conversation",
    createdAt: now,
    updatedAt: now,
  };

  fs.mkdirSync(conversationCwd(meta.id), { recursive: true });

  const entries = readRegistry();
  entries.push(meta);
  writeRegistry(entries);

  return meta;
}

export function getConversationMeta(id: string): ConversationMeta | undefined {
  return readRegistry().find((entry) => entry.id === id);
}

export function touchConversation(id: string, patch?: Partial<Pick<ConversationMeta, "title" | "modelId">>): void {
  const entries = readRegistry();
  const index = entries.findIndex((entry) => entry.id === id);
  if (index === -1) return;

  entries[index] = { ...entries[index], ...patch, updatedAt: new Date().toISOString() };
  writeRegistry(entries);
}

/**
 * "default" maps to the pre-existing shared session's cwd (env.workspaceDir) verbatim,
 * not a subdirectory — this keeps that session's already-persisted history from being
 * orphaned when it's adopted into the registry as conversation id "default" (see Task 2).
 * Every other id gets its own directory under dataDir/conversations.
 */
export function conversationCwd(id: string): string {
  if (id === "default") return env.workspaceDir;
  return path.join(env.dataDir, "conversations", id);
}

/**
 * Generalizes session.ts's single sessionPromise to a per-id map, mirroring the
 * per-task session isolation scheduler/index.ts already does for scheduled agents —
 * each conversation id gets its own persisted AgentSession, memoized so concurrent
 * callers for the same id share one in-flight creation.
 */
export function getOrCreateSession(id: string): Promise<AgentSession> {
  let promise = sessionPromises.get(id);
  if (!promise) {
    promise = createSession(id);
    sessionPromises.set(id, promise);
  }
  return promise;
}

async function createSession(id: string): Promise<AgentSession> {
  const cwd = conversationCwd(id);
  fs.mkdirSync(cwd, { recursive: true });

  const { authStorage, modelRegistry, model, customTools } = await getAgentDeps();

  const { session } = await createAgentSession({
    cwd,
    agentDir: env.agentDir,
    model,
    authStorage,
    modelRegistry,
    customTools,
    sessionManager: SessionManager.continueRecent(cwd),
  });

  return session;
}
