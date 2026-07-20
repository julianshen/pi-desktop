import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  createAgentSession,
  SessionManager,
  type AgentSession,
  type ExtensionUIContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { Message as AGUIMessage } from "@ag-ui/core";
import { env } from "../config/env.js";
import { getAgentDeps } from "./deps.js";
import { resolveModelById } from "./models.js";
import { createArtifactTools } from "../artifacts/tools.js";
import { create as createPendingInteraction } from "../web-fetch/pending-interactions.js";
import { createWebFetchTools } from "../web-fetch/tools.js";
import { createPlanTools } from "./plan-tools.js";
import { createSearchTools } from "../search/tools.js";
import { createGeneratedFileTools } from "../chat-workspace/generated-files.js";
import { ChatWorkspaceStore, type ConversationRecord } from "../chat-workspace/store.js";

export interface ConversationMeta extends ConversationRecord {}

const sessionPromises = new Map<string, Promise<AgentSession>>();

/**
 * Task 5 (SPEC.md's "The custom confirm() implementation" subsection): how long
 * ctx.ui.confirm() waits for a human answer before the pending-interaction registry
 * (web-fetch/pending-interactions.ts) applies its fail-closed timeout default
 * (`{ approved: false }`, never `true` — see that file's timeoutDefaultFor()). 2
 * minutes is a judgment call, not a value mandated by SPEC.md (which only requires
 * *some* timeout exists, per US-06) -- long enough that a user glancing away from
 * chat doesn't get an auto-deny for no reason, short enough that a `web_fetch` call
 * genuinely dies rather than tying up the session indefinitely (no SDK-level timeout
 * wraps execute() itself, confirmed against the installed SDK's compiled source).
 */
export const DEFAULT_CONFIRM_TIMEOUT_MS = 120_000;

/**
 * Task 5: builds the ExtensionUIContext installed on every session via
 * session.extensionRunner.setUIContext() (see createSession() below). Every method
 * except confirm() mirrors the SDK's own noOpUIContext defaults (see
 * node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js) as
 * closely as TypeScript's structural typing allows -- this app has no TUI/terminal
 * surface for select/input/notify/widgets/etc., so every one of those stays inert.
 *
 * `theme` is the one deliberate divergence from mirroring noOpUIContext exactly: the
 * real noOpUIContext's `theme` getter returns a live Theme built by pi's own
 * modes/interactive/theme/theme.js (imported internally, not part of this package's
 * intended embedding surface -- only `initTheme()`/`Theme` are exported from the
 * package root, and initTheme() has vetoable side effects, e.g. an optional file
 * watcher, that a headless Bun server has no business triggering). Nothing in this
 * app's custom tools ever reads ctx.ui.theme (there is no rendering surface to style),
 * so an empty placeholder cast to Theme satisfies the interface without invoking any
 * of that machinery.
 *
 * confirm() is the one real implementation (AC-5.1): it creates a `kind: "confirm"`
 * pending interaction in the shared registry (web-fetch/pending-interactions.ts,
 * Task 3) and awaits its promise instead of returning the SDK default `false`
 * immediately. See the design-decision comment on the `host` field below.
 */
function buildConfirmUIContext(conversationId: string): ExtensionUIContext {
  return {
    select: async () => undefined,
    /**
     * Design decision (documented per TASKS.md Task 5's instructions): confirm()'s
     * signature only gives us a free-text `message` string composed by whichever
     * custom tool called ctx.ui.confirm() (the not-yet-built web_fetch tool) -- the
     * SDK gives no structured "what is this approval about" field alongside it.
     * pending-interactions.ts's `kind: "confirm"` variant has a `host: string`
     * field, but nothing in that file enforces hostname formatting on it (confirmed
     * by reading pending-interactions.ts directly -- it's typed `string`, never
     * parsed or validated as a hostname anywhere in create()/resolve()/getPending()).
     *
     * Two options were considered: (a) parse a hostname out of `message` with a
     * regex/heuristic, or (b) pass `message` straight through as `host`, treating
     * that field's real semantics as "human-readable description of what's being
     * approved" rather than strictly a hostname. (a) is fragile -- it silently
     * breaks the moment the calling tool rewords its message, and invents parsing
     * logic against a message format that doesn't exist yet (web_fetch is a later
     * task). (b) is simpler and more robust, and pushes the responsibility to the
     * right place: the eventual web_fetch tool can compose a well-formatted message
     * up front (e.g. "pi wants to fetch example.com — this targets your local
     * machine or network.") rather than this task inventing fragile parsing for a
     * caller that doesn't exist yet. Chose (b). The frontend (a later task) renders
     * `host` as-is either way, so this is purely an internal naming/semantics
     * decision, not an API contract change.
     */
    confirm: async (_title, message, opts) => {
      /**
       * create()'s second parameter is DistributiveOmit<PendingInteraction, "id" |
       * "createdAt"> (see pending-interactions.ts), which still requires
       * conversationId as part of the request object itself -- only "id" and
       * "createdAt" are stripped -- so it's passed here as well as positionally,
       * matching pending-interactions.test.ts's own established call pattern.
       */
      const { promise } = createPendingInteraction(conversationId, {
        conversationId,
        kind: "confirm",
        host: message,
        timeoutMs: opts?.timeout ?? DEFAULT_CONFIRM_TIMEOUT_MS,
      });
      const result = await promise;
      /**
       * create()'s declared return type is Promise<InteractionResult> (the union of
       * ConfirmResult | RenderResult) regardless of the request's own `kind` --
       * pending-interactions.ts doesn't (and can't easily) narrow its return type by
       * the input's kind, so this narrows at the call site instead. Since this
       * promise was created with `kind: "confirm"` above, and pending-
       * interactions.ts's settle()/timeoutDefaultFor() always settle a given
       * interaction with a result of that same kind, the `else` branch is
       * unreachable in practice -- but it's handled explicitly (fail-closed: `false`)
       * rather than asserted away, since a `never`-cast here would silently paper
       * over a real bug if that invariant ever broke.
       */
      return result.kind === "confirm" ? result.approved : false;
    },
    input: async () => undefined,
    notify: () => {},
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    // Generic in ExtensionUIContext's own declaration (custom<T>(...): Promise<T>);
    // mirrored here with an explicit type parameter rather than a bare `async () =>
    // undefined` (which doesn't type-check against an unconstrained T) -- runtime
    // behavior is identical to the SDK's own noOpUIContext.custom.
    custom: async <T,>() => undefined as unknown as T,
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    editor: async () => undefined,
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    theme: {} as Theme,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "UI not available" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };
}

