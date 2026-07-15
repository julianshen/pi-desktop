/**
 * The content-handling core of the `web_fetch` tool: plain HTTP fetch,
 * SPA-shell detection, and HTML -> markdown conversion.
 *
 * CONTRACT CHANGE (REVIEW.md #1, #2, #5 remediation — read before touching
 * tools.ts's call site): plainFetch() used to be a thin
 * `fetch(url, { redirect: "follow" })` wrapper with zero dependency on
 * safety.ts. It no longer is. It now:
 *
 *   1. Resolves DNS and classifies EVERY hop it visits (the input URL and
 *      every redirect target) via safety.ts's resolveTarget(), and connects
 *      to the literal resolved IP for that hop — Bun's own fetch() never
 *      gets a hostname to re-resolve independently. This closes REVIEW.md
 *      #2 (DNS-rebinding TOCTOU): the address that was classified is
 *      provably the address that gets connected to, because it's the same
 *      value, not a second independent lookup.
 *
 *      Mechanism (verified against Bun's actual source, not assumed from
 *      Node): the request URL's hostname is rewritten to the literal IP,
 *      and a `Host` header is set to the ORIGINAL hostname:port. Bun's own
 *      fetch implementation (src/runtime/webcore/fetch.rs /
 *      src/http/lib.rs) reads a user-supplied `Host` header, uses it verbatim
 *      as the wire Host header (skipping the auto-generated one, and Bun's
 *      fetch does not enforce the browser forbidden-header-name list, so
 *      `Host` is settable at all), AND uses that same value — not the IP —
 *      for the TLS SNI/certificate-verification hostname
 *      (`get_tls_hostname()` prioritizes the Host-header-derived hostname
 *      over the URL's own (IP) hostname). So the TCP/TLS connection goes to
 *      the pinned IP while both virtual-hosted HTTP (`Host`) and HTTPS
 *      (SNI + cert hostname) behave exactly as if the original hostname had
 *      been connected to directly. No dispatcher/lookup override exists on
 *      Bun's fetch() for this — this Host-header trick is what Bun's own
 *      fetch natively supports, so there was no need to drop to node:http/
 *      node:https.
 *
 *   2. Handles redirects manually (`redirect: "manual"`, never "follow").
 *      On every 3xx with a Location header, the target is resolved to an
 *      absolute URL and reclassified. If it's private AND its `host`
 *      (hostname:port) differs from the ORIGINAL input URL's host, that's a
 *      target the caller (tools.ts) never had a chance to gate — plainFetch
 *      throws PrivateRedirectError (see its class doc below) instead of
 *      following it. This closes REVIEW.md #1 (redirect SSRF). A redirect
 *      to the SAME host as the original input is treated as already covered
 *      by whatever gating the caller already did for that host (tools.ts's
 *      `approvedHostsFor()` is itself keyed by `target.host`) and is
 *      followed without re-throwing — this is also what keeps a same-origin
 *      redirect (e.g. a trailing-slash redirect on a loopback dev server the
 *      user already approved) from spuriously re-prompting. Chains longer
 *      than MAX_REDIRECTS throw TooManyRedirectsError.
 *
 *   3. Applies a hard timeout (FETCH_TIMEOUT_MS, overridable via
 *      `options.timeoutMs`, merged with an optional caller-supplied
 *      `options.signal` via AbortSignal.any) and reads the response body via
 *      a streamed, byte-capped reader (MAX_RESPONSE_BYTES) instead of an
 *      unconditional `.text()` — REVIEW.md #5. A slow-loris response times
 *      out; an oversized response is truncated and the connection is
 *      cancelled rather than drained to completion.
 *
 * The SUCCESS return shape (`{ html, response }`) is UNCHANGED. Only the
 * failure modes changed (thrown PrivateRedirectError / TooManyRedirectsError
 * instead of silently following anything) plus `response.url`, which is
 * normalized back to the logical (hostname-based) final URL rather than the
 * literal-IP URL actually connected to — see overrideResponseUrl() below —
 * so toReadableContent() and any other caller keep seeing sensible URLs.
 * tools.ts's owner: catching PrivateRedirectError and re-running the same
 * classify+confirm gate against `error.redirectUrl`, then calling
 * `plainFetch(error.redirectUrl)` again as a fresh top-level fetch, is the
 * intended recovery path (that fresh call's hop 0 is then treated as
 * "already gated" exactly like the original input URL was).
 *
 * Zero dependencies on the rest of the feature (approval UI, pending
 * interactions) beyond safety.ts's classification primitives — see
 * TASKS.md Task 1.
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
import { resolveTarget, type HostResolver, type LookupAddress } from "./safety.js";

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

/** Per-hop request timeout (REVIEW.md #5). Overridable via PlainFetchOptions.timeoutMs for tests. */
const FETCH_TIMEOUT_MS = 20_000;
/** Response body byte cap (REVIEW.md #5) — read via a streamed, capped reader, never an unconditional .text(). */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
/** Redirect-hop cap (REVIEW.md #1). */
export const MAX_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Thrown when a redirect hop resolves to a private/loopback/link-local
 * address on a DIFFERENT host than the original input URL — i.e. a target
 * the caller (tools.ts) never had a chance to run through its own
 * classify+confirm approval gate. Carries enough information for the caller
 * to re-run that same gate and retry.
 *
 * This is the "distinguishable result" REVIEW.md #1 asks for: a thrown,
 * `instanceof`-checkable error class rather than a sentinel field on the
 * success return shape, so the existing `{ html, response }` success shape
 * stays unchanged and tools.ts's owner can wrap the existing
 * `await plainFetch(target)` call in a try/catch (which finding #6 already
 * recommends adding for network errors generally).
 */
