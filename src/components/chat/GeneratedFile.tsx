import { useEffect, useState } from "react";
import { DownloadIcon, FileIcon, RotateCcwIcon } from "lucide-react";

export type GeneratedFileState = "available" | "missing" | "saving" | "saved" | "failed";
export interface GeneratedFileView { id: string; name: string; mediaType: string; byteSize: number; state: GeneratedFileState }

export function GeneratedFile({ file, onSave }: { file: GeneratedFileView; onSave: (fileId: string) => Promise<"saved" | "cancelled" | void> }) {
  const [state, setState] = useState(file.state);
  useEffect(() => setState(file.state), [file.state]);
  const save = async () => {
    setState("saving");
    try { const outcome = await onSave(file.id); setState(outcome === "cancelled" ? "available" : "saved"); } catch { setState("failed"); }
  };
  const canSave = state === "available" || state === "failed";
  return (
    <div className="blueprint flex items-center gap-ds-2 bg-surface p-ds-2" aria-label={`Generated file ${file.name}`}>
      <FileIcon size={15} className="text-accent" />
      <div className="min-w-0 flex-1"><div className="truncate text-[13px]">{file.name}</div><div className="text-[11px] text-text/50">{file.mediaType} · {file.byteSize} B</div></div>
      <span role="status" className="tag">{state}</span>
      {canSave && <button type="button" className="btn btn-primary btn-icon" aria-label={state === "failed" ? `Retry saving ${file.name}` : `Save ${file.name}`} onClick={() => void save()}>{state === "failed" ? <RotateCcwIcon size={13} /> : <DownloadIcon size={13} />}</button>}
    </div>
  );
}
