import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useConversations, type ConversationMeta } from "./useConversations.js";

/**
 * Task 9 frontend test harness: bun:test (this repo's existing test runner, per
 * server/src/**\/*.test.ts) driven against a real DOM via
 * @happy-dom/global-registrator (registered once in the repo-root bunfig.toml
 * [test].preload, see test-setup.ts) + @testing-library/react's renderHook/act. A
 * from-scratch smoke test (renderHook + useState + useEffect + waitFor) was run
 * first to confirm bun:test can drive React 19 hook tests cleanly before writing
 * these — it worked with no JSX-transform or DOM friction, so no manual-QA fallback
 * was needed for any AC-9.x.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeMeta(overrides: Partial<ConversationMeta> = {}): ConversationMeta {
  return {
    id: overrides.id ?? "conv-1",
    title: overrides.title ?? "Untitled",
    createdAt: overrides.createdAt ?? "2026-07-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("useConversations", () => {
  test("AC-9.1: loading is true and conversations is empty while the initial fetch is in flight", async () => {
    let resolveFetch!: (res: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    global.fetch = mock(() => pending) as unknown as typeof fetch;

    const { result } = renderHook(() => useConversations());

    expect(result.current.loading).toBe(true);
    expect(result.current.conversations).toEqual([]);

    // Drain the pending fetch so it doesn't leak into the next test as an
    // unhandled promise.
    resolveFetch(jsonResponse([]));
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  test("AC-9.2: loading becomes false and conversations is [] after a successful empty fetch", async () => {
    global.fetch = mock(() => Promise.resolve(jsonResponse([]))) as unknown as typeof fetch;

    const { result } = renderHook(() => useConversations());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.conversations).toEqual([]);
  });

  test("AC-9.3: searchQuery filters `filtered` to only the conversation whose title matches", async () => {
    const matching = makeMeta({ id: "a", title: "Sprint planning" });
    const other = makeMeta({ id: "b", title: "Design review" });
    global.fetch = mock(() => Promise.resolve(jsonResponse([matching, other]))) as unknown as typeof fetch;

    const { result } = renderHook(() => useConversations());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.filtered).toHaveLength(2);

    act(() => {
      result.current.setSearchQuery("sprint");
    });

    await waitFor(() => {
      expect(result.current.filtered).toHaveLength(1);
    });
    expect(result.current.filtered[0]?.id).toBe("a");
  });

  test("AC-9.4: create() resolves with the new conversation appearing in conversations and activeId set to it", async () => {
    const created = makeMeta({ id: "new-conv", title: "New conversation" });
    global.fetch = mock((_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse(created, 201));
      }
      return Promise.resolve(jsonResponse([]));
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useConversations());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let resolved: ConversationMeta | undefined;
    await act(async () => {
      resolved = await result.current.create();
    });

    expect(resolved).toEqual(created);
    expect(result.current.conversations.some((c) => c.id === "new-conv")).toBe(true);
    expect(result.current.activeId).toBe("new-conv");
  });
});
