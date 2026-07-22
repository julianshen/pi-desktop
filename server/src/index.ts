import express, { type Express } from "express";
import cors from "cors";
import readline from "node:readline";
import { timingSafeEqual } from "node:crypto";
import { pipeUIMessageStreamToResponse, type UIMessage } from "ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { env } from "./config/env.js";
import { handleAiSdkRun, type AgentSessionEventSource } from "./ai-sdk/adapter.js";
import { getSchedulerService, startScheduler } from "./scheduler/index.js";
import { createScheduledTasksRouter } from "./scheduler/routes.js";
import type { SchedulerService } from "./scheduler/service.js";
import { settingsRouter } from "./settings/routes.js";
import {
  getConversationMeta,
  touchConversation,
  touchConversationAfterTurn,
  setLiveSessionModel,
  getConversationMessages,
  getLastTurnError,
  conversationCwd,
  getOrCreateSession,
  getWorkspaceStore,
} from "./agent/conversations.js";
import { ConversationWorkspace } from "./chat-workspace/conversations.js";
import { createChatWorkspaceRouter } from "./chat-workspace/routes.js";
import { AttachmentWorkspace } from "./chat-workspace/attachments.js";
import { BranchWorkspace, type BranchMessage, type BranchSession } from "./chat-workspace/branches.js";
import { journalRunStream, RunManager } from "./chat-workspace/runs.js";
import { setActivePlanRun } from "./agent/plan-tools.js";
import { listAvailableModels, resolveModelById } from "./agent/models.js";
import { getLatestArtifact, getArtifactById } from "./artifacts/store.js";
import {
  getPending as getPendingInteraction,
  resolve as resolvePendingInteraction,
  type ConfirmResult,
  type RenderResult,
} from "./web-fetch/pending-interactions.js";

/**
 * Task 6: both models.ts functions already accept an optional ModelRegistry
 * override (built for exactly this — see models.ts's own comment), so createApp()
 * forwards one through rather than always falling back to the real
 * getAgentDeps()-sourced registry. Lets index.test.ts exercise GET /api/models and
 * PATCH /api/conversations/:id/model against a stubbed registry with configured
 * models, mirroring agent/models.test.ts's makeRegistryStub pattern, instead of a
 * real provider-less registry that would always resolve empty/undefined.
 *
 * ADR-001 (resolve-endpoint trust-boundary remediation): resolveToken follows the
 * exact same "injectable option" pattern for the same reason — it's the server's
 * own resolve token, established once at startup by main() via readResolveToken()
 * below (env var or stdin, see that function's doc comment) and threaded through
 * here rather than read as a bare module-level side effect, so createApp() stays
 * synchronous and index.test.ts can inject any value (including null/undefined for
 * the "no token configured" fail-closed case) without touching real stdin/env
 * state. null/undefined/empty means "no token was ever established" — the resolve
 * route below fails closed (401 unconditionally) in that case, per ADR-001 step 1.3.
 */
export interface CreateAppOptions {
  modelRegistry?: ModelRegistry;
  resolveToken?: string | null;
  schedulerService?: SchedulerService;
}

const STDIN_RESOLVE_TOKEN_TIMEOUT_MS = 3000;

export interface ReadResolveTokenDeps {
  env?: NodeJS.ProcessEnv;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  timeoutMs?: number;
}

