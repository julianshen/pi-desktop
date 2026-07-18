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

  test("message text renders inside the font-body-classed wrapper (inherited, not hardcoded per element)", async () => {
    const { container } = renderMessages([{ role: "assistant", content: "Rendered by Task 9" }]);

    const paragraph = await waitFor(() => screen.getByText("Rendered by Task 9"));
    expect(paragraph.tagName).toBe("P");
    // Task 9 replaced the Task 7 plain-`<p className="font-body ...">`
    // placeholder with Streamdown's own paragraph renderer, which carries no
    // class of its own (verified against the installed `streamdown`
    // package's compiled output) — `font-body`/text size/color are inherited
    // from the message's wrapper div instead, asserted directly below.
    expect(paragraph.className).toBe("");
    const wrapper = container.querySelector('[data-role="assistant"] > div');
    expect(wrapper?.className).toContain("font-body");
    expect(paragraph.textContent).toBe("Rendered by Task 9");
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

describe("Message markdown rendering (Task 9, AC-9.1/AC-9.2/AC-9.3)", () => {
  test("AC-9.1: a heading, a list, bold text, and a fenced code block with a language tag render as real formatted HTML, with the code block syntax-highlighted", async () => {
    const markdown = [
      "# Heading",
      "",
      "- item one",
      "- item two",
      "",
      "**bold text**",
      "",
      "```ts",
      "const x = 1;",
      "```",
    ].join("\n");

    const { container } = renderMessages([{ role: "assistant", content: markdown }]);

    await waitFor(() => expect(screen.getByText("Heading")).toBeTruthy());

    // Real formatted HTML elements — not literal `#`/`-`/`**`/`` ``` `` characters.
    expect(container.querySelector("h1")?.textContent).toBe("Heading");
    expect(container.querySelectorAll("li").length).toBe(2);
    expect(container.querySelector('[data-streamdown="strong"]')?.textContent).toBe("bold text");
    expect(container.textContent).not.toContain("**bold text**");
    expect(container.textContent).not.toContain("# Heading");

    // Syntax-highlighted code: Shiki tokenizes the fenced block into multiple
    // per-token `<span>`s carrying real resolved hex colors via the
    // `--sdm-c` custom property (not the library's unresolved `inherit`
    // placeholder it renders before highlighting settles) — same
    // DOM-structure-over-single-getByText-match approach
    // `ArtifactCanvas.test.tsx`'s Task 10 tests use for this exact
    // "Shiki splits code into many spans" wrinkle. Waits for the async
    // highlight pass, which isn't synchronous with the initial render.
    await waitFor(() => {
      const codeSpans = container.querySelectorAll('pre code span[style*="--sdm-c"]');
      expect(codeSpans.length).toBeGreaterThan(1);
      const hasRealTokenColor = Array.from(codeSpans).some((el) =>
        /--sdm-c:\s*#/i.test(el.getAttribute("style") ?? ""),
      );
      expect(hasRealTokenColor).toBe(true);
    });
    expect(container.textContent).toContain("const x = 1;");
  });

  test("AC-9.2: a user's own sent message with markdown syntax gets the same formatting treatment as an assistant message", async () => {
    const markdown = "# User heading\n\n**bold from the user**";
    const { container } = renderMessages([{ role: "user", content: markdown }]);

    await waitFor(() => expect(screen.getByText("User heading")).toBeTruthy());

    const root = container.querySelector('[data-role="user"]');
    expect(root?.querySelector("h1")?.textContent).toBe("User heading");
    expect(root?.querySelector('[data-streamdown="strong"]')?.textContent).toBe("bold from the user");
    expect(container.textContent).not.toContain("**bold from the user**");
    expect(container.textContent).not.toContain("# User heading");
  });

  // AC-9.3 — the core reason Streamdown was chosen over a static markdown
  // renderer: a still-streaming message (`status: { type: "running" }`,
  // matching `ThreadMessageLike`'s real shape) with genuinely incomplete
  // markdown at the tail — where a live response is actively mid-token —
  // must render cleanly at that intermediate state, never showing raw
  // unterminated syntax. (An unclosed marker earlier in an *already-closed*
  // block, followed by more text, is correctly left as literal text by
  // CommonMark itself — not a streaming glitch — so both cases below place
  // the incomplete syntax at the very end of `content`, mirroring how a
  // real token-by-token stream would still be mid-line there.)
  describe("AC-9.3: still-streaming (incomplete) markdown never shows raw unterminated syntax", () => {
    test("an unclosed bold marker at the tail renders as real bold, not a literal `**`", async () => {
      const { container } = renderMessages([
        {
          role: "assistant",
          content: "Some emphasis: **this is bold and still typ",
          status: { type: "running" },
        },
      ]);

      await waitFor(() => expect(screen.getByText(/Some emphasis/)).toBeTruthy());

      expect(container.querySelector('[data-status="running"]')).toBeTruthy();
      const strong = container.querySelector('[data-streamdown="strong"]');
      expect(strong?.textContent).toBe("this is bold and still typ");
      expect(container.textContent).not.toContain("**");
    });

    test("an unterminated fenced code block at the tail renders as a real code block, not literal backticks", async () => {
      const { container } = renderMessages([
        {
          role: "assistant",
          content: "Here's the fix:\n\n```ts\nfunction foo() {\n  return 1;\n",
          status: { type: "running" },
        },
      ]);

      await waitFor(() => expect(screen.getByText(/Here's the fix/)).toBeTruthy());

      const codeBlock = container.querySelector('[data-streamdown="code-block"]');
      expect(codeBlock).toBeTruthy();
      // Streamdown's own marker for "this fence hasn't closed yet" — the
      // block still renders as real code, it just knows it's not finished.
      expect(codeBlock?.getAttribute("data-incomplete")).toBe("true");
      expect(container.textContent).not.toContain("```");
      expect(container.textContent).toContain("function foo()");
    });
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
