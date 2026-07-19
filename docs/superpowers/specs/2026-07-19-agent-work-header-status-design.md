# Agent Work Header Status Design

Date: 2026-07-19  
Status: Approved visual direction; pending written-spec review  
Scope: Chat view Agent Work presentation only

## Problem

The current Agent Work UI uses a permanent 320 px right sidebar on wide windows and a bottom-right `<details>` panel on narrower windows. The narrow layout can cover the message composer, while the wide layout permanently reduces transcript width. Monitoring agent work is important, but prompt entry must remain continuously visible and usable.

## Approved Direction

Replace both current presentations with a 32 px status bar directly below `MainHeader`. The bar is visible only when the active conversation has an agent run that has not been dismissed. It summarizes status, current step, and progress. Clicking the bar opens a right-aligned drawer over the transcript only. The drawer must never cover the message composer.

The approved completed-state behavior is explicit acknowledgement: a completed run remains visible as `Completed · N/N` until the user dismisses it.

## User Experience

### No run

Render no Agent Work bar and reserve no vertical space. The chat layout is unchanged.

### Running or queued, collapsed

The default presentation is a single 32 px row below `MainHeader`:

- animated steel-blue status dot;
- `Agent Work` label;
- current in-progress step, truncated to one line;
- completed/total progress, such as `2 / 4`;
- disclosure chevron.

The row is a composite control. A primary expand/collapse button fills all available row space and contains the status summary. Terminal states add a sibling dismiss button at the trailing edge. Running states have no dismiss action, so their primary button visually occupies the full row. This avoids nested interactive controls while preserving a large click target.

### Running or queued, expanded

Activating the primary row button opens a right-aligned drawer anchored immediately beneath it. The drawer reuses the existing full `RunInspector` content: plan, recent events, steering input, and stop action.

The drawer overlays the upper-right transcript region instead of reflowing the conversation. Its bottom edge is constrained above the composer reserve, so the composer remains visible and interactive at every supported window size. Activating the row again, pressing Escape, or clicking outside closes the drawer and returns focus to the row.

### Completed

When a run completes:

- replace the animated dot with a success check;
- use the subdued green/gray terminal treatment;
- show `Completed`, the final step summary, and `N/N` progress;
- show a dismiss button;
- keep the row visible until manually dismissed;
- keep the row expandable so the user can review the final plan and events.

Dismissal applies only to the current run ID. A different or newly started run must appear automatically. Dismissal is UI state, not deletion or archival of server data.

### Failed, stopped, or interrupted

Terminal non-success states follow the same acknowledgement model as completed runs. They use the existing danger or neutral tokens, remain expandable for diagnosis, and remain visible until dismissed. Error text stays in the drawer; the compact row shows only the concise terminal status.

## Responsive Behavior

- The status bar is the sole presentation at all widths; remove the `1180px` desktop/sidebar split.
- At narrow widths, omit the current-step label before reducing the status or progress indicators.
- The drawer width is `min(420px, 100%)` of the transcript surface.
- The drawer height is capped at `min(520px, available transcript height minus the measured composer boundary)`.
- `Thread` places a ref on the existing `ThreadPrimitive.ViewportFooter` that contains `Composer`, including the attachment tray, validation text, and footer padding. `ChatView` accepts and forwards this ref. `AgentWorkSurface` observes that element with `ResizeObserver` and uses its actual `getBoundingClientRect().height` as the drawer's bottom inset. The measured height already includes the footer's `pt-ds-2`; no spacing is added a second time. This is an explicit layout contract rather than a fixed composer-height guess.
- Before the first measurement is available, the drawer uses a conservative 160 px bottom inset. Once measured, changes caused by attachments, textarea growth, validation text, or window resizing update the inset without remounting the drawer.
- If the available height is unusually small, the drawer scrolls internally.

## Component Design

### `AgentWorkSurface`

A new focused layout component owns the compact bar, expanded drawer, and acknowledgement UI. It accepts:

- `state: ReturnTypeUseActiveRun`;
- `conversationId: string` to reset local focus/expansion state when the active conversation changes;
- `renderChat(composerBoundaryRef)`, a render prop that returns the active `ChatView` with the supplied ref attached.

It renders a vertical surface:

1. compact status bar when a non-dismissed run exists;
2. a relative, flexible chat-content region;
3. the existing `RunInspector` as an anchored overlay inside that region when expanded.

The render prop makes the boundary contract explicit: `AgentWorkSurface` owns the callback ref and measurement, while `App` passes that ref into `ChatView`. It does not clone or inspect opaque children.

It owns only ephemeral presentation state:

- `expanded: boolean`;
- `dismissedRunId: string | null`.

