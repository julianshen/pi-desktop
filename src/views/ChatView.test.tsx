import { afterEach, describe, expect, mock, test } from "bun:test";
import type { MutableRefObject } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  AssistantRuntimeProvider,
  InMemoryThreadListAdapter,
  useLocalRuntime,
  useThreadRuntime,
  type ChatModelAdapter,
  type ChatModelRunResult,
  type ThreadRuntime,
} from "@assistant-ui/react";
import { ChatView, parseGeneratedFileResult } from "./ChatView.js";

test("downloadable generated-file tool results restore from their typed JSON envelope", () => {
  expect(parseGeneratedFileResult(JSON.stringify({ generatedFile: { id: "file", runId: "run", name: "report.csv", mediaType: "text/csv", byteSize: 12, state: "available" } }))).toEqual({ id: "file", runId: "run", name: "report.csv", mediaType: "text/csv", byteSize: 12, state: "available" });
});

/**
 * Test-environment-only fix, unrelated to ChatView.tsx's own behavior: both
 * `useLocalRuntime()` (this file's harness) and the real `useChatRuntime()`
 * (App.tsx) share the same underlying thread-list runtime core (confirmed:
 * node_modules/@assistant-ui/core/dist/react/runtimes/useLocalRuntime.js also
 * calls `useRemoteThreadListRuntime()`), which auto-generates a title after a
 * thread's very first completed run
 * (node_modules/@assistant-ui/core/dist/react/runtimes/
 * RemoteThreadListHookInstanceManager.js's `runEnd` -> `generateTitle()`) by
 * calling into `InMemoryThreadListAdapter.generateTitle()` (the no-cloud
 * default; `node_modules/@assistant-ui/core/dist/runtimes/remote-thread-list/
 * adapter/in-memory.js`) and piping the result through `assistant-stream`'s
 * `AssistantMessageAccumulator` — a `class ... extends TransformStream`
 * defined once, the first time any file in this whole `bun test` process
 * imports `@assistant-ui/react` (module evaluation is cached process-wide).
 * In this project's happy-dom-backed test environment that first evaluation
 * leaves the class unable to `pipeThrough()` a genuine, later-constructed
 * `ReadableStream` ("readable should be ReadableStream") — confirmed via a
 * standalone repro: reassigning `globalThis.ReadableStream`/`TransformStream`
 * to Node's native `node:stream/web` classes from THIS file has no effect
 * once an earlier test file in the same run (Thread.test.tsx/Message.test.tsx/
 * Composer.test.tsx, Task 7, all import `@assistant-ui/react` too) has already
 * triggered that one-time class evaluation — by the time this file's own
 * top-level code runs, the class is already permanently defined. This is a
 * pre-existing gap in this feature's test infrastructure (none of Task 7's
 * tests ever drove a real completed run, only static `initialMessages`), not
 * a ChatView.tsx defect, and does not reflect real browser behavior (a real
 * browser has exactly one native Streams implementation — this collision is
 * an artifact of this specific polyfilled test environment). Rather than
 * fight the class's already-poisoned prototype chain, this stubs out the
 * specific method that reaches it: `generateTitle()`'s return value is never
 * awaited by its own caller (a fire-and-forget `aui.threadListItem().generateTitle()`
 * call, same file) and this test suite has no assertions about thread titles,
 * so a promise that never settles is a safe, inert no-op — it simply means
 * the internal auto-title machinery never reaches the `pipeThrough()` call
 * that would otherwise crash.
 */
InMemoryThreadListAdapter.prototype.generateTitle = () => new Promise<never>(() => {});

/**
 * Task 8 (assistant-ui-migration/TASKS.md): ChatView.tsx no longer talks to
 * @copilotkit/react-core at all — it reads/writes chat state entirely through
 * whatever `AssistantRuntimeProvider` supplies (App.tsx builds the real one via
 * useChatRuntime(); here, a real (not mocked) `useLocalRuntime()` — the same
 * "real render through a stub ChatModelAdapter, no mock.module() of
 * @assistant-ui/react itself" convention Task 7's Thread.test.tsx/
 * Message.test.tsx/Composer.test.tsx already established, followed here for
 * consistency across this feature's test suite (per this task's own
 * instructions). Unlike the pre-migration file, there is no
 * `@tauri-apps/api/core`/resolve-token mocking needed at all — ChatView.tsx no
 * longer touches ADR-001's resolve-token flow (Task 8, item 3: the old
 * web_fetch approval chip is deleted, not ported).
 */

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

