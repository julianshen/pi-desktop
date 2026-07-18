import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useLocalRuntime,
  type ChatModelAdapter,
  type ChatModelRunOptions,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import type { ReactNode } from "react";
import { API_BASE } from "../../state/apiBase.js";

/**
 * Task 12 (assistant-ui-migration/TASKS.md; ADR-002-tool-approval-trust-boundary.md).
 *
 * `@tauri-apps/api/core`'s `invoke` is mocked the same way this repo's
 * established convention mocks it everywhere else that touches
 * `getResolveToken()` (`src/App.test.tsx`, `src/lib/resolveToken.test.ts`):
 * `resolveTokenInvokeImpl` is reassigned per test so each test controls
 * whether the (mocked) `get_resolve_token` Rust command resolves or rejects,
 * without re-registering the module mock. `ApprovalRequest.tsx` and
 * `Message.tsx` are imported dynamically, after this `mock.module()` call —
 * a static top-level `import` would be hoisted ahead of it and pick up the
 * real (unmocked) `@tauri-apps/api/core`, same reasoning as every other test
 * file in this repo that mocks this module.
 */
let resolveTokenInvokeImpl: () => Promise<unknown> = () => Promise.resolve("test-resolve-token");
const invokeCalls: Array<{ cmd: string }> = [];

mock.module("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    invokeCalls.push({ cmd });
    if (cmd === "get_resolve_token") return resolveTokenInvokeImpl();
    return Promise.reject(new Error(`ApprovalRequest.test.tsx: unexpected invoke("${cmd}")`));
  },
}));

const { ApprovalRequest } = await import("./ApprovalRequest.js");
const { Message } = await import("./Message.js");
const { ConversationIdContext } = await import("../../lib/conversationIdContext.js");
const { __resetResolveTokenCacheForTests } = await import("../../lib/resolveToken.js");

const CONVERSATION_ID = "conv-123";
const APPROVAL_ID = "approval-abc";
const TOOL_CALL_ID = "call-1";
// A real-looking private-network target, matching web-fetch/SPEC.md's own
// "the kind of URL that actually needs a human confirm" examples — rendered
// verbatim below is exactly the point of AC-12.1.
const TARGET_URL = "http://169.254.169.254/latest/meta-data/iam/security-credentials/";

const RESOLVE_URL = `${API_BASE}/api/conversations/${CONVERSATION_ID}/pending-interaction/${APPROVAL_ID}/resolve`;

interface FetchCall {
  url: string;
  init?: RequestInit;
}
let fetchCalls: FetchCall[] = [];
let fetchImpl: () => Promise<Response> = () => Promise.resolve(new Response(JSON.stringify({ resolved: true }), { status: 200 }));
let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
  fetchCalls = [];
  invokeCalls.length = 0;
  resolveTokenInvokeImpl = () => Promise.resolve("test-resolve-token");
  fetchImpl = () => Promise.resolve(new Response(JSON.stringify({ resolved: true }), { status: 200 }));
  global.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), init });
    return fetchImpl();
  }) as typeof fetch;
  delete import.meta.env.VITE_RESOLVE_TOKEN;
  __resetResolveTokenCacheForTests();
});

afterEach(() => {
  global.fetch = originalFetch;
  __resetResolveTokenCacheForTests();
  cleanup();
});

function renderStandalone(conversationId: string | null = CONVERSATION_ID) {
  return render(
    <ConversationIdContext.Provider value={conversationId}>
      <ApprovalRequest approvalId={APPROVAL_ID} toolCallId={TOOL_CALL_ID} args={{ url: TARGET_URL }} />
    </ConversationIdContext.Provider>,
  );
}

