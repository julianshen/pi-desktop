import { describe, expect, mock, test } from "bun:test";

/**
 * Task 10. Mocks `@tauri-apps/api/core`'s `invoke` the same way this repo's
 * established convention mocks other packages via `mock.module()` (see
 * `src/views/ChatView.test.tsx`'s `@copilotkit/react-core` mock). `invokeImpl`
 * is reassigned per test so each test controls whether the (mocked) Rust
 * command resolves or rejects, without re-registering the module mock.
 *
 * `headlessRender.ts` is imported dynamically, after `mock.module()` runs —
 * a static top-level `import` would be hoisted ahead of that call and pick up
 * the real (unmocked) `@tauri-apps/api/core`, same reasoning as
 * `ChatView.test.tsx`'s own dynamic-import comment.
 */
let invokeImpl: (cmd: string, args?: unknown) => Promise<unknown> = () =>
  Promise.reject(new Error("invokeImpl not configured for this test"));

mock.module("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeImpl(cmd, args),
}));

const { renderUrlHeadless } = await import("./headlessRender.js");

describe("renderUrlHeadless", () => {
  test("AC-10.1: invokes render_url_headless with { url, timeoutMs } and returns its resolved HTML", async () => {
    let capturedCmd: string | undefined;
    let capturedArgs: unknown;
    invokeImpl = (cmd, args) => {
      capturedCmd = cmd;
      capturedArgs = args;
      return Promise.resolve("<html><body>rendered</body></html>");
    };

    const result = await renderUrlHeadless("https://example.com/app", 8000);

    expect(capturedCmd).toBe("render_url_headless");
    expect(capturedArgs).toEqual({ url: "https://example.com/app", timeoutMs: 8000 });
    expect(result).toBe("<html><body>rendered</body></html>");
  });

  test("AC-10.2: never throws — returns null when the Rust command's promise rejects (render failure/timeout)", async () => {
    invokeImpl = () => Promise.reject(new Error("render timed out"));

    const result = await renderUrlHeadless("https://example.com/app", 8000);

    expect(result).toBeNull();
  });

  test("AC-10.2: returns null (not throw) even for a non-Error rejection reason", async () => {
    // Rust command errors surface to JS as plain strings (Result<String, String>'s
    // Err arm), not Error instances — this must be handled honestly too, not just
    // the Error-shaped case.
    invokeImpl = () => Promise.reject("render window closed before completion");

    const result = await renderUrlHeadless("https://example.com/app", 8000);

    expect(result).toBeNull();
  });
});
