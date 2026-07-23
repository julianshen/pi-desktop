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
    update: () => Promise.reject(new Error("update() not implemented in this test fixture")),
    remove: () => Promise.reject(new Error("remove() not implemented in this test fixture")),
    projects: [],
    folders: [],
    createProject: () => Promise.reject(new Error("createProject() not implemented in this test fixture")),
    createFolder: () => Promise.reject(new Error("createFolder() not implemented in this test fixture")),
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
  onOpenTaskCreate,
  view = "chat",
}: {
  conversations: UseConversationsResult;
  activeConv?: string;
  onSetModel?: (name: string) => void;
  onOpenTaskCreate?: () => void;
  view?: ShellState["view"];
}) {
  const [modelOpen, setModelOpen] = useState(false);
  const state: ShellState = {
    view,
    activeConv,
    artifactOpen: false,
    canvasArtifactId: null,
    canvasTab: "code",
    modelOpen,
    model: "pi-2 Sonnet",
    activeFilter: "All",
    settingsSection: "providers",
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
    openTaskCreate: onOpenTaskCreate ?? noop,
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
  test("scheduled tasks exposes only the real create action and no decorative filter control", () => {
    const onOpenTaskCreate = mock(() => {});
    global.fetch = mock(() => Promise.resolve(jsonResponse([]))) as unknown as typeof fetch;

    render(
      <Harness
        conversations={makeConversationsResult()}
        view="scheduled"
        onOpenTaskCreate={onOpenTaskCreate}
      />,
    );

    expect(screen.queryByText("Filter tasks")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New schedule" }));
    expect(onOpenTaskCreate).toHaveBeenCalledTimes(1);
  });

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

  // Bug fix (live smoke-test): switching models via the header picker persisted
  // server-side and updated the composer footer correctly, but the HEADER
  // BUTTON ITSELF kept showing the old model name until a full reload. Root
  // cause: `conversations` (the shared `useConversations()` list, passed down
  // as a prop) was never told about a successful switch — nothing called
  // `conversations.refetch()` — so the effect that re-derives `selectedModelId`
  // from `activeConversation?.modelId` (which re-runs whenever `switching`
  // flips back to `false`, one of its own deps) read the still-stale modelId
  // and clobbered the correct optimistic selection back to the old model.
  //
  // AC-11.2 above already asserts the label shows the new model at SOME point
  // after switching, but `waitFor` stops polling the instant that's first
  // true — it can't catch a revert that happens moments later. This test uses
  // a stateful harness (mirroring how App.tsx really re-renders MainHeader
  // with a fresh `conversations` prop once `refetch()` resolves) with a
  // deliberately delayed GET /api/conversations, so it can assert the label
  // stays correct THROUGH the window between "switch succeeds" and "refetch
  // resolves" — the exact window the bug lived in.
  test("BUG: header button label stays on the newly selected model and never reverts to the old one before the refetch resolves", async () => {
    const models = [
      { id: "model-a", label: "Model A", provider: "anthropic" },
      { id: "model-b", label: "Model B", provider: "anthropic" },
    ];
    let convModelId = "model-a";
    // GET /api/conversations (what a real `refetch()` hits) is held pending
    // until the test explicitly resolves it below, so the "refetch is in
    // flight but hasn't resolved yet" window is directly observable. Built
    // directly in this scope (not inside the `mock()` callback) to match the
    // existing `resolveFetch!` pattern above this test — hoisting a
    // reassignment out of a doubly-nested closure like that also sidesteps a
    // TS control-flow-narrowing quirk that otherwise types the resolver as
    // `never` at its call site.
    let resolveConversationsFetch!: () => void;
    const pendingConversationsFetch = new Promise<Response>((resolve) => {
      resolveConversationsFetch = () =>
        resolve(jsonResponse([makeMeta({ id: "conv-1", title: "Sprint planning", modelId: convModelId })]));
    });

    global.fetch = mock((url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        convModelId = "model-b";
        return Promise.resolve(jsonResponse({ id: "conv-1", modelId: "model-b" }));
      }
      if (url.includes("/api/settings/default-model")) {
        return Promise.resolve(jsonResponse({ provider: null, model: null }));
      }
      if (url.includes("/api/models")) {
        return Promise.resolve(jsonResponse(models));
      }
      return pendingConversationsFetch;
    }) as unknown as typeof fetch;

    function StatefulHarness() {
      const [conversations, setConversations] = useState<ConversationMeta[]>([
        makeMeta({ id: "conv-1", title: "Sprint planning", modelId: "model-a" }),
      ]);
      const refetch = async () => {
        const res = await fetch("/api/conversations");
        const data = (await res.json()) as ConversationMeta[];
        setConversations(data);
      };
      return (
        <Harness
          conversations={makeConversationsResult({ conversations, refetch })}
          activeConv="conv-1"
        />
      );
    }

    render(<StatefulHarness />);

    await waitFor(() => expect(screen.getByText("Model A")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Model picker"));
    await waitFor(() => expect(screen.getByText("Model B")).toBeTruthy());
    fireEvent.click(screen.getByText("Model B"));

    // Optimistic update lands as soon as the PATCH resolves.
    await waitFor(() => expect(screen.getByLabelText("Model picker").textContent).toContain("Model B"));

    // The refetch triggered by the switch is still pending at this point
    // (`resolveConversationsFetch` hasn't been called) — `conversations`
    // still reports the stale "model-a". Give any effects a chance to
    // re-run off `switching` flipping to `false` and confirm the label does
    // NOT get clobbered back to the old model in this window.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByLabelText("Model picker").textContent).toContain("Model B");
    expect(screen.getByLabelText("Model picker").textContent).not.toContain("Model A");

    // Now let the refetch resolve with the now-fresh conversation and confirm
    // the label still agrees.
    resolveConversationsFetch();
    await waitFor(() => expect(screen.getByLabelText("Model picker").textContent).toContain("Model B"));
    expect(screen.getByLabelText("Model picker").textContent).not.toContain("Model A");
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