export class PrivateRedirectError extends Error {
  /** The redirect target that requires (re-)approval — pass this to classifyTarget()/ctx.ui.confirm() and, on approval, to a fresh plainFetch() call. */
  readonly redirectUrl: URL;
  /** The hop that issued the redirect — included for a clearer error/log message only. */
  readonly fromUrl: URL;

  constructor(redirectUrl: URL, fromUrl: URL) {
    super(
      `Redirect from ${fromUrl.href} to ${redirectUrl.href} targets a private/internal address (${redirectUrl.host}) and requires approval before it can be followed.`,
    );
    this.name = "PrivateRedirectError";
    this.redirectUrl = redirectUrl;
    this.fromUrl = fromUrl;
  }
}

/** Thrown when a redirect chain exceeds MAX_REDIRECTS without settling on a final response. */
export class TooManyRedirectsError extends Error {
  readonly url: URL;
  readonly maxRedirects: number;

  constructor(url: URL, maxRedirects: number) {
    super(`Too many redirects (> ${maxRedirects}) while fetching ${url.href}.`);
    this.name = "TooManyRedirectsError";
    this.url = url;
    this.maxRedirects = maxRedirects;
  }
}

export interface PlainFetchOptions {
  /** Caller-supplied abort signal, merged with the internal timeout via AbortSignal.any(). tools.ts's execute() currently has an unused `_signal` parameter (REVIEW.md #5) that could be wired in here once its owner adapts the call site. */
  signal?: AbortSignal;
  /** DI seam for DNS resolution, matching safety.ts's resolveHost pattern — lets fetcher.test.ts control per-hop DNS answers deterministically. Defaults to safety.ts's real-DNS resolver. */
  resolveHost?: HostResolver;
  /** Per-hop request timeout in ms. Defaults to FETCH_TIMEOUT_MS; overridable so tests can exercise the timeout path without a real 20s wait. */
  timeoutMs?: number;
}

/** IPv6 literals must be bracketed to be valid in a URL's hostname component. */
function formatAddressForUrl(address: LookupAddress): string {
  return address.family === 6 ? `[${address.address}]` : address.address;
}

/**
 * Response.url is a read-only accessor from the Response prototype; shadowing
 * it with an own property (same pattern fetcher.test.ts's makeResponse()
 * helper already uses) lets us report the logical (hostname-based) final URL
 * instead of the literal-IP URL actually connected to.
 */
function overrideResponseUrl(response: Response, logicalUrl: URL): void {
  Object.defineProperty(response, "url", { value: logicalUrl.href, configurable: true });
}

/**
 * Streams the response body with a hard byte cap instead of an unconditional
 * `.text()` (REVIEW.md #5). Once the cap is exceeded, the underlying reader
 * is cancelled immediately (not drained) so a huge or slow-loris response
 * can't tie up the connection — the caller gets back whatever was read up to
 * the cap. Decodes as UTF-8; unlike Response.text(), this doesn't sniff the
 * Content-Type charset, which is an accepted tradeoff for capping reads
 * before the whole body (and its headers-declared charset) can be trusted.
 */
async function readBodyWithLimit(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("response exceeded byte cap").catch(() => {});
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

/**
 * Plain (non-headless-render) fetch. See the module doc comment above for
 * the full redirect/DNS-pinning/timeout/size-cap design — this is the
 * function REVIEW.md #1, #2, and #5 are about.
 */
export async function plainFetch(
  url: URL,
  options: PlainFetchOptions = {},
): Promise<{ html: string; response: Response }> {
  const initialHost = url.host;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  let hopUrl = url;
  let redirectCount = 0;

  while (true) {
    const resolved = await resolveTarget(hopUrl, options.resolveHost);

    // A private hop on a DIFFERENT host than the original input is a target
    // the caller never gated (REVIEW.md #1). A private hop on the SAME host
    // (including hop 0, the original input itself) is either the original,
    // already-gated target or a same-origin redirect off it — proceed.
    if (resolved.classification === "private" && hopUrl.host !== initialHost) {
      throw new PrivateRedirectError(hopUrl, url);
    }

    const connectUrl = new URL(hopUrl.href);
    connectUrl.hostname = formatAddressForUrl(resolved.address);

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

    const response = await fetch(connectUrl, {
      redirect: "manual",
      signal,
      headers: { Host: hopUrl.host },
    });

    const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get("location") : null;
    if (location) {
      if (redirectCount >= MAX_REDIRECTS) {
        throw new TooManyRedirectsError(url, MAX_REDIRECTS);
      }
      const nextUrl = new URL(location, hopUrl);
      if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
        throw new Error(`Redirect from ${hopUrl.href} to unsupported URL scheme "${nextUrl.protocol}" is not permitted.`);
      }
      hopUrl = nextUrl;
      redirectCount++;
      continue;
    }

    const html = await readBodyWithLimit(response, MAX_RESPONSE_BYTES);
    overrideResponseUrl(response, hopUrl);
    return { html, response };
  }
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
