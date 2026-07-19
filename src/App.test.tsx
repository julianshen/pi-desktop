import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
// Type-only — erased at compile time, so it doesn't pull in the real (unmocked)
// `@assistant-ui/react` module; only used below to type `mockAssistantRuntime`
// so `toBe(mockAssistantRuntime)` type-checks against `useAssistantChatRuntime`'s
// real `AssistantRuntime` return type.
import type { AssistantRuntime } from "@assistant-ui/react";

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
 * `invoke` — the same `mock.module()` convention `headlessRender.test.ts`
 * itself uses for that same module.
 *
 * ADR-001 ("Resolve-endpoint trust boundary") update: the watcher now also calls
 * `getResolveToken()` (src/lib/resolveToken.ts) when it resolves a render-kind
 * interaction, which invokes a SECOND Tauri command (`get_resolve_token`) through
 * this same mocked `invoke`. The single shared `invokeImpl` this file used to have
 * is now split into `renderInvokeImpl` (`render_url_headless`, reassigned per test,
 * same as before) and `resolveTokenInvokeImpl` (`get_resolve_token`, defaulting to a
 * successful resolution so the pre-existing AC-10.1/AC-10.2 tests below — none of
 * which care about ADR-001 — see a normal, real-looking token) dispatched by `cmd`.
 */

mock.module("./styles/design-system.css", () => ({}));

/**
 * Task 6 mocking: `@assistant-ui/react-ai-sdk`'s `useChatRuntime` and
 * `AssistantChatTransport`. Safe to mock process-wide here (unlike
 * `./views/ChatView` — see this file's own header comment above about that
 * pitfall) because no other file in `src/` imports `@assistant-ui/react` or
 * `@assistant-ui/react-ai-sdk` yet (verified via `grep -rl "@assistant-ui"
 * src/` — only `App.tsx` itself does, as of Task 6; Task 7 is the one that
 * introduces real usage elsewhere, in a later commit).
 *
 * `useChatRuntimeCalls` records every `{ api }` a real call would have sent
 * `useChatRuntime({ transport })` — read via `MockAssistantChatTransport`'s
 * own `.api` field, the same field the real `AssistantChatTransport`
 * (`node_modules/@assistant-ui/react-ai-sdk/dist/ui/use-chat/
 * AssistantChatTransport.d.ts`) exposes via its `HttpChatTransportInitOptions`
 * constructor argument.
 */
interface ChatRuntimeCall {
  api: string;
  prepareSendMessagesRequest?: (options: {
    id: string;
    messages: unknown[];
    trigger: "submit-message" | "regenerate-message";
    messageId: string | undefined;
    body: Record<string, unknown> | undefined;
  }) => PromiseLike<{ body: object }> | { body: object };
}
const useChatRuntimeCalls: ChatRuntimeCall[] = [];
const mockAssistantRuntime = { __mockAssistantRuntime: true } as unknown as AssistantRuntime;

class MockAssistantChatTransport {
  readonly api: string;
  readonly prepareSendMessagesRequest?: ChatRuntimeCall["prepareSendMessagesRequest"];
  constructor(options: { api: string; prepareSendMessagesRequest?: ChatRuntimeCall["prepareSendMessagesRequest"] }) {
    this.api = options.api;
    this.prepareSendMessagesRequest = options.prepareSendMessagesRequest;
  }
}

mock.module("@assistant-ui/react-ai-sdk", () => ({
  useChatRuntime: (options: { transport: MockAssistantChatTransport }) => {
    useChatRuntimeCalls.push({
      api: options.transport.api,
      prepareSendMessagesRequest: options.transport.prepareSendMessagesRequest,
    });
    return mockAssistantRuntime;
  },
  AssistantChatTransport: MockAssistantChatTransport,
}));

let renderInvokeImpl: (args?: unknown) => Promise<unknown> = () =>
  Promise.reject(new Error("renderInvokeImpl not configured for this test"));
let resolveTokenInvokeImpl: () => Promise<unknown> = () => Promise.resolve("test-resolve-token");
const invokeCalls: Array<{ cmd: string; args: unknown }> = [];

mock.module("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => {
    invokeCalls.push({ cmd, args });
    if (cmd === "get_resolve_token") return resolveTokenInvokeImpl();
    return renderInvokeImpl(args);
  },
}));

