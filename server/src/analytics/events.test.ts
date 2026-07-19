import { afterEach, describe, expect, test } from "bun:test";
import { setServerAnalyticsSink, trackServerEvent, type DispatchedServerAnalyticsEvent } from "./events.js";

afterEach(() => setServerAnalyticsSink());

describe("privacy-safe server analytics", () => {
  test("AC-16.1: dispatches only approved terminal outcome dimensions", () => {
    const events: DispatchedServerAnalyticsEvent[] = [];
    setServerAnalyticsSink((event) => events.push(event));
    trackServerEvent({ name: "chat_turn_terminal", properties: { outcome: "completed", retryable: false, model_provider: "anthropic", duration_bucket: "1_10s" } });
    expect(events).toEqual([{ name: "chat_turn_terminal", platform: "server", properties: { outcome: "completed", retryable: false, model_provider: "anthropic", duration_bucket: "1_10s" } }]);
  });

  test("AC-16.2 and AC-16.3: recursive denylist rejects attachment/search secrets", () => {
    for (const field of ["prompt", "content", "query", "url", "apiKey", "filename", "local_path", "sha256_hash"]) {
      expect(() => trackServerEvent({ name: "web_search_run_completed", properties: { provider: "brave", outcome: "success", result_count_bucket: "1", latency_bucket: "under_1s", nested: { [field]: "secret" } } } as never)).toThrow(`Analytics field is forbidden`);
    }
  });
});
