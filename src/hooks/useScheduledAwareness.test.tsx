import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useScheduledAwareness } from "./useScheduledAwareness.js";

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; cleanup(); });

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("useScheduledAwareness", () => {
  test("AC-11.1: polls durable unread totals globally without changing server read state", async () => {
    const calls: string[] = [];
    global.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/api/scheduled-tasks")) return Promise.resolve(response({ tasks: [], unreadCount: 3 }));
      return Promise.reject(new Error(`Unexpected ${url}`));
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useScheduledAwareness({ pollMs: 60_000 }));
    await waitFor(() => expect(result.current.unreadCount).toBe(3));
    expect(calls.every((call) => call.startsWith("GET "))).toBe(true);
  });

  test("AC-11.2: only unread failures notify once after granted permission and native failure never marks read", async () => {
    const calls: string[] = [];
    global.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/api/scheduled-tasks")) return Promise.resolve(response({ tasks: [{ id: "task", name: "Nightly", unreadCount: 2 }], unreadCount: 2 }));
      if (url.includes("/api/scheduled-tasks/task/runs")) return Promise.resolve(response({ runs: [
        { id: "failed", status: "failed", unread: true }, { id: "done", status: "completed", unread: true },
      ] }));
      return Promise.reject(new Error(`Unexpected ${url}`));
    }) as unknown as typeof fetch;
    let notifications = 0;
    const { result } = renderHook(() => useScheduledAwareness({
      pollMs: 60_000,
      notification: {
        isPermissionGranted: () => Promise.resolve(true),
        requestPermission: () => Promise.resolve("granted"),
        sendNotification: () => { notifications += 1; throw new Error("native unavailable"); },
      },
    }));
    await waitFor(() => expect(result.current.unreadCount).toBe(2));
    await waitFor(() => expect(notifications).toBe(1));
    await act(async () => { await result.current.refresh(); });
    expect(notifications).toBe(1);
    expect(calls.some((call) => call.startsWith("POST "))).toBe(false);
  });

  test("AC-11.3: a deliberate read event refreshes the durable count without re-notifying the handled run", async () => {
    let unreadCount = 1;
    let notifications = 0;
    global.fetch = mock((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/scheduled-tasks")) return Promise.resolve(response({ tasks: unreadCount ? [{ id: "task", name: "Nightly", unreadCount }] : [], unreadCount }));
      if (url.includes("/runs")) return Promise.resolve(response({ runs: [{ id: "failed-again", status: "failed", unread: true }] }));
      return Promise.reject(new Error(`Unexpected ${url}`));
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useScheduledAwareness({ pollMs: 60_000, notification: {
      isPermissionGranted: () => Promise.resolve(true), requestPermission: () => Promise.resolve("granted"), sendNotification: () => { notifications += 1; },
    } }));
    await waitFor(() => expect(notifications).toBe(1));
    unreadCount = 0;
    window.dispatchEvent(new Event("scheduled-runs-read"));
    await waitFor(() => expect(result.current.unreadCount).toBe(0));
    expect(notifications).toBe(1);
  });
});
