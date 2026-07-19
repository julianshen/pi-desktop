import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { RefCallback } from "react";
import { AgentWorkSurface } from "./AgentWorkSurface.js";
import type { ReturnTypeUseActiveRun } from "./runInspectorTypes.js";

type Status = NonNullable<ReturnTypeUseActiveRun["run"]>["status"];
type Step = ReturnTypeUseActiveRun["plan"][number];

const stop = mock(async () => {});
const steer = mock(async (_instruction: string) => {});
const originalResizeObserver = globalThis.ResizeObserver;

function makeState(status: Status | null = "running", options: { id?: string; plan?: Step[]; events?: ReturnTypeUseActiveRun["events"] } = {}): ReturnTypeUseActiveRun {
  return {
    run: status === null ? null : {
      id: options.id ?? "run-1",
      conversationId: "conversation-1",
      status,
      createdAt: "2026-07-19T00:00:00Z",
    },
    plan: options.plan ?? [],
    events: options.events ?? [],
    error: null,
    stop,
    steer,
  };
}

function renderSurface(state = makeState(), options: { conversationId?: string; chatClick?: () => void; composerClick?: () => void; captureRef?: (ref: RefCallback<HTMLElement | null>) => void } = {}) {
  return render(
    <AgentWorkSurface
      state={state}
      conversationId={options.conversationId ?? "conversation-1"}
      renderChat={(composerBoundaryRef) => {
        options.captureRef?.(composerBoundaryRef);
        return (
          <>
            <button type="button" onClick={options.chatClick} data-testid="transcript-control">Transcript control</button>
            <button type="button" onClick={options.composerClick} data-testid="composer-control">Composer control</button>
          </>
        );
      }}
    />,
  );
}

function primaryButton() {
  return screen.getByRole("button", { name: /Agent work (details|Running|Queued|Completed|Failed|Stopped|Interrupted)/i });
}

class ResizeObserverMock {
  static instances: ResizeObserverMock[] = [];
  callback: ResizeObserverCallback;
  observe = mock((_target: Element) => {});
  disconnect = mock(() => {});
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverMock.instances.push(this);
  }
  resize(target: Element) {
    this.callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}

beforeEach(() => {
  stop.mockClear();
  steer.mockClear();
  ResizeObserverMock.instances = [];
  globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  if (originalResizeObserver) globalThis.ResizeObserver = originalResizeObserver;
  else Reflect.deleteProperty(globalThis, "ResizeObserver");
});

