import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import fs from "node:fs/promises";
import { cleanup, render, screen } from "@testing-library/react";
import { compile } from "tailwindcss";
import { AssistantRuntimeProvider, useLocalRuntime, type ChatModelAdapter } from "@assistant-ui/react";
import type { ReactNode } from "react";
import { Composer } from "./Composer.js";

/**
 * Task 7 (assistant-ui-migration/TASKS.md, AC-7.1). Same two-part convention
 * `Thread.test.tsx` establishes (read that file's header comment for the
 * full rationale): a real render proving the mapped utility classes/existing
 * `.btn`/`.btn-primary` hand classes are what's actually applied, plus a
 * `tailwindcss@4.3.2` `compile()` pass proving the Tailwind-utility half
 * resolves through `design-system.css`'s own tokens, not shadcn defaults.
 *
 * `Composer.tsx` deliberately mixes ONE Tailwind-mapped input (no competing
 * `.input` hand class — see that file's own header comment on the CSS
 * Cascade Layers conflict this avoids) with the EXISTING unlayered
 * `.btn`/`.btn-primary`/`.btn-secondary`/`.btn-icon` classes for its actions
 * — both are asserted below, since AC-7.1 cares about the exact token
 * *values*, not which one of the two valid mapping mechanisms produced them.
 */

const stubChatModel: ChatModelAdapter = {
  run: async () => ({ content: [] }),
};

function TestHarness({ children }: { children: ReactNode }) {
  const runtime = useLocalRuntime(stubChatModel);
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

afterEach(() => {
  cleanup();
});

describe("Composer (Task 7, AC-7.1)", () => {
  test("the message input uses mapped-token utility classes (bg-transparent/text-text), never a shadcn/default class", () => {
    render(
      <TestHarness>
        <Composer />
      </TestHarness>,
    );

    const input = screen.getByLabelText("Message input");
    expect(input.className).toContain("bg-transparent");
    expect(input.className).toContain("text-text");
    expect(input.className).toContain("font-body");
    // Never the generator's own shadcn palette/tokens.
    expect(input.className).not.toMatch(/\b(bg-background|bg-muted|text-foreground|text-muted-foreground|caret-primary)\b/);
  });

  test("the send action reuses this app's existing .btn/.btn-primary classes, not a shadcn Button variant", () => {
    render(
      <TestHarness>
        <Composer />
      </TestHarness>,
    );

    const sendButton = screen.getByLabelText("Send message");
    expect(sendButton.className).toContain("btn");
    expect(sendButton.className).toContain("btn-primary");
    expect(sendButton.className).toContain("btn-icon");
    expect(sendButton.className).not.toMatch(/\b(bg-primary|rounded-full|shadow-\[)\b/);
  });

  test("the composer frame renders inside this app's Blueprint wireframe (corner registration marks), not a rounded shadcn card", () => {
    const { container } = render(
      <TestHarness>
        <Composer />
      </TestHarness>,
    );

    const blueprint = container.querySelector(".blueprint");
    expect(blueprint).toBeTruthy();
    // Blueprint.tsx renders four `.corner` marks — this app's signature motif
    // (CLAUDE.md), proving Composer used the real component, not a bare div.
    expect(blueprint?.querySelectorAll(".corner").length).toBe(4);
    expect(blueprint?.className).toContain("bg-surface");
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

describe("Composer.tsx utility classes resolve through design-system.css's tokens (AC-7.1)", () => {
  test("bg-transparent/text-text/font-body (ComposerPrimitive.Input) resolve through the real tokens, not oklch shadcn defaults", async () => {
    const generated = await compileDesignSystemCss(["bg-transparent", "text-text", "font-body"]);

    expect(generated).toMatch(/\.text-text\s*{\s*color:\s*var\(--color-text\);?\s*}/);
    expect(generated).toMatch(/\.font-body\s*{\s*font-family:\s*var\(--font-body\);?\s*}/);
    expect(generated).not.toMatch(/oklch/);
  });

  test("bg-surface (Blueprint frame) resolves through var(--color-surface)", async () => {
    const generated = await compileDesignSystemCss(["bg-surface"]);
    expect(generated).toMatch(/\.bg-surface\s*{\s*background-color:\s*var\(--color-surface\);?\s*}/);
  });

  test("gap-ds-2/px-ds-2/py-ds-1 resolve through this design system's own -ds- spacing scale", async () => {
    const generated = await compileDesignSystemCss(["gap-ds-2", "px-ds-2", "py-ds-1"]);

    expect(generated).toMatch(/\.gap-ds-2\s*{\s*gap:\s*var\(--space-2\);?\s*}/);
    expect(generated).toMatch(/\.px-ds-2\s*{[^}]*var\(--space-2\)/);
    expect(generated).toMatch(/\.py-ds-1\s*{[^}]*var\(--space-1\)/);
  });
});
