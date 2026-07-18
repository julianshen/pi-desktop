import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import fs from "node:fs/promises";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { compile } from "tailwindcss";
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  type ChatModelAdapter,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import type { ReactNode } from "react";
import { Thread } from "./Thread.js";

/**
 * Task 7 (assistant-ui-migration/TASKS.md, AC-7.1). Two complementary checks,
 * mirroring Task 1's `src/styles/design-system.test.ts` precedent (read
 * there first for the "why" of the compile-based half):
 *
 * 1. A real render (via `@testing-library/react` + `AssistantRuntimeProvider`)
 *    proving the exact `@theme`-mapped utility class names from TASKS.md's
 *    Task 7 section (`bg-*`, `text-*`, `font-heading`/`font-body`) are the
 *    ones actually applied to the rendered DOM — not a placeholder assertion.
 * 2. A `tailwindcss@4.3.2` `compile()` pass (same technique
 *    `design-system.test.ts` established — `happy-dom` has no CSS engine, so
 *    `getComputedStyle()` can't resolve `@theme`/`var()` in a test run; the
 *    only non-tautological way to prove a class resolves to the right value
 *    is to run the real compiler `@tailwindcss/vite` uses under the hood)
 *    proving those exact classes resolve through `design-system.css`'s own
 *    `var(--color-*)`/`var(--font-*)` tokens, not Assistant UI's/shadcn's
 *    defaults (which would show up as `oklch(...)` or an undefined
 *    `var(--background)`/`var(--foreground)`/`var(--muted)`/`var(--primary)`
 *    reference).
 *
 * Rendering Assistant UI's primitives needs a real `AssistantRuntime` in
 * context or they throw ("not.. inside <AssistantRuntimeProvider>") — same
 * constraint `App.test.tsx` (Task 6) hit for `ChatView.tsx`'s CopilotKit
 * hooks, but solved differently here: rather than mocking the whole runtime
 * module away (Task 6's approach, needed there because `useChatRuntime`
 * talks to a real HTTP transport), this file builds a REAL, minimal
 * `AssistantRuntime` via `@assistant-ui/react`'s own `useLocalRuntime()` with
 * a stub `ChatModelAdapter` that never actually calls a model — Assistant
 * UI's exported, documented way to run its primitives standalone/offline
 * (e.g. in Storybook), which is exactly TASKS.md's "test harness or
 * Storybook-equivalent" language for AC-7.1. No mock.module() needed, so
 * none of this file's mocking leaks into other test files in the same
 * `bun test` run (the exact pitfall App.test.tsx's own header comment
 * documents for `mock.module()`).
 */

const stubChatModel: ChatModelAdapter = {
  run: async () => ({ content: [] }),
};

function TestHarness({
  initialMessages,
  children,
}: {
  initialMessages?: ThreadMessageLike[];
  children: ReactNode;
}) {
  const runtime = useLocalRuntime(stubChatModel, { initialMessages });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

afterEach(() => {
  cleanup();
});

describe("Thread (Task 7, AC-7.1)", () => {
  test("renders the mapped-token welcome state (bg-bg/text-text/font-heading) when the thread has no messages", () => {
    const { container } = render(
      <TestHarness>
        <Thread />
      </TestHarness>,
    );

    expect(screen.getByText("How can I help you today?")).toBeTruthy();

    const root = container.querySelector(".bg-bg.text-text");
    expect(root).toBeTruthy();

    const heading = screen.getByText("How can I help you today?");
    expect(heading.className).toContain("font-heading");
    expect(heading.className).toContain("text-text");
    // Never a bare Tailwind default color/shadcn class on the mapped welcome heading.
    expect(heading.className).not.toMatch(/text-(foreground|muted-foreground|slate|zinc|gray)-?\d*/);
  });

  test("renders prior messages (not the welcome state) via Message, once the thread has history", async () => {
    const initialMessages: ThreadMessageLike[] = [
      { role: "user", content: "Hello there" },
      { role: "assistant", content: "Hi! How can I help?" },
    ];

    render(
      <TestHarness initialMessages={initialMessages}>
        <Thread />
      </TestHarness>,
    );

    // `useLocalRuntime()`'s `initialMessages` populate asynchronously
    // (verified empirically), so wait for the seeded history to actually
    // land before asserting the welcome state is gone.
    await waitFor(() => expect(screen.getByText("Hello there")).toBeTruthy());
    expect(screen.getByText("Hi! How can I help?")).toBeTruthy();
    expect(screen.queryByText("How can I help you today?")).toBeNull();
  });
});

const CSS_PATH = path.join(import.meta.dir, "..", "..", "styles", "design-system.css");
const TAILWIND_INDEX_CSS = path.join(import.meta.dir, "..", "..", "..", "node_modules", "tailwindcss", "index.css");

async function compileDesignSystemCss(candidates: string[]) {
  const css = await fs.readFile(CSS_PATH, "utf8");
  const result = await compile(css, {
    base: path.dirname(CSS_PATH),
    loadStylesheet: async (id, base) => {
      const resolved = id === "tailwindcss" ? TAILWIND_INDEX_CSS : path.join(base, id);
      const content = await fs.readFile(resolved, "utf8");
      return { path: resolved, base: path.dirname(resolved), content };
    },
  });
  return result.build(candidates);
}

describe("Thread.tsx utility classes resolve through design-system.css's tokens (AC-7.1)", () => {
  test("bg-bg / text-text (ThreadPrimitive.Root) resolve through var(--color-bg)/var(--color-text), not oklch shadcn defaults", async () => {
    const generated = await compileDesignSystemCss(["bg-bg", "text-text"]);

    expect(generated).toMatch(/\.bg-bg\s*{\s*background-color:\s*var\(--color-bg\);?\s*}/);
    expect(generated).toMatch(/\.text-text\s*{\s*color:\s*var\(--color-text\);?\s*}/);
    expect(generated).not.toMatch(/oklch/);
  });

  test("font-heading / font-body (ThreadWelcome) resolve through the Barlow/Barlow Condensed stacks", async () => {
    const generated = await compileDesignSystemCss(["font-heading", "font-body"]);

    expect(generated).toMatch(/\.font-heading\s*{\s*font-family:\s*var\(--font-heading\);?\s*}/);
    expect(generated).toMatch(/\.font-body\s*{\s*font-family:\s*var\(--font-body\);?\s*}/);
  });

  test("gap-ds-4/px-ds-6/py-ds-4 (Thread.Viewport) resolve through this design system's own -ds- spacing scale", async () => {
    const generated = await compileDesignSystemCss(["gap-ds-4", "px-ds-6", "py-ds-4"]);

    expect(generated).toMatch(/\.gap-ds-4\s*{\s*gap:\s*var\(--space-4\);?\s*}/);
    expect(generated).toMatch(/\.px-ds-6\s*{[^}]*padding-(inline|left)[^}]*var\(--space-6\)/);
    expect(generated).toMatch(/\.py-ds-4\s*{[^}]*padding-(block|top)[^}]*var\(--space-4\)/);
  });
});
