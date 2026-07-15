import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * ADR-001 ("Resolve-endpoint trust boundary") + its Addendum. Mocks
 * `@tauri-apps/api/core`'s `invoke` the same way this repo's established convention
 * mocks it elsewhere (`src/lib/headlessRender.test.ts`, `src/App.test.tsx`).
 * `invokeImpl` is reassigned per test so each test controls whether the (mocked) Rust
 * command resolves or rejects, without re-registering the module mock.
 *
 * `resolveToken.ts` is imported dynamically, after `mock.module()` runs — a static
 * top-level `import` would be hoisted ahead of that call and pick up the real
 * (unmocked) `@tauri-apps/api/core`, same reasoning as the other test files' own
 * dynamic-import comments.
 *
 * `import.meta.env.VITE_RESOLVE_TOKEN` is exercised by directly setting/deleting it
 * per test — Bun's `import.meta.env` is a live view over `process.env` (verified: an
 * assignment through either name is immediately visible through the other), so this
 * needs no extra test tooling beyond plain assignment/`delete`, unlike a real Vite
 * build's static replacement. There is no existing precedent in this repo for
 * exercising a Vite env var's *fallback* branch specifically (App.tsx/serverOrigin.ts
 * only ever read `VITE_COPILOTKIT_RUNTIME_URL` with a hardcoded `??` default, never
 * under test) — this file establishes that convention.
 */
let invokeImpl: (cmd: string, args?: unknown) => Promise<unknown> = () =>
  Promise.reject(new Error("invokeImpl not configured for this test"));
let invokeCallCount = 0;

mock.module("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => {
    invokeCallCount += 1;
    return invokeImpl(cmd, args);
  },
}));

const { getResolveToken, __resetResolveTokenCacheForTests } = await import("./resolveToken.js");

const ORIGINAL_VITE_RESOLVE_TOKEN = import.meta.env.VITE_RESOLVE_TOKEN;

beforeEach(() => {
  invokeCallCount = 0;
  invokeImpl = () => Promise.reject(new Error("invokeImpl not configured for this test"));
  __resetResolveTokenCacheForTests();
  delete import.meta.env.VITE_RESOLVE_TOKEN;
});

afterEach(() => {
  if (ORIGINAL_VITE_RESOLVE_TOKEN === undefined) {
    delete import.meta.env.VITE_RESOLVE_TOKEN;
  } else {
    import.meta.env.VITE_RESOLVE_TOKEN = ORIGINAL_VITE_RESOLVE_TOKEN;
  }
  __resetResolveTokenCacheForTests();
});

describe("getResolveToken (ADR-001)", () => {
  test("ADR-001: invoke('get_resolve_token') success returns that value verbatim", async () => {
    invokeImpl = (cmd) => {
      expect(cmd).toBe("get_resolve_token");
      return Promise.resolve("rust-token-123");
    };

    const token = await getResolveToken();

    expect(token).toBe("rust-token-123");
  });

  test("ADR-001: an empty-string invoke() success is returned as-is, not treated as 'no token' (the Rust side's own unwrap_or_default() sentinel — the server, not this getter, rejects it)", async () => {
    invokeImpl = () => Promise.resolve("");

    const token = await getResolveToken();

    expect(token).toBe("");
  });

  test("ADR-001 Addendum: invoke() failure (no Tauri bridge, e.g. npm run dev's no-window sub-mode) falls back to import.meta.env.VITE_RESOLVE_TOKEN", async () => {
    invokeImpl = () => Promise.reject(new Error("invoke is not available"));
    import.meta.env.VITE_RESOLVE_TOKEN = "vite-fallback-token";

    const token = await getResolveToken();

    expect(token).toBe("vite-fallback-token");
  });

  test("ADR-001 Addendum: invoke() failure AND no VITE_RESOLVE_TOKEN set resolves to null (the genuine no-token-available degraded state)", async () => {
    invokeImpl = () => Promise.reject(new Error("invoke is not available"));
    delete import.meta.env.VITE_RESOLVE_TOKEN;

    const token = await getResolveToken();

    expect(token).toBeNull();
  });

  test("ADR-001 Addendum: an empty-string VITE_RESOLVE_TOKEN does not count as a usable fallback — resolves to null", async () => {
    invokeImpl = () => Promise.reject(new Error("invoke is not available"));
    import.meta.env.VITE_RESOLVE_TOKEN = "";

    const token = await getResolveToken();

    expect(token).toBeNull();
  });

  test("memoization: calling getResolveToken() twice only invokes the underlying invoke() mock once", async () => {
    invokeImpl = () => Promise.resolve("rust-token-abc");

    const first = await getResolveToken();
    const second = await getResolveToken();

    expect(first).toBe("rust-token-abc");
    expect(second).toBe("rust-token-abc");
    expect(invokeCallCount).toBe(1);
  });

  test("memoization: concurrent early callers (before the first invoke() call settles) share the same in-flight promise, not one invoke() per caller", async () => {
    let resolveInvoke!: (value: string) => void;
    invokeImpl = () =>
      new Promise((resolve) => {
        resolveInvoke = resolve;
      });

    const firstCall = getResolveToken();
    const secondCall = getResolveToken();
    resolveInvoke("rust-token-xyz");

    const [first, second] = await Promise.all([firstCall, secondCall]);

    expect(first).toBe("rust-token-xyz");
    expect(second).toBe("rust-token-xyz");
    expect(invokeCallCount).toBe(1);
  });
});
