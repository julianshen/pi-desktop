import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { RunDetail } from "./RunDetail.js";
import type { ScheduledRunRecord } from "./types.js";

afterEach(cleanup);

function run(overrides: Partial<ScheduledRunRecord> = {}): ScheduledRunRecord {
  return {
    id: "run-1", taskId: "task-1", trigger: "manual", status: "completed",
    startedAt: "2026-07-21T01:00:00.000Z", completedAt: "2026-07-21T01:00:05.000Z",
    durationMs: 5000, modelId: "anthropic/claude", finalText: "# Report\n\nAll systems nominal.",
    files: [{ id: "file-1", name: "report.md", mediaType: "text/markdown", byteSize: 42, state: "available" }],
    unread: true,
    definition: { name: "Daily report", prompt: "Build the daily report", cron: "0 8 * * *", timezone: "UTC", enabled: true },
    ...overrides,
  };
}

describe("RunDetail", () => {
  test("AC-9.1: completed evidence shows timing, model, definition snapshot, final text, and owned files", () => {
    render(<RunDetail run={run()} loading={false} error={null} onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Run inspector" })).toBeTruthy();
    expect(screen.getByText("anthropic/claude")).toBeTruthy();
    expect(screen.getByText("Build the daily report")).toBeTruthy();
    expect(screen.getByText(/All systems nominal/)).toBeTruthy();
    expect(screen.getByText("report.md")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  test("AC-9.1: failed, interrupted, skipped, and running evidence stays explicit and actionable", () => {
    const { rerender } = render(<RunDetail run={run({ status: "failed", finalText: undefined, error: { code: "process_interrupted", message: "The process stopped.", retryable: true } })} loading={false} error={null} onClose={() => {}} />);
    expect(screen.getByText("process_interrupted")).toBeTruthy();
    expect(screen.getByText(/You can retry this task/)).toBeTruthy();
    rerender(<RunDetail run={run({ status: "skipped", skipReason: "already_running", finalText: undefined, files: [] })} loading={false} error={null} onClose={() => {}} />);
    expect(screen.getByText(/another run of this task was already active/)).toBeTruthy();
    rerender(<RunDetail run={run({ status: "running", completedAt: undefined, finalText: undefined, files: [] })} loading={false} error={null} onClose={() => {}} />);
    expect(screen.getByText(/still in progress/)).toBeTruthy();
  });

  test("AC-9.2: inspector has a dismiss control and a layout hook for wide persistent/default in-pane presentation", () => {
    const { container } = render(<RunDetail run={run()} loading={false} error={null} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Close run inspector" })).toBeTruthy();
    expect(container.querySelector(".scheduled-run-inspector")).toBeTruthy();
  });
});
