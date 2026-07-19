import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefCallback,
} from "react";
import { ChevronDownIcon, CircleAlertIcon, CircleCheckIcon, CircleStopIcon, XIcon } from "lucide-react";
import { RunInspector } from "./RunInspector.js";
import type { ReturnTypeUseActiveRun } from "./runInspectorTypes.js";

interface AgentWorkSurfaceProps {
  state: ReturnTypeUseActiveRun;
  conversationId: string;
  renderChat: (composerBoundaryRef: RefCallback<HTMLElement | null>) => ReactNode;
}

const STATUS_LABELS = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
  interrupted: "Interrupted",
} as const;

const TERMINAL_STATUSES = new Set(["completed", "failed", "stopped", "interrupted"]);
const DRAWER_HEIGHT = "min(520px, max(0px, calc(100% - var(--composer-boundary-height))))";

function safeId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export function AgentWorkSurface({ state, conversationId, renderChat }: AgentWorkSurfaceProps) {
  const [expanded, setExpanded] = useState(false);
  const [dismissedRunId, setDismissedRunId] = useState<string | null>(null);
  const [composerBoundary, setComposerBoundary] = useState<HTMLElement | null>(null);
  const [composerBoundaryHeight, setComposerBoundaryHeight] = useState(160);
  const primaryButtonRef = useRef<HTMLButtonElement>(null);
  const run = state.run;
  const visibleRun = run && dismissedRunId !== run.id ? run : null;
  const composerBoundaryRef = useCallback<RefCallback<HTMLElement | null>>((element) => {
    setComposerBoundary(element);
  }, []);

  useEffect(() => {
    setExpanded(false);
  }, [conversationId, run?.id]);

  useLayoutEffect(() => {
    if (!composerBoundary) return;
    const measure = () => setComposerBoundaryHeight(composerBoundary.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(composerBoundary);
    return () => observer.disconnect();
  }, [composerBoundary]);

  const closeAndRestoreFocus = useCallback(() => {
    setExpanded(false);
    primaryButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeAndRestoreFocus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closeAndRestoreFocus, expanded]);

  const sortedPlan = useMemo(
    () => [...state.plan].sort((left, right) => left.position - right.position),
    [state.plan],
  );
  const completed = sortedPlan.filter((step) => step.status === "completed").length;
  const currentStep = sortedPlan.find((step) => step.status === "in_progress")
    ?? sortedPlan.find((step) => step.status === "failed")
    ?? [...sortedPlan].reverse().find((step) => step.status === "completed")
    ?? sortedPlan.find((step) => step.status === "pending");

  const drawerId = visibleRun
    ? `agent-work-details-${safeId(conversationId)}-${safeId(visibleRun.id)}`
    : undefined;
  const overlayStyle = {
    "--composer-boundary-height": `${composerBoundaryHeight}px`,
  } as CSSProperties;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {visibleRun && (() => {
        const statusLabel = STATUS_LABELS[visibleRun.status];
        const running = visibleRun.status === "queued" || visibleRun.status === "running";
        const terminal = TERMINAL_STATUSES.has(visibleRun.status);
        const rowVariant = visibleRun.status === "completed"
          ? "border-success bg-success-bg text-success"
          : visibleRun.status === "failed"
            ? "border-danger bg-danger-bg text-danger"
            : visibleRun.status === "stopped" || visibleRun.status === "interrupted"
              ? "border-divider bg-surface text-muted"
              : "border-divider bg-surface text-accent";
        return (
          <div className={`flex h-8 shrink-0 border ${rowVariant}`}>
            <span key={`${visibleRun.id}-${visibleRun.status}`} className="sr-only" aria-live="polite" aria-atomic="true">
              Agent work {statusLabel}
            </span>
            <button
              ref={primaryButtonRef}
              type="button"
              className="flex min-w-0 flex-1 items-center gap-ds-2 px-ds-3 text-left font-body text-[12px]"
              aria-label={`Agent work details: ${statusLabel}`}
              aria-expanded={expanded}
              aria-controls={drawerId}
              onClick={() => setExpanded((open) => !open)}
            >
              {running && <span data-testid="agent-work-running-dot" className="h-[7px] w-[7px] shrink-0 rounded-full bg-accent motion-safe:animate-pulse motion-reduce:animate-none" />}
              {visibleRun.status === "completed" && <CircleCheckIcon data-testid="agent-work-status-icon" size={14} />}
              {visibleRun.status === "failed" && <CircleAlertIcon data-testid="agent-work-status-icon" size={14} />}
              {(visibleRun.status === "stopped" || visibleRun.status === "interrupted") && <CircleStopIcon data-testid="agent-work-status-icon" size={14} />}
              <span className="font-heading uppercase tracking-[0.08em]">Agent work</span>
              <span>{statusLabel}</span>
              {currentStep && <span className="hidden min-[620px]:inline min-w-0 truncate">{currentStep.title}</span>}
              {sortedPlan.length > 0 && <span className="ml-auto shrink-0">{completed}/{sortedPlan.length}</span>}
              <ChevronDownIcon size={14} className={`shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`} />
            </button>
            {terminal && (
              <button
                type="button"
                className="flex w-8 shrink-0 items-center justify-center border-l border-current/20"
                aria-label="Dismiss Agent work result"
                onClick={(event) => {
                  event.stopPropagation();
                  setExpanded(false);
                  setDismissedRunId(visibleRun.id);
                }}
              >
                <XIcon size={13} />
              </button>
            )}
          </div>
        );
      })()}
      <div className="relative min-h-0 flex-1">
        {renderChat(composerBoundaryRef)}
        {visibleRun && expanded && (
          <>
            <button
              type="button"
              className="absolute inset-x-0 top-0 z-20 cursor-default bg-transparent"
              style={{ ...overlayStyle, bottom: "var(--composer-boundary-height)" }}
              aria-label="Close Agent work details"
              onClick={(event) => {
                event.stopPropagation();
                closeAndRestoreFocus();
              }}
            />
            <aside
              id={drawerId}
              className="absolute right-0 top-0 z-30 w-[min(420px,100%)] overflow-y-auto border border-border bg-surface shadow-lg"
              style={{
                ...overlayStyle,
                "--agent-work-drawer-height": DRAWER_HEIGHT,
                height: "var(--agent-work-drawer-height)",
              } as CSSProperties}
              aria-label="Agent work details"
            >
              <div className="h-full">
                <RunInspector state={{ ...state, plan: sortedPlan }} />
              </div>
            </aside>
          </>
        )}
      </div>
    </div>
  );
}
