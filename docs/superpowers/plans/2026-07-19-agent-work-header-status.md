# Agent Work Header Status Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the permanent/floating Agent Work panels with an accessible header status surface whose drawer never covers the dynamic chat composer.

**Architecture:** Add a focused `AgentWorkSurface` that owns compact status, expansion, acknowledgement, focus, and composer-boundary measurement while continuing to render the existing `RunInspector` for detailed controls. Pass an explicit callback ref through `ChatView` and `Thread` to the existing `ThreadPrimitive.ViewportFooter`, then integrate the surface into `App` and delete both old responsive presentations.

**Tech Stack:** React 19, TypeScript, Assistant UI primitives, Tailwind v4 design tokens, Testing Library, Bun test, ResizeObserver.

---

## File Map

- Create `src/components/chat/AgentWorkSurface.tsx`: compact bar, status derivation, expanded transcript drawer, terminal acknowledgement, focus handling, and measured composer boundary.
- Create `src/components/chat/AgentWorkSurface.test.tsx`: behavioral, responsive-class, measurement, keyboard, click-outside, and reduced-motion coverage.
- Modify `src/styles/design-system.css`: add semantic success/success-background tokens for the approved completed treatment.
- Modify `src/styles/design-system.test.ts`: prove the new success utility classes resolve through the app's own tokens.
- Modify `src/components/chat/Thread.tsx`: accept an optional composer-boundary callback ref and attach it to `ThreadPrimitive.ViewportFooter`.
- Modify `src/components/chat/Thread.test.tsx`: verify the footer ref contract without changing existing rendering behavior.
- Modify `src/views/ChatView.tsx`: accept and forward the optional composer-boundary callback ref.
- Modify `src/views/ChatView.test.tsx`: verify ChatView forwards the ref to the actual composer footer.
- Modify `src/App.tsx`: wrap Chat view content in `AgentWorkSurface` and remove the old wide aside and narrow `<details>` panel.
- Modify `src/App.test.tsx`: verify the new integration and absence of both obsolete presentations.

## Chunk 1: Status Surface and Composer Boundary

### Task 1: Build the Agent Work status surface with TDD

**Files:**
- Create: `src/components/chat/AgentWorkSurface.test.tsx`
- Create: `src/components/chat/AgentWorkSurface.tsx`
- Modify: `src/styles/design-system.css`
- Modify: `src/styles/design-system.test.ts`
- Reuse: `src/components/chat/RunInspector.tsx`
- Reuse: `src/components/chat/runInspectorTypes.ts`

- [ ] **Step 1: Write the failing status and progress tests**

Create a shared running fixture matching `ReturnTypeUseActiveRun`, render `AgentWorkSurface` with a simple `renderChat` child, and assert:

```tsx
test("no run reserves no Agent Work row", () => {
  render(<AgentWorkSurface state={{ ...base, run: null, plan: [] }} conversationId="conv" renderChat={() => <div>Chat</div>} />);
  expect(screen.queryByRole("button", { name: /Agent work/i })).toBeNull();
});

test("running run shows current step and completed progress in a collapsed row", () => {
  renderSurface({
    run: { ...base.run, status: "running" },
    plan: [
      { id: "one", position: 0, title: "Inspect", status: "completed" },
      { id: "two", position: 1, title: "Update collapsed state", status: "in_progress" },
    ],
  });
  const toggle = screen.getByRole("button", { name: /Agent work/i });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByText("Update collapsed state")).toBeTruthy();
  expect(screen.getByText("1 / 2")).toBeTruthy();
});

test.each([
  ["queued", "Queued"], ["running", "Running"], ["completed", "Completed"],
  ["failed", "Failed"], ["stopped", "Stopped"], ["interrupted", "Interrupted"],
] as const)("%s run with no plan still exposes a meaningful status", (status, label) => {
  renderSurface({ run: { ...base.run, status }, plan: [] });
  expect(screen.getByText(label)).toBeTruthy();
});
```

