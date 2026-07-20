# Agent Chat Experience — Verification Evidence

Date: 2026-07-18 (Asia/Taipei)

## Automated acceptance

- Representative workflow: project/folder organization → branch-scoped attachment → durable plan → steer → search event → tray-style view restoration → completion → edit-to-branch → return to original branch.
- Security matrix: traversal-style identifiers, symlinks, MIME spoofing, 25 MiB overflow, cross-conversation attachment access, strict Mermaid/link handling, search-key redaction, and main-window-only native capabilities.
- Native save: opaque IDs only, canonical app-owned source, regular-file/symlink checks, exact-byte copy, explicit overwrite refusal, atomic temp-and-rename, and cleanup after failure.
- Generated-file publication: the agent can publish a workspace file into run-scoped app storage, restore its typed download card, and remove the stored copy when its conversation is deleted.

## Scale measurements

Measured on the development machine with Bun 1.3.10. Regression gates use a deliberately generous 30-second ceiling to avoid flaky hardware-dependent failures.

| Fixture | Measurement |
|---|---:|
| Create and list 2,000 conversations | 62 ms |
| Convert 100,000 messages for restoration | 4 ms |
| Commit and replay 10,000 run events (+ start event) | 462 ms |
| Validate/hash/stream-copy a 25 MiB attachment | 25 ms |

The authoritative fixtures live in `server/src/chat-workspace/performance.test.ts`; console output records the current measurement on every run.

## Native packaging

The macOS `.app` bundle was built and launched directly. Its bundled Bun sidecar reached `http://127.0.0.1:4319`, confirming the packaged resource path and pinned pi runtime load successfully. Native chooser appearance, overwrite-confirmation appearance, and tray hide/reopen still require an interactive signed-app pass and are covered here by bridge/Rust automation rather than visual evidence.

Tauri's full DMG command reaches the installer wrapper after producing the working `.app`, but the environment's Finder/DMG wrapper fails. This is recorded as a packaging-environment limitation; it is not represented as a successful installer build.

## Browser evidence

- `desktop-command-center.png` — 1440×960 dense four-column chat workspace with the durable run inspector.
- `brave-search-settings.png` — provider-neutral configuration surface with Brave first, password-only credential entry, enable toggle, and bounded result count.
- `narrow-command-center.png` — 860×900 layout with the inspector collapsed into the accessible Agent work drawer.
- `accessibility-snapshots.txt` — desktop, settings, and narrow semantic snapshots.
- `browser-console.json` — zero warning/error entries for the verified flow.

The required system-Chrome extension surface was unavailable in this environment after the prescribed retry. The visual/accessibility pass therefore used the controlled in-app Chromium browser. This is valid webview evidence, but it does not claim system-Chrome-extension coverage.