// Imported dynamically, after every mock.module() above registers its
// replacement — a static top-level `import` would be hoisted ahead of those
// calls and pick up the real (unmocked) modules instead, same reasoning as
// headlessRender.test.ts's own dynamic-import comment.
const { usePendingRenderInteractionWatcher, useAssistantChatRuntime } = await import("./App.js");
// Already loaded as part of App.js's own import graph above — importing it again
// here just gets the same cached module instance, exposing its test-only
// cache-reset helper (see resolveToken.ts's own doc comment for why this exists).
const { __resetResolveTokenCacheForTests } = await import("./lib/resolveToken.js");
const { __replaceAttachmentDraftForTests, __resetAttachmentDraftsForTests } = await import("./state/attachmentDrafts.js");

test("chat integrates the Agent Work header surface without the legacy inspector placements", async () => {
  const appSource = await Bun.file(new URL("./App.tsx", import.meta.url)).text();

  expect(appSource).toContain("AgentWorkSurface");
  expect(appSource).toContain("renderChat");
  expect(appSource).not.toContain("min-[1180px]:block");
  expect(appSource).not.toContain("<details");
  expect(appSource).not.toContain("bottom-ds-3 right-ds-3");
});

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
  useChatRuntimeCalls.length = 0;
  renderInvokeImpl = () => Promise.reject(new Error("renderInvokeImpl not configured for this test"));
  resolveTokenInvokeImpl = () => Promise.resolve("test-resolve-token");
  delete import.meta.env.VITE_RESOLVE_TOKEN;
  __resetResolveTokenCacheForTests();
  __resetAttachmentDraftsForTests();
});

afterEach(() => {
  global.fetch = originalFetch;
  __resetResolveTokenCacheForTests();
  __resetAttachmentDraftsForTests();
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

    renderInvokeImpl = () => Promise.resolve("<html><body>hydrated SPA content</body></html>");

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
    renderInvokeImpl = () => Promise.reject(new Error("render timed out"));

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
    renderInvokeImpl = () =>
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
    // Still only one render_url_headless invoke() call (the no-double-fire guard this
    // test is about) — the extra invoke() now visible in invokeCalls.length is
    // ADR-001's own get_resolve_token() call, fired exactly once right before the
    // resolve POST above, which is unrelated to the render-command double-fire guard
    // this test exists to prove.
    expect(invokeCalls.filter((c) => c.cmd === "render_url_headless").length).toBe(1);
    expect(invokeCalls.filter((c) => c.cmd === "get_resolve_token").length).toBe(1);
  });

  test("ADR-001: the resolve POST carries the X-Resolve-Token header when getResolveToken() succeeds", async () => {
    const pendingInteraction = {
      id: "int-5",
      kind: "render",
      url: "https://spa.example.com/token-header",
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
      return Promise.resolve(jsonResponse({ interaction: getCount === 1 ? pendingInteraction : null }));
    }) as unknown as typeof fetch;

    renderInvokeImpl = () => Promise.resolve("<html>ok</html>");
    resolveTokenInvokeImpl = () => Promise.resolve("shared-token-xyz");

    renderHook(() => usePendingRenderInteractionWatcher("conv-1"));

    await waitFor(() => {
      const resolveCall = calls.find((c) => c.url.includes("/pending-interaction/int-5/resolve"));
      expect(resolveCall).toBeDefined();
    });
    const resolveCall = calls.find((c) => c.url.includes("/pending-interaction/int-5/resolve"))!;
    const headers = resolveCall.init?.headers as Record<string, string>;
    expect(headers["X-Resolve-Token"]).toBe("shared-token-xyz");
  });

  test("ADR-001 Addendum: when getResolveToken() resolves to null (invoke() fails and no VITE_RESOLVE_TOKEN fallback), the watcher still sends the resolve POST (without the header) and degrades gracefully — no crash, no unhandled rejection", async () => {
    const pendingInteraction = {
      id: "int-6",
      kind: "render",
      url: "https://spa.example.com/no-token",
      timeoutMs: 8000,
      conversationId: "conv-1",
      createdAt: "2026-07-01T00:00:00.000Z",
    };

    const calls: FetchCall[] = [];
    let getCount = 0;
    global.fetch = mock((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (init?.method === "POST") {
        // Mirrors the real server's ADR-001 auth check: no/invalid token -> 401.
        // The watcher must not throw or leave an unhandled rejection over this.
        return Promise.resolve(jsonResponse({ error: "unauthorized" }, 401));
      }
      getCount += 1;
      return Promise.resolve(jsonResponse({ interaction: getCount === 1 ? pendingInteraction : null }));
    }) as unknown as typeof fetch;

    renderInvokeImpl = () => Promise.resolve("<html>ok</html>");
    resolveTokenInvokeImpl = () => Promise.reject(new Error("no Tauri bridge present"));
    delete import.meta.env.VITE_RESOLVE_TOKEN;

    renderHook(() => usePendingRenderInteractionWatcher("conv-1"));

    await waitFor(() => {
      const resolveCall = calls.find((c) => c.url.includes("/pending-interaction/int-6/resolve"));
      expect(resolveCall).toBeDefined();
    });
    const resolveCall = calls.find((c) => c.url.includes("/pending-interaction/int-6/resolve"))!;
    const headers = (resolveCall.init?.headers ?? {}) as Record<string, string>;
    expect(headers["X-Resolve-Token"]).toBeUndefined();
  });
});

