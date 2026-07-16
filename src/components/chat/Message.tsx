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
import { useRef, type FC } from "react";
import {
  ErrorPrimitive,
  MessagePrimitive,
  useAuiState,
  useMessagePartText,
  type TextMessagePartComponent,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import { StreamdownTextPrimitive } from "@assistant-ui/react-streamdown";
import { code as streamdownCodePlugin } from "@streamdown/code";

/**
 * Task 9 (assistant-ui-migration/TASKS.md, AC-9.1/AC-9.2/AC-9.3): real
 * markdown rendering for a message's text content, for both assistant AND
 * user messages alike (`markdown-rendering/PRD.md`'s US-01 through US-04) —
 * replaces Task 7's plain-`<p>` placeholder.
 *
 * `StreamdownTextPrimitive` (`@assistant-ui/react-streamdown`) reads the
 * current message part via `useMessagePartText()` internally
 * (`node_modules/@assistant-ui/react-streamdown/src/primitives/StreamdownText.tsx:70`)
 * rather than a `text` prop — `MessagePrimitive.Parts` already wraps
 * whichever component it's given for `components.Text` in the matching
 * `TextMessagePartProvider` context (verified against the installed
 * package's own `src/__tests__/StreamdownText.test.tsx`, which renders this
 * exact primitive with no props of its own, wrapped only in
 * `<TextMessagePartProvider text=... isRunning=...>`). No explicit `text-*`
 * color/`font-*`/size utility is set here on purpose, same reasoning as
 * Task 7's placeholder it replaces: those are inherited from whichever
 * wrapper this renders inside (`text-text` for assistant, `text-bg`-on-
 * `bg-accent` for the user bubble — see `Message` below) since Streamdown's
 * own default element renderers (`p`, `li`, headings, ...) don't hardcode a
 * text color themselves (verified against the installed `streamdown`
 * package's compiled output — e.g. its paragraph/heading renderers only add
 * sizing/weight classes like `font-semibold text-3xl`, never a `text-*`
 * color class).
 *
 * `mode` is left at `StreamdownTextPrimitiveProps`'s own default
 * (`"streaming"`) — required for AC-9.3: Streamdown's `remend`-based
 * incomplete-markdown repair (closing an unterminated code fence or bold
 * marker before parsing) only runs when `mode === "streaming"`, and
 * `MessagePrimitive.Parts` renders this same component for a message's text
 * whether it's still arriving or already complete, so `mode="static"` (used
 * by `ArtifactCanvas.tsx`'s Task 10 code tab, where content is always
 * already-fetched) would be wrong here.
 *
 * `key={generation}` below: `ArtifactCanvas.tsx`'s Task 10 doc comment
 * already flagged this exact `streamdown` limitation ("Streamdown's internal
 * block memoization does not reliably re-highlight on a plain content-prop
 * change alone") and worked around it with a `key` tied to content identity.
 * Reproduced here empirically: `ThreadRuntime.reset()` replacing a thread's
 * messages in place (`ChatView.tsx`'s conversation-switch history-seeding
 * effect, and — separately re-verified — a plain `.reset()` alone with no
 * `switchToNewThread()` involved) updates the SAME
 * `MessagePrimitive.Root`/part-position rather than unmounting it, and
 * `streamdown`'s own paragraph/heading memo comparator
 * (`node_modules/streamdown/dist/chunk-*.js`'s `E(e,t) => e.className===
 * t.className && qe(e.node,t.node)`) compares AST node *position*, not
 * text — two different one-paragraph messages produce a structurally
 * identical position, so it wrongly treats them as equal and never
 * re-renders, permanently freezing the old text on screen (confirmed by
 * direct reproduction: swapping this out for a plain `<p>{text}</p>` made
 * the freeze disappear; reintroducing bare `Streamdown` alone, with no
 * custom props, reintroduced it — this is `streamdown`'s own bug, not
 * `@assistant-ui/react-streamdown`'s wrapping).
 *
 * The enclosing message's own `id` (`useAuiState((s) => s.message.id)`)
 * looked like the obvious key at first, but doesn't reliably change here:
 * `ChatView.test.tsx`'s own cross-conversation-isolation fixture (a
 * regression test this task must not break) intentionally reuses the same
 * `"history-0"` id for the first message of every conversation, and nothing
 * about a real server response guarantees otherwise either. Instead this
 * tracks *content continuity* directly: `text` growing token-by-token during
 * a real streaming turn is always a superset of what a ref remembers from
 * the previous render (`text.startsWith(prevText)`); a `.reset()`-caused
 * swap to a genuinely different message is not. Only a real discontinuity
 * bumps `generation` (and therefore the `key`), so a live turn's incremental
 * updates never remount mid-stream (preserving AC-9.3/AC-8.3), while a
 * conversation switch reliably does.
 */
const MessageText: TextMessagePartComponent = () => {
  const { text } = useMessagePartText();
  const prevTextRef = useRef("");
  const generationRef = useRef(0);
  if (!text.startsWith(prevTextRef.current)) {
    generationRef.current += 1;
  }
  prevTextRef.current = text;

  return (
    <StreamdownTextPrimitive
      key={generationRef.current}
      plugins={{ code: streamdownCodePlugin }}
      // Pinned to one light theme for both of Streamdown's light/dark shiki
      // slots — `design-system.css` has no dark-mode tokens anywhere else in
      // this app, so intentionally not using Streamdown's own
      // `["github-light","github-dark"]` default pair, which would only ever
      // diverge from this if the app started toggling a `dark` class it
      // never does.
      shikiTheme={["github-light", "github-light"]}
      // `{ enabled: true }` is already `streamdown`'s own default for
      // `linkSafety` when the prop is omitted (verified against the
      // installed `streamdown` package's compiled output — its `Streamdown`
      // component binds `linkSafety = { enabled: true }` when no value is
      // passed). Set explicitly here, not to override that default, but to
      // document the decision: pi's responses can include `web_fetch`-
      // sourced content, and this app's reviewed stance
      // (`markdown-rendering/SPEC.md`) is that a link-confirmation step
      // before opening an external link is a deliberate safety default, not
      // an accidental one worth leaving implicit.
      linkSafety={{ enabled: true }}
    />
  );
};

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
