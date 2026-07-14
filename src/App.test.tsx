import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

/**
 * Task 10 (AC-10.1/AC-10.2): exercises `usePendingRenderInteractionWatcher()`
 * (exported from App.tsx, called from `App()` there — see that file's own
 * comment for why it must live in App.tsx rather than ChatView.tsx) directly
 * via `@testing-library/react`'s `renderHook()`, rather than mounting the
 * whole `<App />` tree.
 *
 * Deliberately scoped this way instead of `render(<App />)`: the watcher has
 * no rendering output of its own to assert against (that's the whole point of
 * AC-10.1's "no visible UI" requirement) — only network side effects (a poll
 * fetch, `renderUrlHeadless()`, a resolve POST). Mounting the full `<App />`
 * tree would require `mock.module()`-stubbing every child view/component
 * (TitleBar, Sidebar, ChatView, CopilotKit, ...), and `mock.module()`
 * registrations in this codebase's `bun:test` setup are process-global, not
 * scoped to this file — stubbing `./views/ChatView` here would silently swap
 * out the REAL ChatView module for every other test file in the same `bun
 * test` run too (confirmed empirically: an earlier version of this file did
 * exactly that and broke `ChatView.test.tsx`'s own unrelated assertions).
 * Testing the exported hook directly avoids that blast radius entirely — the
 * only modules mocked below (`@tauri-apps/api/core`, the CSS import) are ones
 * no other test file touches.
 *
 * Real (unmocked) `renderUrlHeadless()` (src/lib/headlessRender.ts) is
 * exercised end-to-end, calling into a mocked `@tauri-apps/api/core`
 * `invoke` — same `mock.module()` convention `ChatView.test.tsx` established
 * for `@copilotkit/react-core`, and the same one `headlessRender.test.ts`
 * itself uses.
 */

mock.module("./styles/design-system.css", () => ({}));

/**
 * `invokeImpl` stands in for the Rust `render_url_headless` command
 * (src-tauri/src/web_fetch.rs), reassigned per test.
 */
let invokeImpl: (cmd: string, args?: unknown) => Promise<unknown> = () =>
  Promise.reject(new Error("invokeImpl not configured for this test"));
const invokeCalls: Array<{ cmd: string; args: unknown }> = [];

mock.module("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => {
    invokeCalls.push({ cmd, args });
    return invokeImpl(cmd, args);
  },
}));

// Imported dynamically, after every mock.module() above registers its
// replacement — a static top-level `import` would be hoisted ahead of those
// calls and pick up the real (unmocked) modules instead, same reasoning as
// ChatView.test.tsx's own dynamic-import comment.
const { usePendingRenderInteractionWatcher } = await import("./App.js");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface FetchCall {
  url: string;
  init?: RequestInit;
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
  invokeCalls.length = 0;
  invokeImpl = () => Promise.reject(new Error("invokeImpl not configured for this test"));
});

afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
});

