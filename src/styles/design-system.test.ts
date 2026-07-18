import { describe, expect, test } from "bun:test";
import { compile } from "tailwindcss";
import path from "node:path";
import fs from "node:fs/promises";

/**
 * Task 1 (assistant-ui-migration), AC-1.1: proves Tailwind utility classes
 * mapped in `design-system.css`'s `@theme inline` block resolve through the
 * exact same `var(--color-*)`/`var(--font-*)`/`var(--space-*)` reference the
 * hand-rolled CSS below them already uses — not a new, parallel value.
 *
 * Why this doesn't render a component and read `getComputedStyle()`:
 * `bun:test` (via `happy-dom`, see `../../test-setup.ts`) has no CSS engine —
 * it never runs Vite's pipeline, so `@tailwindcss/vite` never processes this
 * file in a test run, and `getComputedStyle()` can't resolve `var()` or
 * `@theme` at all in that environment. The only real (non-tautological) way
 * to verify AC-1.1 here is to run the actual installed `tailwindcss@4.3.2`
 * compiler — the same one `@tailwindcss/vite` uses under the hood — against
 * the real `design-system.css` file, and inspect the real generated CSS.
 */

const CSS_PATH = path.join(import.meta.dir, "design-system.css");
const TAILWIND_INDEX_CSS = path.join(
  import.meta.dir,
  "..",
  "..",
  "node_modules",
  "tailwindcss",
  "index.css",
);

async function compileDesignSystemCss(candidates: string[]) {
  const css = await fs.readFile(CSS_PATH, "utf8");
  const result = await compile(css, {
    base: path.dirname(CSS_PATH),
    // Mirrors what `@tailwindcss/vite`/`@tailwindcss/node` do at build time:
    // resolve the bare `@import "tailwindcss"` specifier via the installed
    // package rather than a relative path.
    loadStylesheet: async (id, base) => {
      const resolved = id === "tailwindcss" ? TAILWIND_INDEX_CSS : path.join(base, id);
      const content = await fs.readFile(resolved, "utf8");
      return { path: resolved, base: path.dirname(resolved), content };
    },
  });
  return { css, generated: result.build(candidates) };
}

/**
 * Pulls a `--token: value;` declaration's literal value out of the `:root`
 * block specifically (not the `@theme inline` block above it, which
 * re-declares the same token names as `var(--token)` self-references).
 */
function readRootTokenValue(css: string, token: string): string {
  const rootBlockStart = css.indexOf("\n:root {");
  if (rootBlockStart === -1) throw new Error(":root block not found in design-system.css");
  const rootBlock = css.slice(rootBlockStart);
  const match = rootBlock.match(new RegExp(`${token}:\\s*([^;]+);`));
  if (!match) throw new Error(`Token ${token} not found in :root block`);
  return match[1].trim();
}

describe("design-system.css Tailwind v4 @theme mapping (AC-1.1)", () => {
  test("bg-accent resolves through var(--color-accent), the same token design-system.css defines", async () => {
    const { css, generated } = await compileDesignSystemCss(["bg-accent"]);

    expect(generated).toContain(".bg-accent");
    expect(generated).toMatch(/\.bg-accent\s*{\s*background-color:\s*var\(--color-accent\);?\s*}/);

    // Not a default Tailwind palette value (those are oklch(...)) — and the
    // referenced custom property really does carry design-system.css's own
    // accent color, not a duplicate/forked value.
    expect(generated).not.toMatch(/\.bg-accent\s*{\s*background-color:\s*oklch/);
    expect(readRootTokenValue(css, "--color-accent")).toBe("#5980a6");
  });

  test("text-accent resolves through the same var(--color-accent) token", async () => {
    const { generated } = await compileDesignSystemCss(["text-accent"]);
    expect(generated).toMatch(/\.text-accent\s*{\s*color:\s*var\(--color-accent\);?\s*}/);
  });

  test("bg-neutral-100/300 resolve through this app's own neutrals, not Tailwind's default gray-ish neutral-* palette", async () => {
    const { css, generated } = await compileDesignSystemCss(["bg-neutral-100", "bg-neutral-300"]);

    expect(generated).toMatch(/\.bg-neutral-100\s*{\s*background-color:\s*var\(--color-neutral-100\);?\s*}/);
    expect(generated).toMatch(/\.bg-neutral-300\s*{\s*background-color:\s*var\(--color-neutral-300\);?\s*}/);
    expect(generated).not.toMatch(/\.bg-neutral-100\s*{\s*background-color:\s*oklch/);

    expect(readRootTokenValue(css, "--color-neutral-100")).toBe("#f5f5f8");
    expect(readRootTokenValue(css, "--color-neutral-300")).toBe("#d4d4d7");
  });

  test("font-heading resolves through var(--font-heading), the Barlow Condensed stack", async () => {
    const { css, generated } = await compileDesignSystemCss(["font-heading"]);

    expect(generated).toMatch(/\.font-heading\s*{\s*font-family:\s*var\(--font-heading\);?\s*}/);
    expect(readRootTokenValue(css, "--font-heading")).toContain("Barlow Condensed");
  });

  test("font-body resolves through var(--font-body), the Barlow stack", async () => {
    const { css, generated } = await compileDesignSystemCss(["font-body"]);
    expect(generated).toMatch(/\.font-body\s*{\s*font-family:\s*var\(--font-body\);?\s*}/);
    expect(readRootTokenValue(css, "--font-body")).toContain("Barlow");
  });

  test("p-ds-4 resolves through var(--space-4) using the design-system-suffixed key (no collision with Tailwind's default numeric spacing scale)", async () => {
    const { css, generated } = await compileDesignSystemCss(["p-ds-4", "p-4"]);

    expect(generated).toMatch(/\.p-ds-4\s*{\s*padding:\s*var\(--space-4\);?\s*}/);
    expect(readRootTokenValue(css, "--space-4")).toBe("13.6px");

    // AC-1.2 spirit, spacing-specific: the bare numeric `p-4` utility must
    // still use Tailwind's own default calc-based scale, unaffected by this
    // mapping — proves the `-ds-` suffix genuinely avoided the collision.
    expect(generated).toMatch(/\.p-4\s*{\s*padding:\s*calc\(var\(--spacing\)\s*\*\s*4\);?\s*}/);
  });

  test("design-system.css still parses/compiles cleanly end to end with Tailwind v4 (no @theme syntax errors)", async () => {
    const { generated } = await compileDesignSystemCss(["bg-accent"]);
    // A syntax error in the @theme block would throw during compile() above;
    // this also asserts the rest of the hand-rolled CSS survived untouched.
    expect(generated).toContain(".blueprint");
    expect(generated).toContain(".btn-primary");
  });
});
