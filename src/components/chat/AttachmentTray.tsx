import { FileTextIcon, ImageIcon, LoaderCircleIcon, RotateCcwIcon, XIcon } from "lucide-react";
import type { AttachmentView } from "../../state/attachmentDrafts.js";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function statusLabel(item: AttachmentView): string {
  if (item.state === "uploading") return "Staging";
  if (item.state === "ready") return "Ready";
  if (item.state === "missing") return "Missing";
  return "Rejected";
}

export function AttachmentTray({
  attachments,
  onRemove,
  onRetry,
}: {
  attachments: readonly AttachmentView[];
  onRemove: (id: string) => void;
  onRetry?: () => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div role="list" aria-label="Staged attachments" className="flex w-full flex-col gap-ds-1 border-b border-border/70 pb-ds-2">
      {attachments.map((item) => {
        const failed = item.state === "rejected" || item.state === "missing";
        return (
          <div role="listitem" key={item.id} className="flex min-h-10 items-center gap-ds-2 bg-bg/60 px-ds-2 py-ds-1">
            {item.mediaType.startsWith("image/")
              ? <ImageIcon aria-label="Image attachment" size={15} className="shrink-0 text-accent" />
              : <FileTextIcon aria-label="File attachment" size={15} className="shrink-0 text-accent" />}
            <div className="min-w-0 flex-1">
              <div className="truncate font-body text-[13px] font-medium text-text">{item.name}</div>
              {failed ? (
                <div className="text-[11px] text-danger">{item.name}: {item.error ?? `Attachment is ${item.state}`}</div>
              ) : (
                <div className="text-[11px] text-text/55">{item.mediaType} · {formatBytes(item.byteSize)}</div>
              )}
            </div>
            <span className={`tag ${failed ? "tag-danger" : "tag-accent"}`}>
              {item.state === "uploading" && <LoaderCircleIcon aria-hidden size={11} />}
              {statusLabel(item)}
            </span>
            <span className="text-[10px] uppercase tracking-wide text-text/45">
              {item.disclosure === "local_only" ? "Local only until sent" : item.disclosure}
            </span>
            {failed && onRetry && (
              <button type="button" className="btn btn-secondary btn-icon" aria-label="Choose files again" onClick={onRetry}>
                <RotateCcwIcon size={13} />
              </button>
            )}
            <button type="button" className="btn btn-secondary btn-icon" aria-label={`Remove ${item.name}`} onClick={() => onRemove(item.id)}>
              <XIcon size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
