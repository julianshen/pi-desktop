/**
 * Task 7 (assistant-ui-migration/TASKS.md, AC-7.1): restyled `Message` chat
 * component. Built directly on `@assistant-ui/react`'s `MessagePrimitive`
 * (the same primitive `npx shadcn add "https://r.assistant-ui.com/thread"`'s
 * generated `src/components/assistant-ui/thread.tsx` uses for its own
 * `AssistantMessage`/`UserMessage` — that plumbing isn't reinvented here),
 * restyled with `design-system.css`'s `@theme`-mapped Tailwind utilities
 * (`bg-*`, `text-*`, `border-divider`, `font-heading`/`font-body`,
 * `p-ds-*`/`gap-ds-*`) instead of the generator's own shadcn/neutral-gray
 * classes (`bg-muted`, `text-foreground`, `bg-background`, ...).
 *
 * Deliberately NOT built on the generated `thread.tsx`'s own `AssistantMessage`/
 * `UserMessage` (which additionally pull in reasoning/tool-group/attachment/
 * branch-picker/edit-composer/dialog/collapsible machinery) — Task 7's scope is
 * the core Thread/Composer/Message building blocks only; those richer
 * behaviors aren't part of this app's current chat surface and would drag in
 * Radix collapsible/dialog primitives (and their own CSS keyframes) that
 * `design-system.css` doesn't define and this task has no mandate to add.
 */
import type { FC } from "react";
import {
  ErrorPrimitive,
  MessagePrimitive,
  useAuiState,
  type TextMessagePartComponent,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";

/**
 * Renders a message's plain-text content.
 *
 * TODO(Task 9): Streamdown message-content rendering — replace this plain
 * `<p>` with `@assistant-ui/react-streamdown`'s message-part renderer, for
 * both assistant AND user messages alike (`markdown-rendering/PRD.md`'s
 * US-01 through US-04). This plain-text version is the explicit, documented
 * placeholder Task 7 is scoped to ship.
 */
const MessageText: TextMessagePartComponent = ({ text }) => (
  // No explicit `text-*` color utility here on purpose — this renders inside
  // both the assistant's `text-text`-colored wrapper and the user's
  // `text-bg`-on-`bg-accent` bubble (see `Message` below); inheriting `color`
  // from whichever wrapper it's nested in keeps both legible instead of
  // hardcoding one role's contrast onto the other.
  <p className="whitespace-pre-wrap font-body text-[15px] leading-[1.55]">{text}</p>
);

/**
 * Fallback renderer for any tool-call message part (e.g. `publish_artifact`,
 * `web_fetch`). Shows the tool name and a compact, literal (never paraphrased)
 * view of its arguments/result — matching this app's existing "never
 * paraphrase a tool's real input" convention (see `web-fetch/SPEC.md`).
 *
 * TODO(Task 12): render `tool-approval-request` parts (`part.approval` set,
 * `part.approval.approved === undefined`) via the `ApprovalRequest` component
 * instead of this generic fallback — this is the "obvious insertion point"
 * TASKS.md's Task 7 section calls for. `ApprovalRequest` will correlate the
 * literal target off this same part's `args`/`argsText` (carried here as
 * `toolArgsText` below), matching by `toolCallId`, per ADR-002 Decision point 4.
 */
const ToolFallback: ToolCallMessagePartComponent = ({ toolName, argsText, result }) => (
  <div className="blueprint flex flex-col gap-ds-1 bg-surface p-ds-3 font-body text-[13px] text-text">
    <span className="font-heading text-[11px] uppercase tracking-[0.08em] text-accent">{toolName}</span>
    {argsText && <pre className="whitespace-pre-wrap break-words text-text/80">{argsText}</pre>}
    {result !== undefined && (
      <pre className="whitespace-pre-wrap break-words border-t border-divider pt-ds-1 text-text/70">
        {typeof result === "string" ? result : JSON.stringify(result, null, 2)}
      </pre>
    )}
  </div>
);

const MessageErrorBanner: FC = () => (
  <MessagePrimitive.Error>
    <ErrorPrimitive.Root className="mt-ds-2 border border-danger bg-danger-bg p-ds-2 font-body text-[13px] text-danger">
      <ErrorPrimitive.Message className="line-clamp-2" />
    </ErrorPrimitive.Root>
  </MessagePrimitive.Error>
);

/**
 * A single chat message — assistant messages render flush-left as plain text
 * on the thread's own background; user messages render as a right-aligned
 * steel-blue-accent bubble, mirroring this design system's convention of
 * reserving `--color-accent` for the user's own affirmative actions (see
 * `.btn-primary`/`.seg-opt:has(input:checked)` in `design-system.css`).
 */
export const Message: FC = () => {
  const role = useAuiState((s) => s.message.role);
  const isUser = role === "user";

  return (
    <MessagePrimitive.Root
      data-role={role}
      className={
        isUser
          ? "ml-auto flex max-w-[75%] flex-col items-end gap-ds-1"
          : "mr-auto flex max-w-[75%] flex-col items-start gap-ds-1"
      }
    >
      <div
        className={
          isUser
            ? "bg-accent px-ds-3 py-ds-2 font-body text-[15px] leading-[1.55] text-bg"
            : "px-ds-1 py-ds-1 font-body text-[15px] leading-[1.55] text-text"
        }
      >
        <MessagePrimitive.Parts
          components={{
            Text: MessageText,
            tools: { Fallback: ToolFallback },
          }}
        />
      </div>
      <MessageErrorBanner />
    </MessagePrimitive.Root>
  );
};
