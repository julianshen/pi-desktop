import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * The window is frameless (`decorations: false`, tauri.conf.json) — these
 * three dots are the app's only window-chrome controls, not a non-functional
 * copy of a real native title bar. Mocks `@tauri-apps/api/core`'s `invoke`
 * the same way `headlessRender.test.ts` does: `invokeImpl` reassigned per
 * test, module imported dynamically after `mock.module()` runs so the static
 * import doesn't get hoisted ahead of the mock registration.
 */
let invokeImpl: (cmd: string, args?: unknown) => Promise<unknown> = () => Promise.resolve(undefined);
let invokeCalls: string[] = [];

mock.module("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => {
    invokeCalls.push(cmd);
    return invokeImpl(cmd, args);
  },
}));

const { TitleBar } = await import("./TitleBar.js");

describe("TitleBar window-chrome dots", () => {
  beforeEach(() => {
    invokeCalls = [];
    invokeImpl = () => Promise.resolve(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  test("clicking the red dot invokes window_close", () => {
    render(<TitleBar windowTitle="Chat" />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(invokeCalls).toEqual(["window_close"]);
  });

  test("clicking the yellow dot invokes window_minimize", () => {
    render(<TitleBar windowTitle="Chat" />);
    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    expect(invokeCalls).toEqual(["window_minimize"]);
  });

  test("clicking the green dot invokes window_toggle_maximize", () => {
    render(<TitleBar windowTitle="Chat" />);
    fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
    expect(invokeCalls).toEqual(["window_toggle_maximize"]);
  });

  test("a rejected invoke() (e.g. npm run dev's browser-only mode, no Tauri bridge) is caught, never thrown out to the caller", async () => {
    invokeImpl = () => Promise.reject(new Error("no Tauri bridge present"));
    render(<TitleBar windowTitle="Chat" />);

    expect(() => fireEvent.click(screen.getByRole("button", { name: "Close" }))).not.toThrow();
    // Let the rejected promise's .catch() handler run before the test ends.
    await Promise.resolve();
    await Promise.resolve();
  });
});