/**
 * ADR-001 step 1: resolves this server's own resolve-approval token, with the
 * precedence explicitly signed off on during this remediation:
 *
 * 1. `PI_DESKTOP_RESOLVE_TOKEN` env var, if set (non-empty) -- the dev-mode path
 *    (R6 wires this into `npm run dev`'s `concurrently` orchestration, see
 *    ADR-001's Addendum) and a legitimate manual override for anyone running the
 *    server standalone (`npm run server:dev`, `bun src/index.ts`).
 * 2. Otherwise, one line read from the process's own stdin -- the packaged-build
 *    handoff channel `src-tauri/src/lib.rs` writes to immediately after spawning
 *    the sidecar (ADR-001's stdin-handoff design). Bounded by a timeout so this
 *    NEVER hangs server startup:
 *    - `stdin.isTTY` true (a real terminal) skips the read entirely -- verified
 *      against real Bun behavior with a scratch script (`process.stdin.isTTY` is
 *      `true`/boolean under a real TTY via `script -q /dev/null`, and `undefined`
 *      when piped/redirected, e.g. `echo x | bun run ...` -- same as Node, not
 *      assumed from docs, per this repo's CLAUDE.md verification convention).
 *      There is no line coming from a human terminal; waiting for one would hang
 *      every standalone/manual dev workflow.
 *    - Otherwise (piped, e.g. Rust's `CommandChild` stdin pipe) reads with a
 *      bounded timeout (a few seconds -- the packaged Rust side writes the token
 *      synchronously right after `spawn()`, so the line arrives near-instantly).
 *      No line before the timeout, or the stream ending with nothing on it, both
 *      resolve to null, same as case 3.
 * 3. Neither yields a token -> resolves to null. Callers (main()) must NOT treat
 *    that as fatal -- the server still starts, per ADR-001's explicit fail-closed
 *    decision enforced downstream on the resolve route itself, not here.
 *
 * `deps` exists purely for unit testing this function's pure logic without
 * touching the real process.stdin/process.env (index.test.ts's HTTP-level tests
 * exercise the resolve route's auth behavior directly via createApp({
 * resolveToken }) instead; this function's own stdin-reading mechanics aren't
 * re-tested there).
 */
export async function readResolveToken(deps: ReadResolveTokenDeps = {}): Promise<string | null> {
  const env = deps.env ?? process.env;
  const envToken = env.PI_DESKTOP_RESOLVE_TOKEN;
  if (envToken) return envToken;

  const stdin = deps.stdin ?? process.stdin;
  if (stdin.isTTY) return null;

  const timeoutMs = deps.timeoutMs ?? STDIN_RESOLVE_TOKEN_TIMEOUT_MS;

  return new Promise<string | null>((resolvePromise) => {
    let settled = false;
    const rl = readline.createInterface({ input: stdin as NodeJS.ReadableStream, terminal: false });

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.removeAllListeners();
      rl.close();
      resolvePromise(value);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    rl.once("line", (line: string) => {
      const trimmed = line.trim();
      finish(trimmed.length > 0 ? trimmed : null);
    });

    rl.once("close", () => finish(null));
  });
}

/**
 * Constant-time token comparison for the resolve route's auth check below --
 * ADR-001 doesn't mandate this specifically, but a plain `===` on a secret
 * comparison is a well-known timing side channel, and this is a near-zero-cost
 * hardening on top of the ADR's design. Length-mismatch is checked first (and
 * short-circuits to false) because `timingSafeEqual` throws, rather than
 * returning false, when given buffers of different lengths.
 */
