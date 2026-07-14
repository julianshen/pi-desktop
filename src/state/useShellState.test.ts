import { describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { useShellState } from "./useShellState.js";

/**
 * Regression test for a CRITICAL bug found in final review: `activeConv` was
 * hardcoded to `"c1"`, a stale mock conversation id from src/data/mockData.ts.
 * Nothing anywhere reconciled that to the real server-side conversation before
 * App.tsx rendered ChatView/ArtifactCanvas with it, so every fresh launch sent
 * threadId "c1" to /agui, which the server (server/src/agent/conversations.ts's
 * getOrCreateSession — no registry-membership check) silently treated as a brand
 * new empty conversation instead of falling back to "default". This is exactly
 * the regression AC-12.2 was designed to prevent, and it was invisible to
 * ChatView.test.tsx's AC-12.2 test because that test injects
 * conversationId="default" directly as a prop, bypassing this real initial-state
 * wiring entirely.
 *
 * "default" is always a safe, correct starting id: server/src/agent/conversations.ts's
 * conversationCwd("default") maps 1:1 to env.workspaceDir (the pre-existing shared
 * session), and ensureDefaultConversation() lazily registers it on first touch
 * regardless of whether GET /api/conversations has returned yet.
 */
describe("useShellState", () => {
  test("initial activeConv is the real 'default' conversation id, not a stale mock id", () => {
    const { result } = renderHook(() => useShellState());
    expect(result.current.state.activeConv).toBe("default");
  });

  test("initial view defaults to chat and activeFilter matches DEFAULT_FILTER for that view", () => {
    const { result } = renderHook(() => useShellState());
    expect(result.current.state.view).toBe("chat");
  });

  // Most turns don't publish an artifact, so opening the Canvas unconditionally on
  // every launch showed an empty "Nothing published to the canvas yet" panel far
  // more often than real content. It now starts closed; the user opens it
  // explicitly (MainHeader's Canvas button) or implicitly (clicking a
  // publish_artifact chat attachment chip).
  test("Canvas starts closed by default", () => {
    const { result } = renderHook(() => useShellState());
    expect(result.current.state.artifactOpen).toBe(false);
  });

  /**
   * Regression test for a bug found LIVE via /tgd-verify (a real running app in a real
   * browser), not just a mocked-test-only issue: `state.model` was hardcoded to
   * "pi-2 Sonnet", a stale mock default from before this feature was wired to a real
   * backend. MainHeader.tsx's own model picker correctly showed the honest "Select
   * model" empty state (verified live, in an environment with no configured models),
   * but ChatView.tsx's composer footer — which renders `state.model` directly — showed
   * the fake "pi-2 Sonnet" name at the same time, immediately below it. There is no
   * server-exposed "default model" (GET /api/models's ModelSummary has no
   * current/default flag), so the only honest initial value is empty; ChatView.tsx
   * renders nothing in the composer footer when `model` is falsy instead of ever
   * showing a fake name.
   */
  test("initial model is empty, never the stale fake 'pi-2 Sonnet' mock default", () => {
    const { result } = renderHook(() => useShellState());
    expect(result.current.state.model).toBe("");
    expect(result.current.state.model).not.toBe("pi-2 Sonnet");
  });

  describe("artifact-attachment Canvas pinning", () => {
    test("initial canvasArtifactId is null (show the latest artifact)", () => {
      const { result } = renderHook(() => useShellState());
      expect(result.current.state.canvasArtifactId).toBeNull();
    });

    test("openArtifact(id) opens the Canvas pinned to that specific artifact id", () => {
      const { result } = renderHook(() => useShellState());
      act(() => result.current.actions.openArtifact("artifact-7"));
      expect(result.current.state.artifactOpen).toBe(true);
      expect(result.current.state.canvasArtifactId).toBe("artifact-7");
    });

    test("openArtifact() with no id opens the Canvas showing the latest artifact", () => {
      const { result } = renderHook(() => useShellState());
      act(() => result.current.actions.openArtifact("artifact-7"));
      act(() => result.current.actions.openArtifact());
      expect(result.current.state.artifactOpen).toBe(true);
      expect(result.current.state.canvasArtifactId).toBeNull();
    });

    test("toggleArtifact() clears a pinned artifact id when reopening a closed Canvas", () => {
      const { result } = renderHook(() => useShellState());
      act(() => result.current.actions.openArtifact("artifact-7"));
      act(() => result.current.actions.toggleArtifact()); // close
      expect(result.current.state.artifactOpen).toBe(false);
      act(() => result.current.actions.toggleArtifact()); // reopen via the generic button
      expect(result.current.state.artifactOpen).toBe(true);
      expect(result.current.state.canvasArtifactId).toBeNull();
    });

    test("setActiveConv() clears a pinned artifact id from the previous conversation", () => {
      const { result } = renderHook(() => useShellState());
      act(() => result.current.actions.openArtifact("artifact-7"));
      act(() => result.current.actions.setActiveConv("conv-2"));
      expect(result.current.state.canvasArtifactId).toBeNull();
    });
  });
});
