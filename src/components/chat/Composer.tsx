/**
 * Task 7 (assistant-ui-migration/TASKS.md, AC-7.1): restyled `Composer` chat
 * component. Wraps `@assistant-ui/react`'s `ComposerPrimitive` (the same
 * primitive the shadcn-generated `src/components/assistant-ui/thread.tsx`
 * wires up) with this app's own visual language: the `Blueprint` frame
 * (hairline border + `+` corner registration marks — this app's signature
 * motif, see `src/components/Blueprint.tsx`) around a plain, borderless
 * input, and the existing `.btn`/`.btn-primary` button classes for the send
 * action — instead of Assistant UI's own rounded-pill shadcn styling.
 *
 * Deliberately does NOT combine Tailwind override utilities with
 * `design-system.css`'s unlayered hand-rolled classes (`.input`) on the same
 * element: `@import "tailwindcss"` puts Tailwind's generated utilities inside
 * `@layer utilities`, and per the CSS Cascade Layers spec, ANY unlayered
 * rule (like `.input` in this file, declared outside a `@layer`) beats ANY
 * layered rule regardless of selector specificity or source order — so a
 * Tailwind utility like `bg-transparent` could never actually override
 * `.input`'s own `background`. Every element below uses ONE styling source
 * (either pure `@theme`-mapped Tailwind utilities, or an existing unlayered
 * hand class used as-is) to avoid silently-ineffective overrides.
 */
import type { FC } from "react";
import { AuiIf, ComposerPrimitive } from "@assistant-ui/react";
import { ArrowUpIcon, SquareIcon } from "lucide-react";
import { Blueprint } from "../Blueprint";

export const Composer: FC = () => {
  return (
    <Blueprint className="flex w-full items-end gap-ds-2 bg-surface p-ds-2">
      <ComposerPrimitive.Root className="flex w-full items-end gap-ds-2">
        <ComposerPrimitive.Input
          placeholder="Send a message..."
          rows={1}
          autoFocus
          enterKeyHint="send"
          aria-label="Message input"
          className="max-h-32 min-h-9 flex-1 resize-none border-none bg-transparent px-ds-2 py-ds-1 font-body text-[15px] leading-[1.55] text-text outline-none placeholder:text-text/50"
        />
        <ComposerAction />
      </ComposerPrimitive.Root>
    </Blueprint>
  );
};

const ComposerAction: FC = () => {
  return (
    <>
      <AuiIf condition={(s) => !s.thread.isRunning}>
        <ComposerPrimitive.Send aria-label="Send message" className="btn btn-primary btn-icon">
          <ArrowUpIcon size={16} />
        </ComposerPrimitive.Send>
      </AuiIf>
      <AuiIf condition={(s) => s.thread.isRunning}>
        <ComposerPrimitive.Cancel aria-label="Stop generating" className="btn btn-secondary btn-icon">
          <SquareIcon size={14} />
        </ComposerPrimitive.Cancel>
      </AuiIf>
    </>
  );
};