interface FetchCall {
  url: string;
}

/** Quick, non-streaming stub model — resolves a turn in one shot. */
const quickModel: ChatModelAdapter = {
  run: async () => ({ content: [{ type: "text", text: "OK" }] }),
};

/** Streaming stub model (AC-8.3) — yields growing partial text over several ticks. */
async function* streamingRun(): AsyncGenerator<ChatModelRunResult> {
  yield { content: [{ type: "text", text: "Hel" }] };
  await new Promise((resolve) => setTimeout(resolve, 15));
  yield { content: [{ type: "text", text: "Hello wor" }] };
  await new Promise((resolve) => setTimeout(resolve, 15));
  yield { content: [{ type: "text", text: "Hello world" }] };
}
const streamingModel: ChatModelAdapter = { run: streamingRun };

/**
 * Captures the current `ThreadRuntime` into a ref so tests can imperatively
 * drive a real run (`.append({ role: "user", ..., startRun: true })`) the
 * same way Task 7's Composer.tsx's real send button ultimately does, without
 * needing to simulate raw textarea typing/Enter for every test. Rendered as a
 * sibling of `<ChatView />` under the same `AssistantRuntimeProvider`.
 */
function RuntimeCapture({ runtimeRef }: { runtimeRef: MutableRefObject<ThreadRuntime | null> }) {
  runtimeRef.current = useThreadRuntime();
  return null;
}

/**
 * Standard harness: one real `useLocalRuntime()` per render, matching
 * Thread.test.tsx/Message.test.tsx's own convention. No `initialMessages`
 * option — ChatView's own history-seeding effect unconditionally clears the
 * thread on mount (see ChatView.tsx's `.reset([])` doc comment), so any
 * pre-seeded runtime content would be wiped before a test could observe it;
 * tests that need specific history seed it via a mocked
 * GET /api/conversations/:id/messages response instead (`mockFetch()` below).
 */
function Harness({
  conversationId = "default",
  model = "",
  adapter = quickModel,
  runtimeRef,
  onTurnComplete,
  onOpenArtifact,
}: {
  conversationId?: string;
  model?: string;
  adapter?: ChatModelAdapter;
  runtimeRef?: MutableRefObject<ThreadRuntime | null>;
  onTurnComplete?: () => void;
  onOpenArtifact?: (artifactId: string) => void;
}) {
  const runtime = useLocalRuntime(adapter, {});
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {runtimeRef && <RuntimeCapture runtimeRef={runtimeRef} />}
      <ChatView model={model} conversationId={conversationId} onTurnComplete={onTurnComplete} onOpenArtifact={onOpenArtifact} />
    </AssistantRuntimeProvider>
  );
}

/**
 * Cross-conversation-isolation harness (item 5): unlike `Harness` above, the
 * `useLocalRuntime()` call lives in a component that is NOT remounted when
 * `conversationId` changes — only `<ChatView key={conversationId} />` is —
 * mirroring App.tsx's real structure exactly: `useAssistantChatRuntime()`
 * (the runtime) is called once per `App()` render and persists across
 * conversation switches, while only `<ChatView key={state.activeConv} .../>`
 * remounts (App.tsx's own doc comment on that `key`).
 */
function IsolationHarness({ conversationId, adapter = quickModel }: { conversationId: string; adapter?: ChatModelAdapter }) {
  const runtime = useLocalRuntime(adapter, {});
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ChatView key={conversationId} model="" conversationId={conversationId} />
    </AssistantRuntimeProvider>
  );
}

let originalFetch: typeof fetch;

afterEach(() => {
  if (originalFetch) global.fetch = originalFetch;
  cleanup();
});

