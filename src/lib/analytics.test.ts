import { afterEach, describe, expect, test } from "bun:test";
import { setDesktopAnalyticsSink, trackDesktopEvent, type DispatchedDesktopAnalyticsEvent } from "./analytics.js";

afterEach(() => setDesktopAnalyticsSink());

describe("privacy-safe desktop analytics", () => {
  test("AC-17.1, AC-17.2, and AC-17.3: restoration and save events contain approved dimensions", () => {
    const events: DispatchedDesktopAnalyticsEvent[] = [];
    setDesktopAnalyticsSink((event) => events.push(event));
    trackDesktopEvent({ name: "conversation_restored", properties: { outcome: "success", had_active_run: true, message_count_bucket: "6_20" } });
    trackDesktopEvent({ name: "agent_run_restored", properties: { outcome: "success", prior_status: "running", replayed_event_count_bucket: "2_5" } });
    trackDesktopEvent({ name: "generated_file_save_terminal", properties: { outcome: "cancelled", media_category: "text", size_bucket: "under_1mib" } });
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.platform === "desktop")).toBe(true);
  });

  test("recursively rejects content and filesystem metadata", () => {
    for (const field of ["content", "destination_path", "filename", "sha_hash", "queryUrl", "api_key"]) {
      expect(() => trackDesktopEvent({ name: "generated_file_save_terminal", properties: { outcome: "saved", media_category: "text", size_bucket: "under_1mib", nested: { [field]: "private" } } } as never)).toThrow("Analytics field is forbidden");
    }
  });

  test("AC-13.1: scheduled opened/notified outcomes dispatch only approved status booleans and enums", () => {
    const events: DispatchedDesktopAnalyticsEvent[] = [];
    setDesktopAnalyticsSink((event) => events.push(event));
    trackDesktopEvent({ name: "scheduled_task_run_opened", properties: { outcome: "success", run_status: "completed", has_files: true } });
    trackDesktopEvent({ name: "scheduled_task_failure_notified", properties: { outcome: "permission_denied", app_visible: false } });
    expect(events).toEqual([
      { name: "scheduled_task_run_opened", platform: "desktop", properties: { outcome: "success", run_status: "completed", has_files: true } },
      { name: "scheduled_task_failure_notified", platform: "desktop", properties: { outcome: "permission_denied", app_visible: false } },
    ]);
    for (const field of ["taskId", "runId", "prompt", "errorMessage", "fileMetadata", "path"]) {
      expect(() => trackDesktopEvent({ name: "scheduled_task_run_opened", properties: { outcome: "failed", run_status: "unknown", has_files: false, nested: { [field]: "private" } } } as never)).toThrow("Analytics field is forbidden");
    }
  });
});
