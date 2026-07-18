/**
 * Task 7 (assistant-ui-migration/TASKS.md, AC-7.1): restyled `Thread` chat
 * component. Wraps `@assistant-ui/react`'s `ThreadPrimitive` (the same
 * primitive the shadcn-generated `src/components/assistant-ui/thread.tsx`
 * wires up — `Root` > `Viewport` > `Messages` > `ViewportFooter`, verified
 * against that generated file and the installed `@assistant-ui/react@0.14.26`
 * `.d.ts`s) with `design-system.css`'s `@theme`-mapped Tailwind utilities.
 *
 * Not wired into `ChatView.tsx` here — that's Task 8's job (TASKS.md
 * explicitly scopes this task to the building blocks only).
 */
import type { FC } from "react";
import { AuiIf, ThreadPrimitive } from "@assistant-ui/react";
import { Composer } from "./Composer";
import { Message } from "./Message";

const ThreadWelcome: FC = () => (
  <div className="mx-auto flex max-w-md flex-1 flex-col items-center justify-center gap-ds-2 px-ds-4 text-center">
    <h1 className="font-heading text-2xl font-semibold text-text">How can I help you today?</h1>
    <p className="font-body text-[14px] text-text/60">Ask a question, or hand off a task.</p>
  </div>
);

export const Thread: FC = () => {
  return (
    <ThreadPrimitive.Root className="flex h-full flex-col bg-bg font-body text-text">
      <ThreadPrimitive.Viewport className="flex flex-1 flex-col gap-ds-4 overflow-y-auto px-ds-6 py-ds-4">
        <AuiIf condition={(s) => s.thread.messages.length === 0}>
          <ThreadWelcome />
        </AuiIf>
        <div className="flex flex-1 flex-col gap-ds-4">
          <ThreadPrimitive.Messages>{() => <Message />}</ThreadPrimitive.Messages>
        </div>
        <ThreadPrimitive.ViewportFooter className="sticky bottom-0 pt-ds-2">
          <Composer />
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};
