import { useState } from "react";
import { ExternalLinkIcon, XIcon } from "lucide-react";

export interface CitationView { id: string; title: string; url: string; snippet?: string; source: string }

export function CitationList({ citations, onOpen }: { citations: readonly CitationView[]; onOpen?: (url: string) => void }) {
  const [pending, setPending] = useState<CitationView | null>(null);
  return (
    <div className="mt-ds-2 flex flex-wrap gap-ds-1" aria-label="Sources">
      {citations.map((citation) => (
        <button key={citation.id} type="button" className="tag tag-accent max-w-full" onClick={() => setPending(citation)} title={citation.url}>
          <ExternalLinkIcon size={11} /> {citation.title} · {citation.source}
        </button>
      ))}
      {pending && (
        <div role="dialog" aria-modal="true" aria-label="Open external source" className="fixed inset-0 z-50 grid place-items-center bg-text/25 p-ds-4">
          <div className="blueprint max-w-md bg-surface p-ds-4 text-text">
            <div className="font-heading text-lg">Open external source?</div>
            <p className="my-ds-2 break-all text-[13px]">{pending.title}<br />{pending.url}</p>
            <div className="flex justify-end gap-ds-1">
              <button type="button" className="btn btn-secondary btn-icon" aria-label="Cancel external navigation" onClick={() => setPending(null)}><XIcon size={13} /></button>
              <button type="button" className="btn btn-primary" onClick={() => { onOpen?.(pending.url); setPending(null); }}>Open source</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
