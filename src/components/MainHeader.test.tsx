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

/**
 * MainHeader now fetches GET /api/models and GET /api/settings/default-model
 * concurrently (Promise.all) on every `view` change, not just once on mount, so it
 * can show the real Settings-configured default when a conversation has no
 * per-conversation model override. A mock that returns the SAME Response instance
 * (or the same already-resolved promise) for both calls breaks with
 * "Body has already been used" once both `.json()` calls run — each call below
 * must produce a FRESH Response. `defaultModel` defaults to the not-yet-set shape.
 */
function mockFetchForModels(
  models: unknown[],
  options: { defaultModel?: { provider: string | null; model: string | null }; onPatch?: (init?: RequestInit) => Response } = {},
): typeof fetch {
  const defaultModel = options.defaultModel ?? { provider: null, model: null };
  return mock((url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      return Promise.resolve(options.onPatch ? options.onPatch(init) : jsonResponse({}, 500));
    }
    if (url.includes("/api/settings/default-model")) {
      return Promise.resolve(jsonResponse(defaultModel));
    }
    return Promise.resolve(jsonResponse(models));
  }) as unknown as typeof fetch;
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
  view = "chat",
}: {
  conversations: UseConversationsResult;
  activeConv?: string;
  onSetModel?: (name: string) => void;
  view?: ShellState["view"];
}) {
  const [modelOpen, setModelOpen] = useState(false);
  const state: ShellState = {
    view,
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
    // MainHeader awaits both /api/models and /api/settings/default-model
    // (Promise.all) — give each its own never-shared pending promise so resolving
    // one doesn't try to read the other's already-consumed body.
    global.fetch = mock((url: string) =>
      url.includes("/api/settings/default-model") ? Promise.resolve(jsonResponse({ provider: null, model: null })) : pending,
    ) as unknown as typeof fetch;

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

    global.fetch = mockFetchForModels(models, {
      onPatch: () => jsonResponse({ ...conv, modelId: models[1]?.id }),
    });

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

    global.fetch = mockFetchForModels(models, { onPatch: () => jsonResponse({}, 500) });

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

    global.fetch = mockFetchForModels(models, {
      onPatch: () => jsonResponse({ ...conv, modelId: models[1]?.id }),
    });

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

  // Bug fix (live-usage report: "provider and model settings work not as expected"):
  // connecting a provider happens in a completely separate view (Settings >
  // Providers) with no direct channel back to MainHeader. Before this fix,
  // MainHeader fetched /api/models exactly once on mount, so returning to Chat
  // after connecting a provider elsewhere left the picker showing zero models
  // until a full app reload — reproduced live against a real running app.
  test("bug fix: model list is refetched when navigating back to Chat (view change), not just once on mount", async () => {
    const models = [{ id: "anthropic/claude-opus-4-5", label: "Claude Opus 4.5", provider: "anthropic" }];
    let fetchCount = 0;
    global.fetch = mock((url: string) => {
      if (url.includes("/api/settings/default-model")) {
        return Promise.resolve(jsonResponse({ provider: null, model: null }));
      }
      fetchCount += 1;
      // First mount: no provider connected yet, so the real backend would return [].
      // After navigating away to Settings and back, a provider is now connected.
      return Promise.resolve(jsonResponse(fetchCount === 1 ? [] : models));
    }) as unknown as typeof fetch;

    const conv = makeMeta({ id: "conv-1", title: "Sprint planning" });
    const { rerender } = render(
      <Harness conversations={makeConversationsResult({ conversations: [conv], activeId: "conv-1" })} activeConv="conv-1" view="chat" />,
    );

    await waitFor(() => expect(screen.queryByText("Loading models…")).toBeNull());
    expect(screen.getByText("Select model")).toBeTruthy();

    // Navigate to Settings, then back to Chat — simulates connecting a provider
    // there and returning, without a full page reload.
    rerender(
      <Harness conversations={makeConversationsResult({ conversations: [conv], activeId: "conv-1" })} activeConv="conv-1" view="settings" />,
    );
    rerender(
      <Harness conversations={makeConversationsResult({ conversations: [conv], activeId: "conv-1" })} activeConv="conv-1" view="chat" />,
    );

    // No per-conversation override and no configured default in this test, so the
    // header label correctly stays the honest "Select model" (a separate, deliberate
    // fix — see the next test) — the refetch itself is proven by opening the
    // dropdown and seeing the newly-available model as an option.
    await waitFor(() => expect(fetchCount).toBeGreaterThan(1));
    fireEvent.click(screen.getByLabelText("Model picker"));
    await waitFor(() => expect(screen.getByText("Claude Opus 4.5")).toBeTruthy());
  });

  // Bug fix (same live-usage report): a fresh conversation with no explicit
  // per-conversation model override must show the real global default configured
  // via Settings > Model Defaults, not an arbitrary first entry from the model
  // list — falling back to `models[0]` could display (and the user could then
  // send a message against) a different model than what the conversation will
  // actually use, since the SDK resolves the real starting model from the
  // Settings-configured default, not list order.
  test("bug fix: a conversation with no modelId override shows the real Settings-configured default, not an arbitrary models[0]", async () => {
    const models = [
      { id: "anthropic/claude-opus-4-5", label: "Claude Opus 4.5", provider: "anthropic" },
      { id: "anthropic/claude-haiku-4-5", label: "Claude Haiku 4.5", provider: "anthropic" },
    ];
    // /api/settings/default-model returns { provider, model } with a BARE model id
    // (provider-model-settings' own convention) — deliberately NOT pre-combined with
    // the provider prefix here, to prove MainHeader reconstructs `${provider}/${model}`
    // itself rather than assuming the two endpoints share an id format.
    global.fetch = mockFetchForModels(models, {
      defaultModel: { provider: "anthropic", model: "claude-haiku-4-5" },
    });

    const conv = makeMeta({ id: "conv-1", title: "New conversation" });
    render(<Harness conversations={makeConversationsResult({ conversations: [conv], activeId: "conv-1" })} activeConv="conv-1" />);

    // Not "Claude Opus 4.5" (models[0]) — the actual configured default.
    await waitFor(() => expect(screen.getByText("Claude Haiku 4.5")).toBeTruthy());
    expect(screen.queryByText("Claude Opus 4.5")).toBeNull();
  });
});
