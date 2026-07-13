import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useCallback, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Role, TextMessage } from "@copilotkit/runtime-client-gql";

/**
 * Task 12 critical-bug-fix CopilotKit-mocking pattern (supersedes Task 12's original
 * mock — see git history for that version and its now-stale header comment).
 *
 * Task 12's original mock modeled "whatever the real CopilotKit singleton agent
 * currently holds" as a thread store keyed by an externally-set `activeThreadId`,
 * flipped directly via a test-only `setActiveThread()` helper. That mock passed even
 * though the REAL installed library sent the SAME threadId for every conversation
 * (verified via live E2E reproduction, see ChatView.tsx's call-site comment) — because
 * the mock never exercised the actual mechanism ChatView uses to pick a thread, it just
 * asserted rendering was correct *given* per-conversation data that nothing in the real
 * app was actually producing.
 *
 * This version closes that gap by also mocking `useThreads()` (the hook ChatView now
 * calls to route `conversationId` onto the shared thread store) and driving thread
 * selection exclusively through ChatView's own `conversationId` prop + effect, the same
 * path production code takes — not a side-channel test helper. `setThreadId` mutates the
 * same module-level `activeThreadId` the real ThreadsProvider's `setThreadId` mutates
 * conceptually (a single shared value, since CopilotKit's `agent` is a singleton), and
 * forces a re-render the way the real ThreadsProvider's `useState` would.
 *
 * This still does NOT model the real HttpAgent's actual message-persistence behavior
 * (the real `agent.messages` singleton gets cleared, with nothing to refill it from, on
 * every thread switch — see ChatView.tsx's "known remaining gap" comment). This mock's
 * per-thread store deliberately keeps each thread's messages indefinitely so these tests
 * can prove ChatView's own rendering logic (greeting vs. transcript, local draft-state
 * reset) is correct given each thread's data — full-fidelity proof that the real app's
 * history persists across a switch-and-back requires the live E2E check documented in
 * the Task 12 critical-fix commit, not this file.
 */

type MockMessage = InstanceType<typeof TextMessage>;

interface ThreadState {
  messages: MockMessage[];
  isLoading: boolean;
}

let activeThreadId = "default";
const threadStore = new Map<string, ThreadState>();
const threadIdRequestLog: string[] = [];

function threadFor(id: string): ThreadState {
  let state = threadStore.get(id);
  if (!state) {
    state = { messages: [], isLoading: false };
    threadStore.set(id, state);
  }
  return state;
}

function resetThreads(): void {
  threadStore.clear();
  activeThreadId = "default";
  threadIdRequestLog.length = 0;
}

// Task 12.1 critical-bug-fix note: `useCopilotChat()` itself is never called by
// ChatView.tsx anymore — the component reads messages via `useCopilotChatInternal()`
// instead, because the real installed @copilotkit/react-core@1.62.3 only populates a
// `messages` field there (not the `visibleMessages` field `useCopilotChat()` wraps it in,
// which is unconditionally `undefined` at runtime; see ChatView.tsx's call-site comment).
// This mock therefore mirrors `useCopilotChatInternal()`'s real shape — returning raw
// AG-UI-format messages under `messages` — and ChatView.tsx itself is responsible for
// running `aguiToGQL()` over them, same as it does against the real library. Mocking under
// the old `visibleMessages` key (as this file originally did) would validate nothing: it
// would pass even if ChatView.tsx regressed back to reading the always-`undefined`
// `visibleMessages` field, because the mock — not the real library's actual behavior —
// would be supplying the data.
mock.module("@copilotkit/react-core", () => ({
  useCopilotChatInternal: () => {
    const state = threadFor(activeThreadId);
    return {
      messages: state.messages,
      isLoading: state.isLoading,
      appendMessage: async (message: MockMessage) => {
        state.messages = [...state.messages, message];
      },
    };
  },
  // Mirrors ThreadsContextValue's real shape (@copilotkit/react-core's
  // index.d.mts): { threadId, setThreadId, isThreadIdExplicit }. Backed by real
  // React state (via useState, a real hook — safe to call here since this factory's
  // functions run as hooks inside ChatView's own render) so that calling
  // `setThreadId` from ChatView's effect actually triggers a re-render, the same way
  // the real ThreadsProvider's `useState`-backed `setThreadId` does.
  useThreads: () => {
    const [id, setId] = useState(activeThreadId);
    // useCallback with an empty dep array, mirroring the real ThreadsProvider's own
    // `setThreadId` (@copilotkit/react-core's threads-context.tsx: `useCallback(...,
    // [])`) — a referentially-stable setter is required for ChatView's
    // `useEffect(() => setThreadId(conversationId), [conversationId, setThreadId])`
    // to only fire once per `conversationId` change rather than on every render.
    const setThreadId = useCallback((value: string) => {
      activeThreadId = value;
      threadIdRequestLog.push(value);
      setId(value);
    }, []);
    return { threadId: id, isThreadIdExplicit: true, setThreadId };
  },
}));