Also assert queued/running use the animated steel-blue indicator, completed uses the success check and green/gray terminal tokens, failed uses danger tokens, and stopped/interrupted use neutral terminal tokens. Assert the polite live region contains only the concise run-status announcement.

Add failing compile assertions to `design-system.test.ts` for `text-success`, `bg-success-bg`, and `border-success`, following that file's existing `compileDesignSystemCss` pattern. Expected before implementation: the candidates do not resolve to the required app variables.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun test src/components/chat/AgentWorkSurface.test.tsx src/styles/design-system.test.ts`  
Expected: FAIL because `AgentWorkSurface.tsx` does not exist and the success token utilities are not mapped.

- [ ] **Step 3: Implement status derivation and the collapsed composite bar**

In `AgentWorkSurface.tsx`, define:

```tsx
const TERMINAL_STATUSES = new Set(["completed", "failed", "stopped", "interrupted"]);

export function getAgentWorkSummary(state: ReturnTypeUseActiveRun) {
  const ordered = [...state.plan].sort((a, b) => a.position - b.position);
  const completed = state.plan.filter((step) => step.status === "completed").length;
  const step = ordered.find((item) => item.status === "in_progress")
    ?? ordered.find((item) => item.status === "failed")
    ?? [...ordered].reverse().find((item) => item.status === "completed")
    ?? ordered.find((item) => item.status === "pending");
  const statusLabel = state.run ? {
    queued: "Queued", running: "Running", completed: "Completed", failed: "Failed",
    stopped: "Stopped", interrupted: "Interrupted",
  }[state.run.status] : "No run";
  return {
    completed,
    total: state.plan.length,
    currentStep: step?.title,
    statusLabel,
    terminal: state.run ? TERMINAL_STATUSES.has(state.run.status) : false,
  };
}
```

Add `--color-success: #527864` and `--color-success-bg: #f4f8f5` to `:root`, and map both through the Tailwind v4 `@theme inline` block exactly as the existing danger tokens are mapped. Render the chat region even when `state.run` is null: the root is `flex min-h-0 flex-1 flex-col`, `renderChat(composerBoundaryRef)` always renders inside `relative min-h-0 flex-1`, and only the 32 px status bar is conditional. The bar is a token-based, non-interactive `flex h-8 flex-none` container. Put the summary inside a flexing primary `<button aria-expanded aria-controls>`. Use a 7 px circular `span` with `bg-accent motion-safe:animate-pulse motion-reduce:animate-none` for queued/running, Lucide `CircleCheckIcon` for completed, `CircleAlertIcon` for failed, and `CircleStopIcon` for stopped/interrupted; every indicator is accompanied by visible status text. Render the current-step span only when `currentStep` exists, and hide it with `hidden min-[620px]:inline`; no-plan runs therefore show the explicit status exactly once. Always retain status and progress. Use `text-accent` for queued/running, `border-success bg-success-bg text-success` for completed, `border-danger bg-danger-bg text-danger` for failed, and `border-divider bg-surface text-muted` for stopped/interrupted.

Inside the status bar's existing `state.run` guard, add `<span key={`${state.run.id}:${state.run.status}`} className="sr-only" aria-live="polite" aria-atomic="true">Agent work {statusLabel}</span>`. Its visible announcement derives only from status and its key changes for a new run ID or status transition, not events, cursor, plan text, or progress, so polling updates do not repeatedly announce ordinary activity.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `bun test src/components/chat/AgentWorkSurface.test.tsx src/styles/design-system.test.ts`  
Expected: PASS for no-run, status, step, progress, and success-token mapping tests.

- [ ] **Step 5: Write failing interaction and terminal acknowledgement tests**

Add assertions for:

- clicking the primary button opens/closes the existing `RunInspector` drawer;
- `Escape` closes it and restores focus to the primary button;
- clicking the transcript backdrop closes it;
- completed, failed, stopped, and interrupted runs show a sibling dismiss button;
- queued/running runs do not show dismiss;
- dismiss hides only that run ID;
- a later run ID becomes visible and collapsed;
- clicking dismiss does not toggle the drawer;
- the expand and dismiss buttons are siblings, not nested.
- queued/running status dots include both `motion-safe:animate-pulse` and `motion-reduce:animate-none`;
- current-step text carries `hidden min-[620px]:inline`, while status and progress do not;
- rerendering with additional events but unchanged run ID/status does not change the polite live-region text, while changing running to completed updates it from `Agent work Running` to `Agent work Completed`;
- steering text entered through the expanded `RunInspector` calls `state.steer`;
- the expanded Stop button calls `state.stop`.

