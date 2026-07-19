import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RunInspector } from "./RunInspector.js";

afterEach(cleanup);
const base = {
  run: { id: "run", conversationId: "conv", status: "running" as const, createdAt: "now" },
  plan: [{ id: "one", position: 0, title: "Inspect files", status: "in_progress" as const }, { id: "two", position: 1, title: "Write result", status: "pending" as const }],
  events: [{ id: "event", runId: "run", cursor: 1, type: "tool_started", data: {}, createdAt: "now" }],
  error: null,
  stop: mock(() => Promise.resolve()),
  steer: mock(() => Promise.resolve()),
};
describe("RunInspector", () => {
  test("AC-12.1: exposes accurate plan, active step, progress and activity", () => {
    render(<RunInspector state={base} />);
    expect(screen.getByText("Inspect files").closest("li")?.getAttribute("aria-current")).toBe("step");
    expect(screen.getByText("0/2 steps")).toBeTruthy();
    expect(screen.getByText("tool started")).toBeTruthy();
  });
  test("AC-12.3: running enables stop/steer while terminal disables both", () => {
    const { rerender } = render(<RunInspector state={base} />);
    fireEvent.change(screen.getByLabelText("Steer active run"), { target: { value: "Focus on tests" } });
    expect((screen.getByRole("button", { name: "Send steering instruction" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Stop run" }) as HTMLButtonElement).disabled).toBe(false);
    rerender(<RunInspector state={{ ...base, run: { ...base.run, status: "completed" } }} />);
    expect((screen.getByRole("button", { name: "Stop run" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
