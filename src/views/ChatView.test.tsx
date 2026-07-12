import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Role, TextMessage } from "@copilotkit/runtime-client-gql";

/**
 * Task 12 CopilotKit-mocking pattern (no precedent from Task 9/10/11 — those
 * don't touch `useCopilotChat`, only `fetch`).
 *
 * Verified against the installed @copilotkit/react-core (1.62.3): its real
 * `useCopilotChat()` (dist/index.mjs) returns only `{ visibleMessages,
 * appendMessage, reloadMessages, stopGeneration, reset, isLoading, isAvailable,
 * runChatCompletion, mcpServers, setMcpServers }` — no `agent`/`threadId`, and the
 * `id` option on `UseCopilotChatOptions` is declared in the .d.ts but never read
 * by the implementation. So the real hook offers no way for a caller to select
 * which backend thread it talks to; that live wiring is out of Task 12's scope
 * (ChatView.tsx's call-site comment + this file's header record that finding).
 *
 * This mock stands in for "whatever the real CopilotKit singleton agent
 * currently holds", keyed by an externally-set `activeThreadId` the test flips
 * via `setActiveThread()` — modeling per-conversation message storage. It proves
 * ChatView's own render logic (choosing greeting vs. real transcript, shedding
 * its local draft-box state) is correct given per-conversation data, and that a
 * `key`-driven remount (exactly what App.tsx does) doesn't leak one
 * conversation's messages into another's. It does NOT prove the real,
 * installed CopilotKit library itself separates threads — that gap is real and
 * is called out in ChatView.tsx's comment, not hidden by this test passing.
 */

type MockMessage = InstanceType<typeof TextMessage>;

interface ThreadState {
  visibleMessages: MockMessage[];
  isLoading: boolean;
}

let activeThreadId = "default";
const threadStore = new Map<string, ThreadState>();

function threadFor(id: string): ThreadState {
  let state = threadStore.get(id);
  if (!state) {
    state = { visibleMessages: [], isLoading: false };
    threadStore.set(id, state);
  }
  return state;
}

function setActiveThread(id: string): void {
  activeThreadId = id;
}

function resetThreads(): void {
  threadStore.clear();
  activeThreadId = "default";
}

mock.module("@copilotkit/react-core", () => ({
  useCopilotChat: () => {
    const state = threadFor(activeThreadId);
    return {
      visibleMessages: state.visibleMessages,
      isLoading: state.isLoading,
      appendMessage: async (message: MockMessage) => {
        state.visibleMessages = [...state.visibleMessages, message];
      },
    };
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
  test("AC-12.1: a message sent in conversation A is still visible after switching to B then back to A", async () => {
    setActiveThread("conv-a");
    const { rerender } = render(<ChatView key="conv-a" model="pi-2 Sonnet" />);

    const textarea = screen.getByPlaceholderText(/Message pi/);
    fireEvent.change(textarea, { target: { value: "Hello from A" } });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Enter" });
    });

    expect(screen.getByText("Hello from A")).toBeTruthy();

    // Switch to conversation B: App.tsx remounts ChatView via `key={activeConv}`.
    setActiveThread("conv-b");
    await act(async () => {
      rerender(<ChatView key="conv-b" model="pi-2 Sonnet" />);
    });

    expect(screen.queryByText("Hello from A")).toBeNull();
    expect(screen.getByText(GREETING_SNIPPET, { exact: false })).toBeTruthy();

    // Switch back to conversation A.
    setActiveThread("conv-a");
    await act(async () => {
      rerender(<ChatView key="conv-a" model="pi-2 Sonnet" />);
    });

    expect(screen.getByText("Hello from A")).toBeTruthy();
  });

  test("AC-12.2: the default conversation's pre-existing messages show on load, not an empty greeting", async () => {
    const priorUser = new TextMessage({ id: "u1", content: "What's the weather API key stored as?", role: Role.User });
    const priorAssistant = new TextMessage({ id: "a1", content: "It's WEATHER_API_KEY in your .env.", role: Role.Assistant });
    threadFor("default").visibleMessages = [priorUser, priorAssistant];
    setActiveThread("default");

    render(<ChatView key="default" model="pi-2 Sonnet" />);

    expect(screen.getByText("What's the weather API key stored as?")).toBeTruthy();
    expect(screen.getByText("It's WEATHER_API_KEY in your .env.")).toBeTruthy();
    expect(screen.queryByText(GREETING_SNIPPET, { exact: false })).toBeNull();
  });
});