describe("ApprovalRequest (Task 12, component-level)", () => {
  // AC-12.1: literal target + Approve/Deny controls.
  test("AC-12.1: renders the literal url argument verbatim, with Approve/Deny controls", async () => {
    renderStandalone();

    await waitFor(() => expect(screen.getByText(TARGET_URL)).toBeTruthy());
    expect(screen.getByText("approval needed")).toBeTruthy();
    expect(screen.getByText("Approve")).toBeTruthy();
    expect(screen.getByText("Deny")).toBeTruthy();
    // Never paraphrased/truncated/host-only — the exact string, nothing else.
    expect(screen.getByText(TARGET_URL).textContent).toBe(TARGET_URL);
  });

  test("AC-12.1: a non-string/missing url argument does not crash and shows an honest placeholder, never a paraphrase", async () => {
    render(
      <ConversationIdContext.Provider value={CONVERSATION_ID}>
        <ApprovalRequest approvalId={APPROVAL_ID} toolCallId={TOOL_CALL_ID} args={{}} />
      </ConversationIdContext.Provider>,
    );

    await waitFor(() => expect(screen.getByText("approval needed")).toBeTruthy());
    expect(screen.getByText("(no target provided)")).toBeTruthy();
  });

  // AC-12.2: resolve token unreachable -> disabled + visible error, never an
  // unauthenticated request.
  test("AC-12.2: resolve token unreachable (invoke() fails, no VITE_RESOLVE_TOKEN fallback) -> Approve/Deny disabled with a visible error", async () => {
    resolveTokenInvokeImpl = () => Promise.reject(new Error("no Tauri bridge"));

    renderStandalone();

    const approveButton = await waitFor(() => screen.getByText("Approve") as HTMLButtonElement);
    const denyButton = screen.getByText("Deny") as HTMLButtonElement;
    await waitFor(() => expect(approveButton.disabled).toBe(true));
    expect(denyButton.disabled).toBe(true);
    expect(screen.getByText(/Could not verify this session/)).toBeTruthy();
  });

  test("AC-12.2: clicking a disabled (token-unreachable) Approve/Deny never sends a fetch request at all", async () => {
    resolveTokenInvokeImpl = () => Promise.reject(new Error("no Tauri bridge"));

    renderStandalone();

    const approveButton = await waitFor(() => screen.getByText("Approve") as HTMLButtonElement);
    await waitFor(() => expect(approveButton.disabled).toBe(true));

    fireEvent.click(approveButton);
    fireEvent.click(screen.getByText("Deny"));
    // Let any stray microtask/promise chain settle before asserting silence.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchCalls.length).toBe(0);
  });

  test("AC-12.2: no ConversationIdContext.Provider in scope also disables Approve/Deny with a visible error (never an unaddressed resolve request)", async () => {
    renderStandalone(null);

    const approveButton = await waitFor(() => screen.getByText("Approve") as HTMLButtonElement);
    expect(approveButton.disabled).toBe(true);
    expect(screen.getByText(/Could not verify this session/)).toBeTruthy();

    fireEvent.click(approveButton);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchCalls.length).toBe(0);
  });

  // AC-12.3: Approve/Deny call Task 11's resolve endpoint directly.
  test("AC-12.3: clicking Approve POSTs directly to Task 11's resolve endpoint with the exact URL, method, body, and X-Resolve-Token header", async () => {
    renderStandalone();

    const approveButton = await waitFor(() => screen.getByText("Approve"));
    fireEvent.click(approveButton);

    await waitFor(() => expect(fetchCalls.length).toBe(1));
    const call = fetchCalls[0]!;
    expect(call.url).toBe(RESOLVE_URL);
    expect(call.init?.method).toBe("POST");
    expect(JSON.parse(call.init?.body as string)).toEqual({ approved: true });
    const headers = call.init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Resolve-Token"]).toBe("test-resolve-token");
  });

  test("AC-12.3: clicking Deny POSTs { approved: false } to the same resolve endpoint", async () => {
    renderStandalone();

    const denyButton = await waitFor(() => screen.getByText("Deny"));
    fireEvent.click(denyButton);

    await waitFor(() => expect(fetchCalls.length).toBe(1));
    expect(fetchCalls[0]!.url).toBe(RESOLVE_URL);
    expect(JSON.parse(fetchCalls[0]!.init?.body as string)).toEqual({ approved: false });
  });

  test("a second click while a resolve POST is already in flight does not send a second fetch (double-submission guard)", async () => {
    let releaseFetch!: () => void;
    fetchImpl = () =>
      new Promise((resolve) => {
        releaseFetch = () => resolve(new Response(JSON.stringify({ resolved: true }), { status: 200 }));
      });

    renderStandalone();
    const approveButton = await waitFor(() => screen.getByText("Approve"));
    fireEvent.click(approveButton);
    await waitFor(() => expect(fetchCalls.length).toBe(1));

    fireEvent.click(screen.getByText("Approve"));
    fireEvent.click(screen.getByText("Deny"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchCalls.length).toBe(1);

    releaseFetch();
  });

  // respond()'s `if (!res.ok)` branch — a server-side rejection of the resolve
  // call (wrong/rotated X-Resolve-Token, or the interaction already
  // resolved/expired) must never look like success to the user.
  test("respond(): a 401 resolve response shows the 401-specific error, is not treated as submitted, and re-enables the button for a retry", async () => {
    fetchImpl = () => Promise.resolve(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));

    renderStandalone();
    const approveButton = await waitFor(() => screen.getByText("Approve") as HTMLButtonElement);
    fireEvent.click(approveButton);

    await waitFor(() => expect(screen.getByText("Could not verify this session — approval was not recorded.")).toBeTruthy());
    expect(fetchCalls.length).toBe(1);
    // Not treated as submitted/successful: Approve/Deny remain, re-enabled so
    // the user has a path forward (e.g. after re-authenticating).
    await waitFor(() => expect((screen.getByText("Approve") as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByText("Deny") as HTMLButtonElement).disabled).toBe(false);
  });

  test("respond(): a non-401 non-ok resolve response (e.g. 500) shows the generic status error, distinct from the 401 copy, and re-enables the button", async () => {
    fetchImpl = () => Promise.resolve(new Response(JSON.stringify({ error: "boom" }), { status: 500 }));

    renderStandalone();
    const approveButton = await waitFor(() => screen.getByText("Approve") as HTMLButtonElement);
    fireEvent.click(approveButton);

    await waitFor(() => expect(screen.getByText("Approval request failed (status 500) — it was not recorded.")).toBeTruthy());
    // Distinct from the 401-specific copy above.
    expect(screen.queryByText(/Could not verify this session/)).toBeNull();
    expect((screen.getByText("Approve") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByText("Deny") as HTMLButtonElement).disabled).toBe(false);
  });

  // respond()'s `catch (error)` block — a network-level failure of the fetch()
  // call itself (offline, DNS failure, aborted connection, ...), distinct from
  // a server response that arrived but was non-ok above.
  test("respond(): a network exception during fetch() shows the catch-block error and does not leave the button permanently disabled", async () => {
    fetchImpl = () => Promise.reject(new Error("network down"));

    renderStandalone();
    const approveButton = await waitFor(() => screen.getByText("Approve") as HTMLButtonElement);
    fireEvent.click(approveButton);

    await waitFor(() => expect(screen.getByText("Approval request failed — it was not recorded.")).toBeTruthy());
    expect((screen.getByText("Approve") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByText("Deny") as HTMLButtonElement).disabled).toBe(false);
  });

  // respond()'s own comment: the resolve token is re-fetched fresh (via
  // getResolveToken()) rather than read off the `resolveToken` state var, so a
  // click landing before the mount effect's setState has committed still gets
  // the true current token. Simulated with a slow-resolving token invoke():
  // during that window `resolveToken` state is still `undefined` (not `null`),
  // so per the AC-12.2 comment above `respond`, Approve/Deny stay enabled
  // through this transient phase rather than being disabled.
  test("respond() re-fetches the resolve token fresh, so a click before the mount effect's token state commits still uses the resolved token", async () => {
    let releaseToken!: (token: string) => void;
    resolveTokenInvokeImpl = () =>
      new Promise((resolve) => {
        releaseToken = resolve;
      });

    renderStandalone();
    const approveButton = screen.getByText("Approve") as HTMLButtonElement;
    expect(approveButton.disabled).toBe(false);
    fireEvent.click(approveButton);

    // respond() is awaiting its own getResolveToken() call — nothing sent yet.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchCalls.length).toBe(0);

    releaseToken("late-token");

    await waitFor(() => expect(fetchCalls.length).toBe(1));
    const headers = fetchCalls[0]!.init?.headers as Record<string, string>;
    expect(headers["X-Resolve-Token"]).toBe("late-token");
  });
});