function tokensMatch(expected: string, actual: string): boolean {
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(actual);
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * Task 5: the AI SDK's `UIMessage` shape (verified against the installed
 * `ai@6.0.224` package's own types, `node_modules/ai/dist/index.d.ts:1580`)
 * represents a message's content as `parts: Array<UIMessagePart<...>>`, NOT a
 * plain string like the now-removed AG-UI `RunAgentInput` messages' `.content`
 * field (the legacy `agui/adapter.ts`'s `extractLatestUserText` read that
 * directly; deleted post-/tgd-review once this route fully replaced it) -- a
 * text part is `{ type: 'text', text: string }` (index.d.ts:1609). Walks
 * backward from the end of `messages`, returns the first `role: "user"`
 * message's text, joining that message's text parts (a message could in
 * principle carry more than one, e.g. text interleaved with file parts) with a
 * blank line. Returns "" for no user message or a user message with no text
 * parts at all (e.g. attachment-only) -- never throws on a plausible-but-empty
 * input.
 */
function extractLatestUserTextFromUIMessages(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "user") continue;
    return message.parts
      .filter((part): part is Extract<UIMessage["parts"][number], { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n\n");
  }
  return "";
}

function withTextAttachments(
  userText: string,
  references: Array<{ name: string; text: string }>,
): string {
  if (references.length === 0) return userText;
  const blocks = references.map(({ name, text }) => {
    const safeName = name.replace(/[<>"'&]/g, "_");
    return `\n\n--- Attached local file: ${safeName} ---\n${text}\n--- End attached file: ${safeName} ---`;
  });
  return `${userText}${blocks.join("")}`;
}

function branchMessageToHistory(message: BranchMessage) {
  if (message.role === "user") {
    const content = typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content.filter((part): part is { type: "text"; text: string } => !!part && typeof part === "object" && (part as { type?: unknown }).type === "text").map((part) => part.text).join("")
        : "";
    return { id: message.id, role: "user" as const, content };
  }
  if (message.role === "assistant") {
    const content = Array.isArray(message.content)
      ? message.content.filter((part): part is { type: "text"; text: string } => !!part && typeof part === "object" && (part as { type?: unknown }).type === "text").map((part) => part.text).join("")
      : typeof message.content === "string" ? message.content : "";
    return { id: message.id, role: "assistant" as const, content };
  }
  return { id: message.id, role: "tool" as const, content: JSON.stringify(message.content) };
}

/**
 * Builds the Express app without binding a port, so tests (index.test.ts) can
 * app.listen(0) it on an ephemeral port and hit it with real HTTP requests, instead
 * of duplicating route logic or mocking Express. main() below is the only caller
 * that actually binds env.port.
 */
export function createApp(options?: CreateAppOptions): Express {
  const app = express();
  // Security-review finding (Critical, /tgd-review security-auditor): restrict CORS to
  // this app's own frontend origins (see config/env.ts's DEFAULT_CORS_ORIGINS for the
  // full rationale) instead of the `cors` package's wildcard default. Scoped mitigation
  // only — no request auth is added here, that's a separate tracked initiative.
  app.use(cors({ origin: env.corsOrigins }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  if (options?.schedulerService) {
    app.use(createScheduledTasksRouter(options.schedulerService));
  }

  // Agent Chat Experience Tasks 1–2: transactional conversation workspace and
  // organization/lifecycle routes. Mount under /api so the router's resource
  // paths stay reusable in isolated HTTP contract tests.
  const workspaceStore = getWorkspaceStore();
  const attachmentWorkspace = new AttachmentWorkspace(workspaceStore, env.dataDir);
  const branchWorkspace = new BranchWorkspace(workspaceStore);
  const runManager = new RunManager(workspaceStore);
  const branchSession = async (conversationId: string): Promise<BranchSession> => {
    const session = await getOrCreateSession(conversationId);
    const manager = session.sessionManager;
    return {
      getLeafId: () => manager.getLeafId(),
      getEntry: (id) => manager.getEntry(id),
      getBranch: (id) => manager.getBranch(id),
      branch: (id) => manager.branch(id),
      resetLeaf: () => manager.resetLeaf(),
      navigateTree: (id) => session.navigateTree(id),
      appendMessage: (message) => manager.appendMessage(message),
    };
  };
  app.use("/api", createChatWorkspaceRouter(
    new ConversationWorkspace(workspaceStore, env.dataDir),
    {
      attachments: attachmentWorkspace,
      branches: branchWorkspace,
      branchSession,
      runs: runManager,
      hasActiveRun: (id) => runManager.hasActiveConversationRun(id),
    },
  ));

  // Task 6 (AC-6.1): list available models. listAvailableModels() forwards to
  // getAgentDeps()'s real modelRegistry when options.modelRegistry is unset (the
  // production default); index.test.ts injects a stub via options for a
  // deterministic, non-empty response.
  app.get("/api/models", (_req, res) => {
    listAvailableModels(options?.modelRegistry)
      .then((models) => res.json(models))
      .catch((error: unknown) => {
        console.error("[api/models] unhandled error", error);
        if (!res.headersSent) res.status(500).end();
      });
  });

  // Task 6 (AC-6.2/AC-6.3): switch a conversation's model. 404 for an unknown
  // conversation id (checked first, same pattern as GET /api/conversations/:id
  // above). 400 for a modelId that resolveModelById can't resolve — per Task 5's
  // AC-5.3 contract resolveModelById returns undefined rather than throwing, so this
  // is a plain undefined check; per SPEC.md, touchConversation is deliberately not
  // called in that case, leaving the conversation's modelId unchanged.
  //
  // Critical fix (/tgd-review, found independently by code-reviewer and
  // test-engineer): this used to stop at touchConversation() -- it never told the
  // already-cached AgentSession (agent/conversations.ts's sessionPromises) about
  // the switch, so a conversation that had already sent a message kept using its
  // OLD model forever. setLiveSessionModel(id, resolved) now applies the switch to
  // the live session (a no-op if none exists yet, per its own doc comment) *before*
  // touchConversation() runs, so a rejection (e.g. no auth configured for the
  // target model) falls through to the outer .catch() below and leaves stored
  // metadata untouched -- the visible "current model" never gets ahead of what the
  // live session will actually use next.
  app.patch("/api/conversations/:id/model", express.json(), (req, res) => {
    const meta = getConversationMeta(req.params.id);
    if (!meta) {
      res.status(404).end();
      return;
    }

    const body = req.body as { modelId?: unknown } | undefined;
    const modelId = typeof body?.modelId === "string" ? body.modelId : undefined;

    (modelId ? resolveModelById(modelId, options?.modelRegistry) : Promise.resolve(undefined))
      .then(async (resolved) => {
        if (!resolved) {
          res.status(400).end();
          return;
        }
        await setLiveSessionModel(req.params.id, resolved);
        touchConversation(req.params.id, { modelId });
        res.json(getConversationMeta(req.params.id));
      })
      .catch((error: unknown) => {
        console.error("[api/conversations/:id/model] unhandled error", error);
        if (!res.headersSent) res.status(500).end();
      });
  });

  // Critical fix (/tgd-review code-reviewer finding — US-03 P0 / TASKS.md's
  // AC-12.2): "switching to a previously-open conversation shows an empty
  // transcript, not its real prior messages" — root-caused in ChatView.tsx's
  // "Known remaining gap" comment (now updated) to two things: the installed
  // `@ag-ui/client` HttpAgent has no real connect()/replay implementation, and
  // (until now) this server exposed no way for the frontend to fetch a
  // conversation's history and seed the client-side agent state itself.
  // SPEC.md anticipated this exact contingency and named this route/shape.
  //
  // getConversationMessages() (agent/conversations.ts) does the mapping from
  // pi's internal AgentMessage[] to the @ag-ui/core Message[] wire shape
  // ChatView.tsx feeds straight into `agent.setMessages()`. Same malformed-id
  // handling convention as GET /api/conversations/:id/artifacts/latest below:
  // conversations.ts's assertSafeConversationId guard normalizes to a plain 400
  // (a client error, no stack trace leaked), everything else is an unexpected
  // 500 logged via console.error first.
  app.get("/api/conversations/:id/messages", (req, res) => {
    if (typeof req.query.branchId === "string") {
      branchSession(req.params.id)
        .then((session) => branchWorkspace.messages(req.params.id, req.query.branchId as string, session))
        .then((messages) => res.json(messages.map(branchMessageToHistory)))
        .catch((error: unknown) => {
          res.status(error instanceof Error && error.message === "Branch not found" ? 404 : 400).json({
            error: { code: "NOT_FOUND", message: error instanceof Error ? error.message : "Branch lookup failed", retryable: false },
          });
        });
      return;
    }
    getConversationMessages(req.params.id)
      .then((messages) => res.json(messages))
      .catch((error: unknown) => {
        if (error instanceof Error && error.message.startsWith("Invalid conversation id")) {
          res.status(400).end();
          return;
        }
        console.error("[api/conversations/:id/messages] unhandled error", error);
        if (!res.headersSent) res.status(500).end();
      });
  });

  // Bug fix (live-usage report: a failed turn — real OpenRouter 402
  // "insufficient credits" — was completely invisible in the UI, even after
  // adapter.ts was fixed to emit a real RUN_ERROR over the AG-UI stream). The
  // installed CopilotKit version's `<CopilotKit onError>` prop silently no-ops
  // without a `publicApiKey` (confirmed by reading the installed package's own
  // source — this app is deliberately self-hosted with no license key), so
  // there is no client-side way to observe an agent run error at all. This
  // endpoint gives the frontend an independent, backend-owned check: "did the
  // most recent turn fail, and why" — ChatView.tsx polls it on the same
  // isLoading true->false edge it already tracks for onTurnComplete.
  app.get("/api/conversations/:id/last-error", (req, res) => {
    getLastTurnError(req.params.id)
      .then((message) => res.json({ message }))
      .catch((error: unknown) => {
        if (error instanceof Error && error.message.startsWith("Invalid conversation id")) {
          res.status(400).end();
          return;
        }
        console.error("[api/conversations/:id/last-error] unhandled error", error);
        if (!res.headersSent) res.status(500).end();
      });
  });

  // Task 8 (AC-8.1/AC-8.2): latest published artifact for a conversation.
  // getLatestArtifact() returns undefined when none has been published yet — per
  // spec that's an expected state, not an error, so it's normalized to 200 null
  // rather than 404.
  //
  // Task 8 review fix: getLatestArtifact() -> artifactsPath() -> conversationCwd()
  // throws *synchronously* for a malformed id (path-traversal guard, see
  // agent/conversations.ts's assertSafeConversationId) — unlike the async routes
  // above, there's no promise here for a bare .catch() to hang off, so the throw
  // must be caught explicitly or it reaches Express's default error handler and
  // leaks a stack trace (with absolute local paths) in a 500 response. A malformed
  // id is a client error, so this normalizes to a plain 400, matching this file's
  // other "no JSON body" error responses; genuinely unexpected errors are still
  // logged via console.error first, same convention as the .catch() blocks above,
  // so they stay debuggable rather than being silently swallowed.
  app.get("/api/conversations/:id/artifacts/latest", (req, res) => {
    try {
      res.json(getLatestArtifact(req.params.id) ?? null);
    } catch (error: unknown) {
      console.error("[api/conversations/:id/artifacts/latest] unhandled error", error);
      if (!res.headersSent) res.status(400).end();
    }
  });

  // Artifacts-as-chat-attachments feature: fetch one specific artifact by id, not
  // just whatever is currently "latest" — backs the Canvas opening to the exact
  // artifact a clicked chat attachment published, even if a newer one has since
  // been published in the same conversation. Registered *after* the /latest route
  // above (Express matches path patterns in registration order, and "latest" would
  // otherwise also match this route's :artifactId param) so a request to
  // .../artifacts/latest keeps hitting that route first. Same 200-null-for-"not
  // found" and 400-for-malformed-id conventions as /latest — an unknown artifact id
  // is an expected "nothing to show" state here too (e.g. a stale chat attachment
  // referencing an id that's since been pruned), not a client error.
  app.get("/api/conversations/:id/artifacts/:artifactId", (req, res) => {
    try {
      res.json(getArtifactById(req.params.id, req.params.artifactId) ?? null);
    } catch (error: unknown) {
      console.error("[api/conversations/:id/artifacts/:artifactId] unhandled error", error);
      if (!res.headersSent) res.status(400).end();
    }
  });

  // Task 4 (AC-4.4): the pending-interaction poll endpoint (SPEC.md's "Getting the
  // pending interaction to the frontend — RESOLVED: poll" section — push was ruled
  // out because the browser never talks to /agui directly, see that section for the
  // full trace). getPendingInteraction() already returns undefined for "nothing
  // pending" or "settled" — normalized to 200 { interaction: null }, not 404, same
  // "expected state, not an error" convention as GET .../artifacts/latest above.
  //
  // conversationCwd(id) is called here purely for its assertSafeConversationId
  // side-effect-free validation (it does no I/O by itself) — same path-traversal
  // guard every other per-conversation route in this file relies on, reused rather
  // than duplicated. Same broad try/catch -> 400 convention as .../artifacts/latest
  // (AC-4.3 / this repo's "Task 8 fix"): a malformed id throws synchronously, so a
  // bare .catch() on a promise chain wouldn't catch it, and letting it fall through
  // to Express's default error handler would leak a stack trace with absolute local
  // paths in the response body.
  app.get("/api/conversations/:id/pending-interaction", (req, res) => {
    try {
      conversationCwd(req.params.id);
      res.json({ interaction: getPendingInteraction(req.params.id) ?? null });
    } catch (error: unknown) {
      console.error("[api/conversations/:id/pending-interaction] unhandled error", error);
      if (!res.headersSent) res.status(400).end();
    }
  });

  // Task 4 (AC-4.1/AC-4.2/AC-4.3): resolves a pending interaction the frontend has
  // just answered (an approve/deny click, Task 8; or a headless-render result, Task
  // 10). This route only has :interactionId and a body — it deliberately does NOT
  // know whether the interaction is confirm- or render-kind (that's pending-
  // interactions.ts's own private state, never exposed), so the body shape itself
  // is what disambiguates: `{ approved: boolean }` for confirm-kind, `{ html:
  // string | null }` for render-kind. A body matching neither shape unambiguously
  // (missing both fields, or carrying both) is a 400, checked *before* calling
  // resolve() — never guessed at.
  //
  // resolve() returns false for an unknown, already-resolved, or already-timed-out
  // id (pending-interactions.ts's own contract) — that must surface as 404, not a
  // false-looking 200, per AC-4.2: the caller needs to know its approval/render
  // answer never actually reached anything.
  //
  // ADR-001 / REVIEW.md High finding ("self-approval bypass"): this route used to
  // have no auth beyond CORS, so any local HTTP client (including a
  // prompt-injected agent's own `bash` tool) could approve its own pending
  // web_fetch private-network request. Now requires an `X-Resolve-Token` header
  // exactly matching this server's own resolve token (options.resolveToken, set
  // by main() via readResolveToken() -- see ADR-001 for the full stdin/env
  // handoff design and why bash can't observe either channel). This check runs
  // FIRST, before the malformed-id / body-shape / ownership checks below, so an
  // unauthenticated caller learns nothing about whether any of that would have
  // succeeded. Per ADR-001 step 1.3: if the server itself has no token configured
  // (options.resolveToken is null/undefined/empty), every request is rejected
  // unconditionally -- fail-closed by explicit, deliberate design, not a bug.
  //
  // assistant-ui-migration Task 11 / ADR-002-tool-approval-trust-boundary.md
  // Decision point 2: this is also the resolve endpoint for the AI SDK migration's
  // `tool-approval-request` UI chunk (server/src/ai-sdk/adapter.ts, Task 4) -- the
  // route's `:interactionId` and the AI SDK's `approvalId` are the SAME value
  // (the adapter sets `approvalId: interaction.id` when it writes that chunk), so
  // no route rename was made here. Renaming to a `/tool-approvals/:approvalId/`
  // path was considered (ADR-002 calls it "cosmetic, no bearing on the trust
  // boundary") and deliberately rejected: it would only churn a path the
  // frontend already needs to call correctly under a security-sensitive contract,
  // for a naming difference that doesn't reflect a real behavioral distinction.
  app.post("/api/conversations/:id/pending-interaction/:interactionId/resolve", express.json(), (req, res) => {
    const serverToken = options?.resolveToken;
    const requestToken = req.header("X-Resolve-Token");
    if (!serverToken || !requestToken || !tokensMatch(serverToken, requestToken)) {
      res.status(401).end();
      return;
    }

    try {
      conversationCwd(req.params.id);
    } catch (error: unknown) {
      console.error("[api/conversations/:id/pending-interaction/:interactionId/resolve] unhandled error", error);
      res.status(400).end();
      return;
    }

    const body = req.body as { approved?: unknown; html?: unknown } | undefined;
    const hasApproved = typeof body?.approved === "boolean";
    const hasHtml = !!body && "html" in body && (body.html === null || typeof body.html === "string");

    let result: ConfirmResult | RenderResult | undefined;
    if (hasApproved && !hasHtml) {
      result = { kind: "confirm", approved: body!.approved as boolean };
    } else if (hasHtml && !hasApproved) {
      result = { kind: "render", html: body!.html as string | null };
    }

    if (!result) {
      res.status(400).end();
      return;
    }

    // Low finding (REVIEW.md): bind interactionId to conversationId before
    // resolving. Previously resolvePendingInteraction() was called with only
    // interactionId, never checking it actually belongs to the conversation named
    // in the URL (req.params.id) -- so knowing/guessing/enumerating another
    // conversation's pending interaction id let it be resolved via a different
    // conversation's URL. getPending(conversationId) (pending-interactions.ts)
    // already returns the currently-pending interaction *for that conversation
    // specifically* -- reused here rather than adding a new helper there.
    // Mismatch (including "no pending interaction at all for this conversation")
    // is a 404, matching this route's existing 404-for-unknown-id convention.
    const pending = getPendingInteraction(req.params.id);
    if (!pending || pending.id !== req.params.interactionId) {
      res.status(404).end();
      return;
    }

    if (!resolvePendingInteraction(req.params.interactionId, result)) {
      res.status(404).end();
      return;
    }

    res.json({ resolved: true });
  });

  // Task 5 (AC-5.1/AC-5.2): the Vercel AI SDK / Assistant UI chat route. Originally
  // added alongside the legacy CopilotKit/AG-UI `/agui` route (TASKS.md's Task 5
  // sequencing note), which stayed until Task 8's frontend rebuild proved this route
  // out end-to-end. Task 8 landed (commit 9ec4976) and `/agui`, `agui/adapter.ts`, and
  // `copilot/runtime.ts` have since been deleted (/tgd-review code-reviewer finding,
  // remediated post-review) -- this is now the only chat route. Per-conversation-
  // scoped via the URL path param (SPEC.md's API Contract explicitly rules out a
  // single global /api/chat endpoint, matching every other per-conversation route in
  // this file) -- Assistant UI's transport (`AssistantChatTransport`) is configured
  // with a per-conversation `api` URL, so this shape composes directly with the
  // frontend wiring without a conversationId body field to trust/validate separately.
  //
  // Body shape: `{ messages: UIMessage[] }`, the AI SDK's own standard chat request
  // body (verified against the installed `ai@6.0.224` package's own `UIMessage`
  // export, node_modules/ai/dist/index.d.ts:1580 -- content is `parts: Array<...>`,
  // not a plain string; see extractLatestUserTextFromUIMessages() above for the
  // exact extraction).
  //
  // getOrCreateSession(id) rejects (not throws synchronously) for a malformed id --
  // createSession() is an `async function`, so conversationCwd()'s synchronous throw
  // (assertSafeConversationId, agent/conversations.ts) is captured into the returned
  // promise's rejection rather than escaping synchronously. That's why this route
  // uses the same async .catch() convention as GET /api/conversations/:id/messages
  // and GET /api/conversations/:id/last-error above (both of which reject via the
  // exact same code path), not the synchronous try/catch convention used by the
  // .../artifacts/latest routes (whose getLatestArtifact()/getArtifactById() call
  // conversationCwd() directly, outside any Promise chain, so IT throws
  // synchronously instead). Same "Invalid conversation id" message-prefix check,
  // same 400-no-stack-trace-leaked / 500-logged-first split.
  app.post("/api/conversations/:id/chat", express.json({ limit: "10mb" }), (req, res) => {
    getOrCreateSession(req.params.id)
      .then(async (session) => {
        const body = req.body as { messages?: UIMessage[]; attachmentIds?: unknown } | undefined;
        const messages = Array.isArray(body?.messages) ? body.messages : [];
        const attachmentIds = body?.attachmentIds === undefined ? [] : body.attachmentIds;
        if (!Array.isArray(attachmentIds) || attachmentIds.some((id) => typeof id !== "string")) {
          res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "attachmentIds must be an array of strings", retryable: false } });
          return;
        }
        const conversation = workspaceStore.getConversation(req.params.id);
        const activeBranchId = conversation?.activeBranchId;
        const materialized = await attachmentWorkspace.materialize(req.params.id, attachmentIds as string[], activeBranchId);
        if (activeBranchId) {
          await branchWorkspace.materializePendingReplacement(req.params.id, activeBranchId, session.sessionManager);
        }
        const messageText = extractLatestUserTextFromUIMessages(messages);
        const userText = withTextAttachments(messageText, materialized.textReferences);
        // ai-sdk/adapter.ts's own doc comment claims a real AgentSession "structurally
        // satisfies AgentSessionEventSource ... with no adapter shape changes" needed
        // to wire it in here -- true at the RUNTIME level (the adapter's switch only
        // ever reads the handful of fields PiSessionEvent models, and pi's real
        // AgentSessionEvent variants carry those same fields, just with additional
        // ones the adapter never touches), but NOT true under `tsc --noEmit`'s strict
        // structural check: pi's real `AgentSessionEvent` union has extra variants
        // (`agent_start`, `queue_update`, etc., see
        // node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts)
        // with no PiSessionEvent counterpart, and its `message`-carrying variants use
        // pi's own richer `AgentMessage` type rather than this adapter's intentionally
        // loose duck-typed `AssistantMessage` -- so neither the covariant nor the
        // contravariant half of TS's listener-parameter check succeeds outright. Route
        // wiring (this file, Task 5's actual scope) is the right place for this cast,
        // not adapter.ts (out of scope here, and its own module doc already documents
        // the intended duck-typed contract in detail).
        const rawStream = handleAiSdkRun(
          session as unknown as AgentSessionEventSource,
          userText,
          req.params.id,
          materialized.images.length > 0 ? { images: materialized.images } : undefined,
        );
        const run = runManager.start({
          conversationId: req.params.id,
          branchId: activeBranchId,
          model: conversation?.modelId,
          abort: () => session.abort(),
          steer: (instruction) => session.prompt(instruction, { streamingBehavior: "steer" }),
        });
        setActivePlanRun(req.params.id, { manager: runManager, runId: run.id });
        res.setHeader("X-Pi-Run-Id", run.id);
        const stream = journalRunStream(runManager, run.id, rawStream, () => {
          setActivePlanRun(req.params.id, undefined);
          if (activeBranchId) branchWorkspace.commitLeaf(req.params.id, activeBranchId, session.sessionManager.getLeafId() ?? undefined);
          if (runManager.get(run.id)?.status === "completed") {
            touchConversationAfterTurn(req.params.id, messageText);
          }
        });
        pipeUIMessageStreamToResponse({ response: res, stream });
      })
      .catch((error: unknown) => {
        if (error instanceof Error && "code" in error) {
          const code = (error as { code?: string }).code;
          if (code === "NOT_FOUND" || code === "ATTACHMENT_NOT_READY" || code === "TOO_MANY_ATTACHMENTS") {
            res.status(code === "NOT_FOUND" ? 404 : 400).json({
              error: { code: code === "NOT_FOUND" ? "NOT_FOUND" : "VALIDATION_ERROR", message: error.message, retryable: false },
            });
            return;
          }
        }
        if (error instanceof Error && error.message.startsWith("Invalid conversation id")) {
          res.status(400).end();
          return;
        }
        console.error("[api/conversations/:id/chat] unhandled error", error);
        if (!res.headersSent) res.status(500).end();
      });
  });

  // Settings routes (provider status, connect/disconnect, model selection). Mounted as its
  // own app.use() call, after /health and the AI SDK chat route above.
  app.use("/api/settings", express.json(), settingsRouter);

  return app;
}

async function main(): Promise<void> {
  // ADR-001: the only place that actually performs the env-or-stdin resolve-token
  // read (an async operation) -- createApp() itself stays synchronous and
  // side-effect-free so index.test.ts can call it directly without ever blocking
  // on stdin. See readResolveToken()'s own doc comment for the full precedence.
  const resolveToken = await readResolveToken();
  if (!resolveToken) {
    console.warn(
      "[pi-desktop] no resolve-token was established via PI_DESKTOP_RESOLVE_TOKEN or " +
        "stdin -- the web-fetch private-network approval gate will reject every resolve " +
        "request until one of those is provided (ADR-001, fail-closed by design).",
    );
  }

  await startScheduler();
  const schedulerService = await getSchedulerService();
  const app = createApp({ resolveToken, schedulerService });
  const baseUrl = `http://${env.host}:${env.port}`;

  app.listen(env.port, env.host, () => {
    console.log(`[pi-desktop] server listening on ${baseUrl}`);
  });

}

// Bun-native entrypoint guard (equivalent of Node's require.main === module): only run
// main()'s side effects (binding env.port, starting the scheduler) when this file is
// executed directly, not when index.test.ts imports createApp() for in-process testing.
if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error("[pi-desktop] fatal error during startup", error);
    process.exit(1);
  });
}
