import { createContext } from "react";

/**
 * Task 12 (assistant-ui-migration/TASKS.md, ApprovalRequest component).
 * `Message.tsx`'s `ToolFallback` renders `ApprovalRequest` several component
 * layers below `ChatView.tsx` — the only place in the tree that actually
 * knows the current `conversationId` (`ChatView({ conversationId })`'s own
 * prop, threaded no further than `<Thread />` today) — and
 * `ApprovalRequest` needs it to build Task 11's resolve-endpoint URL
 * (`/api/conversations/:id/pending-interaction/:interactionId/resolve`).
 *
 * A plain React context, rather than threading a new `conversationId` prop
 * through `Thread`/`ThreadPrimitive.Messages`/`Message`, keeps those
 * components' existing no-props signatures (and their Task 7/9 tests, which
 * render them with no such prop) unchanged. Deliberately its own tiny module
 * rather than living in `ChatView.tsx` itself: `ApprovalRequest.tsx` (via
 * `Message.tsx`) needs to import this context, and `ChatView.tsx` (via
 * `Thread.tsx`) needs to provide it — importing the context straight out of
 * `ChatView.tsx` would create a module cycle
 * (`ChatView -> Thread -> Message -> ApprovalRequest -> ChatView`).
 *
 * `null` is the explicit "no provider above this point" default — treated by
 * `ApprovalRequest` the same as a genuinely unusable resolve token (ADR-001's
 * degraded state): never send an unauthenticated/unaddressed resolve
 * request, disable Approve/Deny and show a visible error instead.
 */
export const ConversationIdContext = createContext<string | null>(null);