function mockFetch(handlers: { messages?: unknown; lastError?: { message: string | null } }): FetchCall[] {
  const calls: FetchCall[] = [];
  originalFetch = global.fetch;
  global.fetch = mock((url: string) => {
    calls.push({ url });
    if (url.includes("/last-error")) {
      return Promise.resolve(jsonResponse(handlers.lastError ?? { message: null }));
    }
    if (url.includes("/messages")) {
      return Promise.resolve(jsonResponse(handlers.messages ?? []));
    }
    // Any other URL (in particular a pending-interaction poll, if one ever
    // regressed back in — see the "old approval chip is gone" describe block
    // below) is deliberately NOT handled here, so a stray call surfaces loudly
    // in test output instead of being silently served a default 200.
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  }) as unknown as typeof fetch;
  return calls;
}

describe("ChatView (Task 8) — AC-8.1: history replay on load", () => {
  test("the 'default' conversation's real prior messages render via Task 7's components, not the empty-thread greeting", async () => {
    mockFetch({
      messages: [
        { id: "history-0", role: "user", content: "What's the weather?" },
        { id: "history-1", role: "assistant", content: "I can't check live weather, but I can help with other things." },
      ],
    });

    render(<Harness conversationId="default" />);

    await waitFor(() => expect(screen.getByText("What's the weather?")).toBeTruthy());
    expect(screen.getByText("I can't check live weather, but I can help with other things.")).toBeTruthy();

    // Task 7's Thread.tsx welcome state ("How can I help you today?") only
    // shows when the thread has zero messages — direct re-verification that
    // this is NOT an empty greeting, matching wire-chat-backend's original
    // "Default conversation's pre-existing messages show on app load" fix.
    expect(screen.queryByText("How can I help you today?")).toBeNull();
  });

  test("a brand-new conversation with no prior history legitimately shows the empty-thread welcome state", async () => {
    mockFetch({ messages: [] });

    render(<Harness conversationId="new-conv" />);

    await waitFor(() => expect(screen.getByText("How can I help you today?")).toBeTruthy());
  });

  test("a failed history fetch leaves the transcript empty rather than throwing or inventing content", async () => {
    originalFetch = global.fetch;
    global.fetch = mock(() => Promise.reject(new Error("network down"))) as unknown as typeof fetch;

    render(<Harness conversationId="default" />);

    await waitFor(() => expect(screen.getByText("How can I help you today?")).toBeTruthy());
  });
});

describe("ChatView (Task 8) — AC-8.2: error banner for failed turns", () => {
  test("a failed turn (real provider error shape) shows the error banner with the summarized message", async () => {
    mockFetch({
      messages: [],
      lastError: {
        message: '402: {"message": "Insufficient credits on this OpenRouter key.", "code": 402}',
      },
    });

    const runtimeRef: MutableRefObject<ThreadRuntime | null> = { current: null };
    render(<Harness conversationId="default" runtimeRef={runtimeRef} />);
    await waitFor(() => expect(runtimeRef.current).not.toBeNull());

    runtimeRef.current!.append("hi");

    await waitFor(() => expect(screen.getByText("Insufficient credits on this OpenRouter key.")).toBeTruthy());
    // The raw "402: " HTTP-status prefix and surrounding JSON wrapper must never
    // leak into the rendered banner — summarizeError()'s whole job.
    expect(screen.queryByText(/^402:/)).toBeNull();
  });

  test("a successful turn shows no error banner", async () => {
    mockFetch({ messages: [], lastError: { message: null } });

    const runtimeRef: MutableRefObject<ThreadRuntime | null> = { current: null };
    render(<Harness conversationId="default" runtimeRef={runtimeRef} />);
    await waitFor(() => expect(runtimeRef.current).not.toBeNull());

    runtimeRef.current!.append("hi");

    await waitFor(() => expect(screen.getByText("OK")).toBeTruthy());
    expect(screen.queryByText(/Insufficient credits/)).toBeNull();
  });

  test("sending a new turn clears a stale error banner from the previous turn", async () => {
    const calls = mockFetch({
      messages: [],
      lastError: { message: "402: {\"message\": \"first turn failed\"}" },
    });

    const runtimeRef: MutableRefObject<ThreadRuntime | null> = { current: null };
    render(<Harness conversationId="default" runtimeRef={runtimeRef} />);
    await waitFor(() => expect(runtimeRef.current).not.toBeNull());

    runtimeRef.current!.append("first");
    await waitFor(() => expect(screen.getByText("first turn failed")).toBeTruthy());

    // Second turn succeeds — the stale banner must clear the instant the new
    // turn starts (not just once the new turn's own last-error check settles).
    calls.length = 0;
    global.fetch = mock((url: string) => {
      calls.push({ url });
      if (url.includes("/last-error")) return Promise.resolve(jsonResponse({ message: null }));
      return Promise.resolve(jsonResponse([]));
    }) as unknown as typeof fetch;

    runtimeRef.current!.append("second");
    await waitFor(() => expect(screen.queryByText("first turn failed")).toBeNull());
  });
});