Representative assertion:

```tsx
const toggle = screen.getByRole("button", { name: /Agent work/i });
fireEvent.click(toggle);
expect(toggle.getAttribute("aria-expanded")).toBe("true");
expect(screen.getByLabelText("Agent work details")).toBeTruthy();
fireEvent.keyDown(document, { key: "Escape" });
expect(toggle.getAttribute("aria-expanded")).toBe("false");
expect(document.activeElement).toBe(toggle);
```

For click-outside, render a transcript button from `renderChat`, click the backdrop by its `aria-label="Close Agent work details"`, and assert the transcript button handler was not called, the drawer closed, and focus returned to the primary toggle.

- [ ] **Step 6: Run the interaction tests and verify RED**

Run: `bun test src/components/chat/AgentWorkSurface.test.tsx`  
Expected: FAIL because drawer, Escape, backdrop, terminal dismissal, and run-ID reset behavior are not implemented.

- [ ] **Step 7: Implement expansion, acknowledgement, and focus behavior**

Use local state and stable refs:

```tsx
const [expanded, setExpanded] = useState(false);
const [dismissedRunId, setDismissedRunId] = useState<string | null>(null);
const toggleRef = useRef<HTMLButtonElement>(null);
const visibleRun = state.run && state.run.id !== dismissedRunId ? state.run : null;

useEffect(() => setExpanded(false), [conversationId, state.run?.id]);
useEffect(() => {
  if (!expanded) return;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    setExpanded(false);
    requestAnimationFrame(() => toggleRef.current?.focus());
  };
  document.addEventListener("keydown", onKeyDown);
  return () => document.removeEventListener("keydown", onKeyDown);
}, [expanded]);
```

Inside the always-rendered `relative min-h-0 flex-1` chat region, render a backdrop with `absolute inset-x-0 top-0 z-20`, a measured bottom inset, and `aria-label="Close Agent work details"`. Its pointer handler closes the drawer, stops propagation, and returns focus to the toggle; it never covers the measured composer region. Put `RunInspector` above it in `absolute right-0 top-0 z-30 w-[min(420px,100%)] overflow-y-auto border border-border bg-surface shadow-lg`, wrap the inspector with `h-full`, and apply the measured height described in Step 11. Give the drawer a stable conversation/run-derived ID and `aria-label="Agent work details"`. Render terminal dismiss as a sibling `<button aria-label="Dismiss Agent work result">`; stop propagation and set `dismissedRunId` without changing server state. The drawer's internal overflow handles unusually short windows.

- [ ] **Step 8: Run the interaction tests and verify GREEN**

Run: `bun test src/components/chat/AgentWorkSurface.test.tsx`  
Expected: all interaction and acknowledgement tests PASS.

- [ ] **Step 9: Write the failing ResizeObserver boundary tests**

Install a test-local `MockResizeObserver` that captures its callback. First render with `renderChat` intentionally not attaching the supplied ref and assert an open drawer uses the `160px` fallback. Rerender with the ref attached to a boundary whose `getBoundingClientRect()` returns 88 px and wait for the layout effect. Then change the stubbed height to 156 px and invoke the captured observer callback inside `act(...)` before asserting the CSS variable updates.

```tsx
expect(drawer.style.getPropertyValue("--composer-boundary-height")).toBe("160px");
rerender(<Fixture attachBoundary />);
await waitFor(() => expect(drawer.style.getPropertyValue("--composer-boundary-height")).toBe("88px"));
composerRectHeight = 156;
act(() => resizeCallback?.([], observer));
expect(drawer.style.getPropertyValue("--composer-boundary-height")).toBe("156px");
```

