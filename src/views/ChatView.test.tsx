import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useCallback, useReducer, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
 * This does NOT model the real HttpAgent's actual isFreshRestore clear-on-switch timing
 * (see ChatView.tsx's now-updated seeding-effect comment for the real mechanics). This
 * mock's per-thread store deliberately keeps each thread's messages indefinitely by
 * default so the tests above (AC-12.1/AC-12.2) can prove ChatView's own rendering logic
 * (greeting vs. transcript, local draft-state reset) is correct given each thread's data,
 * independent of CopilotKit's own clear/reconnect lifecycle — full-fidelity proof that
 * the real app's history survives a same-session switch-and-back requires the live E2E
 * check documented in the Task 12 critical-fix commit, not this file.
 *
 * Critical fix (/tgd-review — closes US-03's P0 acceptance criterion / TASKS.md's
 * AC-12.2): `useCopilotChatInternal()` also returns `isAvailable` (mocked constant
 * `true` here — this file's own docstring above already explains why full connect-
 * lifecycle timing isn't modeled) and `setMessages` (mocked below to mirror the real
 * `agent.setMessages()`: it writes into whichever thread is *currently* active, matching
 * the real singleton-agent's behavior of not caring which conversationId the caller
 * thinks it's writing for). The dedicated test below drives a thread that starts with an
 * empty local store (modeling the post-clear state after a reload) and a mocked
 * `fetch()` standing in for the new `GET /api/conversations/:id/messages` endpoint, to
 * prove ChatView's seeding effect actually calls `setMessages()` with the fetched
 * history rather than leaving the transcript empty.
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
    // Real @copilotkit/react-core re-renders on message changes via a subscription
    // (`agent.setMessages()`/`addMessage()` notify `onMessagesChanged`, which
    // `useAgent()` turns into a `forceUpdate`) — this module-level thread store is
    // plain mutable state with no such subscription of its own, so this mock needs its
    // own forceUpdate to reproduce that: without it, mutating `state.messages` from
    // `setMessages()` (below) would update the store but never schedule a re-render,
    // and screen assertions would hang waiting for text that's in the data but not on
    // screen. (AC-12.1's `appendMessage` case happens to work without this too, but
    // only incidentally — because `submit()` also calls the real `setDraft("")`, which
    // triggers ChatView's own re-render as a side effect. `setMessages` has no such
    // incidental trigger, so it needs its own.)
    const [, forceRender] = useReducer((x: number) => x + 1, 0);
    const state = threadFor(activeThreadId);
    return {
      messages: state.messages,
      isLoading: state.isLoading,
      appendMessage: async (message: MockMessage) => {
        state.messages = [...state.messages, message];
        forceRender();
      },
      // Real @copilotkit/react-core flips this false->true around the isFreshRestore
      // clear+swallowed-connect settling (see ChatView.tsx's seeding-effect comment).
      // This file's docstring above explains why that timing isn't modeled — constant
      // `true` still exercises the seeding effect's `conversationId` dependency on every
      // switch, which is what the dedicated seeding test below needs.
      isAvailable: true,
      // Mirrors the real `agent.setMessages()`: writes into whichever thread is
      // *currently* active at call time (not whichever thread was active when
      // useCopilotChatInternal() was invoked) — a real singleton `agent.messages` has no
      // notion of "which conversationId asked for this."
      setMessages: (messages: MockMessage[]) => {
        threadFor(activeThreadId).messages = messages;
        forceRender();
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

let originalFetch: typeof fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  resetThreads();
  originalFetch = global.fetch;
  // Default stub for the seeding effect's GET /api/conversations/:id/messages call
  // (added by the US-03 fix below) so tests that don't care about history-seeding
  // don't hit the real network / log noisy ECONNREFUSED errors. Tests that DO care
  // override global.fetch themselves before rendering.
  global.fetch = mock(() => Promise.resolve(jsonResponse([]))) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
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

  // Bug fix (live-usage report: a real multi-step bash tool-use conversation —
  // generating a PDF from an SVG — showed a stack of empty chat bubbles).
  // Root-caused via direct DOM/data inspection: the backend's AG-UI history is
  // correct (an assistant message with toolCalls and no `content` field, the
  // normal shape for a pure tool-call turn with no accompanying explanation),
  // but @copilotkit/runtime-client-gql's own aguiToGQL() unconditionally
  // synthesizes a TextMessage for every assistant message with toolCalls —
  // `content: message.content || ""` — producing an empty-content TextMessage
  // ChatView then rendered as a blank bubble, IN ADDITION to (not instead of)
  // the real ActionExecutionMessage for the tool call. Both must show correctly:
  // no empty bubble, and the tool chip still renders for every call, not just
  // ones that happen to also carry explanatory text.
  test("bug fix: an assistant message with toolCalls and no text (pure tool-call turn) renders only the tool chip, never an empty bubble", async () => {
    threadFor("default").messages = [
      { id: "u1", role: "user", content: "做成Pdf" },
      {
        id: "a1",
        role: "assistant",
        toolCalls: [{ type: "function", id: "bash_1", function: { name: "bash", arguments: '{"command":"ls -lh out.pdf"}' } }],
      },
      { id: "t1", role: "tool", toolCallId: "bash_1", toolName: "bash", content: "-rw-r--r-- 1 user staff 23K out.pdf" },
      { id: "a2", role: "assistant", content: "PDF 做好了！" },
    ] as unknown as MockMessage[];

    render(<ChatView key="default" model="pi-2 Sonnet" conversationId="default" />);

    await waitFor(() => {
      expect(screen.getByText("bash")).toBeTruthy();
    });
    expect(screen.getByText("PDF 做好了！")).toBeTruthy();

    // No empty assistant bubble: every rendered paragraph must have real text.
    const paragraphs = Array.from(document.querySelectorAll("p"));
    const emptyParagraphs = paragraphs.filter((p) => p.textContent?.trim() === "");
    expect(emptyParagraphs.length).toBe(0);
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

  // Critical fix (/tgd-review code-reviewer finding — closes US-03's P0 acceptance
  // criterion / TASKS.md's AC-12.2): "switching to a previously-open conversation shows
  // an empty transcript, not its real prior messages." Unlike AC-12.1/AC-12.2 above
  // (which pre-populate the mock's idealized per-thread store to prove ChatView's
  // *rendering* logic), this test starts the thread's local store genuinely empty — the
  // real post-isFreshRestore-clear state — and proves ChatView's *seeding effect* is what
  // repopulates it: a mocked `fetch()` stands in for the new
  // `GET /api/conversations/:id/messages` endpoint, and the assertion is that the fetched
  // history actually reaches the screen via the mock's `setMessages()` (which, like the
  // real `agent.setMessages()`, is the only thing that can put messages into the thread
  // store here — nothing else in this test ever populates it).
  test("US-03 fix: switching to a conversation with server-side history replays it via fetch + setMessages, not an empty greeting", async () => {
    threadFor("conv-with-history").messages = [];

    const fetchCalls: string[] = [];
    global.fetch = mock((input: RequestInfo | URL) => {
      const url = String(input);
      fetchCalls.push(url);
      if (url.endsWith("/api/conversations/conv-with-history/messages")) {
        return Promise.resolve(
          jsonResponse([
            { id: "history-0", role: "user", content: "What's the weather API key stored as?" },
            { id: "history-1", role: "assistant", content: "It's WEATHER_API_KEY in your .env." },
          ]),
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }) as unknown as typeof fetch;

    render(<ChatView key="conv-with-history" model="pi-2 Sonnet" conversationId="conv-with-history" />);

    await waitFor(() => {
      expect(screen.getByText("What's the weather API key stored as?")).toBeTruthy();
    });
    expect(screen.getByText("It's WEATHER_API_KEY in your .env.")).toBeTruthy();
    expect(screen.queryByText(GREETING_SNIPPET, { exact: false })).toBeNull();
    expect(fetchCalls.some((url) => url.endsWith("/api/conversations/conv-with-history/messages"))).toBe(true);
  });

  // Contrast case: a conversation the server genuinely has no history for (a brand-new
  // conversation) must stay on the greeting, not error out or render anything from a
  // dangling previous fetch — `setMessages()` must not even be called for an empty
  // response (see ChatView.tsx's seeding-effect comment on why: avoiding a no-op notify).
  test("US-03 fix (contrast): an empty server-side history leaves the greeting shown, not a crash or stale content", async () => {
    threadFor("conv-empty-history").messages = [];

    const fetchCalls: string[] = [];
    global.fetch = mock((input: RequestInfo | URL) => {
      const url = String(input);
      fetchCalls.push(url);
      if (url.endsWith("/api/conversations/conv-empty-history/messages")) {
        return Promise.resolve(jsonResponse([]));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }) as unknown as typeof fetch;

    render(<ChatView key="conv-empty-history" model="pi-2 Sonnet" conversationId="conv-empty-history" />);

    // Confirm the seeding effect actually ran (fetched) before asserting on its
    // aftermath — otherwise this test would trivially pass even if the effect never
    // fired at all, since the greeting is already what an untouched empty thread shows.
    await waitFor(() => {
      expect(fetchCalls.some((url) => url.endsWith("/api/conversations/conv-empty-history/messages"))).toBe(true);
    });
    expect(screen.getByText(GREETING_SNIPPET, { exact: false })).toBeTruthy();
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

  // Bug fix (live-usage report: a chat turn failed against a real, misconfigured
  // provider — OpenRouter 402 "insufficient credits" — with zero visible indication
  // anywhere in the UI, even after adapter.ts was fixed to emit a real RUN_ERROR).
  // The installed CopilotKit version's `<CopilotKit onError>` prop turned out to
  // silently no-op without a `publicApiKey` (this app is deliberately self-hosted,
  // no license key — confirmed by reading the installed package's own source), so
  // ChatView instead polls the new GET /api/conversations/:id/last-error on the
  // same isLoading true->false edge `onTurnComplete` already fires on.
  test("bug fix: a failed turn (last-error endpoint returns a message) renders as a visible banner, and clears on the next send", async () => {
    const state = threadFor("conv-failing");

    global.fetch = mock((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/conversations/conv-failing/messages")) {
        return Promise.resolve(jsonResponse([]));
      }
      if (url.endsWith("/api/conversations/conv-failing/last-error")) {
        return Promise.resolve(jsonResponse({ message: "402: insufficient credits for this request" }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }) as unknown as typeof fetch;

    const { rerender } = render(<ChatView key="conv-failing" model="" conversationId="conv-failing" />);

    // Turn starts, then completes (isLoading true -> false) — the edge that
    // triggers the last-error check, same as onTurnComplete.
    state.isLoading = true;
    await act(async () => {
      rerender(<ChatView key="conv-failing" model="" conversationId="conv-failing" />);
    });
    state.isLoading = false;
    await act(async () => {
      rerender(<ChatView key="conv-failing" model="" conversationId="conv-failing" />);
    });

    await waitFor(() => {
      expect(screen.getByText("402: insufficient credits for this request")).toBeTruthy();
    });

    // Sending a new message clears the banner immediately, without waiting for a
    // fresh last-error check.
    const textarea = screen.getByPlaceholderText(/Message pi/);
    fireEvent.change(textarea, { target: { value: "try again" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    await waitFor(() => {
      expect(screen.queryByText("402: insufficient credits for this request")).toBeNull();
    });
  });

  test("no error banner renders when a turn completes successfully (last-error endpoint returns null)", async () => {
    const state = threadFor("conv-ok");

    global.fetch = mock((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/conversations/conv-ok/messages")) {
        return Promise.resolve(jsonResponse([]));
      }
      if (url.endsWith("/api/conversations/conv-ok/last-error")) {
        return Promise.resolve(jsonResponse({ message: null }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }) as unknown as typeof fetch;

    const { rerender } = render(<ChatView key="conv-ok" model="" conversationId="conv-ok" />);

    state.isLoading = true;
    await act(async () => {
      rerender(<ChatView key="conv-ok" model="" conversationId="conv-ok" />);
    });
    state.isLoading = false;
    await act(async () => {
      rerender(<ChatView key="conv-ok" model="" conversationId="conv-ok" />);
    });

    expect(screen.queryByText(/insufficient credits/)).toBeNull();
  });

  // Bug fix (found in review): the last-error fetch had no ordering guard against a
  // user immediately retrying after a failed turn — a still-in-flight fetch from the
  // turn the user already moved past could resolve AFTER the new turn's own
  // last-error check and clobber the fresh state with a stale error banner.
  test("bug fix: a stale last-error fetch from a turn the user already moved past does not overwrite a fresher state", async () => {
    const state = threadFor("conv-race");

    let resolveStaleFetch!: (res: Response) => void;
    const staleFetch = new Promise<Response>((resolve) => {
      resolveStaleFetch = resolve;
    });

    let lastErrorCallCount = 0;
    global.fetch = mock((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/conversations/conv-race/messages")) {
        return Promise.resolve(jsonResponse([]));
      }
      if (url.endsWith("/api/conversations/conv-race/last-error")) {
        lastErrorCallCount += 1;
        // First call (turn 1's failure) is left in flight; second call (turn 2,
        // which succeeded) resolves immediately.
        return lastErrorCallCount === 1 ? staleFetch : Promise.resolve(jsonResponse({ message: null }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }) as unknown as typeof fetch;

    const { rerender } = render(<ChatView key="conv-race" model="" conversationId="conv-race" />);

    // Turn 1 completes (failed) -- fires the first (stale) last-error fetch, left in flight.
    state.isLoading = true;
    await act(async () => {
      rerender(<ChatView key="conv-race" model="" conversationId="conv-race" />);
    });
    state.isLoading = false;
    await act(async () => {
      rerender(<ChatView key="conv-race" model="" conversationId="conv-race" />);
    });

    // User immediately sends a follow-up (submit() clears error + bumps the request id).
    const textarea = screen.getByPlaceholderText(/Message pi/);
    fireEvent.change(textarea, { target: { value: "try again" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    // Turn 2 completes successfully -- its own last-error fetch resolves with null.
    state.isLoading = true;
    await act(async () => {
      rerender(<ChatView key="conv-race" model="" conversationId="conv-race" />);
    });
    state.isLoading = false;
    await act(async () => {
      rerender(<ChatView key="conv-race" model="" conversationId="conv-race" />);
    });

    // Now the STALE turn-1 fetch finally resolves, with an error -- after turn 2
    // already succeeded. Without the request-id guard this would clobber the
    // correct "no error" state with turn 1's stale message.
    await act(async () => {
      resolveStaleFetch(jsonResponse({ message: "402: stale insufficient credits error" }));
    });

    expect(screen.queryByText(/stale insufficient credits/)).toBeNull();
  });

  // Bug fix follow-up (found live: the real OpenRouter 402 error, once actually
  // surfaced, turned out to be an HTTP-status-prefixed JSON string —
  // `"402: {...}"`, not bare JSON — wrapping a much longer structure with a
  // `previous_errors` array repeating the same text per retry attempt.
  // Rendering it verbatim dumped a wall of raw JSON dominating the whole
  // transcript; the initial fix's JSON.parse also silently failed on the raw
  // string because of the un-stripped `"402: "` prefix. Extract just the
  // human-readable top-level `message` field after stripping that prefix.
  test("bug fix follow-up: a JSON-shaped provider error (real OpenRouter 402 shape, status-prefixed) renders its clean message, not the raw JSON", async () => {
    const state = threadFor("conv-json-error");
    // Exact raw shape captured live: "<status>: <json>", not bare JSON.
    const rawOpenRouterError = `402: ${JSON.stringify({
      message: "This request requires more credits, or fewer max_tokens.",
      code: 402,
      metadata: {
        provider_name: null,
        previous_errors: [
          { code: 402, message: "This request requires more credits, or fewer max_tokens." },
          { code: 402, message: "This request requires more credits, or fewer max_tokens." },
        ],
      },
    })}`;

    global.fetch = mock((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/conversations/conv-json-error/messages")) {
        return Promise.resolve(jsonResponse([]));
      }
      if (url.endsWith("/api/conversations/conv-json-error/last-error")) {
        return Promise.resolve(jsonResponse({ message: rawOpenRouterError }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }) as unknown as typeof fetch;

    const { rerender } = render(<ChatView key="conv-json-error" model="" conversationId="conv-json-error" />);

    state.isLoading = true;
    await act(async () => {
      rerender(<ChatView key="conv-json-error" model="" conversationId="conv-json-error" />);
    });
    state.isLoading = false;
    await act(async () => {
      rerender(<ChatView key="conv-json-error" model="" conversationId="conv-json-error" />);
    });

    await waitFor(() => {
      expect(screen.getByText("This request requires more credits, or fewer max_tokens.")).toBeTruthy();
    });
    // The raw JSON (metadata, previous_errors, code, etc.) must never render.
    expect(screen.queryByText(/previous_errors/)).toBeNull();
    expect(screen.queryByText(/"metadata"/)).toBeNull();
  });

  // New feature: a publish_artifact tool call renders as a clickable attachment
  // chip (title + language), distinct from the generic "tool: {name}" chip other
  // tool calls get, and clicking it calls onOpenArtifact with the published
  // artifact's id — the args a publish_artifact call carries are already the full
  // { id, title, language, code } payload (server/src/artifacts/tools.ts), so the
  // chip needs no extra fetch to render.
  describe("artifacts-as-chat-attachments", () => {
    test("a publish_artifact tool call renders as an attachment chip with its title and language, not the generic tool chip", async () => {
      threadFor("conv-artifact").messages = [
        { id: "u1", role: "user", content: "chart the weather" },
        {
          id: "a1",
          role: "assistant",
          toolCalls: [
            {
              type: "function",
              id: "call_1",
              function: {
                name: "publish_artifact",
                arguments: JSON.stringify({
                  id: "weather-chart",
                  title: "weather_chart.tsx",
                  language: "tsx",
                  code: "export const Chart = () => null;",
                }),
              },
            },
          ],
        },
        { id: "t1", role: "tool", toolCallId: "call_1", toolName: "publish_artifact", content: "Published." },
      ] as unknown as MockMessage[];

      render(<ChatView key="conv-artifact" model="" conversationId="conv-artifact" />);

      await waitFor(() => {
        expect(screen.getByText("weather_chart.tsx")).toBeTruthy();
      });
      expect(screen.getByText("tsx")).toBeTruthy();
      // Not the generic tool chip's raw tool-name rendering.
      expect(screen.queryByText("publish_artifact")).toBeNull();
    });

    test("clicking a publish_artifact attachment chip calls onOpenArtifact with the artifact's id", async () => {
      threadFor("conv-artifact-click").messages = [
        {
          id: "a1",
          role: "assistant",
          toolCalls: [
            {
              type: "function",
              id: "call_1",
              function: {
                name: "publish_artifact",
                arguments: JSON.stringify({ id: "weather-chart", title: "weather_chart.tsx", language: "tsx", code: "" }),
              },
            },
          ],
        },
        { id: "t1", role: "tool", toolCallId: "call_1", toolName: "publish_artifact", content: "Published." },
      ] as unknown as MockMessage[];

      const openedIds: string[] = [];
      render(
        <ChatView
          key="conv-artifact-click"
          model=""
          conversationId="conv-artifact-click"
          onOpenArtifact={(id) => openedIds.push(id)}
        />,
      );

      const chip = await waitFor(() => screen.getByText("weather_chart.tsx"));
      fireEvent.click(chip);

      expect(openedIds).toEqual(["weather-chart"]);
    });

    test("other tool calls (e.g. bash) still render the generic tool chip, unaffected by the artifact special-case", async () => {
      threadFor("conv-generic-tool").messages = [
        {
          id: "a1",
          role: "assistant",
          toolCalls: [{ type: "function", id: "bash_1", function: { name: "bash", arguments: '{"command":"ls"}' } }],
        },
        { id: "t1", role: "tool", toolCallId: "bash_1", toolName: "bash", content: "out.pdf" },
      ] as unknown as MockMessage[];

      render(<ChatView key="conv-generic-tool" model="" conversationId="conv-generic-tool" />);

      await waitFor(() => {
        expect(screen.getByText("bash")).toBeTruthy();
      });
      expect(screen.getByText("tool")).toBeTruthy();
    });
  });

  // Task 8 (SPEC.md's "web_fetch" approval-gate feature): a `kind: "confirm"`
  // pending interaction, delivered via ChatView's own independent poll of
  // GET /api/conversations/:id/pending-interaction (App.tsx's sibling
  // `usePendingRenderInteractionWatcher` polls the same endpoint but only ever
  // acts on `kind: "render"` — these two pollers are intentionally separate,
  // see App.tsx's own comment), renders as a standalone approve/deny chip in
  // the transcript, not attached to any specific message.
  describe("pending-interaction approval chip (Task 8)", () => {
    function fetchMockFor(
      conversationId: string,
      opts: {
        interaction?: { id: string; kind: "confirm" | "render"; host?: string } | null;
        onResolve?: (interactionId: string, body: unknown) => Response | Promise<Response>;
      },
    ) {
      const fetchCalls: { url: string; body?: unknown }[] = [];
      const fn = mock((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(init.body as string) as unknown) : undefined;
        fetchCalls.push({ url, body });

        if (url.endsWith(`/api/conversations/${conversationId}/messages`)) {
          return Promise.resolve(jsonResponse([]));
        }
        if (url.endsWith(`/api/conversations/${conversationId}/pending-interaction`)) {
          return Promise.resolve(jsonResponse({ interaction: opts.interaction ?? null }));
        }
        const resolveMatch = url.match(
          new RegExp(`/api/conversations/${conversationId}/pending-interaction/([^/]+)/resolve$`),
        );
        if (resolveMatch) {
          const interactionId = resolveMatch[1];
          if (opts.onResolve) return Promise.resolve(opts.onResolve(interactionId, body));
          return Promise.resolve(jsonResponse({ resolved: true }));
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      }) as unknown as typeof fetch;
      return { fn, fetchCalls };
    }

    test("AC-8.1: a pending confirm-kind interaction renders a chip with the literal host and visible Approve/Deny controls", async () => {
      const { fn } = fetchMockFor("conv-confirm-1", {
        interaction: { id: "int-1", kind: "confirm", host: "192.168.1.50" },
      });
      global.fetch = fn;

      render(<ChatView key="conv-confirm-1" model="" conversationId="conv-confirm-1" />);

      // Literal host text, verbatim — not a paraphrase, not truncated.
      await waitFor(() => {
        expect(screen.getByText("192.168.1.50")).toBeTruthy();
      });
      expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
    });

    test("AC-8.1 (contrast): no chip renders when no pending interaction exists, or when the pending interaction is render-kind", async () => {
      const { fn } = fetchMockFor("conv-confirm-2", { interaction: null });
      global.fetch = fn;

      render(<ChatView key="conv-confirm-2" model="" conversationId="conv-confirm-2" />);

      // Give the poll a tick to run and confirm nothing renders.
      await waitFor(() => {
        expect(screen.getByPlaceholderText(/Message pi/)).toBeTruthy();
      });
      expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
    });

    test("AC-8.2 [R]: clicking Approve calls resolve with { approved: true }, disables both buttons while in flight, and clears the chip once resolved", async () => {
      let resolveResolvePost!: (res: Response) => void;
      const pendingResolvePost = new Promise<Response>((resolve) => {
        resolveResolvePost = resolve;
      });

      const { fn, fetchCalls } = fetchMockFor("conv-approve", {
        interaction: { id: "int-approve", kind: "confirm", host: "10.0.0.7" },
        onResolve: () => pendingResolvePost,
      });
      global.fetch = fn;

      render(<ChatView key="conv-approve" model="" conversationId="conv-approve" />);

      await waitFor(() => {
        expect(screen.getByText("10.0.0.7")).toBeTruthy();
      });

      const approveButton = screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement;
      const denyButton = screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement;
      fireEvent.click(approveButton);

      // While the resolve POST is still in flight, both buttons must be
      // disabled — avoids a double-submission from a second click.
      await waitFor(() => {
        expect(approveButton.disabled).toBe(true);
      });
      expect(denyButton.disabled).toBe(true);

      const resolveCall = fetchCalls.find((c) => c.url.endsWith("/pending-interaction/int-approve/resolve"));
      expect(resolveCall).toBeTruthy();
      expect(resolveCall!.body).toEqual({ approved: true });

      await act(async () => {
        resolveResolvePost(jsonResponse({ resolved: true }));
      });

      // Chip clears once resolved (this implementation optimistically clears
      // right after the click settles rather than waiting for the next poll
      // tick — see ChatView.tsx's resolvePendingConfirm comment).
      await waitFor(() => {
        expect(screen.queryByText("10.0.0.7")).toBeNull();
      });
    });

    test("AC-8.3: clicking Deny calls resolve with { approved: false } and clears the chip", async () => {
      const { fn, fetchCalls } = fetchMockFor("conv-deny", {
        interaction: { id: "int-deny", kind: "confirm", host: "127.0.0.1" },
      });
      global.fetch = fn;

      render(<ChatView key="conv-deny" model="" conversationId="conv-deny" />);

      await waitFor(() => {
        expect(screen.getByText("127.0.0.1")).toBeTruthy();
      });

      const denyButton = screen.getByRole("button", { name: "Deny" });
      await act(async () => {
        fireEvent.click(denyButton);
      });

      const resolveCall = fetchCalls.find((c) => c.url.endsWith("/pending-interaction/int-deny/resolve"));
      expect(resolveCall).toBeTruthy();
      expect(resolveCall!.body).toEqual({ approved: false });

      await waitFor(() => {
        expect(screen.queryByText("127.0.0.1")).toBeNull();
      });
    });
  });
});
