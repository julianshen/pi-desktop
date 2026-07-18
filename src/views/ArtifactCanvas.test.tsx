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

  // assistant-ui-migration/AC-16.1: this is also the re-verification that
  // publish_artifact's Canvas live-update behavior holds now that tool-call
  // visibility flows through the new ai-sdk/adapter.ts instead of the old
  // agui/adapter.ts (Task 16, re-run and re-confirmed unmodified). Note the
  // "AC-13.2" in this test's own name is markdown-rendering's unrelated AC
  // numbering (a pre-existing coincidental id collision, not this feature's
  // own AC-13.2 -- see server/src/scheduler/index.test.ts for that one).
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

    const { container, rerender } = render(
      <ArtifactCanvas tab="code" onSetTab={noop} onClose={noop} conversationId="conv-1" refreshSignal={0} />,
    );

    // Initial artifact loads and renders. Task 10: the Code tab now renders through
    // Streamdown/Shiki, which splits highlighted code into multiple per-token spans —
    // so code content is asserted via `textContent` (survives that splitting) rather
    // than `getByText` (requires a single element's text to match exactly).
    await waitFor(() => {
      expect(screen.getByText("initial.tsx")).toBeTruthy();
    });
    expect(container.textContent ?? "").toContain("const a = 1;");

    // Simulate a completed turn: refreshSignal changes, fetch is still in flight.
    rerender(<ArtifactCanvas tab="code" onSetTab={noop} onClose={noop} conversationId="conv-1" refreshSignal={1} />);

    await waitFor(() => {
      expect(screen.getByText("updating")).toBeTruthy();
    });
    // The prior content stays visible (dimmed underneath), not blanked, while updating.
    expect(container.textContent ?? "").toContain("const a = 1;");

    // Resolve the refetch with the newly published artifact.
    resolveSecondFetch(jsonResponse(published));

    await waitFor(() => {
      expect(screen.getByText("published.tsx")).toBeTruthy();
    });
    await waitFor(() => {
      expect(container.textContent ?? "").toContain("const b = 2;");
    });
    expect(screen.queryByText("updating")).toBeNull();
  });

  // Artifacts-as-chat-attachments: clicking a chat attachment chip pins the Canvas
  // to that exact artifact id instead of "whatever is latest".
  describe("pinnedArtifactId", () => {
    test("fetches the specific artifact by id, not the latest, when pinnedArtifactId is set", async () => {
      const requestedUrls: string[] = [];
      global.fetch = mock((input: RequestInfo | URL) => {
        requestedUrls.push(String(input));
        return Promise.resolve(jsonResponse(makeArtifact({ id: "older-1", title: "older.tsx" })));
      }) as unknown as typeof fetch;

      render(
        <ArtifactCanvas
          tab="code"
          onSetTab={noop}
          onClose={noop}
          conversationId="conv-1"
          pinnedArtifactId="older-1"
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("older.tsx")).toBeTruthy();
      });
      expect(requestedUrls.some((url) => url.endsWith("/conversations/conv-1/artifacts/older-1"))).toBe(true);
      expect(requestedUrls.some((url) => url.endsWith("/artifacts/latest"))).toBe(false);
    });

    test("falls back to fetching the latest artifact when pinnedArtifactId is null", async () => {
      const requestedUrls: string[] = [];
      global.fetch = mock((input: RequestInfo | URL) => {
        requestedUrls.push(String(input));
        return Promise.resolve(jsonResponse(makeArtifact()));
      }) as unknown as typeof fetch;

      render(
        <ArtifactCanvas tab="code" onSetTab={noop} onClose={noop} conversationId="conv-1" pinnedArtifactId={null} />,
      );

      await waitFor(() => {
        expect(requestedUrls.length).toBeGreaterThan(0);
      });
      expect(requestedUrls.some((url) => url.endsWith("/artifacts/latest"))).toBe(true);
    });

    test("switching pinnedArtifactId re-fetches the newly pinned artifact", async () => {
      global.fetch = mock((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/artifacts/a1")) return Promise.resolve(jsonResponse(makeArtifact({ id: "a1", title: "first.tsx" })));
        if (url.endsWith("/artifacts/a2")) return Promise.resolve(jsonResponse(makeArtifact({ id: "a2", title: "second.tsx" })));
        return Promise.resolve(jsonResponse(null));
      }) as unknown as typeof fetch;

      const { rerender } = render(
        <ArtifactCanvas tab="code" onSetTab={noop} onClose={noop} conversationId="conv-1" pinnedArtifactId="a1" />,
      );

      await waitFor(() => {
        expect(screen.getByText("first.tsx")).toBeTruthy();
      });

      rerender(
        <ArtifactCanvas tab="code" onSetTab={noop} onClose={noop} conversationId="conv-1" pinnedArtifactId="a2" />,
      );

      await waitFor(() => {
        expect(screen.getByText("second.tsx")).toBeTruthy();
      });
    });
  });

  // Bug fix (test-engineer persona, /tgd-review): ArtifactCanvas.tsx's two
  // independent effects (the [conversationId, pinnedArtifactId]-keyed one and the
  // [refreshSignal]-keyed one, ArtifactCanvas.tsx:122-145) both call the shared
  // `load()` function, but each effect's own `cancelled` closure only guards its
  // OWN next invocation, not the other effect's in-flight fetch. Since App.tsx
  // renders <ArtifactCanvas> with no `key` prop (it persists across a conversation
  // switch, unlike key-remounted ChatView), a refreshSignal-triggered fetch for
  // conversation A that's still in flight when the user switches to conversation B
  // can resolve AFTER B's fetch and silently clobber B's correct, already-visible
  // artifact with A's stale one.
  test("BUG: a stale refreshSignal-triggered fetch for conversation A landing after switching to conversation B must not clobber B's artifact", async () => {
    const artifactA = makeArtifact({ id: "a1", title: "conv-a-initial.tsx", code: "const a = 1;" });
    const artifactAUpdated = makeArtifact({ id: "a2", title: "conv-a-updated.tsx", code: "const a2 = 2;" });
    const artifactB = makeArtifact({ id: "b1", title: "conv-b.tsx", code: "const b = 1;" });

    let resolveStaleAFetch!: (res: Response) => void;
    const staleAFetch = new Promise<Response>((resolve) => {
      resolveStaleAFetch = resolve;
    });

    // fetchArtifact always hits the same "latest" URL per conversation, so a
    // call-count-aware mock is used to distinguish the first (immediate) conv-a
    // fetch (initial mount load) from the second (held pending, simulating "a turn
    // completed on A, refetch is in flight") one.
    let convACallCount = 0;
    global.fetch = mock((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/conversations/conv-a/")) {
        convACallCount += 1;
        if (convACallCount === 1) return Promise.resolve(jsonResponse(artifactA));
        return staleAFetch;
      }
      if (url.includes("/conversations/conv-b/")) {
        return Promise.resolve(jsonResponse(artifactB));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    }) as unknown as typeof fetch;

    const { rerender } = render(
      <ArtifactCanvas tab="code" onSetTab={noop} onClose={noop} conversationId="conv-a" refreshSignal={0} />,
    );

    // Initial load of conversation A resolves and renders.
    await waitFor(() => {
      expect(screen.getByText("conv-a-initial.tsx")).toBeTruthy();
    });

    // A turn completes on conversation A: refreshSignal changes, kicking off the
    // second conv-a fetch — held pending (not resolved yet).
    rerender(<ArtifactCanvas tab="code" onSetTab={noop} onClose={noop} conversationId="conv-a" refreshSignal={1} />);
    await waitFor(() => {
      expect(screen.getByText("updating")).toBeTruthy();
    });

    // Before that fetch resolves, the user switches to conversation B (refreshSignal
    // unchanged). B's fetch resolves and its artifact must show.
    rerender(<ArtifactCanvas tab="code" onSetTab={noop} onClose={noop} conversationId="conv-b" refreshSignal={1} />);
    await waitFor(() => {
      expect(screen.getByText("conv-b.tsx")).toBeTruthy();
    });
    expect(screen.queryByText("updating")).toBeNull();

    // NOW resolve the still-pending stale A fetch. It must NOT be allowed to
    // overwrite the canvas, which has already moved on to conversation B.
    resolveStaleAFetch(jsonResponse(artifactAUpdated));

    // Give the resolved promise's .then() a chance to run and (if the bug is
    // present) clobber state.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(screen.getByText("conv-b.tsx")).toBeTruthy();
    expect(screen.queryByText("conv-a-updated.tsx")).toBeNull();
    expect(screen.queryByText("conv-a-initial.tsx")).toBeNull();
  });

  // Preview tab: real usage (checked against actual ~/.pi-desktop artifacts.json
  // data) only ever produces standalone HTML and SVG artifacts with anything
  // visually meaningful to render — this replaces the old unconditional "No rich
  // preview available" message with a real, sandboxed rendering for those two.
  describe("Preview tab", () => {
    test("an HTML artifact renders in a sandboxed iframe with the raw HTML as srcDoc", async () => {
      const htmlCode = "<!DOCTYPE html><html><body><h1>Hi</h1></body></html>";
      global.fetch = mock(() =>
        Promise.resolve(jsonResponse(makeArtifact({ language: "html", title: "page.html", code: htmlCode }))),
      ) as unknown as typeof fetch;

      render(<ArtifactCanvas tab="preview" onSetTab={noop} onClose={noop} conversationId="conv-1" />);

      const iframe = await waitFor(() => screen.getByTitle("Preview: page.html"));
      expect(iframe.tagName).toBe("IFRAME");
      expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
      // No allow-same-origin: the srcDoc frame must get a unique opaque origin,
      // not inherit the app's — allow-scripts + allow-same-origin together would
      // let agent-generated content script its way back into the host page.
      expect(iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
      expect(iframe.getAttribute("srcdoc")).toBe(htmlCode);
    });

    test("an SVG artifact renders in a sandboxed iframe wrapped in a centering HTML shell", async () => {
      const svgCode = '<svg width="10" height="10"><circle r="5"/></svg>';
      global.fetch = mock(() =>
        Promise.resolve(jsonResponse(makeArtifact({ language: "svg", title: "shape.svg", code: svgCode }))),
      ) as unknown as typeof fetch;

      render(<ArtifactCanvas tab="preview" onSetTab={noop} onClose={noop} conversationId="conv-1" />);

      const iframe = await waitFor(() => screen.getByTitle("Preview: shape.svg"));
      const srcDoc = iframe.getAttribute("srcdoc") ?? "";
      expect(srcDoc).toContain(svgCode);
      expect(srcDoc).toContain("<!DOCTYPE html>");
    });

    test("a non-previewable language still shows the honest fallback message, not an iframe", async () => {
      global.fetch = mock(() =>
        Promise.resolve(jsonResponse(makeArtifact({ language: "python", title: "script.py", code: "print(1)" }))),
      ) as unknown as typeof fetch;

      render(<ArtifactCanvas tab="preview" onSetTab={noop} onClose={noop} conversationId="conv-1" />);

      await waitFor(() => {
        expect(screen.getByText("No rich preview available for this artifact type — showing code only.")).toBeTruthy();
      });
      expect(screen.queryByTitle("Preview: script.py")).toBeNull();
    });

    test("language matching is case-insensitive", async () => {
      global.fetch = mock(() =>
        Promise.resolve(jsonResponse(makeArtifact({ language: "HTML", title: "upper.html", code: "<b>x</b>" }))),
      ) as unknown as typeof fetch;

      render(<ArtifactCanvas tab="preview" onSetTab={noop} onClose={noop} conversationId="conv-1" />);

      await waitFor(() => {
        expect(screen.getByTitle("Preview: upper.html")).toBeTruthy();
      });
    });
  });

  // Task 10 (assistant-ui-migration): the Code tab must render artifact.code as one
  // syntax-highlighted code block, never as parsed markdown prose — a Python `#`
  // comment must never become a markdown heading element.
  describe("Code tab", () => {
    test("AC-10.2: a Python artifact's `#` comment renders as literal code text, never as a markdown heading", async () => {
      const pythonCode = "# this is a comment\nprint('hello')";
      global.fetch = mock(() =>
        Promise.resolve(jsonResponse(makeArtifact({ language: "python", title: "script.py", code: pythonCode }))),
      ) as unknown as typeof fetch;

      const { container } = render(
        <ArtifactCanvas tab="code" onSetTab={noop} onClose={noop} conversationId="conv-1" />,
      );

      await waitFor(() => {
        expect(screen.getByText("script.py")).toBeTruthy();
      });

      // No heading element anywhere in the rendered output — the `#` must never be
      // reinterpreted as markdown.
      for (const tag of ["h1", "h2", "h3", "h4", "h5", "h6"]) {
        expect(container.querySelectorAll(tag).length).toBe(0);
      }

      // The `#`-prefixed comment is present verbatim as literal code text somewhere
      // in the rendered code block.
      expect(container.textContent ?? "").toContain("# this is a comment");
    });
  });
});
