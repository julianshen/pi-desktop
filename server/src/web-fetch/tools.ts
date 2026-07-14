/**
 * The `web_fetch` custom tool (Task 6, SPEC.md's "`web_fetch` tool"
 * subsection): plain-HTTP fetch -> markdown for most pages, gated by a
 * private-network approval flow, with an honest fallback when a page looks
 * like an empty SPA shell. Mirrors artifacts/tools.ts's
 * `createArtifactTools(conversationId)` factory shape, plus a
 * `sessionKind: "interactive" | "scheduled"` parameter (needed for US-05's
 * hard-block behavior — a scheduled/background run must never pause on an
 * approval nobody will give).
 */
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { plainFetch, toReadableContent, looksLikeEmptySpaShell, type FetchedPage } from "./fetcher.js";
import { classifyTarget, DnsResolutionError } from "./safety.js";

export type SessionKind = "interactive" | "scheduled";

/**
 * How long ctx.ui.confirm() waits for a human answer before the
 * pending-interaction registry (web-fetch/pending-interactions.ts) applies
 * its fail-closed timeout default ({ approved: false }, never true — see
 * that file's timeoutDefaultFor()). Same order of magnitude as
 * agent/conversations.ts's DEFAULT_CONFIRM_TIMEOUT_MS, kept as an
 * independent local constant rather than importing it, since this module has
 * no other dependency on conversations.ts (Task 6 rule: don't touch
 * conversations.ts) and this value is a judgment call, not a shared
 * contract.
 */
const CONFIRM_TIMEOUT_MS = 120_000;

/**
 * Per-conversation set of already-approved local-network hosts (AC-6.3),
 * module-level, matching this app's existing per-conversation in-memory
 * state pattern (see agent/conversations.ts's sessionPromises Map,
 * pending-interactions.ts's registry). Never persisted to disk — cleared
 * only by process restart, same lifetime as everything else in this
 * pattern. SPEC.md's Boundaries section: "Never persist approved hosts to
 * disk or beyond the conversation's in-memory session lifetime."
 */
const approvedHostsByConversation = new Map<string, Set<string>>();

function approvedHostsFor(conversationId: string): Set<string> {
  let hosts = approvedHostsByConversation.get(conversationId);
  if (!hosts) {
    hosts = new Set();
    approvedHostsByConversation.set(conversationId, hosts);
  }
  return hosts;
}

/**
 * Structured details attached to every AgentToolResult this tool returns —
 * separate from the human-readable `content` text, for callers/tests that
 * want to check outcome/metadata programmatically without string-matching.
 *
 * Note: SPEC.md's `execute()` sketch shows a top-level `isError: true` field
 * on error results, but the *actually installed* `AgentToolResult<T>` type
 * (@earendil-works/pi-agent-core) has no such field — the SDK derives
 * "was this an error" purely from whether execute() threw (confirmed by
 * reading pi-agent-core's compiled agent-loop.js: executePreparedToolCall()
 * always resolves `{ result, isError: false }` for a normally-returned
 * value, regardless of the value's own shape). Per this app's own
 * CLAUDE.md/SPEC.md convention of verifying against the installed SDK
 * rather than a sketch, error states here are signaled through
 * `details.ok === false` plus a human-readable `content` message — never by
 * throwing (throwing would surface as a generic tool failure, losing the
 * specific, user-facing messages AC-6.4/AC-6.5/AC-6.6 require) and never by
 * a nonexistent `isError` field.
 */
type WebFetchDetails =
  | { ok: true; url: string; title: string | null; status: number; contentType: string | null; fetchedAt: string }
  | { ok: false; url: string; reason: "invalid-url" | "dns-error" | "scheduled-private-blocked" | "not-approved" };

function textResult(text: string, details: WebFetchDetails) {
  return { content: [{ type: "text" as const, text }], details };
}

function pageResult(page: FetchedPage) {
  return textResult(page.markdown, {
    ok: true,
    url: page.url,
    title: page.title,
    status: page.status,
    contentType: page.contentType,
    fetchedAt: page.fetchedAt,
  });
}

