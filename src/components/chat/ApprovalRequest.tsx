/**
 * Task 12 (assistant-ui-migration/TASKS.md; ADR-002-tool-approval-trust-boundary.md).
 * Renders a pending `web_fetch` approval gate as a chat-surface UI element —
 * the visual successor to the pre-migration `ChatView.tsx`'s approval chip
 * (`git show 9ec4976^:src/views/ChatView.tsx`'s `pendingConfirm` block) — and
 * resolves it by calling Task 11's authenticated resolve endpoint directly.
 *
 * Rendered by `Message.tsx`'s `ToolFallback` whenever the current tool-call
 * message part carries a pending `approval` (`part.approval` set,
 * `part.approval.approved === undefined`, per that file's own dispatch
 * condition) — see that file's comment for exactly how `approvalId`/
 * `toolCallId`/`args` get here.
 *
 * ADR-002 Decision point 6 / Finding 2 (binding guardrail, re-verified here
 * against the real installed `@assistant-ui/react-ai-sdk`/`@assistant-ui/core`
 * types, not assumed): `ToolCallMessagePartProps` (the props type Assistant
 * UI's own tool-call rendering slot hands a component like `ToolFallback`)
 * exposes a `respondToApproval: (response: ToolApprovalResponse) => void`
 * callback (`node_modules/@assistant-ui/core/dist/react/types/
 * MessagePartComponentTypes.d.ts:50`) that looks like the "obvious" way to
 * answer an approval. Confirmed by reading the installed package's own
 * compiled source that this callback is NOT safe to use here: it forwards to
 * `MessagePartRuntime.respondToToolApproval`
 * (`node_modules/@assistant-ui/react/dist/primitives/message/
 * MessagePartsGrouped.js:192`, `t13.respondToToolApproval`), which — on the
 * real AI-SDK-backed runtime this app uses (`useChatRuntime()`,
 * `@assistant-ui/react-ai-sdk`) — resolves to
 * `chatHelpers.addToolApprovalResponse({ approvalId, approved, reason })`
 * (`node_modules/@assistant-ui/react-ai-sdk/src/ui/use-chat/
 * useAISDKRuntime.ts:374`), the exact client-trusted resend-through-the-
 * ordinary-chat-transport path ADR-002 rejects (Finding 2: a co-located
 * `bash` tool could forge the same resend and self-approve). This component
 * therefore never receives, reads, or calls `respondToApproval` at all —
 * `ToolFallback` (`Message.tsx`) intentionally passes this component only
 * `approvalId`/`toolCallId`/`args`, not the full `ToolCallMessagePartProps`
 * object those came from, so there is no `respondToApproval` reference in
 * scope here to call by mistake. Approve/Deny below POST directly to Task
 * 11's dedicated endpoint instead (ADR-002 Decision point 2).
 *
 * Literal-target rule (ADR-002 Decision point 4): the `tool-approval-request`
 * wire chunk itself deliberately carries no host/URL — by the time it
 * reaches this component, though, the AI SDK's own UI-message reducer has
 * already merged it onto the SAME tool-call part that carries the tool's
 * real `input` (confirmed against `node_modules/ai/dist/index.js`'s
 * `processUIMessageStream`: `case "tool-approval-request"` looks up the
 * existing part by `toolCallId` — the one `tool-input-available` populated —
 * and only ever adds an `approval` field to it, never a separate part). So
 * `args` here already carries `web_fetch`'s real `url` argument; no separate
 * correlation step is needed on this component's side. Rendered verbatim,
 * never paraphrased, per `web-fetch/SPEC.md`'s original rule.
 */
import { useContext, useEffect, useState } from "react";
import { API_BASE } from "../../state/apiBase.js";
import { getResolveToken } from "../../lib/resolveToken.js";
import { ConversationIdContext } from "../../lib/conversationIdContext.js";

export interface ApprovalRequestProps {
  /** `interaction.id` (`pending-interactions.ts`) == the AI SDK's `approvalId` — same value, two vocabularies (ADR-002 Decision point 2). Also Task 11's `:interactionId` route param. */
  approvalId: string;
  /** Unused for the resolve call itself (the endpoint is keyed by `approvalId`/`conversationId` only) — kept for a stable React key / future correlation needs, and so the DOM carries it for tests. */
  toolCallId: string;
  /** The tool-call part's raw `args` — for `web_fetch`, `{ url: string }` (`server/src/web-fetch/tools.ts`'s `defineTool` parameters). */
  args: unknown;
}

