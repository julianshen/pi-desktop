import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TaskForm } from "./TaskForm.js";
import type { ScheduledTaskInput, ScheduledTaskSummary } from "./types.js";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
});

function task(): ScheduledTaskSummary {
  return {
    id: "task-1", name: "Morning report", prompt: "Build the report", cron: "0 8 * * *",
    timezone: "Asia/Taipei", enabled: true, modelId: "anthropic/claude",
    createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
    status: "active", lastRun: null, nextRun: "2026-07-22T00:00:00.000Z",
    scheduleLabel: "0 8 * * * · Asia/Taipei", unreadCount: 0,
  };
}

function installModels() {
  global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify([
    { id: "anthropic/claude", label: "Claude", provider: "anthropic" },
  ]), { status: 200, headers: { "Content-Type": "application/json" } }))) as unknown as typeof fetch;
}

describe("TaskForm", () => {
  test("AC-8.1: invalid Phase 1 fields stay open with actionable feedback and no fake reliability or destination fields", async () => {
    installModels();
    const submit = mock((_value: ScheduledTaskInput) => Promise.resolve());
    render(<TaskForm mode="create" onSubmit={submit} onCancel={() => {}} />);
    await waitFor(() => expect(screen.getByRole("option", { name: "Claude" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Task name"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Cron expression"), { target: { value: "every morning" } });
    fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "Mars/Olympus" } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect(screen.getByText("Enter a task name.")).toBeTruthy();
    expect(screen.getByText("Enter instructions for the agent.")).toBeTruthy();
    expect(screen.getByText("Use a valid five-field cron expression.")).toBeTruthy();
    expect(screen.getByText("Use a valid IANA timezone.")).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
    expect(screen.queryByText("Retry attempts")).toBeNull();
    expect(screen.queryByText("Destination")).toBeNull();
  });

  test("AC-8.1: edit loads canonical values/models and submits exactly the supported definition fields", async () => {
    installModels();
    let submitted: ScheduledTaskInput | undefined;
    render(<TaskForm mode="edit" task={task()} onSubmit={(value) => { submitted = value; return Promise.resolve(); }} onCancel={() => {}} />);
    await waitFor(() => expect(screen.getByRole("option", { name: "Claude" })).toBeTruthy());
    expect((screen.getByLabelText("Task name") as HTMLInputElement).value).toBe("Morning report");
    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Build a concise report" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(submitted?.prompt).toBe("Build a concise report"));
    expect(submitted).toEqual({
      name: "Morning report", prompt: "Build a concise report", cron: "0 8 * * *",
      timezone: "Asia/Taipei", enabled: true, modelId: "anthropic/claude",
    });
  });

  test("review regression: submits backend-valid named-weekday cron syntax", async () => {
    installModels();
    let submitted: ScheduledTaskInput | undefined;
    render(<TaskForm mode="create" onSubmit={(value) => { submitted = value; return Promise.resolve(); }} onCancel={() => {}} />);
    await waitFor(() => expect(screen.getByRole("option", { name: "Claude" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Task name"), { target: { value: "Monday report" } });
    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Build the report" } });
    fireEvent.change(screen.getByLabelText("Cron expression"), { target: { value: "0 9 * * Mon" } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));

    await waitFor(() => expect(submitted?.cron).toBe("0 9 * * Mon"));
    expect(screen.queryByText("Use a valid five-field cron expression.")).toBeNull();
  });

  test("AC-8.1: a rejected server mutation remains in the form action region", async () => {
    installModels();
    render(<TaskForm mode="create" onSubmit={() => Promise.reject(new Error("The selected model is unavailable."))} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText("Task name"), { target: { value: "Report" } });
    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Build it" } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("selected model is unavailable"));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