/**
 * Phase 2 stub (Task 6 scope only — Task 11 wires the real implementation).
 * Always returns null, so web_fetch's SPA-shell branch always falls back
 * honestly to the plain-fetch content (AC-6.6) rather than fabricating
 * rendered output that doesn't exist yet.
 *
 * TODO(Task 11): replace this stub with the real headless-webview render
 * fallback — create a `kind: "render"` pending interaction via
 * pending-interactions.ts's create(), await its promise, and return the
 * resolved `html` field (or null on timeout/failure). No change needed to
 * the safety gate above: the render path must reuse the same
 * classifyTarget() result already computed for this call, never fetch (or
 * render) before it (SPEC.md's "Always" boundary).
 */
async function renderViaHeadlessWebview(_conversationId: string, _url: URL): Promise<string | null> {
  return null;
}

export function createWebFetchTools(conversationId: string, sessionKind: SessionKind): ToolDefinition[] {
  const webFetch = defineTool({
    name: "web_fetch",
    label: "Web fetch",
    description: "Fetch a URL and return its readable content as markdown, with metadata.",
    parameters: Type.Object({
      url: Type.String({ description: "The absolute URL to fetch, e.g. https://example.com/page" }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      // (a) Parse params.url. Invalid input is rejected immediately, before
      // any network call — including no DNS lookup for classification.
      let target: URL;
      try {
        target = new URL(params.url);
      } catch {
        return textResult(`Invalid URL: "${params.url}".`, {
          ok: false,
          url: params.url,
          reason: "invalid-url",
        });
      }

      // (b) Classify once, upfront, before either the plain-fetch or
      // (future) webview-render path — SPEC.md's Boundaries: "Always
      // resolve DNS and classify the resolved IP before any fetch attempt
      // ... never fetch first and check after."
      let classification: Awaited<ReturnType<typeof classifyTarget>>;
      try {
        classification = await classifyTarget(target);
      } catch (error) {
        const reason =
          error instanceof DnsResolutionError
            ? error.message
            : `Could not resolve DNS for "${target.hostname}".`;
        return textResult(reason, { ok: false, url: target.href, reason: "dns-error" });
      }

      if (classification === "private") {
        // (c) Scheduled sessions hard-block immediately — never call
        // ctx.ui.confirm(), never create a pending interaction (AC-6.4,
        // US-05: an unattended run must never hang waiting on an approval
        // nobody will give).
        if (sessionKind === "scheduled") {
          return textResult(`Fetching ${target.host} is not permitted in a background run.`, {
            ok: false,
            url: target.href,
            reason: "scheduled-private-blocked",
          });
        }

        const approvedHosts = approvedHostsFor(conversationId);
        if (!approvedHosts.has(target.host)) {
          // The composed message IS the pending interaction's `host` field
          // downstream (agent/conversations.ts's buildConfirmUIContext
          // passes `message` straight through as `host`) — so it must name
          // the exact target.href itself, not a paraphrase (SPEC.md
          // Boundaries: "Always show the literal host/URL in the approval
          // prompt, never a paraphrase.").
          const approved = await ctx.ui.confirm(
            "Allow local network fetch?",
            `pi wants to fetch ${target.href} — this targets your local machine or network (${target.host}). Allow this fetch?`,
            { timeout: CONFIRM_TIMEOUT_MS },
          );
          if (!approved) {
            // (AC-6.5) Denied (explicit or timeout default) — return an
            // explicit error and stop. Never proceed to fetch anyway.
            return textResult(`Fetch of ${target.host} was not approved.`, {
              ok: false,
              url: target.href,
              reason: "not-approved",
            });
          }
          // Remembered for this conversation's in-memory session lifetime
          // only (AC-6.3) — never persisted to disk.
          approvedHosts.add(target.host);
        }
      }

      // (d) Plain fetch.
      const { html, response } = await plainFetch(target);
      const plainPage = toReadableContent(html, target, response);

      // (e)/(f)/(g): if the plain fetch doesn't look like an empty SPA
      // shell, return it as-is. Otherwise try the (stubbed, in this task)
      // render fallback, and fall back honestly to the plain-fetch content
      // if it returns null (AC-6.6) — never fabricate content, never
      // silently return nothing.
      if (!looksLikeEmptySpaShell(html)) {
        return pageResult(plainPage);
      }

      const renderedHtml = await renderViaHeadlessWebview(conversationId, target);
      if (renderedHtml === null) {
        return pageResult(plainPage);
      }
      return pageResult(toReadableContent(renderedHtml, target, response));
    },
  });

  return [webFetch];
}