function literalTarget(args: unknown): string | undefined {
  if (args && typeof args === "object" && "url" in args) {
    const url = (args as { url?: unknown }).url;
    if (typeof url === "string") return url;
  }
  return undefined;
}

/**
 * AC-12.2 / direct port of `web-fetch`'s `209e979` degraded-state fix,
 * re-derived here against `ApprovalRequest`'s own resolve-token lifecycle
 * instead of the pre-migration chip's: `undefined` == still resolving (the
 * `getResolveToken()` call below is memoized process-wide and normally
 * near-instant, per that module's own doc comment, so Approve/Deny stay
 * enabled through this transient phase); `null` == genuinely no token
 * available anywhere (the real ADR-001 degraded state) or no
 * `conversationId` in scope (this component rendered with no
 * `ConversationIdContext.Provider` above it) — either one means a resolve
 * request can never be safely/correctly sent, so both disable Approve/Deny
 * and show the same visible error, never a silently-unauthenticated request.
 */
export function ApprovalRequest({ approvalId, toolCallId, args }: ApprovalRequestProps) {
  const conversationId = useContext(ConversationIdContext);
  const target = literalTarget(args);

  const [resolveToken, setResolveToken] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void getResolveToken().then((token) => {
      if (!cancelled) setResolveToken(token);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);

  const authUnavailable = resolveToken === null || conversationId === null;
  const disabled = submitting || submitted || authUnavailable;

  // AC-12.3: Approve/Deny both funnel through here, POSTing directly to Task
  // 11's dedicated endpoint (never through Assistant UI's own tool-approval
  // resend path — see this file's header comment). `submitting` guards
  // against a double-submission from a fast double-click; `submitted` keeps
  // the buttons disabled afterward (a second resolve of the same
  // `approvalId` would just 404 server-side — pending-interactions.ts's
  // resolve() is one-shot) until the tool's real result eventually replaces
  // this whole component (`Message.tsx`'s dispatch condition stops matching
  // once the part's `result` arrives).
  const respond = async (approved: boolean) => {
    if (disabled || !conversationId) return;
    setSubmitting(true);
    setRequestError(null);
    try {
      // Fetched fresh (not read off the `resolveToken` state var) so a click
      // that lands before the mount-effect's setState has committed still
      // gets getResolveToken()'s true current answer — same reasoning as the
      // pre-migration chip's `resolvePendingConfirm` (memoized, so this is a
      // no-op await after the first real resolution anywhere in the app).
      const token = await getResolveToken();
      const res = await fetch(`${API_BASE}/api/conversations/${conversationId}/pending-interaction/${approvalId}/resolve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token !== null ? { "X-Resolve-Token": token } : {}),
        },
        body: JSON.stringify({ approved }),
      });
      if (!res.ok) {
        setRequestError(
          res.status === 401
            ? "Could not verify this session — approval was not recorded."
            : `Approval request failed (status ${res.status}) — it was not recorded.`,
        );
        return;
      }
      setSubmitted(true);
    } catch (error: unknown) {
      console.error("[ApprovalRequest] failed to resolve pending interaction", error);
      setRequestError("Approval request failed — it was not recorded.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="blueprint flex flex-col gap-ds-2 bg-surface p-ds-3 font-body text-[13px] text-text"
      data-tool-call-id={toolCallId}
      data-approval-id={approvalId}
    >
      <div className="flex flex-wrap items-center gap-ds-2">
        <span className="tag tag-accent">approval needed</span>
        {/* Literal `url` argument, verbatim — never paraphrased (see header comment). */}
        <span style={{ fontFamily: "ui-monospace,'SF Mono',Menlo,monospace", fontSize: 12.5 }}>{target ?? "(no target provided)"}</span>
      </div>
      <div className="flex gap-ds-2">
        <button type="button" className="btn btn-primary" disabled={disabled} onClick={() => void respond(true)}>
          Approve
        </button>
        <button type="button" className="btn btn-secondary" disabled={disabled} onClick={() => void respond(false)}>
          Deny
        </button>
      </div>
      {authUnavailable && (
        <div className="border border-danger bg-danger-bg p-ds-2 text-[12.5px] text-danger">Could not verify this session — approval is unavailable.</div>
      )}
      {requestError && <div className="border border-danger bg-danger-bg p-ds-2 text-[12.5px] text-danger">{requestError}</div>}
    </div>
  );
}