describe("ChatView (Task 8) — AC-8.3: assistant responses stream in visibly", () => {
  test("a streaming response renders growing partial text through Task 7's Message component, not all at once", async () => {
    mockFetch({ messages: [] });

    const runtimeRef: MutableRefObject<ThreadRuntime | null> = { current: null };
    render(<Harness conversationId="default" adapter={streamingModel} runtimeRef={runtimeRef} />);
    await waitFor(() => expect(runtimeRef.current).not.toBeNull());

    runtimeRef.current!.append("hi");

    // First a smaller intermediate chunk is visible...
    await waitFor(() => expect(screen.getByText("Hel")).toBeTruthy());
    // ...before the final, complete text ever appears — proving the message
    // rendered incrementally rather than materializing complete in one paint.
    await waitFor(() => expect(screen.getByText("Hello world")).toBeTruthy());
  });
});

describe("ChatView (Task 8) — item 3: the old web_fetch approval chip is gone", () => {
  test("ChatView.tsx's source contains no remaining pendingConfirm state or pending-interaction poll", async () => {
    const source = await Bun.file(new URL("./ChatView.tsx", import.meta.url)).text();
    expect(source).not.toMatch(/pendingConfirm/);
    expect(source).not.toMatch(/pending-interaction/);
    expect(source).not.toMatch(/getResolveToken/);
    expect(source).not.toMatch(/@copilotkit\//);
  });

  test("no fetch call to a pending-interaction endpoint is ever made, even while a turn is running", async () => {
    const calls = mockFetch({ messages: [] });
    const runtimeRef: MutableRefObject<ThreadRuntime | null> = { current: null };
    render(<Harness conversationId="default" runtimeRef={runtimeRef} adapter={streamingModel} />);
    await waitFor(() => expect(runtimeRef.current).not.toBeNull());

    runtimeRef.current!.append("hi");
    await waitFor(() => expect(screen.getByText("Hello world")).toBeTruthy());

    expect(calls.some((c) => c.url.includes("pending-interaction"))).toBe(false);
    expect(screen.queryByText("approval needed")).toBeNull();
  });
});

describe("ChatView (Task 8) — item 4: onTurnComplete/onOpenArtifact prop contract", () => {
  test("onTurnComplete fires exactly once, only on the isRunning true -> false edge (not on mount)", async () => {
    mockFetch({ messages: [] });
    let turnCompleteCount = 0;
    const runtimeRef: MutableRefObject<ThreadRuntime | null> = { current: null };

    render(<Harness conversationId="default" runtimeRef={runtimeRef} onTurnComplete={() => (turnCompleteCount += 1)} />);
    await waitFor(() => expect(runtimeRef.current).not.toBeNull());

    // Give the mount/history-seed effects a moment to settle — must not fire on mount.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(turnCompleteCount).toBe(0);

    runtimeRef.current!.append("hi");
    await waitFor(() => expect(screen.getByText("OK")).toBeTruthy());
    await waitFor(() => expect(turnCompleteCount).toBe(1));

    // Stays at 1 — not re-fired on subsequent unrelated renders.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(turnCompleteCount).toBe(1);
  });

  test("onOpenArtifact fires with the clicked publish_artifact tool call's literal id", async () => {
    // Seeded via the real GET /messages history path (toThreadMessageLikeHistory()),
    // not useLocalRuntime()'s own `initialMessages` — ChatView's history-seeding
    // effect unconditionally clears the thread on mount (this file's "AC-8.1"
    // describe block above), so anything seeded only via `initialMessages` would
    // be wiped before this test could observe it. Exercising the real fetch path
    // here also happens to double-check that a history-replayed tool call renders
    // through the same publishArtifactToolUI registration as a live one.
    mockFetch({
      messages: [
        {
          id: "history-0",
          role: "assistant",
          toolCalls: [
            {
              type: "function",
              id: "call-1",
              function: {
                name: "publish_artifact",
                arguments: JSON.stringify({ id: "artifact-42", title: "Quarterly Report", language: "markdown" }),
              },
            },
          ],
        },
      ],
    });

    let openedArtifactId: string | undefined;
    render(<Harness conversationId="default" onOpenArtifact={(id) => (openedArtifactId = id)} />);

    await waitFor(() => expect(screen.getByText("Quarterly Report")).toBeTruthy());
    fireEvent.click(screen.getByText("Quarterly Report"));

    expect(openedArtifactId).toBe("artifact-42");
  });
});

// assistant-ui-migration/AC-15.1: also the re-verification that cross-conversation
// isolation (wire-chat-backend's original catalog entry) holds under the new
// Assistant UI runtime -- re-confirmed in Task 15, no new test needed since this
// one already covers the exact behavior AC-15.1 requires.
describe("ChatView (Task 8) — item 5: cross-conversation isolation", () => {
  test("switching conversationId clears the previous conversation's messages and seeds the new one's real history", async () => {
    const calls: FetchCall[] = [];
    originalFetch = global.fetch;
    global.fetch = mock((url: string) => {
      calls.push({ url });
      if (url.includes("/last-error")) return Promise.resolve(jsonResponse({ message: null }));
      if (url.includes("/conversations/conv-A/messages")) {
        return Promise.resolve(jsonResponse([{ id: "history-0", role: "user", content: "Message from conversation A" }]));
      }
      if (url.includes("/conversations/conv-B/messages")) {
        return Promise.resolve(jsonResponse([{ id: "history-0", role: "user", content: "Message from conversation B" }]));
      }
      return Promise.resolve(jsonResponse([]));
    }) as unknown as typeof fetch;

    const { rerender } = render(<IsolationHarness conversationId="conv-A" />);
    await waitFor(() => expect(screen.getByText("Message from conversation A")).toBeTruthy());

    rerender(<IsolationHarness conversationId="conv-B" />);

    await waitFor(() => expect(screen.getByText("Message from conversation B")).toBeTruthy());
    // The critical assertion: conversation A's message must NOT still be visible
    // once B's history has loaded — direct re-verification of wire-chat-backend's
    // "Cross-conversation message isolation" catalog entry under Assistant UI.
    expect(screen.queryByText("Message from conversation A")).toBeNull();

    // Switching back to A re-fetches and re-shows A's own history, not B's.
    rerender(<IsolationHarness conversationId="conv-A" />);
    await waitFor(() => expect(screen.getByText("Message from conversation A")).toBeTruthy());
    expect(screen.queryByText("Message from conversation B")).toBeNull();
  });

  test("switching to a conversation with no history clears the previous conversation's messages rather than leaving them visible", async () => {
    originalFetch = global.fetch;
    global.fetch = mock((url: string) => {
      if (url.includes("/last-error")) return Promise.resolve(jsonResponse({ message: null }));
      if (url.includes("/conversations/conv-A/messages")) {
        return Promise.resolve(jsonResponse([{ id: "history-0", role: "user", content: "Message from conversation A" }]));
      }
      return Promise.resolve(jsonResponse([]));
    }) as unknown as typeof fetch;

    const { rerender } = render(<IsolationHarness conversationId="conv-A" />);
    await waitFor(() => expect(screen.getByText("Message from conversation A")).toBeTruthy());

    rerender(<IsolationHarness conversationId="conv-empty" />);

    await waitFor(() => expect(screen.getByText("How can I help you today?")).toBeTruthy());
    expect(screen.queryByText("Message from conversation A")).toBeNull();
  });
});
