import { useState } from "react";
import { CircleIcon, CircleStopIcon, LoaderCircleIcon, SendIcon } from "lucide-react";
import type { ReturnTypeUseActiveRun } from "./runInspectorTypes.js";

export function RunInspector({ state }: { state: ReturnTypeUseActiveRun }) {
  const [instruction, setInstruction] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const running = state.run?.status === "running" || state.run?.status === "queued";
  const completed = state.plan.filter((step) => step.status === "completed").length;
  const submitSteer = async () => {
    if (!instruction.trim()) return;
    try { await state.steer(instruction); setInstruction(""); setActionError(null); }
    catch (error) { setActionError(error instanceof Error ? error.message : "Steering failed"); }
  };
  return (
    <div className="flex h-full flex-col bg-surface font-body text-text" aria-label="Run inspector">
      <div className="border-b border-divider px-ds-3 py-ds-2">
        <div className="font-heading text-[12px] uppercase tracking-[0.1em] text-accent">Agent work</div>
        <div className="mt-ds-1 flex items-center justify-between text-[12px]">
          <span>{state.run?.status ?? "No run"}</span>
          {state.plan.length > 0 && <span>{completed}/{state.plan.length} steps</span>}
        </div>
      </div>
      <ol className="flex-1 space-y-ds-2 overflow-y-auto p-ds-3" aria-label="Task plan">
        {state.plan.map((step) => (
          <li key={step.id} className="flex gap-ds-2 text-[13px]" aria-current={step.status === "in_progress" ? "step" : undefined}>
            {step.status === "in_progress" ? <LoaderCircleIcon size={14} className="text-accent" /> : <CircleIcon size={14} className={step.status === "completed" ? "fill-accent text-accent" : "text-text/35"} />}
            <span>{step.title}</span><span className="sr-only">{step.status}</span>
          </li>
        ))}
        {state.events.filter((event) => event.type !== "ui_message_chunk" && event.type !== "plan_updated").slice(-12).map((event) => (
          <li key={event.cursor} className="border-l border-divider pl-ds-2 text-[11px] text-text/55">{event.type.replace(/_/g, " ")}</li>
        ))}
      </ol>
      {(state.error || actionError) && <div role="alert" className="px-ds-3 text-[12px] text-danger">{actionError ?? state.error}</div>}
      <div className="border-t border-divider p-ds-2">
        <label className="sr-only" htmlFor="steer-run">Steer active run</label>
        <div className="flex gap-ds-1">
          <input id="steer-run" className="input min-w-0 flex-1" value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="Steer the agent…" disabled={!running} />
          <button type="button" className="btn btn-primary btn-icon" aria-label="Send steering instruction" disabled={!running || !instruction.trim()} onClick={() => void submitSteer()}><SendIcon size={13} /></button>
          <button type="button" className="btn btn-secondary btn-icon" aria-label="Stop run" disabled={!running} onClick={() => void state.stop().catch((error: unknown) => setActionError(error instanceof Error ? error.message : "Stop failed"))}><CircleStopIcon size={14} /></button>
        </div>
      </div>
    </div>
  );
}
