import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

/**
 * Shared "pause mid-tool-call and wait on something the frontend supplies
 * later over HTTP" primitive (Task 3, SPEC.md's "PendingInteraction registry"
 * subsection). Used by two later, separate tasks: the private-network
 * approval gate ("confirm") and the headless-webview render bridge
 * ("render"). Not persisted to disk — module-level in-memory state only,
 * matching this app's existing per-conversation in-memory state pattern (see
 * agent/conversations.ts's sessionPromises Map). A server restart loses any
 * in-flight pending interaction; that's acceptable because the tool call that
 * created it dies with the process too.
 */
export type PendingInteraction =
  | { id: string; conversationId: string; kind: "confirm"; host: string; createdAt: string; timeoutMs: number }
  | { id: string; conversationId: string; kind: "render"; url: string; createdAt: string; timeoutMs: number };

export type ConfirmResult = { kind: "confirm"; approved: boolean };
export type RenderResult = { kind: "render"; html: string | null };

type InteractionResult = ConfirmResult | RenderResult;

/**
 * Plain `Omit<PendingInteraction, "id" | "createdAt">` does not distribute
 * over PendingInteraction's discriminated union (TS's Omit is defined via
 * Pick<T, Exclude<keyof T, K>>, and Pick doesn't distribute over unions) — it
 * would collapse to only the keys common to both union members, silently
 * dropping "host" and "url" entirely and letting create() accept a request
 * with neither. This distributes explicitly so create()'s request type still
 * requires "host" for kind: "confirm" and "url" for kind: "render".
 */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/**
 * Internal-only entry. `resolver` is deliberately never returned from any
 * exported function (getPending() strips it down to the PendingInteraction's
 * own public shape) — exposing it would let arbitrary code resolve
 * interactions it shouldn't be able to, defeating the approval gate's safety
 * boundary.
 */
interface RegistryEntry {
  interaction: PendingInteraction;
  settled: boolean;
  resolver: (result: InteractionResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const registry = new Map<string, RegistryEntry>();

/**
 * Creation-notification hook (Task 4, ADR-002-tool-approval-trust-boundary.md
 * Decision point 4 -- "Visualization-only bridge"). `ai-sdk/adapter.ts`
 * subscribes to this so it can hand-construct and write a
 * `tool-approval-request` UI stream chunk purely for frontend visualization;
 * the approval's actual resolution still happens entirely outside this
 * mechanism (the authenticated resolve endpoint, Task 11). A plain
 * per-process EventEmitter is enough -- this hook is deliberately minimal
 * (ADR-002 Decision point 4), not a general pub/sub system.
 *
 * IMPORTANT: this hook only fires for `kind: "confirm"` interactions (see
 * the emit call inside create() below). `kind: "render"` interactions (the
 * headless-webview bridge) do NOT notify today -- per ADR-002's Consequences,
 * a future feature wanting the render bridge to also surface over the AI SDK
 * stream needs to extend this hook, not assume it already does.
 */
const creationEmitter = new EventEmitter();
const INTERACTION_CREATED_EVENT = "interaction-created";

/**
 * Subscribes `listener` to every future `kind: "confirm"` interaction
 * creation, firing synchronously (inside create(), right after
 * registry.set(...)) with the created interaction's public shape ("id",
 * "conversationId", "host" -- never the internal resolver/timer, matching
 * getPending()'s own "never expose the resolver" convention above). Returns
 * an unsubscribe function, mirroring this file's own create()'s
 * id-plus-promise return convention and agui/adapter.ts's
 * session.subscribe()'s own unsubscribe-function convention.
 */
export function onInteractionCreated(listener: (interaction: PendingInteraction) => void): () => void {
  creationEmitter.on(INTERACTION_CREATED_EVENT, listener);
  return () => {
    creationEmitter.off(INTERACTION_CREATED_EVENT, listener);
  };
}

/**
 * AC-3.2's contract: the timeout default must be the SAFE (fail-closed)
 * direction — confirm defaults to NOT approved, render defaults to no HTML
 * (the caller falls back to the honest plain-fetch content rather than
 * fabricating a render). Getting this backwards would silently disable the
 * safety boundary the whole web-fetch approval feature exists for.
 */
function timeoutDefaultFor(interaction: PendingInteraction): InteractionResult {
  return interaction.kind === "confirm" ? { kind: "confirm", approved: false } : { kind: "render", html: null };
}

/**
 * Settles entry `id` with `result` exactly once. Used by both resolve() and
 * the timeout firing — whichever runs first wins; the loser is a no-op that
 * returns false rather than throwing or double-resolving the promise
 * (AC-3.3). Always clears the timer and removes the entry from the registry
 * so a later call (explicit resolve() after a timeout, or vice versa) finds
 * nothing and returns false too (AC-3.3, AC-3.4).
 */
function settle(id: string, result: InteractionResult): boolean {
  const entry = registry.get(id);
  if (!entry || entry.settled) return false;

  entry.settled = true;
  clearTimeout(entry.timer);
  registry.delete(id);
  entry.resolver(result);
  return true;
}

/**
 * Creates a new pending interaction for `conversationId` and returns its id
 * plus a promise that settles either via a later resolve(id, ...) call or via
 * `req.timeoutMs` elapsing first (AC-3.1, AC-3.2) — whichever happens first
 * wins (settle() above enforces the one-shot contract).
 */
export function create(
  conversationId: string,
  req: DistributiveOmit<PendingInteraction, "id" | "createdAt">,
): { id: string; promise: Promise<InteractionResult> } {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const interaction = { ...req, conversationId, id, createdAt } as PendingInteraction;

  let resolver!: (result: InteractionResult) => void;
  const promise = new Promise<InteractionResult>((res) => {
    resolver = res;
  });

  const timer = setTimeout(() => {
    settle(id, timeoutDefaultFor(interaction));
  }, req.timeoutMs);

  registry.set(id, { interaction, settled: false, resolver, timer });

  // Only "confirm" interactions notify -- see the doc comment on
  // creationEmitter/onInteractionCreated above.
  if (interaction.kind === "confirm") {
    creationEmitter.emit(INTERACTION_CREATED_EVENT, interaction);
  }

  return { id, promise };
}

/**
 * Resolves interaction `id` with `result`, settling create()'s promise.
 * Returns false — never throws — if `id` is unknown (AC-3.4), already
 * resolved, or already timed out (AC-3.3).
 */
export function resolve(id: string, result: InteractionResult): boolean {
  return settle(id, result);
}

/**
 * Returns the still-pending interaction for `conversationId`, in its public
 * shape only (id, conversationId, kind, host-or-url, createdAt, timeoutMs) —
 * never the internal resolver. Returns undefined if there is none, or if it
 * has already settled (resolved or timed out).
 */
export function getPending(conversationId: string): PendingInteraction | undefined {
  for (const entry of registry.values()) {
    if (!entry.settled && entry.interaction.conversationId === conversationId) {
      return entry.interaction;
    }
  }
  return undefined;
}
