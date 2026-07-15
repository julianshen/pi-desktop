import { invoke } from "@tauri-apps/api/core";

/**
 * ADR-001 ("Resolve-endpoint trust boundary") + its Addendum. Shared getter for the
 * per-launch resolve-endpoint auth token, consumed by both `App.tsx`'s headless-render
 * watcher (`usePendingRenderInteractionWatcher`) and `ChatView.tsx`'s approval chip
 * (`resolvePendingConfirm`) so every `POST .../resolve` call — the confirm-kind
 * approval chip AND the render-kind headless bridge alike — carries the same
 * `X-Resolve-Token` header value.
 *
 * Two-tier lookup, per ADR-001:
 * 1. `invoke("get_resolve_token")` (`src-tauri/src/lib.rs`) — works in a packaged
 *    build and in `npm run tauri dev`, both of which have a real Tauri IPC bridge.
 *    On success this returns whatever the Rust side returns, `""` included — an
 *    empty string is a legitimate value (dev mode with `PI_DESKTOP_RESOLVE_TOKEN`
 *    unset, see `get_resolve_token`'s own doc comment) and is NOT special-cased here:
 *    the server-side resolve route is what's responsible for rejecting an
 *    empty/mismatched token, not this getter.
 * 2. On ANY `invoke()` failure — covers `npm run dev`'s no-Tauri-window sub-mode
 *    (there is no IPC bridge at all in a plain browser tab pointed at Vite, so
 *    `invoke()` fails unconditionally there, not just on error) as well as any other
 *    command failure — fall back to `import.meta.env.VITE_RESOLVE_TOKEN`, a second
 *    Vite-exposed env var carrying the same value as `PI_DESKTOP_RESOLVE_TOKEN`
 *    (Vite only injects `VITE_`-prefixed vars into `import.meta.env`, which is why
 *    this can't just reuse that other name directly). Only a non-empty string counts
 *    as a usable fallback.
 *
 * If both paths come up empty, this resolves to `null` — the genuine "no token
 * available anywhere" degraded state ADR-001's "New coupling" consequence calls out:
 * callers (the approval chip in particular) are expected to show a real degraded UI
 * for that case, not silently send an unauthenticated request.
 *
 * Memoized at module scope: the underlying value never changes for the lifetime of
 * this process, and multiple call sites (App.tsx + ChatView.tsx) need to agree on the
 * same answer without coordinating with each other — same idea as the server side's
 * `agent/deps.ts` singleton-memoization pattern, just client-side. The promise itself
 * (not just its resolved value) is cached so concurrent early callers share one
 * in-flight `invoke()` call rather than each firing their own.
 *
 * Like `headlessRender.ts`'s `renderUrlHeadless()`, this must NEVER throw — callers
 * need a definite, always-resolvable `string | null` back, not another thing to catch.
 */
let cachedTokenPromise: Promise<string | null> | null = null;

async function fetchResolveToken(): Promise<string | null> {
  try {
    return await invoke<string>("get_resolve_token");
  } catch (error: unknown) {
    console.error(
      "[resolveToken] get_resolve_token invoke() failed (no Tauri bridge, or a command error) — falling back to VITE_RESOLVE_TOKEN",
      error,
    );
    const fallback = import.meta.env.VITE_RESOLVE_TOKEN;
    return typeof fallback === "string" && fallback.length > 0 ? fallback : null;
  }
}

export function getResolveToken(): Promise<string | null> {
  if (!cachedTokenPromise) {
    cachedTokenPromise = fetchResolveToken();
  }
  return cachedTokenPromise;
}

/**
 * Test-only escape hatch: clears the module-level memoization so each test can
 * exercise `getResolveToken()`'s invoke-then-fallback logic from a clean slate,
 * without needing a fresh module instance per test (bun:test's module registry is
 * shared across `test()` cases within a file, same as the rest of this codebase's
 * dynamic-import-after-mock.module() convention). Not imported by any non-test code.
 */
export function __resetResolveTokenCacheForTests(): void {
  cachedTokenPromise = null;
}
