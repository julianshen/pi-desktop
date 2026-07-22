import { useState } from "react";
import { Streamdown } from "streamdown";
import { code as streamdownCodePlugin } from "@streamdown/code";
import { math as streamdownMathPlugin } from "@streamdown/math";
import { createMermaidPlugin } from "@streamdown/mermaid";
import { saveScheduledRunFile } from "../../lib/nativeFiles.js";
import type { ScheduledRunRecord } from "./types.js";

const streamdownMermaidPlugin = createMermaidPlugin({ config: { securityLevel: "strict", htmlLabels: false } });

function timestamp(value?: string): string {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "long" }).format(new Date(value)) : "—";
}

export function RunDetail({ run, loading, error, onClose }: {
  run: ScheduledRunRecord | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  const [saveState, setSaveState] = useState<string | null>(null);
  return (
    <aside className="scheduled-run-inspector" role="dialog" aria-label="Run inspector">
      <header>
        <div><div className="scheduled-eyebrow">Run evidence</div><h3>{run?.id ?? "Run inspector"}</h3></div>
        <button type="button" aria-label="Close run inspector" onClick={onClose}>×</button>
      </header>
      {loading && <div role="status" className="scheduled-pane-state">Loading run evidence…</div>}
      {error && <div role="alert" className="scheduled-form-error">{error}</div>}
      {run && !loading && (
        <div className="scheduled-inspector-content">
          <div className={`scheduled-inspector-status scheduled-run-status-${run.status}`}>{run.status}</div>
          <dl>
            <div><dt>Trigger</dt><dd>{run.trigger}</dd></div>
            <div><dt>Model</dt><dd>{run.modelId ?? "App default"}</dd></div>
            <div><dt>Started</dt><dd>{timestamp(run.startedAt)}</dd></div>
            <div><dt>Completed</dt><dd>{timestamp(run.completedAt)}</dd></div>
          </dl>
          <section><div className="scheduled-eyebrow">Definition snapshot</div><h4>{run.definition.name}</h4><pre>{run.definition.prompt}</pre><code>{run.definition.cron} · {run.definition.timezone}</code></section>
          {run.status === "running" && <div className="scheduled-run-message">This run is still in progress. Evidence refreshes from durable state.</div>}
          {run.status === "skipped" && <div className="scheduled-run-message">Skipped because another run of this task was already active.</div>}
          {run.error && <div className="scheduled-form-error"><strong>{run.error.code}</strong><br />{run.error.message}{run.error.retryable ? " You can retry this task." : ""}</div>}
          {run.finalText && <section><div className="scheduled-eyebrow">Final response</div><div className="scheduled-final-text"><Streamdown mode="static" plugins={{ code: streamdownCodePlugin, math: streamdownMathPlugin, mermaid: streamdownMermaidPlugin }} linkSafety={{ enabled: true }}>{run.finalText}</Streamdown></div></section>}
          <section>
            <div className="scheduled-eyebrow">Generated files</div>
            {run.files.map((file) => (
              <div className="scheduled-inspector-file" key={file.id}>
                <span><strong>{file.name}</strong><small>{file.mediaType} · {file.byteSize} bytes</small></span>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={file.state !== "available"}
                  onClick={() => {
                    setSaveState("Saving…");
                    void saveScheduledRunFile({ taskId: run.taskId, runId: run.id, fileId: file.id, name: file.name, mediaType: file.mediaType, byteSize: file.byteSize })
                      .then((result) => setSaveState(result.status === "saved" ? "File saved." : "Save cancelled."))
                      .catch((cause: unknown) => setSaveState(cause instanceof Error ? cause.message : "Save failed."));
                  }}
                >{file.state === "available" ? "Save" : "Missing"}</button>
              </div>
            ))}
            {!run.files.length && <p className="text-muted">No files were generated.</p>}
            {saveState && <div role="status" className="scheduled-save-state">{saveState}</div>}
          </section>
        </div>
      )}
    </aside>
  );
}