/**
 * Task 6 (TASKS.md / AC-6.1 / AC-6.2): `useAssistantChatRuntime()` (exported
 * from App.tsx, called from `App()` there in place of the old
 * `<CopilotKit runtimeUrl={RUNTIME_URL} ...>` wrapper) is exercised directly
 * via `renderHook()`, the same "exported hook, not `render(<App />)`"
 * convention this file's own header comment establishes for
 * `usePendingRenderInteractionWatcher` above. At the time Task 6 wrote this,
 * `ChatView.tsx` (out of scope for Task 6, rebuilt in Task 8) still imported
 * `@copilotkit/react-core`'s `useCopilotChatInternal`/`useThreads` directly,
 * which threw synchronously ("Remember to wrap your app in a `<CopilotKit>`
 * ...", verified against the installed package's own
 * `useCopilotContext()`/`useThreads()` source,
 * `node_modules/@copilotkit/react-core/dist/copilotkit-*.mjs`) now that
 * `App.tsx` no longer rendered a `<CopilotKit>` provider — so
 * `render(<App />)` wasn't a usable test vehicle until Task 8 landed. Task 8
 * has since landed and `ChatView.tsx` no longer depends on CopilotKit at all
 * (the whole `@copilotkit/*`/`agui/`/`copilot/` stack was deleted in a
 * post-/tgd-review remediation), but this exported-hook test shape was kept
 * as-is rather than churned now that its original constraint no longer
 * applies -- mocking `./views/ChatView` away to use `render(<App />)` instead
 * would still hit this file's own documented `mock.module()` process-global
 * leak pitfall (it would silently swap out the REAL ChatView module for
 * `ChatView.test.tsx` too, in the same `bun test` run). Testing the exported
 * hook directly proves exactly this task's actual scope — the
 * runtime/transport wiring — without that problem.
 */