When the run ID changes, the new run is visible and collapsed by default. A status change for the same run does not lose the user's expanded/collapsed choice. Dismiss is available only for terminal statuses.

The status bar itself is a non-interactive flex container with two possible children:

1. a primary expand/collapse `<button aria-expanded aria-controls>` containing status, current step, progress, and chevron;
2. for terminal runs only, a sibling dismiss `<button>` with its own accessible label.

The dismiss handler stops propagation defensively, although sibling controls do not otherwise share activation behavior.

### `RunInspector`

Keep the existing component responsible for detailed plan/event rendering and steer/stop actions. It remains independently testable. Minor visual adjustments may remove redundant outer sizing assumptions, but action behavior and data contracts do not change.

### `ChatView` and `Thread`

Add an optional composer-boundary ref prop to `ChatView`, forwarded to `Thread`. `Thread` attaches it to the existing `ThreadPrimitive.ViewportFooter`, so the measured boundary always includes `Composer`, attachment drafts, validation errors, textarea growth, and footer padding. With no ref supplied, both components behave exactly as they do today.

This is the only ChatView/Thread layout API added for the feature. Agent Work does not inspect DOM selectors or reach into opaque child markup.

### `App`

In the Chat view, place `AgentWorkSurface` immediately after `MainHeader` and wrap the existing `ChatView`. Remove:

- the wide-screen 320 px `<aside>`;
- the narrow-screen bottom-right `<details>` panel.

Other views and `ArtifactCanvas` remain out of scope. When Canvas is open, the Agent Work bar belongs to the chat column and the drawer stays bounded to that column.

## State Derivation

All data continues to come from `useActiveRun(activeConversationId)`:

- status from `state.run.status`;
- plan from `state.plan`;
- completed count from steps with status `completed`;
- current-step label from the first `in_progress` step; if none exists, use the first `failed` step, otherwise the last `completed` step by position, otherwise the first `pending` step, otherwise concise run status text;
- detailed activity and errors from the existing inspector.

No server endpoint, persistence schema, polling behavior, or agent execution behavior changes.

## Accessibility

- Implement the status summary as a primary button with `aria-expanded` and `aria-controls`; keep the terminal dismiss button as its sibling, never nested inside it.
- Give the drawer a stable ID and an `aria-label` identifying Agent Work details.
- The status text must not depend on color or animation alone.
- Pause or omit pulse animation under `prefers-reduced-motion`.
- Provide a separately labelled dismiss button; it must not trigger row expansion.
- Escape closes the drawer and restores focus to the row.
- Preserve keyboard access to steer and stop controls.
- Announce meaningful status transitions through a restrained polite live region; polling ticks and ordinary event additions must not repeatedly announce.

## Error Handling

- Existing polling errors remain visible in the expanded inspector.
- If run data is temporarily unavailable, do not invent progress or a current step.
- A previously known run may keep its last honest status while `state.error` is shown in the drawer.
- Steering and stop failures continue to use `RunInspector`'s existing inline alert.
- Dismiss and expand actions are local and cannot fail.

## Testing

Add component tests covering:

1. no run renders no status bar;
2. running run renders collapsed status, current step, and progress;
3. clicking the row opens and closes the detailed inspector;
4. Escape closes the drawer and restores focus;
5. terminal runs show the correct status and dismiss action;
6. dismiss hides only the current run;
7. a new run ID reappears after a previous run was dismissed;
8. narrow layout hides the step label but retains status and progress;
9. the drawer uses the transcript-bounded layout and measured composer boundary;
10. composer boundary measurement updates when attachment or validation content changes;
11. existing steer and stop behavior remains functional through the drawer;
12. the expand and dismiss controls are accessible sibling buttons with distinct actions;
13. reduced-motion styling disables the running pulse animation.
14. clicking outside the drawer closes it without triggering transcript or composer actions.

Update `App` tests or source assertions to verify the old permanent aside and floating `<details>` implementations are removed and the new surface wraps Chat view content.

## Acceptance Criteria

- The composer and attachment input remain fully visible and clickable whether Agent Work is collapsed or expanded.
- Agent Work no longer permanently consumes 320 px of transcript width.
- A running agent remains monitorable from the compact row at every supported width.
- Expanded plan, progress, events, steering, and stop controls preserve their current behavior.
- A completed run remains visible until explicitly dismissed.
- Dismissing one run never suppresses a later run.
- Switching conversations shows only the active conversation's Agent Work state.
- Existing design-system tokens and Industry/blueprint visual language are preserved.
- No backend or protocol change is introduced.

## Out of Scope

- Changing run execution, polling, resumability, or event schemas;
- persisting the expanded/collapsed preference across app launches;
- adding notifications or tray badges;
- redesigning the plan, event list, steering controls, or Canvas;
- changing how chat history or branches are stored.