let workspaceStore: ChatWorkspaceStore | undefined;

export function getWorkspaceStore(): ChatWorkspaceStore {
  if (workspaceStore && !fs.existsSync(workspaceStore.databasePath)) {
    try {
      workspaceStore.close();
    } catch {
      // The containing directory may have been removed while SQLite was open.
    }
    workspaceStore = undefined;
  }
  workspaceStore ??= new ChatWorkspaceStore({ dataDir: env.dataDir });
  return workspaceStore;
}

export function listConversations(): ConversationMeta[] {
  return getWorkspaceStore().listConversations();
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

  return getWorkspaceStore().createConversation(meta);
}

export function getConversationMeta(id: string): ConversationMeta | undefined {
  return getWorkspaceStore().getConversation(id);
}

export function touchConversation(id: string, patch?: Partial<Pick<ConversationMeta, "title" | "modelId">>): void {
  getWorkspaceStore().updateConversation(id, { ...patch, updatedAt: new Date().toISOString() });
}

export function touchConversationAfterTurn(id: string, userText: string): void {
  const conversation = getConversationMeta(id);
  if (!conversation) return;
  const normalized = userText.replace(/\s+/g, " ").trim();
  const title = conversation.title === "New conversation" && normalized
    ? normalized.slice(0, 60)
    : undefined;
  touchConversation(id, title ? { title } : undefined);
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
  const now = new Date().toISOString();
  getWorkspaceStore().ensureConversation({
    id: "default",
    title: "New conversation",
    createdAt: now,
    updatedAt: now,
  });
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
   *
   * web-fetch's web_fetch tool (createWebFetchTools) is wired in the same way and
   * for the same reason (AC-7.1): it's conversationId-scoped (per-conversation
   * approved-hosts state, see web-fetch/tools.ts), so it can't live inside
   * getAgentDeps()'s singleton bundle either — putting it there would bake in
   * whichever conversationId happened to trigger the first getAgentDeps() call for
   * the lifetime of the process. It is also constructed with `sessionKind:
   * "interactive"` here, never "scheduled" — scheduler/index.ts's own session
   * construction (createScheduledSession) passes "scheduled" independently
   * (AC-7.2/US-05); getAgentDeps()'s memoized bundle stays completely unaware of
   * sessionKind, on purpose.
   */
  const { session } = await createAgentSession({
    cwd,
    agentDir: env.agentDir,
    model,
    authStorage,
    modelRegistry,
    customTools: [...customTools, ...createArtifactTools(id), ...createWebFetchTools(id, "interactive"), ...createPlanTools(id), ...createSearchTools(id), ...createGeneratedFileTools(id, cwd)],
    sessionManager: SessionManager.continueRecent(cwd),
  });

  /**
   * Task 5 (AC-5.1): install the real confirm() implementation immediately after
   * session creation, so every custom tool's execute() (specifically the
   * not-yet-built web_fetch tool) reaches the pending-interaction registry via
   * ctx.ui.confirm() instead of the SDK's default noOpUIContext, which always
   * resolves confirm() to `false` with no pause at all -- silently turning every
   * approval prompt into a permanent auto-deny rather than a real, awaited gate.
   *
   * AC-5.2 (mode: "rpc" verification, documented finding): grepped the installed
   * SDK's compiled dist/**\/*.js for `mode === "rpc"` (and `"rpc"` generally).
   * Every RPC-mode-specific branch found lives in dist/modes/rpc/rpc-mode.js,
   * dist/modes/rpc/rpc-client.js, dist/main.js, and dist/cli/args.js -- pi's own
   * CLI subprocess entry point (`pi --mode rpc`), an entirely separate code path
   * from the createAgentSession()-based programmatic embedding this app uses; this
   * app never calls main()/runRpcMode()/RpcClient. Within core/extensions/runner.js
   * itself, the `mode` argument passed to setUIContext() is only ever stored
   * (`this.mode = mode`) and later read in exactly one place -- exposed verbatim as
   * ExtensionContext.mode to extension event/command handlers (this app registers
   * no such extensions, only a bare ExtensionUIContext) -- and via
   * ExtensionRunner#hasUI(), which is computed from whether uiContext !==
   * noOpUIContext, not from the mode value. No branch anywhere in core/ checks
   * `mode === "rpc"` specifically. "rpc" is chosen over "tui"/"json"/"print" purely
   * because ExtensionContext's own doc comment calls out "true in TUI and RPC
   * modes" for hasUI -- the closest fit for this headless-but-really-has-a-UI-
   * elsewhere architecture (SPEC.md) -- not because anything actually branches on it.
   */
  session.extensionRunner.setUIContext(buildConfirmUIContext(id), "rpc");

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
