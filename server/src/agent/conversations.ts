import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createAgentSession, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { Message as AGUIMessage } from "@ag-ui/core";
import { env } from "../config/env.js";
import { getAgentDeps } from "./deps.js";
import { resolveModelById } from "./models.js";
import { createArtifactTools } from "../artifacts/tools.js";

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
    /**
     * Code-review finding (Important, /tgd-review): Map.set() happens synchronously
     * here, before createSession()'s async body has a chance to throw/reject — so a
     * transient failure (or a malformed id tripping assertSafeConversationId) would
     * otherwise cache a permanently-rejected promise for `id` forever, "bricking" that
     * conversation until server restart and letting attacker-supplied malformed ids
     * grow this map unboundedly. Evict the entry on rejection so the next call for the
     * same id retries fresh instead of replaying the same stale rejection. The .catch()
     * here only removes the cache entry; it re-throws so callers of getOrCreateSession()
     * still observe the original rejection undisturbed.
     */
    promise.catch(() => {
      if (sessionPromises.get(id) === promise) {
        sessionPromises.delete(id);
      }
    });
    sessionPromises.set(id, promise);
  }
  return promise;
}

/**
 * Critical fix (/tgd-review, found independently by code-reviewer and
 * test-engineer): PATCH /api/conversations/:id/model previously only updated
 * stored ConversationMeta -- it never touched the already-cached AgentSession
 * sitting in sessionPromises, so switching a conversation's model after it had
 * already sent at least one message (the normal case) silently did nothing; the
 * next turn kept using the OLD model. Only a conversation that had never yet
 * created a session picked up the change, and only because createSession()
 * above reads current metadata (getConversationMeta(id)?.modelId) at creation
 * time -- that path was already correct and is untouched here.
 *
 * This closes the gap for the live-session case using the SDK's own
 * AgentSession#setModel(model: Model<any>): Promise<void> (confirmed in
 * node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts).
 * It accepts a resolved Model object -- exactly what models.ts's
 * resolveModelById() already returns -- so the PATCH handler in index.ts can
 * pass the same `resolved` value straight through with no extra mapping.
 *
 * Resolves to void (no-op) when there is no live session yet for `id`: it must
 * NOT force-create one as a side effect of a metadata-only update, since the
 * next getOrCreateSession() call will already pick up the freshly-touched
 * metadata on its own. A rejection from the live session's setModel() (e.g. no
 * auth configured for the target model, per its own doc comment) is
 * deliberately left unswallowed so the caller can keep stored metadata and the
 * live session's actual model consistent instead of reporting success while
 * the live session silently kept its old model.
 */
export async function setLiveSessionModel(id: string, model: Model<Api>): Promise<void> {
  const promise = sessionPromises.get(id);
  if (!promise) return;

  const session = await promise;
  await session.setModel(model);
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

  /**
   * Task 7: artifact tools are per-conversation (publish_artifact closes over this
   * conversation's id so it always saves to *this* conversation's artifacts.json),
   * so they're built here per-session rather than being part of getAgentDeps()'s
   * memoized, conversation-agnostic bundle — appended on top, not replacing it.
   */
  const { session } = await createAgentSession({
    cwd,
    agentDir: env.agentDir,
    model,
    authStorage,
    modelRegistry,
    customTools: [...customTools, ...createArtifactTools(id)],
    sessionManager: SessionManager.continueRecent(cwd),
  });

  return session;
}

/** The element type of AgentSession#messages (see agent-session.d.ts's `get messages(): AgentMessage[]`). */
type SessionMessage = AgentSession["messages"][number];

/**
 * Extracts plain text from pi's content shape, which is either a bare string
 * (UserMessage's common case) or an array of typed parts (TextContent /
 * ImageContent / ThinkingContent / ToolCall — see @earendil-works/pi-ai's
 * types.d.ts). Non-text parts (images, thinking, tool calls) are dropped here;
 * tool calls are extracted separately by extractToolCalls() below, and this repo
 * has no UI representation for inline images or thinking blocks in the replayed
 * history (ChatView.tsx doesn't render them for live messages either).
 */
function extractText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

/** Extracts AG-UI-shaped toolCalls from an AssistantMessage's content array. */
function extractToolCalls(
  content: Array<{ type: string; id?: string; name?: string; arguments?: Record<string, unknown> }>,
): NonNullable<Extract<AGUIMessage, { role: "assistant" }>["toolCalls"]> {
  return content
    .filter((part) => part.type === "toolCall")
    .map((call) => ({
      type: "function" as const,
      id: call.id as string,
      function: { name: call.name as string, arguments: JSON.stringify(call.arguments ?? {}) },
    }));
}