- [ ] **Step 10: Run the measurement test and verify RED**

Run: `bun test src/components/chat/AgentWorkSurface.test.tsx`  
Expected: FAIL because the surface does not observe the supplied composer boundary.

- [ ] **Step 11: Implement explicit composer measurement**

Use a callback ref plus layout effect:

```tsx
const [composerBoundary, setComposerBoundary] = useState<HTMLElement | null>(null);
const [composerHeight, setComposerHeight] = useState(160);
const composerBoundaryRef = useCallback((node: HTMLElement | null) => setComposerBoundary(node), []);

useLayoutEffect(() => {
  if (!composerBoundary) return;
  const measure = () => setComposerHeight(composerBoundary.getBoundingClientRect().height);
  measure();
  const observer = new ResizeObserver(measure);
  observer.observe(composerBoundary);
  return () => observer.disconnect();
}, [composerBoundary]);
```

Apply `--composer-boundary-height: ${composerHeight}px` to both backdrop and drawer. Give the backdrop `bottom: var(--composer-boundary-height)`. Bound the drawer with `height: min(520px, max(0px, calc(100% - var(--composer-boundary-height))))`; do not add footer padding again because the measured element already includes it. Keep `overflow-y-auto` on the drawer so `RunInspector` remains usable when height is constrained.

- [ ] **Step 12: Run all surface tests and commit**

Run: `bun test src/components/chat/AgentWorkSurface.test.tsx src/styles/design-system.test.ts`  
Expected: PASS.

```bash
git add src/components/chat/AgentWorkSurface.tsx src/components/chat/AgentWorkSurface.test.tsx src/styles/design-system.css src/styles/design-system.test.ts
git commit -m "Add Agent Work header status surface"
```

### Task 2: Add the explicit Chat composer boundary contract

**Files:**
- Modify: `src/components/chat/Thread.tsx`
- Modify: `src/components/chat/Thread.test.tsx`
- Modify: `src/views/ChatView.tsx`
- Modify: `src/views/ChatView.test.tsx`

- [ ] **Step 1: Write failing Thread ref-forwarding test**

Use the existing `TestHarness` directly, pass a callback ref to `Thread`, and assert it receives the `ThreadPrimitive.ViewportFooter` element containing the `Message input` textbox.

```tsx
let boundary: HTMLDivElement | null = null;
render(
  <TestHarness>
    <Thread composerBoundaryRef={(node) => { boundary = node; }} />
  </TestHarness>,
);
expect(boundary).not.toBeNull();
expect(boundary?.contains(screen.getByRole("textbox", { name: "Message input" }))).toBe(true);
```

- [ ] **Step 2: Run Thread test and verify RED**

Run: `bun test src/components/chat/Thread.test.tsx`  
Expected: FAIL because `Thread` accepts no props and attaches no ref.

- [ ] **Step 3: Add optional ref prop to Thread**

```tsx
export interface ThreadProps {
  composerBoundaryRef?: RefCallback<HTMLDivElement>;
}

export const Thread: FC<ThreadProps> = ({ composerBoundaryRef }) => (
  // existing root and messages unchanged
  <ThreadPrimitive.ViewportFooter ref={composerBoundaryRef} className="sticky bottom-0 pt-ds-2">
    <Composer />
  </ThreadPrimitive.ViewportFooter>
);
```

- [ ] **Step 4: Run Thread test and verify GREEN**

Run: `bun test src/components/chat/Thread.test.tsx`  
Expected: PASS, including all existing Thread tests.

- [ ] **Step 5: Write failing ChatView forwarding test**

Render the existing `Harness` with a callback ref prop, wait for history seeding, and assert the received element contains the actual message input. Keep the mock history response empty; this test concerns layout wiring only.

- [ ] **Step 6: Run ChatView test and verify RED**

Run: `bun test src/views/ChatView.test.tsx`  
Expected: FAIL because `ChatView` has no `composerBoundaryRef` prop.

- [ ] **Step 7: Forward the optional ref through ChatView**