/**
 * Integration-level guardrail for AC-12.3's other half: not just "the right
 * fetch happens," but "the wrong one — a resend through the ordinary chat
 * transport — never does." Rendered through the REAL dispatch path
 * (`Message.tsx`'s `ToolFallback`, via `ThreadPrimitive.Messages`) and a
 * REAL (not mocked) `useLocalRuntime()`, same "real render, no
 * mock.module() of @assistant-ui/react itself" convention
 * `Message.test.tsx`/`ChatView.test.tsx` already establish for this
 * feature's test suite — so this exercises the actual, real
 * `respondToApproval` callback Assistant UI's tool-call slot hands
 * `ToolFallback` (see `ApprovalRequest.tsx`'s header comment for the full
 * trace of what that callback would do on the real AI-SDK-backed runtime),
 * not a stand-in. `runCalls` records every invocation of the stub
 * `ChatModelAdapter`'s own `run()` — the one thing ANY resend through the
 * ordinary chat transport would have to go through, on this runtime. Never
 * observing a call there, across the whole click -> resolve-POST flow,
 * across BOTH conversion mechanisms this runtime and Message.tsx use
 * (`respondToApproval` never called, `addToolApprovalResponse` never
 * reached), is exactly what proves this component never took Assistant UI's
 * own "obvious" resend-through-chat path ADR-002 rejects.
 */