describe("useAssistantChatRuntime (Task 6)", () => {
  test("AC-6.1: wires useChatRuntime to Task 5's per-conversation chat route (POST /api/conversations/:id/chat)", () => {
    renderHook(() => useAssistantChatRuntime("default"));

    expect(useChatRuntimeCalls).toHaveLength(1);
    expect(useChatRuntimeCalls[0]?.api).toBe("http://127.0.0.1:4319/api/conversations/default/chat");
    expect(useChatRuntimeCalls[0]?.prepareSendMessagesRequest).toBeDefined();
  });

  test("AC-6.1 (grep fallback): App.tsx no longer has an `import ... from \"@copilotkit/...\"` statement anywhere", async () => {
    // A runtime assertion that "the tree has no CopilotKit provider" isn't practical
    // without mounting the ChatView subtree in a way that avoids the mock.module() leak
    // pitfall described in this describe block's own header comment. TASKS.md's Task 6
    // section explicitly allows a grep-based check here as a fallback for exactly this
    // reason, and it remains a valid regression guard now that the CopilotKit stack has
    // been fully deleted (server/src/copilot/, server/src/agui/, and the @copilotkit/*
    // dependencies -- post-/tgd-review remediation).
    //
    // Matches actual `import`/`from` statements only, not prose mentions of the package
    // name — App.tsx's own doc comments legitimately discuss CopilotKit-era history in
    // text, which a bare substring check would wrongly flag as a surviving import.
    const appSource = await Bun.file(new URL("./App.tsx", import.meta.url)).text();
    const copilotKitImportPattern = /from\s+["']@copilotkit\/(react-core|react-ui|runtime-client-gql)["']/;
    expect(copilotKitImportPattern.test(appSource)).toBe(false);
  });

  test("AC-6.2: switching the active conversation points the transport at a genuinely DIFFERENT per-conversation route, not a shared one", () => {
    // Direct re-verification of `wire-chat-backend`'s "Cross-conversation message
    // isolation" regression catalog entry, narrowed to what's actually buildable at this
    // task's boundary (per TASKS.md's own AC-6.2 note): this proves the ROUTING-SCOPE
    // half of that guarantee — that conversation A and conversation B are wired to two
    // distinct server routes, not one shared endpoint the way CopilotKit's singleton
    // `agent` previously sent the same threadId for every conversation (Task 12's
    // critical-bug fix, referenced in App.tsx's own doc comments). Full end-to-end
    // message-CONTENT isolation (A's messages surviving a switch to B and back) requires
    // ChatView.tsx's own thread-switching wiring onto Assistant UI's runtime, which
    // Task 8 builds and re-verifies — this test cannot and does not claim to cover that
    // half, since ChatView.tsx is untouched here.
    const { result, rerender } = renderHook(({ conversationId }: { conversationId: string }) => useAssistantChatRuntime(conversationId), {
      initialProps: { conversationId: "conv-A" },
    });

    rerender({ conversationId: "conv-B" });
    rerender({ conversationId: "conv-A" });

    expect(useChatRuntimeCalls.map((c) => c.api)).toEqual([
      "http://127.0.0.1:4319/api/conversations/conv-A/chat",
      "http://127.0.0.1:4319/api/conversations/conv-B/chat",
      "http://127.0.0.1:4319/api/conversations/conv-A/chat",
    ]);

    // The two conv-A calls (before and after visiting conv-B) point at the identical
    // conv-A route, not a route that drifted or a route conv-B accidentally reused.
    expect(useChatRuntimeCalls[0].api).toBe(useChatRuntimeCalls[2].api);
    expect(useChatRuntimeCalls[0].api).not.toBe(useChatRuntimeCalls[1].api);
    expect(result.current).toBe(mockAssistantRuntime);
  });

  test("AC-6.3: after one of two staged items is removed, chat JSON contains only the remaining opaque ID and no path", async () => {
    __replaceAttachmentDraftForTests("conv-A", [
      { id: "opaque-keep", name: "keep.md", mediaType: "text/markdown", byteSize: 4, state: "ready", disclosure: "local_only" },
      { id: "opaque-remove", name: "remove.png", mediaType: "image/png", byteSize: 8, state: "ready", disclosure: "local_only" },
    ]);
    const { removeAttachmentDraft } = await import("./state/attachmentDrafts.js");
    const fetchBeforeRemove = global.fetch;
    global.fetch = mock(() => Promise.resolve(new Response(null, { status: 204 }))) as unknown as typeof fetch;
    await removeAttachmentDraft("conv-A", "opaque-remove");
    global.fetch = fetchBeforeRemove;

    renderHook(() => useAssistantChatRuntime("conv-A"));
    const prepare = useChatRuntimeCalls[0]?.prepareSendMessagesRequest;
    expect(prepare).toBeDefined();
    const request = await prepare!({
      id: "thread",
      messages: [{ id: "message", role: "user", parts: [{ type: "text", text: "Review" }] }],
      trigger: "submit-message",
      messageId: "message",
      body: { system: "existing" },
    });

    expect(request.body).toMatchObject({ attachmentIds: ["opaque-keep"] });
    const json = JSON.stringify(request.body);
    expect(json).not.toContain("opaque-remove");
    expect(json).not.toMatch(/[/\\](Users|tmp|home)[/\\]/);
  });

  test("AC-8.2: attachment drafts are isolated when the active branch changes", async () => {
    const { setActiveAttachmentBranch } = await import("./state/attachmentDrafts.js");
    setActiveAttachmentBranch("conv-A", "branch-a");
    __replaceAttachmentDraftForTests("conv-A", [
      { id: "attachment-a", name: "a.md", mediaType: "text/markdown", byteSize: 1, state: "ready", disclosure: "local_only" },
    ]);
    setActiveAttachmentBranch("conv-A", "branch-b");
    __replaceAttachmentDraftForTests("conv-A", [
      { id: "attachment-b", name: "b.md", mediaType: "text/markdown", byteSize: 1, state: "ready", disclosure: "local_only" },
    ]);

    renderHook(() => useAssistantChatRuntime("conv-A"));
    const prepare = useChatRuntimeCalls[0]!.prepareSendMessagesRequest!;
    const bodyB = (await prepare({ id: "t", messages: [], trigger: "regenerate-message", messageId: undefined, body: {} })).body;
    expect(bodyB).toMatchObject({ attachmentIds: ["attachment-b"] });
    setActiveAttachmentBranch("conv-A", "branch-a");
    const bodyA = (await prepare({ id: "t", messages: [], trigger: "regenerate-message", messageId: undefined, body: {} })).body;
    expect(bodyA).toMatchObject({ attachmentIds: ["attachment-a"] });
  });
});
