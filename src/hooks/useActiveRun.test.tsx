import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { useActiveRun } from "./useActiveRun.js";
import { setDesktopAnalyticsSink, type DispatchedDesktopAnalyticsEvent } from "../lib/analytics.js";

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; setDesktopAnalyticsSink(); cleanup(); });

describe("useActiveRun", () => {
  test("switching to a conversation with no runs clears the previous run and ignores its late responses", async () => {
    const calls: string[] = [];
    let resolveRunDetail!: (response: Response) => void;
    let resolveRunEvents!: (response: Response) => void;
    const runDetail = new Promise<Response>((resolve) => { resolveRunDetail = resolve; });
    const runEvents = new Promise<Response>((resolve) => { resolveRunEvents = resolve; });

    global.fetch = mock((url: string) => {
      calls.push(url);
      if (url.endsWith("/api/conversations/conv-a/runs")) {
        return Promise.resolve(new Response(JSON.stringify([
          { id: "run-a", conversationId: "conv-a", status: "completed", createdAt: "now" },
        ])));
      }
      if (url.endsWith("/api/conversations/conv-b/runs")) {
        return Promise.resolve(new Response(JSON.stringify([])));
      }
      if (url.endsWith("/api/runs/run-a")) return runDetail;
      if (url.includes("/api/runs/run-a/events")) return runEvents;
      return Promise.reject(new Error(`unexpected ${url}`));
    }) as unknown as typeof fetch;

    const { result, rerender } = renderHook(
      ({ conversationId }: { conversationId: string }) => useActiveRun(conversationId),
      { initialProps: { conversationId: "conv-a" } },
    );
    await waitFor(() => expect(result.current.run?.id).toBe("run-a"));
    const callsBeforeSwitch = calls.length;

    rerender({ conversationId: "conv-b" });
    await waitFor(() => expect(calls).toContain("http://127.0.0.1:4319/api/conversations/conv-b/runs"));
    await waitFor(() => expect(result.current.run).toBeNull());
    expect(calls.slice(callsBeforeSwitch).filter((url) => url.includes("/api/runs/run-a"))).toEqual([]);

    resolveRunDetail(new Response(JSON.stringify({ id: "run-a", conversationId: "conv-a", status: "completed", createdAt: "now" })));
    resolveRunEvents(new Response(JSON.stringify([
      { id: "late-a", runId: "run-a", cursor: 1, type: "progress", data: {}, createdAt: "now" },
    ])));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current.run).toBeNull();
    expect(result.current.events).toEqual([]);
  });

  test("AC-12.2: replay after cursor deduplicates repeated events and preserves order", async () => {
    let eventPoll = 0;
    global.fetch = mock((url: string) => {
      if (url.endsWith("/runs")) return Promise.resolve(new Response(JSON.stringify([{ id: "run-1", conversationId: "conv", status: "running", createdAt: "now" }])));
      if (url.endsWith("/runs/run-1")) return Promise.resolve(new Response(JSON.stringify({ id: "run-1", conversationId: "conv", status: "running", createdAt: "now", plan: [] })));
      if (url.includes("/events")) {
        eventPoll += 1;
        const events = eventPoll === 1
          ? [{ id: "e1", runId: "run-1", cursor: 1, type: "progress", data: { n: 1 }, createdAt: "now" }]
          : [{ id: "e1-repeat", runId: "run-1", cursor: 1, type: "progress", data: { n: 1 }, createdAt: "now" }, { id: "e2", runId: "run-1", cursor: 2, type: "progress", data: { n: 2 }, createdAt: "now" }];
        return Promise.resolve(new Response(JSON.stringify(events)));
      }
      return Promise.reject(new Error(`unexpected ${url}`));
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useActiveRun("conv"));
    await waitFor(() => expect(result.current.events.map((event) => event.cursor)).toEqual([1]));
    await waitFor(() => expect(result.current.events.map((event) => event.cursor)).toEqual([1, 2]), { timeout: 2000 });
  });

  test("AC-17.2: reports a restored active run once with cursor count bucket only", async () => {
    const analytics: DispatchedDesktopAnalyticsEvent[] = [];
    setDesktopAnalyticsSink((event) => analytics.push(event));
    global.fetch = mock((url: string) => {
      if (url.endsWith("/runs")) return Promise.resolve(new Response(JSON.stringify([{ id: "run-restored", conversationId: "conv", status: "running", createdAt: "now" }])));
      if (url.endsWith("/runs/run-restored")) return Promise.resolve(new Response(JSON.stringify({ id: "run-restored", conversationId: "conv", status: "running", createdAt: "now", plan: [] })));
      if (url.includes("/events")) return Promise.resolve(new Response(JSON.stringify([
        { id: "e1", runId: "run-restored", cursor: 1, type: "progress", data: {}, createdAt: "now" },
        { id: "e2", runId: "run-restored", cursor: 2, type: "progress", data: {}, createdAt: "now" },
      ])));
      return Promise.reject(new Error(`unexpected ${url}`));
    }) as unknown as typeof fetch;
    const { unmount } = renderHook(() => useActiveRun("conv"));
    await waitFor(() => expect(analytics).toHaveLength(1));
    expect(analytics[0]).toEqual({ name: "agent_run_restored", platform: "desktop", properties: { outcome: "success", prior_status: "running", replayed_event_count_bucket: "2_5" } });
    unmount();
    expect(analytics).toHaveLength(1);
  });
});