/**
 * Critical fix (/tgd-review code-reviewer finding — closes US-03's P0 acceptance
 * criterion / TASKS.md's AC-12.2): maps pi's internal AgentSession#messages
 * (AgentMessage[] — confirmed via
 * node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts's
 * `get messages(): AgentMessage[]`) to the @ag-ui/core Message[] wire shape, so
 * index.ts's new GET /api/conversations/:id/messages route can hand the frontend
 * something it can feed straight into `@ag-ui/client`'s
 * `AbstractAgent#setMessages()` (see ChatView.tsx's seeding effect) — the exact
 * shape RunAgentInput.messages already uses, so no separate frontend-side mapping
 * is needed.
 *
 * pi's own Message type (@earendil-works/pi-ai) has no stable per-message `id`
 * (only a numeric `timestamp`), but AG-UI's Message schema requires one. A
 * deterministic `history-<index>` id is synthesized here; it only needs to be
 * unique within a single response, since ChatView calls `setMessages()` with the
 * whole array at once (a wholesale replace, not an id-keyed merge).
 *
 * Only "user" / "assistant" / "toolResult" carry a chat-transcript meaning. pi's
 * other AgentMessage roles (bashExecution, custom, branchSummary,
 * compactionSummary — see core/messages.d.ts's CustomAgentMessages module
 * augmentation) have no AG-UI role and no ChatView.tsx rendering for live
 * messages either, so they're dropped here rather than inventing a shape for
 * them. This is a known, documented simplification, not a regression: a
 * conversation whose history contains one of those (e.g. a `!bash` command) will
 * not show that entry after a reload, exactly as it never showed during the live
 * turn.
 */
export function toAGUIHistory(messages: SessionMessage[]): AGUIMessage[] {
  const result: AGUIMessage[] = [];

  messages.forEach((message, index) => {
    const id = `history-${index}`;

    if (message.role === "user") {
      result.push({ id, role: "user", content: extractText(message.content) });
      return;
    }

    if (message.role === "assistant") {
      const text = extractText(message.content);
      const toolCalls = extractToolCalls(message.content);
      // Live-usage bug fix (same root cause as adapter.ts's "empty lines in chat"
      // fix): pi's agentic loop records a content-free assistant message for the
      // turn where the model decides to call a tool — no text_delta, and the tool
      // call itself surfaces as a separate top-level event, not nested in this
      // message's own content array, so extractToolCalls() finds nothing here
      // either. The live-streaming path already skips opening a bubble for these;
      // history replay must not resurrect them as an empty `{id, role:
      // "assistant"}` entry on every reload/conversation-switch — confirmed live
      // via a real conversation showing a stack of empty bubbles after a reload.
      if (!text && toolCalls.length === 0) return;
      result.push({
        id,
        role: "assistant",
        ...(text ? { content: text } : {}),
        ...(toolCalls.length ? { toolCalls } : {}),
      });
      return;
    }

    if (message.role === "toolResult") {
      result.push({ id, role: "tool", toolCallId: message.toolCallId, content: extractText(message.content) });
    }
  });

  return result;
}

/**
 * Backend half of the "switching to a conversation shows an empty transcript"
 * fix (Critical /tgd-review finding, US-03 P0 / AC-12.2). Reuses
 * getOrCreateSession() rather than a separate non-destructive read path — this
 * repo has no such path today, and creating the session here is not wasted work:
 * it's the same session a subsequent chat turn on this conversation will need
 * anyway (mirrors how POST /agui already force-creates one).
 */
export async function getConversationMessages(id: string): Promise<AGUIMessage[]> {
  const session = await getOrCreateSession(id);
  return toAGUIHistory(session.messages as SessionMessage[]);
}

/**
 * Bug fix (live-usage report: a failed turn — real OpenRouter 402 "insufficient
 * credits" — was completely invisible in the UI). adapter.ts now emits a real
 * RUN_ERROR over the AG-UI stream, but the installed CopilotKit version's
 * documented `<CopilotKit onError>` prop silently no-ops without a
 * `publicApiKey` configured (confirmed by reading the installed package's own
 * source, node_modules/@copilotkit/react-core/dist/copilotkit-ympAovXs.mjs's
 * `handleErrors`: `if (copilotApiConfig.publicApiKey && onErrorRef.current)`) —
 * this app is deliberately self-hosted with no license key, so that prop is a
 * dead end here, not a viable way to observe agent errors client-side. This
 * gives the frontend an independent, backend-owned way to check "did the most
 * recent turn fail, and why" — read directly off the last message rather than
 * going through toAGUIHistory() (which intentionally drops content-free
 * assistant messages from history replay).
 */
export async function getLastTurnError(id: string): Promise<string | null> {
  const session = await getOrCreateSession(id);
  const messages = session.messages as SessionMessage[];
  const last = messages[messages.length - 1];
  if (last?.role === "assistant" && last.stopReason === "error") {
    return last.errorMessage ?? "The model call failed.";
  }
  return null;
}
