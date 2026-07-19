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
import { useContext, useState, type FC, type FormEvent } from "react";
import { AuiIf, ComposerPrimitive, useAssistantRuntime } from "@assistant-ui/react";
import { ArrowUpIcon, PaperclipIcon, SquareIcon } from "lucide-react";
import { Blueprint } from "../Blueprint";
import { ConversationIdContext } from "../../lib/conversationIdContext.js";
import {
  chooseAndStageAttachments,
  firstBlockingAttachment,
  hasReadyAttachments,
  removeAttachmentDraft,
  useAttachmentDraft,
} from "../../state/attachmentDrafts.js";
import { AttachmentTray } from "./AttachmentTray.js";

export const Composer: FC = () => {
  const conversationId = useContext(ConversationIdContext);
  const attachments = useAttachmentDraft(conversationId);
  const runtime = useAssistantRuntime();
  const [validationError, setValidationError] = useState<string | null>(null);

  const chooseFiles = () => {
    if (!conversationId) return;
    setValidationError(null);
    void chooseAndStageAttachments(conversationId);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (!conversationId) return;
    const blocking = firstBlockingAttachment(conversationId);
    if (blocking) {
      event.preventDefault();
      setValidationError(`${blocking.name} cannot be sent: ${blocking.error ?? (blocking.state === "uploading" ? "staging is still in progress" : `the item is ${blocking.state}`)}. Remove it or choose the file again.`);
      return;
    }
    const composer = runtime.thread.composer;
    if (!composer.getState().text.trim() && hasReadyAttachments(conversationId)) {
      composer.setText("Please use the attached file(s).");
    }
    setValidationError(null);
  };

  return (
    <Blueprint className="flex w-full flex-col gap-ds-2 bg-surface p-ds-2">
      {conversationId && (
        <AttachmentTray
          attachments={attachments}
          onRemove={(id) => { void removeAttachmentDraft(conversationId, id); }}
          onRetry={chooseFiles}
        />
      )}
      <ComposerPrimitive.Root className="flex w-full items-end gap-ds-2" onSubmit={handleSubmit}>
        {conversationId && (
          <button type="button" className="btn btn-secondary btn-icon" aria-label="Attach files" onClick={chooseFiles}>
            <PaperclipIcon size={16} />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <ComposerPrimitive.Input
            placeholder="Send a message..."
            rows={1}
            autoFocus
            enterKeyHint="send"
            aria-label="Message input"
            aria-invalid={validationError ? true : undefined}
            className="max-h-32 min-h-9 w-full resize-none border-none bg-transparent px-ds-2 py-ds-1 font-body text-[15px] leading-[1.55] text-text outline-none placeholder:text-text/50"
          />
          {validationError && <div role="alert" className="px-ds-2 pt-ds-1 text-[12px] text-danger">{validationError}</div>}
        </div>
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
