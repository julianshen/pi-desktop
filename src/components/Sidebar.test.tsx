import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Sidebar } from "./Sidebar.js";
import type { ConversationMeta } from "../state/useConversations.js";

/**
 * Task 10: same bun:test + happy-dom + @testing-library/react harness Task 9
 * established (root bunfig.toml's [test].preload -> test-setup.ts registers a
 * happy-dom DOM). Uses full render()/screen (not renderHook) since these are
 * component-level ACs. Uses @testing-library/react's fireEvent (already a
 * transitive dep of @testing-library/react, no new package) rather than
 * @testing-library/user-event, which isn't installed — matches SPEC.md's "no new
 * dependencies" constraint.
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
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
    ...overrides,
  };
}

const noop = () => {};

function baseProps(overrides: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  return {
    view: "chat" as const,
    activeConv: "conv-1",
    onSelectConv: noop,
    activeFilter: "All",
    onSelectFilter: noop,
    settingsSection: "providers" as const,
    onSelectSettingsSection: noop,
    ...overrides,
  };
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
});

describe("Sidebar", () => {
  test("AC-10.1: shows the ConversationListLoading spinner state while conversations are fetching, not the old mock list", async () => {
    let resolveFetch!: (res: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    global.fetch = mock(() => pending) as unknown as typeof fetch;

    const { SidebarWithHook } = await importSidebarHarness();
    render(<SidebarWithHook {...baseProps()} />);

    expect(screen.getByText("Loading conversations…")).toBeTruthy();
    // The old mock list content must not render during loading.
    expect(screen.queryByText("Model eval rubric")).toBeNull();

    // Drain the pending fetch so it doesn't leak into later tests.
    resolveFetch(jsonResponse([]));
    await waitFor(() => expect(screen.queryByText("Loading conversations…")).toBeNull());
  });

  test("AC-10.2: shows the ConversationListEmpty badge/CTA state when zero conversations exist", async () => {
    global.fetch = mock(() => Promise.resolve(jsonResponse([]))) as unknown as typeof fetch;

    const { SidebarWithHook } = await importSidebarHarness();
    render(<SidebarWithHook {...baseProps()} />);

    await waitFor(() => expect(screen.getByText("No conversations yet — start one to begin.")).toBeTruthy());
    expect(screen.getByRole("button", { name: "+ New conversation" })).toBeTruthy();
  });

  test("AC-10.3: clicking \"+\" creates a new conversation and it becomes active", async () => {
    const existing = makeMeta({ id: "conv-1", title: "Sprint planning" });
    const created = makeMeta({ id: "conv-new", title: "New conversation" });
    global.fetch = mock((_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.resolve(jsonResponse(created, 201));
      return Promise.resolve(jsonResponse([existing]));
    }) as unknown as typeof fetch;

    let activeConv = "conv-1";
    const onSelectConv = mock((id: string) => {
      activeConv = id;
    });

    const { SidebarWithHook } = await importSidebarHarness();
    const { rerender } = render(<SidebarWithHook {...baseProps({ activeConv, onSelectConv })} />);

    await waitFor(() => expect(screen.getByText("Sprint planning")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    });

    await waitFor(() => expect(onSelectConv).toHaveBeenCalledWith("conv-new"));
    expect(activeConv).toBe("conv-new");

    // Re-render with the now-active id to confirm the new conversation renders
    // highlighted as active once App.tsx's state flows back down.
    rerender(<SidebarWithHook {...baseProps({ activeConv, onSelectConv })} />);
    await waitFor(() => expect(screen.getByText("New conversation")).toBeTruthy());
  });

  test("AC-10.4: typing into search filters the list in real time to matching titles only", async () => {
    const matching = makeMeta({ id: "a", title: "Sprint planning" });
    const other = makeMeta({ id: "b", title: "Design review" });
    global.fetch = mock(() => Promise.resolve(jsonResponse([matching, other]))) as unknown as typeof fetch;

    const { SidebarWithHook } = await importSidebarHarness();
    render(<SidebarWithHook {...baseProps()} />);

    await waitFor(() => {
      expect(screen.getByText("Sprint planning")).toBeTruthy();
      expect(screen.getByText("Design review")).toBeTruthy();
    });

    const search = screen.getByPlaceholderText("Search conversations");
    fireEvent.change(search, { target: { value: "sprint" } });

    await waitFor(() => {
      expect(screen.getByText("Sprint planning")).toBeTruthy();
      expect(screen.queryByText("Design review")).toBeNull();
    });
  });

  test("AC-3.1: renders persisted project/folder hierarchy with accessible selected state", async () => {
    const conversation = makeMeta({ id: "conv-1", title: "Agent plan", projectId: "project-1", folderId: "folder-1", pinnedAt: "2026-07-01T00:00:00.000Z" });
    global.fetch = mock((url: string) => {
      if (url.endsWith("/projects")) return Promise.resolve(jsonResponse([{ id: "project-1", name: "Launch", createdAt: "", updatedAt: "" }]));
      if (url.endsWith("/folders")) return Promise.resolve(jsonResponse([{ id: "folder-1", name: "Research", projectId: "project-1", position: 0, createdAt: "", updatedAt: "" }]));
      return Promise.resolve(jsonResponse([conversation]));
    }) as unknown as typeof fetch;

    const { SidebarWithHook } = await importSidebarHarness();
    render(<SidebarWithHook {...baseProps()} />);

    await waitFor(() => expect(screen.getByText("Launch")).toBeTruthy());
    expect(screen.getByText("Research")).toBeTruthy();
    expect(screen.getByRole("treeitem", { name: /Agent plan/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Pinned")).toBeTruthy();
  });

  test("AC-3.2: pin action updates the row through shared hook state", async () => {
    const conversation = makeMeta({ id: "conv-1", title: "Agent plan" });
    global.fetch = mock((url: string, init?: RequestInit) => {
      if (url.endsWith("/projects") || url.endsWith("/folders")) return Promise.resolve(jsonResponse([]));
      if (init?.method === "PATCH") return Promise.resolve(jsonResponse({ ...conversation, pinnedAt: "2026-07-01T00:00:00.000Z" }));
      return Promise.resolve(jsonResponse([conversation]));
    }) as unknown as typeof fetch;

    const { SidebarWithHook } = await importSidebarHarness();
    render(<SidebarWithHook {...baseProps()} />);
    await waitFor(() => expect(screen.getByText("Agent plan")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Actions for Agent plan" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin Agent plan" }));
    await waitFor(() => expect(screen.getByText("Pinned")).toBeTruthy());
  });

  test("Show archived reveals archived conversations loaded by the workspace", async () => {
    const active = makeMeta({ id: "active", title: "Active chat" });
    const archived = makeMeta({ id: "archived", title: "Archived chat", archivedAt: "2026-07-01T00:00:00.000Z" });
    global.fetch = mock((url: string) => {
      if (url.endsWith("/projects") || url.endsWith("/folders")) return Promise.resolve(jsonResponse([]));
      return Promise.resolve(jsonResponse([active, archived]));
    }) as unknown as typeof fetch;

    const { SidebarWithHook } = await importSidebarHarness();
    render(<SidebarWithHook {...baseProps({ activeConv: "active" })} />);
    await waitFor(() => expect(screen.getByText("Active chat")).toBeTruthy());
    expect(screen.queryByText("Archived chat")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show archived" }));

    expect(screen.getByText("Archived chat")).toBeTruthy();
    expect(screen.queryByText("Active chat")).toBeNull();
  });

  test("deleting the active conversation selects the next valid conversation", async () => {
    const active = makeMeta({ id: "active", title: "Delete me" });
    const next = makeMeta({ id: "next", title: "Keep me" });
    global.fetch = mock((url: string, init?: RequestInit) => {
      if (url.endsWith("/projects") || url.endsWith("/folders")) return Promise.resolve(jsonResponse([]));
      if (init?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
      return Promise.resolve(jsonResponse([active, next]));
    }) as unknown as typeof fetch;
    const onSelectConv = mock(() => {});

    const { SidebarWithHook } = await importSidebarHarness();
    render(<SidebarWithHook {...baseProps({ activeConv: "active", onSelectConv })} />);
    await waitFor(() => expect(screen.getByText("Delete me")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Actions for Delete me" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));

    await waitFor(() => expect(onSelectConv).toHaveBeenCalledWith("next"));
  });
});

/**
 * Sidebar takes `conversations: UseConversationsResult` as a prop (App.tsx calls
 * useConversations() once and passes it down — see App.tsx's Task 10 comment).
 * These tests exercise the real hook (not a hand-rolled stub) so the fetch/create/
 * search wiring between Sidebar and useConversations() is proven end-to-end, via
 * a tiny wrapper component that calls the hook and forwards its result.
 */
async function importSidebarHarness() {
  const { useConversations } = await import("../state/useConversations.js");
  function SidebarWithHook(props: Omit<Parameters<typeof Sidebar>[0], "conversations">) {
    const conversations = useConversations();
    return <Sidebar {...props} conversations={conversations} />;
  }
  return { SidebarWithHook };
}