describe("usePendingRenderInteractionWatcher (Task 10)", () => {
  test("AC-10.1: detects a pending render-kind interaction, calls renderUrlHeadless(url), and POSTs the html result back", async () => {
    const pendingInteraction = {
      id: "int-1",
      kind: "render",
      url: "https://spa.example.com/",
      timeoutMs: 8000,
      conversationId: "conv-1",
      createdAt: "2026-07-01T00:00:00.000Z",
    };

    const calls: FetchCall[] = [];
    let getCount = 0;
    global.fetch = mock((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ resolved: true }));
      }
      getCount += 1;
      // Only the first GET poll returns the pending interaction — once
      // "resolved" server-side it would no longer show up, so later polls
      // (if any happen during the test) see nothing pending.
      return Promise.resolve(jsonResponse({ interaction: getCount === 1 ? pendingInteraction : null }));
    }) as unknown as typeof fetch;

    invokeImpl = () => Promise.resolve("<html><body>hydrated SPA content</body></html>");

    renderHook(() => usePendingRenderInteractionWatcher("conv-1"));

    await waitFor(() => {
      expect(invokeCalls.length).toBeGreaterThan(0);
    });
    expect(invokeCalls[0]).toEqual({
      cmd: "render_url_headless",
      args: { url: "https://spa.example.com/", timeoutMs: 8000 },
    });

    await waitFor(() => {
      const resolveCall = calls.find((c) => c.url.includes("/pending-interaction/int-1/resolve"));
      expect(resolveCall).toBeDefined();
    });
    const resolveCall = calls.find((c) => c.url.includes("/pending-interaction/int-1/resolve"))!;
    expect(resolveCall.url).toBe("http://127.0.0.1:4319/api/conversations/conv-1/pending-interaction/int-1/resolve");
    expect(resolveCall.init?.method).toBe("POST");
    expect(JSON.parse(resolveCall.init?.body as string)).toEqual({
      html: "<html><body>hydrated SPA content</body></html>",
    });
  });

  test("AC-10.2: when renderUrlHeadless() fails, POSTs { html: null } (not silence, not an error) so the waiting web_fetch call isn't left hanging", async () => {
    const pendingInteraction = {
      id: "int-2",
      kind: "render",
      url: "https://spa.example.com/broken",
      timeoutMs: 4000,
      conversationId: "conv-1",
      createdAt: "2026-07-01T00:00:00.000Z",
    };

    const calls: FetchCall[] = [];
    let getCount = 0;
    global.fetch = mock((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ resolved: true }));
      }
      getCount += 1;
      return Promise.resolve(jsonResponse({ interaction: getCount === 1 ? pendingInteraction : null }));
    }) as unknown as typeof fetch;

    // Simulates the Rust command's Err case (render timeout/failure).
    invokeImpl = () => Promise.reject(new Error("render timed out"));

    renderHook(() => usePendingRenderInteractionWatcher("conv-1"));

    await waitFor(() => {
      const resolveCall = calls.find((c) => c.url.includes("/pending-interaction/int-2/resolve"));
      expect(resolveCall).toBeDefined();
    });
    const resolveCall = calls.find((c) => c.url.includes("/pending-interaction/int-2/resolve"))!;
    expect(JSON.parse(resolveCall.init?.body as string)).toEqual({ html: null });
  });

  test("ignores a pending confirm-kind interaction entirely — never invokes the render command or POSTs a resolve for it (Task 8's approval chip owns that kind)", async () => {
    const pendingConfirm = {
      id: "int-3",
      kind: "confirm",
      host: "192.168.1.5",
      timeoutMs: 60000,
      conversationId: "conv-1",
      createdAt: "2026-07-01T00:00:00.000Z",
    };

    const calls: FetchCall[] = [];
    global.fetch = mock((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(jsonResponse({ interaction: pendingConfirm }));
    }) as unknown as typeof fetch;

    renderHook(() => usePendingRenderInteractionWatcher("conv-1"));

    // Give the poll effect a couple of ticks to have run.
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(invokeCalls.length).toBe(0);
    expect(calls.some((c) => c.init?.method === "POST")).toBe(false);
  });

  test("no-double-fire: a slow renderUrlHeadless() is only invoked once even though multiple poll ticks see the same still-pending interaction id", async () => {
    const pendingInteraction = {
      id: "int-4",
      kind: "render",
      url: "https://spa.example.com/slow",
      timeoutMs: 8000,
      conversationId: "conv-1",
      createdAt: "2026-07-01T00:00:00.000Z",
    };

    const calls: FetchCall[] = [];
    global.fetch = mock((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ resolved: true }));
      }
      // Deliberately keeps returning the SAME still-pending interaction on
      // every GET (as if the server hasn't resolved it yet) so several poll
      // ticks elapse before renderUrlHeadless() finishes.
      return Promise.resolve(jsonResponse({ interaction: pendingInteraction }));
    }) as unknown as typeof fetch;

    let resolveInvoke!: (html: string) => void;
    invokeImpl = () =>
      new Promise((resolve) => {
        resolveInvoke = resolve;
      });

    renderHook(() => usePendingRenderInteractionWatcher("conv-1"));

    // Let several 500ms poll ticks elapse while the invoke() call is still pending.
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(invokeCalls.length).toBe(1);

    resolveInvoke("<html>done</html>");

    await waitFor(() => {
      const resolveCall = calls.find((c) => c.url.includes("/pending-interaction/int-4/resolve"));
      expect(resolveCall).toBeDefined();
    });
    expect(invokeCalls.length).toBe(1);
  });
});