describe("ApprovalRequest via Message.tsx's real dispatch (Task 12, AC-12.3 regression guard)", () => {
  const runCalls: ChatModelRunOptions[] = [];
  const stubChatModel: ChatModelAdapter = {
    run: async (options) => {
      runCalls.push(options);
      return { content: [] };
    },
  };

  function pendingApprovalMessages(): ThreadMessageLike[] {
    return [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: TOOL_CALL_ID,
            toolName: "web_fetch",
            args: { url: TARGET_URL },
            argsText: JSON.stringify({ url: TARGET_URL }),
            approval: { id: APPROVAL_ID },
          },
        ],
      },
    ];
  }

  function TestHarness({ children }: { children: ReactNode }) {
    const runtime = useLocalRuntime(stubChatModel, { initialMessages: pendingApprovalMessages() });
    return (
      <AssistantRuntimeProvider runtime={runtime}>
        <ConversationIdContext.Provider value={CONVERSATION_ID}>{children}</ConversationIdContext.Provider>
      </AssistantRuntimeProvider>
    );
  }

  function renderThroughMessage() {
    return render(
      <TestHarness>
        <ThreadPrimitive.Messages>{() => <Message />}</ThreadPrimitive.Messages>
      </TestHarness>,
    );
  }

  beforeEach(() => {
    runCalls.length = 0;
  });

  test("a pending approval tool-call part dispatches to ApprovalRequest (not the generic ToolFallback view)", async () => {
    renderThroughMessage();

    await waitFor(() => expect(screen.getByText(TARGET_URL)).toBeTruthy());
    expect(screen.getByText("approval needed")).toBeTruthy();
    // The generic ToolFallback's own tool-name heading is NOT what rendered here.
    expect(screen.queryByText("web_fetch")).toBeNull();
  });

  test("AC-12.3: clicking Approve resolves via fetch() directly and never calls the stub chat model's run() (no resend through the ordinary chat transport)", async () => {
    renderThroughMessage();

    const approveButton = await waitFor(() => screen.getByText("Approve"));
    fireEvent.click(approveButton);

    await waitFor(() => expect(fetchCalls.length).toBe(1));
    expect(fetchCalls[0]!.url).toBe(RESOLVE_URL);
    expect(JSON.parse(fetchCalls[0]!.init?.body as string)).toEqual({ approved: true });

    // Give the runtime a further beat in case a resend was queued asynchronously.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runCalls.length).toBe(0);
  });
});