describe("AgentWorkSurface", () => {
  test("always renders chat without reserving a status row when there is no run", () => {
    const { container } = renderSurface(makeState(null));
    expect(screen.getByTestId("transcript-control")).toBeTruthy();
    expect(screen.queryByText("Agent work")).toBeNull();
    expect(container.firstElementChild?.className).toContain("flex min-h-0 flex-1 flex-col");
    expect(screen.getByTestId("transcript-control").parentElement?.className).toContain("relative flex min-h-0 flex-1");
  });

  test.each([
    ["queued", "Queued"], ["running", "Running"], ["completed", "Completed"],
    ["failed", "Failed"], ["stopped", "Stopped"], ["interrupted", "Interrupted"],
  ] as const)("shows explicit %s status without a plan", (status, label) => {
    renderSurface(makeState(status));
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByText(/\d+\/\d+/)).toBeNull();
  });

  test("sorts by position and selects current step by priority while showing completed progress", () => {
    const plan: Step[] = [
      { id: "pending", position: 9, title: "Pending late", status: "pending" },
      { id: "done", position: 1, title: "Completed early", status: "completed" },
      { id: "failed", position: 4, title: "Failed middle", status: "failed" },
      { id: "active", position: 7, title: "Active later", status: "in_progress" },
    ];
    renderSurface(makeState("running", { plan }));
    expect(screen.getByText("Active later").className).toContain("hidden min-[620px]:inline");
    expect(screen.getByText("1/4").className).not.toContain("hidden");

    fireEvent.click(primaryButton());
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Completed earlycompleted", "Failed middlefailed", "Active laterin_progress", "Pending latepending",
    ]);
  });

  test("falls back through failed, last completed, and first pending current steps", () => {
    const { rerender } = render(
      <AgentWorkSurface state={makeState("failed", { plan: [
        { id: "failed", position: 3, title: "Broken", status: "failed" },
        { id: "done", position: 1, title: "Older done", status: "completed" },
      ] })} conversationId="c" renderChat={() => <div />} />,
    );
    expect(screen.getByText("Broken")).toBeTruthy();
    rerender(<AgentWorkSurface state={makeState("completed", { plan: [
      { id: "new", position: 8, title: "Newest done", status: "completed" },
      { id: "old", position: 2, title: "Old done", status: "completed" },
    ] })} conversationId="c" renderChat={() => <div />} />);
    expect(screen.getByText("Newest done")).toBeTruthy();
    rerender(<AgentWorkSurface state={makeState("queued", { plan: [
      { id: "later", position: 5, title: "Later pending", status: "pending" },
      { id: "first", position: 1, title: "First pending", status: "pending" },
    ] })} conversationId="c" renderChat={() => <div />} />);
    expect(screen.getByText("First pending")).toBeTruthy();
  });

  test.each([
    ["queued", "border-divider bg-surface text-accent", null, true],
    ["running", "border-divider bg-surface text-accent", null, true],
    ["completed", "border-success bg-success-bg text-success", "lucide-circle-check", false],
    ["failed", "border-danger bg-danger-bg text-danger", "lucide-circle-alert", false],
    ["stopped", "border-divider bg-surface text-muted", "lucide-circle-stop", false],
    ["interrupted", "border-divider bg-surface text-muted", "lucide-circle-stop", false],
  ] as const)("uses the required %s token and icon treatment", (status, tokens, iconClass, hasRunningDot) => {
    render(<AgentWorkSurface state={makeState(status)} conversationId="c" renderChat={() => <div />} />);
    expect(primaryButton().parentElement?.className).toContain(tokens);
    const icon = screen.queryByTestId("agent-work-status-icon");
    if (iconClass) expect(icon?.getAttribute("class")).toContain(iconClass);
    else expect(icon).toBeNull();
    const runningDot = screen.queryByTestId("agent-work-running-dot");
    expect(Boolean(runningDot)).toBe(hasRunningDot);
    if (runningDot) {
      expect(runningDot.className).toContain("bg-accent");
      expect(runningDot.className).toContain("motion-safe:animate-pulse");
      expect(runningDot.className).toContain("motion-reduce:animate-none");
    }
  });

  test.each(["completed", "failed", "stopped", "interrupted"] as const)("exposes dismiss for terminal %s runs without bubbling", (status) => {
    const outerClick = mock(() => {});
    render(
      <div onClick={outerClick}>
        <AgentWorkSurface state={makeState(status)} conversationId="c" renderChat={() => <div />} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Agent work result" }));
    expect(outerClick).not.toHaveBeenCalled();
  });

  test.each(["queued", "running"] as const)("omits dismiss for active %s runs", (status) => {
    render(<AgentWorkSurface state={makeState(status)} conversationId="c" renderChat={() => <div />} />);
    expect(screen.queryByRole("button", { name: "Dismiss Agent work result" })).toBeNull();
  });

  test("is initially collapsed and expands, toggles, and closes from backdrop with focus restoration", () => {
    const chatClick = mock(() => {});
    const composerClick = mock(() => {});
    renderSurface(makeState(), { chatClick, composerClick });
    const primary = primaryButton();
    expect(primary.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByLabelText("Agent work details")).toBeNull();
    fireEvent.click(primary);
    expect(primary.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByLabelText("Agent work details")).toBeTruthy();
    const backdrop = screen.getByLabelText("Close Agent work details");
    fireEvent.click(backdrop);
    expect(chatClick).not.toHaveBeenCalled();
    expect(composerClick).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Agent work details")).toBeNull();
    expect(document.activeElement).toBe(primary);
    fireEvent.click(primary);
    fireEvent.click(primary);
    expect(screen.queryByLabelText("Agent work details")).toBeNull();
  });

  test("Escape closes details and restores focus", () => {
    renderSurface();
    const primary = primaryButton();
    fireEvent.click(primary);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByLabelText("Agent work details")).toBeNull();
    expect(document.activeElement).toBe(primary);
  });

  test("dismisses terminal runs locally with a sibling button and reappears collapsed for a new run", () => {
    const { rerender } = render(<AgentWorkSurface state={makeState("completed")} conversationId="c" renderChat={() => <div />} />);
    const dismiss = screen.getByRole("button", { name: "Dismiss Agent work result" });
    const primary = primaryButton();
    expect(dismiss.parentElement).toBe(primary.parentElement);
    expect(primary.contains(dismiss)).toBe(false);
    fireEvent.click(primary);
    fireEvent.click(dismiss);
    expect(screen.queryByText("Completed")).toBeNull();
    expect(stop).not.toHaveBeenCalled();
    rerender(<AgentWorkSurface state={makeState("completed", { id: "run-2" })} conversationId="c" renderChat={() => <div />} />);
    expect(screen.getByText("Completed")).toBeTruthy();
    expect(primaryButton().getAttribute("aria-expanded")).toBe("false");
  });

  test("conversation and run changes collapse an open drawer", () => {
    const { rerender } = render(<AgentWorkSurface state={makeState()} conversationId="c1" renderChat={() => <div />} />);
    fireEvent.click(primaryButton());
    rerender(<AgentWorkSurface state={makeState()} conversationId="c2" renderChat={() => <div />} />);
    expect(screen.queryByLabelText("Agent work details")).toBeNull();
    fireEvent.click(primaryButton());
    rerender(<AgentWorkSurface state={makeState("running", { id: "run-2" })} conversationId="c2" renderChat={() => <div />} />);
    expect(screen.queryByLabelText("Agent work details")).toBeNull();
  });

  test("live announcement changes for run status but not event polling", () => {
    const state = makeState("running");
    const { rerender } = render(<AgentWorkSurface state={state} conversationId="c" renderChat={() => <div />} />);
    const live = screen.getByText("Agent work Running");
    expect(live.getAttribute("aria-live")).toBe("polite");
    rerender(<AgentWorkSurface state={{ ...state, events: [{ id: "e", runId: "run-1", cursor: 1, type: "tool", data: {}, createdAt: "now" }] }} conversationId="c" renderChat={() => <div />} />);
    expect(screen.getByText("Agent work Running")).toBe(live);
    rerender(<AgentWorkSurface state={{ ...state, run: { ...state.run!, status: "completed" } }} conversationId="c" renderChat={() => <div />} />);
    expect(screen.getByText("Agent work Completed")).not.toBe(live);
  });

  test("steer and stop actions continue to work in the drawer", async () => {
    renderSurface();
    fireEvent.click(primaryButton());
    fireEvent.change(screen.getByLabelText("Steer active run"), { target: { value: "Try another way" } });
    fireEvent.click(screen.getByRole("button", { name: "Send steering instruction" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop run" }));
    await act(async () => {});
    expect(steer).toHaveBeenCalledWith("Try another way");
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test("uses fallback clearance, reserves footer plus trailing UI, observes both boundaries, and disconnects", () => {
    let boundaryRef: RefCallback<HTMLElement | null> | undefined;
    const { unmount } = renderSurface(makeState(), { captureRef: (ref) => { boundaryRef = ref; } });
    fireEvent.click(primaryButton());
    const drawer = screen.getByLabelText("Agent work details");
    const backdrop = screen.getByLabelText("Close Agent work details");
    expect(drawer.className).toContain("w-[min(420px,100%)]");
    expect(drawer.className).toContain("overflow-y-auto");
    expect((drawer.getAttribute("style") ?? "")).toContain("--composer-boundary-height: 160px");
    expect(drawer.style.height).toBe("var(--agent-work-drawer-height)");
    expect(drawer.style.getPropertyValue("--agent-work-drawer-height")).toBe("min(520px, max(0px, calc(100% - var(--composer-boundary-height))))");
    expect((backdrop.getAttribute("style") ?? "")).toContain("bottom: var(--composer-boundary-height)");

    const element = document.createElement("div");
    const chatRegion = screen.getByTestId("transcript-control").parentElement!;
    let boundaryTop = 400;
    let regionBottom = 600;
    element.getBoundingClientRect = () => ({ width: 0, height: 88, top: boundaryTop, right: 0, bottom: boundaryTop + 88, left: 0, x: 0, y: boundaryTop, toJSON() {} });
    chatRegion.getBoundingClientRect = () => ({ width: 0, height: regionBottom, top: 0, right: 0, bottom: regionBottom, left: 0, x: 0, y: 0, toJSON() {} });
    act(() => boundaryRef?.(element));
    expect((screen.getByLabelText("Agent work details").getAttribute("style") ?? "")).toContain("--composer-boundary-height: 200px");
    const observer = ResizeObserverMock.instances.at(-1)!;
    expect(observer.observe).toHaveBeenCalledTimes(2);
    expect(observer.observe).toHaveBeenCalledWith(element);
    expect(observer.observe).toHaveBeenCalledWith(chatRegion);

    boundaryTop = 350;
    act(() => observer.resize(element));
    expect((screen.getByLabelText("Agent work details").getAttribute("style") ?? "")).toContain("--composer-boundary-height: 250px");
    regionBottom = 700;
    act(() => observer.resize(chatRegion));
    expect((screen.getByLabelText("Agent work details").getAttribute("style") ?? "")).toContain("--composer-boundary-height: 350px");
    unmount();
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
  });
});
