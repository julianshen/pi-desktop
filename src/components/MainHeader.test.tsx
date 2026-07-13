import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MainHeader } from "./MainHeader.js";
import type { ShellActions, ShellState } from "../state/useShellState.js";
import type { ConversationMeta, UseConversationsResult } from "../state/useConversations.js";

/**
 * Task 11 (US-05, US-06, US-08): same bun:test + happy-dom + @testing-library/react
 * harness Task 9/13 established (src/state/useConversations.test.ts,
 * src/views/ArtifactCanvas.test.tsx). `conversations` is passed in directly as a
 * plain fixture object (matching how App.tsx now lifts a single useConversations()
 * call and threads its result down as a prop, per Task 10's App.tsx wiring) rather
 * than mocking a second fetch for it — MainHeader itself only fetches
 * GET /api/models and PATCHes /api/conversations/:id/model.
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
    modelId: overrides.modelId,
  };
}

function makeConversationsResult(overrides: Partial<UseConversationsResult> = {}): UseConversationsResult {
  const list = overrides.conversations ?? [];
  return {
    conversations: list,
    loading: false,
    error: null,
    activeId: null,
    setActiveId: () => {},
    create: () => Promise.reject(new Error("create() not implemented in this test fixture")),
    searchQuery: "",
    setSearchQuery: () => {},
    filtered: list,
    refetch: () => Promise.resolve(),
    ...overrides,
  };
}

function noop() {}

/** Mirrors how App.tsx wires modelOpen through useShellState, minus everything
 * MainHeader doesn't touch in these tests. */
function Harness({
  conversations,
  activeConv = "conv-1",
  onSetModel,
}: {
  conversations: UseConversationsResult;
  activeConv?: string;
  onSetModel?: (name: string) => void;
}) {
  const [modelOpen, setModelOpen] = useState(false);
  const state: ShellState = {
    view: "chat",
    activeConv,
    artifactOpen: false,
    canvasTab: "code",
    modelOpen,
    model: "pi-2 Sonnet",
    activeFilter: "All",
    settingsSection: "providers",
    taskOpen: null,
    taskCreate: false,
  };
  const actions: ShellActions = {
    go: noop,
    setActiveConv: noop,
    toggleArtifact: noop,
    openArtifact: noop,
    setCanvasTab: noop,
    toggleModelMenu: () => setModelOpen((o) => !o),
    setModel: onSetModel ?? noop,
    setActiveFilter: noop,
    setSettingsSection: noop,
    openTask: noop,
    backToTasks: noop,
    openTaskCreate: noop,
    closeTaskCreate: noop,
  };
  return <MainHeader state={state} actions={actions} conversations={conversations} />;
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
});