// Imported dynamically, after mock.module() above registers the replacement —
// a static top-level `import` would be hoisted ahead of that call and pick up
// the real (unmocked) module instead.
const { ChatView } = await import("./ChatView.js");

beforeEach(() => {
  resetThreads();
});

afterEach(() => {
  cleanup();
});

const GREETING_SNIPPET = "Hi! I'm pi, your desktop agent.";

describe("ChatView", () => {
  test("AC-12.1: conversationId prop drives distinct threads — a message sent in conversation A does not leak into B", async () => {
    const { rerender } = render(<ChatView key="conv-a" model="pi-2 Sonnet" conversationId="conv-a" />);

    const textarea = screen.getByPlaceholderText(/Message pi/);
    fireEvent.change(textarea, { target: { value: "Hello from A" } });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Enter" });
    });

    expect(screen.getByText("Hello from A")).toBeTruthy();
    // Both the remount key AND the conversationId prop must have carried "conv-a"
    // through to the underlying thread-routing hook — this is the exact call
    // Task 12's original implementation never made (it had no `conversationId` prop
    // at all), which is why both conversations silently shared one thread.
    expect(threadIdRequestLog).toEqual(["conv-a"]);

    // Switch to conversation B: App.tsx remounts ChatView via `key={activeConv}` AND
    // passes a new `conversationId`.
    await act(async () => {
      rerender(<ChatView key="conv-b" model="pi-2 Sonnet" conversationId="conv-b" />);
    });

    expect(threadIdRequestLog).toEqual(["conv-a", "conv-b"]);
    expect(screen.queryByText("Hello from A")).toBeNull();
    expect(screen.getByText(GREETING_SNIPPET, { exact: false })).toBeTruthy();

    // Switch back to conversation A — in this mock's idealized per-thread store (see
    // file header), A's message is still there because nothing ever discarded it.
    await act(async () => {
      rerender(<ChatView key="conv-a" model="pi-2 Sonnet" conversationId="conv-a" />);
    });

    expect(threadIdRequestLog).toEqual(["conv-a", "conv-b", "conv-a"]);
    expect(screen.getByText("Hello from A")).toBeTruthy();
  });

  test("AC-12.2: the active conversation's pre-existing messages show on load, not an empty greeting", async () => {
    const priorUser = new TextMessage({ id: "u1", content: "What's the weather API key stored as?", role: Role.User });
    const priorAssistant = new TextMessage({ id: "a1", content: "It's WEATHER_API_KEY in your .env.", role: Role.Assistant });
    threadFor("default").messages = [priorUser, priorAssistant];

    render(<ChatView key="default" model="pi-2 Sonnet" conversationId="default" />);

    expect(screen.getByText("What's the weather API key stored as?")).toBeTruthy();
    expect(screen.getByText("It's WEATHER_API_KEY in your .env.")).toBeTruthy();
    expect(screen.queryByText(GREETING_SNIPPET, { exact: false })).toBeNull();
  });

  // Regression test for the "chat transcript always renders empty" bug (found live,
  // fixed alongside Task 12's routing work). The real @copilotkit/react-core's
  // `agent.messages` — what `useCopilotChatInternal()`'s `messages` field is actually
  // sourced from — holds plain `@ag-ui/core` message objects (`{ role, content, id }`),
  // NOT `@copilotkit/runtime-client-gql` `TextMessage`/`ActionExecutionMessage` class
  // instances. This test feeds the mock exactly that plain AG-UI shape (unlike the other
  // tests above, which use GQL `TextMessage` instances directly) to prove ChatView.tsx's
  // `aguiToGQL()` conversion step actually runs and produces objects with working
  // `.isTextMessage()` methods. Before the fix, this would have failed two ways: (1) the
  // old code read `useCopilotChat().visibleMessages`, which this mock never populates
  // (it only backs `useCopilotChatInternal()`), so nothing would render; and (2) even a
  // naive `visibleMessages` -> `messages` rename without the `aguiToGQL()` conversion
  // would crash calling `.isTextMessage()` on a plain object that doesn't have it.
  test("renders plain AG-UI-shaped messages (agent.messages' real shape) via the aguiToGQL conversion", async () => {
    threadFor("default").messages = [
      { id: "u1", role: "user", content: "What's the weather API key stored as?" },
      { id: "a1", role: "assistant", content: "It's WEATHER_API_KEY in your .env." },
    ] as unknown as MockMessage[];

    render(<ChatView key="default" model="pi-2 Sonnet" conversationId="default" />);

    expect(screen.getByText("What's the weather API key stored as?")).toBeTruthy();
    expect(screen.getByText("It's WEATHER_API_KEY in your .env.")).toBeTruthy();
    expect(screen.queryByText(GREETING_SNIPPET, { exact: false })).toBeNull();
  });

  // Task 13 follow-up (App.tsx previously flagged `refreshSignal` as unwired pending
  // both Task 12 and Task 13 landing): proves ChatView's new `onTurnComplete` callback
  // fires exactly on the true -> false edge of isLoading, not on every render where
  // isLoading happens to be false — in particular, not on initial mount, where
  // isLoading already starts false.
  test("onTurnComplete fires exactly once on isLoading true->false, and not on initial mount", async () => {
    const state = threadFor("conv-turn");
    let onTurnCompleteCalls = 0;
    const onTurnComplete = () => {
      onTurnCompleteCalls += 1;
    };

    const { rerender } = render(
      <ChatView key="conv-turn" model="pi-2 Sonnet" conversationId="conv-turn" onTurnComplete={onTurnComplete} />,
    );

    // Initial mount: isLoading starts false. Must NOT fire.
    expect(onTurnCompleteCalls).toBe(0);

    // Turn starts: isLoading -> true. Still must not fire (only the false->true edge
    // happened, not true->false).
    state.isLoading = true;
    await act(async () => {
      rerender(
        <ChatView key="conv-turn" model="pi-2 Sonnet" conversationId="conv-turn" onTurnComplete={onTurnComplete} />,
      );
    });
    expect(onTurnCompleteCalls).toBe(0);

    // Turn completes: isLoading -> false. This is the true->false edge — must fire
    // exactly once.
    state.isLoading = false;
    await act(async () => {
      rerender(
        <ChatView key="conv-turn" model="pi-2 Sonnet" conversationId="conv-turn" onTurnComplete={onTurnComplete} />,
      );
    });
    expect(onTurnCompleteCalls).toBe(1);

    // Re-rendering again with isLoading still false must not fire a second time.
    await act(async () => {
      rerender(
        <ChatView key="conv-turn" model="pi-2 Sonnet" conversationId="conv-turn" onTurnComplete={onTurnComplete} />,
      );
    });
    expect(onTurnCompleteCalls).toBe(1);
  });

  // Regression test for a bug found LIVE via /tgd-verify (a real running app in a real
  // browser): useShellState.ts used to initialize `model: "pi-2 Sonnet"`, a stale mock
  // default, and this composer footer rendered it verbatim (`<span>{model}</span>`)
  // even before any real model was ever selected — visibly inconsistent with
  // MainHeader's own picker, which correctly showed the honest "Select model" empty
  // state directly above it in the same live check. The fix: `model` now starts as ""
  // (App.tsx passes `state.model` straight through), and this component must render
  // nothing in the footer rather than ever falling back to a fake name.
  test("composer footer renders nothing (no fake model name) when model is empty on initial load", () => {
    render(<ChatView key="default" model="" conversationId="default" />);

    expect(screen.queryByText("pi-2 Sonnet")).toBeNull();
    // The textarea and send button must still render normally — only the model label
    // span is conditionally omitted.
    expect(screen.getByPlaceholderText(/Message pi/)).toBeTruthy();
  });
});