Add `composerBoundaryRef?: RefCallback<HTMLDivElement>` to `ChatView` props, import the React type, and render `<Thread composerBoundaryRef={composerBoundaryRef} />`. Do not alter history, branch, error, attachment, or tool UI behavior.

- [ ] **Step 8: Run focused tests and commit**

Run: `bun test src/components/chat/Thread.test.tsx src/views/ChatView.test.tsx`  
Expected: PASS.

```bash
git add src/components/chat/Thread.tsx src/components/chat/Thread.test.tsx src/views/ChatView.tsx src/views/ChatView.test.tsx
git commit -m "Expose chat composer boundary"
```

## Chunk 2: App Integration and End-to-End Verification

### Task 3: Replace both legacy Agent Work layouts in App

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`
- Use: `src/components/chat/AgentWorkSurface.tsx`

- [ ] **Step 1: Write the failing App integration regression test**

Add a source-level regression test alongside the existing App wiring tests that reads `App.tsx` and asserts:

```tsx
expect(source).toContain("<AgentWorkSurface");
expect(source).toContain("renderChat={(composerBoundaryRef)");
expect(source).not.toContain("min-[1180px]:block");
expect(source).not.toContain("<details");
expect(source).not.toContain("bottom-ds-3 right-ds-3");
```

Do not add another AgentWorkSurface component test here: Task 1 already covers the component behavior. This App source assertion is limited to proving obsolete responsive wiring is removed and the tested component is connected.

- [ ] **Step 2: Run App test and verify RED**

Run: `bun test src/App.test.tsx`  
Expected: FAIL because App still renders the permanent aside and floating `<details>` panel.

- [ ] **Step 3: Integrate AgentWorkSurface**

Import `AgentWorkSurface` and remove the now-unused direct `RunInspector` import. In the central Chat column, immediately after `MainHeader`, replace the plain ChatView branch with:

```tsx
{state.view === "chat" && (
  <AgentWorkSurface
    state={activeRun}
    conversationId={state.activeConv}
    renderChat={(composerBoundaryRef) => (
      <ChatView
        key={state.activeConv}
        model={state.model}
        conversationId={state.activeConv}
        composerBoundaryRef={composerBoundaryRef}
        onTurnComplete={handleTurnComplete}
        onOpenArtifact={actions.openArtifact}
      />
    )}
  />
)}
```

Delete both old `state.view === "chat"` blocks that render the 320 px `<aside>` and bottom-right `<details>`. Keep `ArtifactCanvas` as the existing sibling so it remains outside the Agent Work surface and the drawer stays bounded to the Chat column.

- [ ] **Step 4: Run App and component tests**

Run: `bun test src/App.test.tsx src/components/chat/AgentWorkSurface.test.tsx src/views/ChatView.test.tsx`  
Expected: PASS.

- [ ] **Step 5: Run typecheck and commit**

Run: `npm run typecheck`  
Expected: root and server `tsc --noEmit` PASS.

```bash
git add src/App.tsx src/App.test.tsx
git commit -m "Move Agent Work below chat header"
```

### Task 4: Verify accessibility, responsive behavior, and regressions

**Files:**
- Verify or fix as evidence requires: `src/components/chat/AgentWorkSurface.tsx`
- Verify or fix as evidence requires: `src/components/chat/AgentWorkSurface.test.tsx`
- Verify or fix as evidence requires: `src/App.tsx`
- Verify or fix as evidence requires: `src/App.test.tsx`
- Verify or fix as evidence requires: `src/views/ChatView.tsx`
- Verify or fix as evidence requires: `src/views/ChatView.test.tsx`
- Verify or fix as evidence requires: `src/components/chat/Thread.tsx`
- Verify or fix as evidence requires: `src/components/chat/Thread.test.tsx`

- [ ] **Step 1: Run the complete frontend test suite**

Run: `bun test ./src`  
Expected: all frontend tests PASS with zero failures.

- [ ] **Step 2: Run full typecheck**

Run: `npm run typecheck`  
Expected: frontend and server typechecks PASS.

- [ ] **Step 3: Start the real frontend and backend for browser verification**

First stop the currently launched packaged app so port 4319 is free: identify the listener with `lsof -nP -iTCP:4319 -sTCP:LISTEN`, inspect its parent with `ps -p <pid>,<ppid> -o pid,ppid,command`, and terminate only those two verified pi-desktop processes. Start `npm run dev` in a tracked terminal session and retain its session ID for cleanup.

Use the real read-only conversation and run APIs. Query `GET /api/conversations`, then `GET /api/conversations/:id/runs` for listed conversations to select an existing conversation with a run if one is present; do not create or modify persistence solely for verification. The deterministic component tests from Task 1 are the authority for queued/running/completed/failed/stopped/interrupted states, new run IDs, dismissal, and ResizeObserver-driven attachment/validation/textarea changes. Browser verification checks the actual available run state, no-run layout, responsive presentation, drawer interaction, and conversation isolation without mocked network payloads. If the persisted data has no run, record that browser verification covered the no-run state while the focused component tests covered run-bearing states.

- [ ] **Step 4: Verify the approved visual states in a real browser**

Check:

- no-run conversations reserve no bar height;
- running bar sits directly under `MainHeader`;
- at a 619 px viewport, current-step text is hidden but status/progress remain;
- at a 620 px or wider viewport, current-step text is visible;
- drawer opens over transcript only;
- the drawer bottom remains above the real composer; automated ResizeObserver tests cover attachment, textarea, and validation-driven height changes deterministically;
- Escape and click-outside close the drawer;
- terminal result remains until dismiss;
- switching conversation never leaks a previous conversation's run surface.

- [ ] **Step 5: Inspect the final diff**

Run: `git diff --check` and `git status --short`  
Expected: no whitespace errors; only intended files plus the user's pre-existing untracked files are present.

- [ ] **Step 6: Commit any verification fixes**

If browser verification required changes, rerun the focused tests covering every changed integration layer:

Run: `bun test src/components/chat/AgentWorkSurface.test.tsx src/components/chat/Thread.test.tsx src/views/ChatView.test.tsx src/App.test.tsx`  
Expected: PASS.

Then stage only whichever of the planned feature files actually changed and commit them. The complete allowed staging set is:

```bash
git add src/components/chat/AgentWorkSurface.tsx src/components/chat/AgentWorkSurface.test.tsx src/components/chat/Thread.tsx src/components/chat/Thread.test.tsx src/views/ChatView.tsx src/views/ChatView.test.tsx src/App.tsx src/App.test.tsx src/styles/design-system.css src/styles/design-system.test.ts
git commit -m "Polish Agent Work status interactions"
```

If no changes were required, do not create an empty commit.

- [ ] **Step 7: Rebuild and launch the desktop app**

Stop the tracked `npm run dev` terminal session with Ctrl-C. Verify `lsof -nP -iTCP:4319 -sTCP:LISTEN` returns no listener before packaging. Run `npm run tauri build`; if DMG creation stalls after the `.app` bundle has succeeded, stop only the stalled DMG packaging process and use the freshly built `.app` bundle.

Launch and verify with reproducible commands:

```bash
open -n /Users/julianshen/prj/pi-desktop/src-tauri/target/release/bundle/macos/pi-desktop.app
for i in 1 2 3 4 5 6 7 8 9 10; do curl -fsS http://127.0.0.1:4319/health && break; sleep 1; done
curl -fsS http://127.0.0.1:4319/health
lsof -nP -iTCP:4319 -sTCP:LISTEN
ps -p <listener-pid>,<listener-ppid> -o pid,ppid,command
```

Expected: health prints `{"status":"ok"}`; `lsof` has exactly one LISTEN row on 127.0.0.1:4319; the listener command is the packaged `pi-desktop-server` inside this bundle; its parent command is the packaged `tauri-app`. If any old listener exists, stop and relaunch before accepting the result.

- [ ] **Step 8: Push the feature branch and update the existing PR**

Run: `git push`  
Expected: `agent/agent-chat-experience` pushes successfully and PR #1 contains the implementation commits.