describe("MainHeader", () => {
  test('AC-11.1: shows the ModelPickerLoading state ("Loading models…") while GET /api/models is in flight, not the hardcoded "pi-2 Sonnet"', async () => {
    let resolveFetch!: (res: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    global.fetch = mock(() => pending) as unknown as typeof fetch;

    render(
      <Harness
        conversations={makeConversationsResult({
          conversations: [makeMeta({ id: "conv-1", title: "Sprint planning" })],
          activeId: "conv-1",
        })}
        activeConv="conv-1"
      />,
    );

    expect(screen.getByText("Loading models…")).toBeTruthy();
    expect(screen.queryByText("pi-2 Sonnet")).toBeNull();

    // Drain the pending fetch so it doesn't leak into the next test.
    resolveFetch(jsonResponse([]));
    await waitFor(() => expect(screen.queryByText("Loading models…")).toBeNull());
  });

  test('AC-11.2: selecting a different model shows the pulsing "Switching model…" state, then updates to the newly selected model on success', async () => {
    const models = [
      { id: "anthropic/claude-opus-4-5", label: "Claude Opus 4.5", provider: "anthropic" },
      { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5", provider: "anthropic" },
    ];
    const conv = makeMeta({ id: "conv-1", title: "Sprint planning", modelId: models[0]?.id });

    global.fetch = mock((_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return Promise.resolve(jsonResponse({ ...conv, modelId: models[1]?.id }));
      }
      return Promise.resolve(jsonResponse(models));
    }) as unknown as typeof fetch;

    render(
      <Harness
        conversations={makeConversationsResult({ conversations: [conv], activeId: "conv-1" })}
        activeConv="conv-1"
      />,
    );

    // Idle, populated state: shows the conversation's real current model, not a spinner/loading text.
    await waitFor(() => expect(screen.getByText("Claude Opus 4.5")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Model picker"));
    await waitFor(() => expect(screen.getByText("Claude Sonnet 5")).toBeTruthy());

    fireEvent.click(screen.getByText("Claude Sonnet 5"));

    // Switching state fires immediately (before the PATCH resolves).
    expect(screen.getByText("Switching model…")).toBeTruthy();

    // On success, the button reflects the newly selected model and the switching
    // label is gone.
    await waitFor(() => expect(screen.getByLabelText("Model picker").textContent).toContain("Claude Sonnet 5"));
    expect(screen.queryByText("Switching model…")).toBeNull();
  });

  test('AC-11.2b: a failed PATCH reverts the selection and surfaces an inline error instead of silently reverting', async () => {
    const models = [
      { id: "anthropic/claude-opus-4-5", label: "Claude Opus 4.5", provider: "anthropic" },
      { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5", provider: "anthropic" },
    ];
    const conv = makeMeta({ id: "conv-1", title: "Sprint planning", modelId: models[0]?.id });

    global.fetch = mock((_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return Promise.resolve(jsonResponse({}, 500));
      }
      return Promise.resolve(jsonResponse(models));
    }) as unknown as typeof fetch;

    render(
      <Harness
        conversations={makeConversationsResult({ conversations: [conv], activeId: "conv-1" })}
        activeConv="conv-1"
      />,
    );

    await waitFor(() => expect(screen.getByText("Claude Opus 4.5")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Model picker"));
    await waitFor(() => expect(screen.getByText("Claude Sonnet 5")).toBeTruthy());
    fireEvent.click(screen.getByText("Claude Sonnet 5"));

    expect(screen.getByText("Switching model…")).toBeTruthy();

    await waitFor(() => expect(screen.getByLabelText("Model picker").textContent).toContain("Claude Opus 4.5"));
    await waitFor(() => expect(screen.getByText(/Couldn.t switch model/)).toBeTruthy());
  });

  test("MEDIUM bug fix: a successful model switch also calls actions.setModel with the newly active model's label, so shared shell state (and ChatView's composer footer) doesn't stay stuck on the initial placeholder label", async () => {
    const models = [
      { id: "anthropic/claude-opus-4-5", label: "Claude Opus 4.5", provider: "anthropic" },
      { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5", provider: "anthropic" },
    ];
    const conv = makeMeta({ id: "conv-1", title: "Sprint planning", modelId: models[0]?.id });

    global.fetch = mock((_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return Promise.resolve(jsonResponse({ ...conv, modelId: models[1]?.id }));
      }
      return Promise.resolve(jsonResponse(models));
    }) as unknown as typeof fetch;

    const setModelCalls: string[] = [];

    render(
      <Harness
        conversations={makeConversationsResult({ conversations: [conv], activeId: "conv-1" })}
        activeConv="conv-1"
        onSetModel={(name) => setModelCalls.push(name)}
      />,
    );

    await waitFor(() => expect(screen.getByText("Claude Opus 4.5")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Model picker"));
    await waitFor(() => expect(screen.getByText("Claude Sonnet 5")).toBeTruthy());
    fireEvent.click(screen.getByText("Claude Sonnet 5"));

    await waitFor(() => expect(screen.getByLabelText("Model picker").textContent).toContain("Claude Sonnet 5"));

    expect(setModelCalls).toEqual(["Claude Sonnet 5"]);
  });

  test('AC-11.3: breadcrumb and title reflect the active conversation\'s real title, never the hardcoded "July investor update"', async () => {
    global.fetch = mock(() => Promise.resolve(jsonResponse([]))) as unknown as typeof fetch;

    render(
      <Harness
        conversations={makeConversationsResult({
          conversations: [makeMeta({ id: "conv-1", title: "Sprint planning" })],
          activeId: "conv-1",
        })}
        activeConv="conv-1"
      />,
    );

    expect(screen.getByText("Chat / Sprint planning")).toBeTruthy();
    expect(screen.getByText("Sprint planning", { selector: "div" })).toBeTruthy();
    expect(screen.queryByText("Chat / July investor update")).toBeNull();
    expect(screen.queryByText("July investor update")).toBeNull();

    await waitFor(() => expect(screen.queryByText("Loading models…")).toBeNull());
  });
});
