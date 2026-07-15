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
import { ThreadPrimitive } from "@assistant-ui/react";
import type { ReactNode } from "react";
import { Message } from "./Message.js";

/**
 * Task 7 (assistant-ui-migration/TASKS.md, AC-7.1). Same two-part convention
 * `Thread.test.tsx`/`Composer.test.tsx` establish — see `Thread.test.tsx`'s
 * header comment for the full rationale (real render via a stub
 * `useLocalRuntime()` + a `tailwindcss@4.3.2` `compile()` pass proving the
 * mapped classes resolve through `design-system.css`'s own tokens).
 *
 * `Message` only renders meaningfully as a child of `ThreadPrimitive.Messages`
 * (it reads the current message via `useAuiState`), so these tests seed the
 * runtime with `initialMessages` and render through `ThreadPrimitive.Messages`
 * rather than mounting `<Message />` directly with no message in scope.
 */

const stubChatModel: ChatModelAdapter = {
  run: async () => ({ content: [] }),
};

function TestHarness({
  initialMessages,
  children,
}: {
  initialMessages: ThreadMessageLike[];
  children: ReactNode;
}) {
  const runtime = useLocalRuntime(stubChatModel, { initialMessages });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

function renderMessages(initialMessages: ThreadMessageLike[]) {
  return render(
    <TestHarness initialMessages={initialMessages}>
      <ThreadPrimitive.Messages>{() => <Message />}</ThreadPrimitive.Messages>
    </TestHarness>,
  );
}

afterEach(() => {
  cleanup();
});

describe("Message (Task 7, AC-7.1)", () => {
  // `useLocalRuntime()`'s `initialMessages` populate asynchronously (verified
  // empirically — the DOM is still an empty placeholder synchronously after
  // `render()` returns), so every assertion below waits for the seeded
  // message text to actually appear before inspecting classNames.
  test("a user message renders as a bg-accent/text-bg bubble, not a shadcn bg-muted/text-foreground bubble", async () => {
    const { container } = renderMessages([{ role: "user", content: "Hello there" }]);

    await waitFor(() => expect(screen.getByText("Hello there")).toBeTruthy());

    const root = container.querySelector('[data-role="user"]');
    expect(root).toBeTruthy();

    const bubble = root!.querySelector("div")!;
    expect(bubble.className).toContain("bg-accent");
    expect(bubble.className).toContain("text-bg");
    expect(bubble.className).not.toMatch(/\b(bg-muted|text-foreground|rounded-xl)\b/);
  });

  test("an assistant message renders flush, using text-text (inherited by its plain-text part), not a shadcn bubble", async () => {
    const { container } = renderMessages([{ role: "assistant", content: "Hi! How can I help?" }]);

    await waitFor(() => expect(screen.getByText("Hi! How can I help?")).toBeTruthy());

    const root = container.querySelector('[data-role="assistant"]');
    expect(root).toBeTruthy();

    const wrapper = root!.querySelector("div")!;
    expect(wrapper.className).toContain("text-text");
    expect(wrapper.className).not.toContain("bg-accent");
  });

  test("message text carries the font-body utility, not a hardcoded font stack", async () => {
    renderMessages([{ role: "assistant", content: "Formatted later by Task 9" }]);

    const paragraph = await waitFor(() => screen.getByText("Formatted later by Task 9"));
    expect(paragraph.tagName).toBe("P");
    expect(paragraph.className).toContain("font-body");
    // TODO(Task 9) is a plain-text placeholder for now — never literal markdown syntax leaking through untouched.
    expect(paragraph.textContent).toBe("Formatted later by Task 9");
  });

  test("a tool-call part renders via the Blueprint-bordered ToolFallback with the literal tool name and args, not a shadcn card", async () => {
    const { container } = renderMessages([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "web_fetch",
            args: { url: "https://example.com" },
            argsText: '{"url":"https://example.com"}',
          },
        ],
      },
    ]);

    await waitFor(() => expect(screen.getByText("web_fetch")).toBeTruthy());
    expect(screen.getByText('{"url":"https://example.com"}')).toBeTruthy();

    const fallback = container.querySelector(".blueprint");
    expect(fallback).toBeTruthy();
    expect(fallback?.className).toContain("bg-surface");
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

describe("Message.tsx utility classes resolve through design-system.css's tokens (AC-7.1)", () => {
  test("bg-accent/text-bg (user bubble) resolve through the real accent/background tokens, not oklch shadcn defaults", async () => {
    const generated = await compileDesignSystemCss(["bg-accent", "text-bg"]);

    expect(generated).toMatch(/\.bg-accent\s*{\s*background-color:\s*var\(--color-accent\);?\s*}/);
    expect(generated).toMatch(/\.text-bg\s*{\s*color:\s*var\(--color-bg\);?\s*}/);
    expect(generated).not.toMatch(/oklch/);
  });

  test("border-danger/bg-danger-bg/text-danger (MessageErrorBanner) resolve through design-system.css's own danger tokens", async () => {
    const generated = await compileDesignSystemCss(["border-danger", "bg-danger-bg", "text-danger"]);

    expect(generated).toMatch(/\.border-danger\s*{\s*border-color:\s*var\(--color-danger\);?\s*}/);
    expect(generated).toMatch(/\.bg-danger-bg\s*{\s*background-color:\s*var\(--color-danger-bg\);?\s*}/);
    expect(generated).toMatch(/\.text-danger\s*{\s*color:\s*var\(--color-danger\);?\s*}/);
  });

  test("text-text/80 and text-text/70 (ToolFallback args/result) resolve through color-mix(...) over var(--color-text), matching .text-muted's own existing idiom", async () => {
    const generated = await compileDesignSystemCss(["text-text/80", "text-text/70"]);

    expect(generated).toMatch(/color-mix\(in oklab, var\(--color-text\) 80%, transparent\)/);
    expect(generated).toMatch(/color-mix\(in oklab, var\(--color-text\) 70%, transparent\)/);
  });

  test("border-divider (ToolFallback result separator) resolves through var(--color-divider)", async () => {
    const generated = await compileDesignSystemCss(["border-divider"]);
    expect(generated).toMatch(/\.border-divider\s*{\s*border-color:\s*var\(--color-divider\);?\s*}/);
  });
});
