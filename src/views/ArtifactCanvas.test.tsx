import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ArtifactCanvas, type Artifact } from "./ArtifactCanvas.js";

/**
 * Task 13 (US-07): same bun:test + happy-dom + @testing-library/react harness Task 9
 * established (src/state/useConversations.test.ts), now exercising a full component
 * render (not just a hook) via @testing-library/react's `render`.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: overrides.id ?? "artifact-1",
    title: overrides.title ?? "revenue_chart.tsx",
    language: overrides.language ?? "tsx",
    code: overrides.code ?? "export const x = 1;",
    publishedAt: overrides.publishedAt ?? "2026-07-01T00:00:00.000Z",
  };
}

const noop = () => {};

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
});

describe("ArtifactCanvas", () => {
  test("AC-13.1: a conversation with no published artifacts shows the DESIGN.md empty state, not the hardcoded WAU-dashboard", async () => {
    global.fetch = mock(() => Promise.resolve(jsonResponse(null))) as unknown as typeof fetch;

    render(<ArtifactCanvas tab="code" onSetTab={noop} onClose={noop} conversationId="conv-empty" />);

    await waitFor(() => {
      expect(screen.getByText("Nothing published to the canvas yet in this conversation.")).toBeTruthy();
    });

    // The hardcoded fake content this task replaces must be gone entirely.
    expect(screen.queryByText("WAU_dashboard.tsx")).toBeNull();
    expect(screen.queryByText("Weekly Active Users")).toBeNull();
  });

  test("AC-13.2: after the current turn completes (refreshSignal changes), the canvas transitions through the updating state and then shows the real published artifact", async () => {
    const initial = makeArtifact({ id: "a1", title: "initial.tsx", code: "const a = 1;" });
    const published = makeArtifact({ id: "a2", title: "published.tsx", code: "const b = 2;" });

    let resolveSecondFetch!: (res: Response) => void;
    const secondFetch = new Promise<Response>((resolve) => {
      resolveSecondFetch = resolve;
    });

    let callCount = 0;
    global.fetch = mock(() => {
      callCount += 1;
      if (callCount === 1) return Promise.resolve(jsonResponse(initial));
      return secondFetch;
    }) as unknown as typeof fetch;

    const { rerender } = render(
      <ArtifactCanvas tab="code" onSetTab={noop} onClose={noop} conversationId="conv-1" refreshSignal={0} />,
    );

    // Initial artifact loads and renders.
    await waitFor(() => {
      expect(screen.getByText("initial.tsx")).toBeTruthy();
    });
    expect(screen.getByText("const a = 1;")).toBeTruthy();

    // Simulate a completed turn: refreshSignal changes, fetch is still in flight.
    rerender(<ArtifactCanvas tab="code" onSetTab={noop} onClose={noop} conversationId="conv-1" refreshSignal={1} />);

    await waitFor(() => {
      expect(screen.getByText("updating")).toBeTruthy();
    });
    // The prior content stays visible (dimmed underneath), not blanked, while updating.
    expect(screen.getByText("const a = 1;")).toBeTruthy();

    // Resolve the refetch with the newly published artifact.
    resolveSecondFetch(jsonResponse(published));

    await waitFor(() => {
      expect(screen.getByText("published.tsx")).toBeTruthy();
    });
    expect(screen.getByText("const b = 2;")).toBeTruthy();
    expect(screen.queryByText("updating")).toBeNull();
  });
});
