/**
 * The content-handling core of the `web_fetch` tool: plain HTTP fetch,
 * SPA-shell detection, and HTML -> markdown conversion. Zero dependencies on
 * the rest of the feature (safety gating, approval, pending interactions) —
 * see TASKS.md Task 1.
 *
 * HTML-to-markdown library choice: `turndown` (^7.2.4), the candidate
 * suggested by SPEC.md — mature, MIT-licensed, no native deps. Verified
 * against the *installed* version's own README/types (not from training
 * data), per this repo's CLAUDE.md convention:
 *   - `new TurndownService(options)` + `.turndown(html: string): string` is
 *     the real API (confirmed via node_modules/turndown/README.md and
 *     @types/turndown's `export = TurndownService` — a CJS default export).
 *   - Turndown has no bundled `.d.ts`; `@types/turndown` was added as a
 *     devDependency for typechecking.
 *   - Turndown depends on `@mixmark-io/domino` (its own dependency, not
 *     ours) to parse HTML in a non-browser (no `window`/`DOMParser`)
 *     environment like Bun — confirmed working via a scratch script before
 *     wiring this in.
 *   - Gotcha discovered while verifying (not documented in the README):
 *     turndown does NOT drop `<script>`/`<style>` contents by default — an
 *     unknown element's text just flows through as plain text. Confirmed via
 *     a scratch repro. Fixed below with `turndownService.remove([...])`.
 *   - Second gotcha: passing a *full* HTML document (with `<head>`) to
 *     `.turndown()` leaks `<title>`/`<meta>` text into the output, because
 *     turndown wraps the whole input in a synthetic `<x-turndown>` root
 *     rather than locating `<body>` itself. Fixed below by stripping
 *     `<head>...</head>` before conversion and extracting the title
 *     ourselves.
 */

import TurndownService from "turndown";

export interface FetchedPage {
  markdown: string;
  title: string | null;
  url: string; // canonical/final URL after redirects
  status: number;
  contentType: string | null;
  fetchedAt: string; // ISO timestamp
}

const turndownService = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});
// Never let raw <script>/<style>/<head> text reach the markdown output (see
// module doc comment above) — turndown does not do this by default.
turndownService.remove(["script", "style", "noscript", "head"]);

/** Plain (non-headless-render) fetch: follows redirects, decodes the body as text. */
export async function plainFetch(url: URL): Promise<{ html: string; response: Response }> {
  const response = await fetch(url, { redirect: "follow" });
  const html = await response.text();
  return { html, response };
}

const BODY_PATTERN = /<body[^>]*>([\s\S]*?)<\/body>/i;
const HEAD_PATTERN = /<head[^>]*>[\s\S]*?<\/head>/i;
const TITLE_PATTERN = /<title[^>]*>([\s\S]*?)<\/title>/i;
// Loose on purpose: broad framework-root id matches ("root", "app", "__next",
// "___gatsby", "__nuxt", "app-root", "reactRoot", ...) so we lean toward
// catching more true SPA shells (false negatives are the thing to minimize
// per SPEC.md; a false positive just costs one extra webview render).
const ROOT_MOUNT_ID_PATTERN = /<div[^>]*\bid=["'][^"']*(root|app|next|gatsby|nuxt)[^"']*["']/i;
const SCRIPT_TAG_PATTERN = /<script[\s>]/i;
const EMPTY_SHELL_TEXT_THRESHOLD = 200;

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractBody(html: string): string {
  const match = BODY_PATTERN.exec(html);
  return match ? match[1] : html;
}

/**
 * AC-1.2 / AC-1.3: near-empty `<body>` (visible text under
 * EMPTY_SHELL_TEXT_THRESHOLD chars) AND a framework root-mount div AND at
 * least one `<script>` tag, all three together — a real short page won't
 * usually have a root-mount div, and a real SPA shell's body text is
 * dominated by boilerplate, not article content.
 */
export function looksLikeEmptySpaShell(html: string): boolean {
  const bodyHtml = extractBody(html);
  const visibleText = stripTags(bodyHtml);
  const hasRootMount = ROOT_MOUNT_ID_PATTERN.test(bodyHtml);
  const hasScript = SCRIPT_TAG_PATTERN.test(bodyHtml);
  return visibleText.length < EMPTY_SHELL_TEXT_THRESHOLD && hasRootMount && hasScript;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const codePoint =
        entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint);
    }
    const lower = entity.toLowerCase();
    return lower in NAMED_ENTITIES ? NAMED_ENTITIES[lower] : match;
  });
}

function extractTitle(html: string): string | null {
  const match = TITLE_PATTERN.exec(html);
  if (!match) return null;
  const decoded = decodeHtmlEntities(match[1]).replace(/\s+/g, " ").trim();
  return decoded.length > 0 ? decoded : null;
}

type ContentKind = "html" | "text" | "binary";

function classifyContentType(contentType: string | null): ContentKind {
  if (!contentType) return "html"; // no header — best-effort treat as HTML/text, never binary
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base === "text/html" || base === "application/xhtml+xml") return "html";
  if (
    base.startsWith("text/") ||
    base === "application/json" ||
    base.endsWith("+json") ||
    base === "application/xml" ||
    base.endsWith("+xml")
  ) {
    return "text";
  }
  return "binary";
}

/**
 * HTML -> markdown + metadata. Also handles non-HTML content types (AC-1.4):
 * JSON/plain-text pass through unconverted, binary types (images, PDFs, ...)
 * return an explicit refusal rather than ever putting decoded binary bytes
 * into the `markdown` field.
 *
 * Takes `response` (in addition to the already-read `html` body) because
 * `FetchedPage.status`/`contentType`/`url` all come from the HTTP response,
 * not from parsing the HTML text itself.
 */
export function toReadableContent(html: string, url: URL, response: Response): FetchedPage {
  const status = response.status;
  const contentType = response.headers.get("content-type");
  const fetchedAt = new Date().toISOString();
  const finalUrl = response.url || url.href;
  const kind = classifyContentType(contentType);

  if (kind === "binary") {
    return {
      markdown: `Cannot read this content type: ${contentType ?? "unknown"}. Binary content is not readable as text.`,
      title: null,
      url: finalUrl,
      status,
      contentType,
      fetchedAt,
    };
  }

  if (kind === "text") {
    // JSON / plain text: pass through as-is, no markdown conversion.
    return { markdown: html, title: null, url: finalUrl, status, contentType, fetchedAt };
  }

  // kind === "html"
  const title = extractTitle(html);
  const bodyOnlyHtml = html.replace(HEAD_PATTERN, "");
  const markdown = turndownService.turndown(bodyOnlyHtml).trim();

  return { markdown, title, url: finalUrl, status, contentType, fetchedAt };
}
