import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createAgentSession, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { env } from "../config/env.js";
import { getAgentDeps } from "./deps.js";
import { resolveModelById } from "./models.js";

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
 * Task 1 fix (path-traversal guard): ids ultimately reach conversationCwd() from
 * client-controlled input (Task 3 wires input.threadId from the AG-UI protocol
 * straight through to getOrCreateSession/conversationCwd), so an id like
 * "../../../../tmp/evil" must never be allowed to escape dataDir/conversations via
 * path.join. Reject anything that isn't a safe single path segment rather than
 * silently stripping/truncating characters — matching this module's existing style
 * of throwing on invariant violations rather than best-effort coercion. "default" and
 * randomUUID()-generated ids both satisfy this pattern.
 */
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function assertSafeConversationId(id: string): void {
  if (!SAFE_ID_PATTERN.test(id)) {
    throw new Error(`Invalid conversation id: "${id}"`);
  }
}

/**
 * "default" maps to the pre-existing shared session's cwd (env.workspaceDir) verbatim,
 * not a subdirectory — this keeps that session's already-persisted history from being
 * orphaned when it's adopted into the registry as conversation id "default" (see Task 2).
 * Every other id gets its own directory under dataDir/conversations.
 */
export function conversationCwd(id: string): string {
  assertSafeConversationId(id);
  if (id === "default") return env.workspaceDir;
  return path.join(env.dataDir, "conversations", id);
}

/**
 * Task 3 fix (review finding): "default" is a real pre-existing conversation
 * (conversationCwd("default") resolves to env.workspaceDir, see above) but it is
 * never created via createConversation(), so without this it would never gain a
 * registry entry — leaving getConversationMeta("default") undefined and
 * touchConversation("default", ...) a silent no-op forever, and "default" would
 * never show up in listConversations(). Lazily inserts a registry entry the first
 * time "default" is touched, using the same default-title convention as
 * createConversation(). Idempotent: a no-op once the entry exists.
 */
function ensureDefaultConversation(): void {
  const entries = readRegistry();
  if (entries.some((entry) => entry.id === "default")) return;

  const now = new Date().toISOString();
  entries.push({ id: "default", title: "New conversation", createdAt: now, updatedAt: now });
  writeRegistry(entries);
}

/**
 * Generalizes session.ts's single sessionPromise to a per-id map, mirroring the
 * per-task session isolation scheduler/index.ts already does for scheduled agents —
 * each conversation id gets its own persisted AgentSession, memoized so concurrent
 * callers for the same id share one in-flight creation.
 */
export function getOrCreateSession(id: string): Promise<AgentSession> {
  if (id === "default") ensureDefaultConversation();

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

  const { authStorage, modelRegistry, model: defaultModel, customTools } = await getAgentDeps();

  /**
   * Task 1 fix (model-sourcing gap): a conversation with a modelId set should get
   * that specific model, resolved via models.ts's resolveModelById — falling back to
   * getAgentDeps()'s env-var default only when modelId is unset OR resolveModelById
   * can't resolve it (unknown id — resolveModelById never throws, per Task 5's
   * AC-5.3 contract, so this is a plain undefined check, not a try/catch).
   */
  const modelId = getConversationMeta(id)?.modelId;
  const model = modelId ? (await resolveModelById(modelId, modelRegistry)) ?? defaultModel : defaultModel;

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
