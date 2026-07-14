import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { plainFetch, looksLikeEmptySpaShell, toReadableContent } from "./fetcher.js";

/**
 * fetcher.ts has zero dependencies on the rest of the web-fetch feature (no
 * env/conversation state), so unlike artifacts/store.test.ts this file needs
 * no PI_DESKTOP_* env scaffolding — plain top-of-file imports are fine.
 */

function makeResponse(body: string, init: { status?: number; contentType?: string | null; url?: string } = {}): Response {
  const headers = new Headers();
  if (init.contentType !== null) {
    headers.set("content-type", init.contentType ?? "text/html; charset=utf-8");
  }
  const response = new Response(body, { status: init.status ?? 200, headers });
  if (init.url) {
    // Response.url is normally set by the fetch implementation, not the
    // constructor; redefine it for tests that care about the final-URL field.
    Object.defineProperty(response, "url", { value: init.url });
  }
  return response;
}

describe("toReadableContent", () => {
  // AC-1.1: Given a URL serving plain server-rendered HTML with a title and body
  // text, when toReadableContent() runs, then it returns markdown containing the
  // page's readable text (not raw tags) plus title, url, status, contentType,
  // fetchedAt.
  test("AC-1.1: converts server-rendered HTML into markdown with full metadata", () => {
    const html = `<!doctype html>
<html>
  <head><title>About Acme</title><meta charset="utf-8"></head>
  <body>
    <h1>About Acme</h1>
    <p>Acme Corp builds <b>widgets</b> for the discerning customer.</p>
  </body>
</html>`;
    const url = new URL("https://example.com/about");
    const response = makeResponse(html, { status: 200, contentType: "text/html; charset=utf-8" });

    const page = toReadableContent(html, url, response);

    expect(page.title).toBe("About Acme");
    expect(page.url).toBe(url.href);
    expect(page.status).toBe(200);
    expect(page.contentType).toBe("text/html; charset=utf-8");
    expect(page.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Readable text present...
    expect(page.markdown).toContain("Acme Corp builds");
    expect(page.markdown).toContain("widgets");
    expect(page.markdown).toContain("# About Acme");
    // ...and raw tags are gone, not merely readable text embedded in markup.
    expect(page.markdown).not.toContain("<h1>");
    expect(page.markdown).not.toContain("<p>");
    expect(page.markdown).not.toContain("<body>");
  });

  test("AC-1.1: strips <script>/<style>/<head> content out of the markdown rather than leaking it as text", () => {
    const html = `<html>
  <head><title>Doc</title><style>.x{color:red}</style></head>
  <body>
    <h1>Doc</h1>
    <p>Real content here.</p>
    <script>window.__data = { leak: true };</script>
  </body>
</html>`;
    const url = new URL("https://example.com/doc");
    const response = makeResponse(html);

    const page = toReadableContent(html, url, response);

    expect(page.markdown).toContain("Real content here.");
    expect(page.markdown).not.toContain("__data");
    expect(page.markdown).not.toContain("color:red");
    expect(page.markdown).not.toContain("Doc\n\nDoc"); // title must not leak in ahead of the heading
  });

  test("AC-1.1: uses the response's final URL (post-redirect), not the originally requested one", () => {
    const html = "<html><body><h1>Landed</h1><p>Final page content.</p></body></html>";
    const requested = new URL("https://example.com/old-path");
    const response = makeResponse(html, { url: "https://example.com/new-path" });

    const page = toReadableContent(html, requested, response);

    expect(page.url).toBe("https://example.com/new-path");
  });

  // AC-1.4: Given a response with a non-HTML, non-text Content-Type (e.g.
  // image/png), when toReadableContent() runs, then it returns an explicit
  // "cannot read this content type" result, never garbled binary text.
  test("AC-1.4: binary content type (image/png) returns an explicit refusal, never garbled bytes", () => {
    // Simulate what response.text() would produce for binary bytes: garbage
    // characters that must never end up in the markdown field.
    const garbledBinary = "\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00";
    const url = new URL("https://example.com/logo.png");
    const response = makeResponse(garbledBinary, { contentType: "image/png" });

    const page = toReadableContent(garbledBinary, url, response);

    expect(page.markdown.toLowerCase()).toContain("cannot read this content type");
    expect(page.markdown).not.toContain(garbledBinary);
    expect(page.contentType).toBe("image/png");
    expect(page.title).toBeNull();
  });

  // AC-1.4 companion case: a second binary type (PDF) is also refused, not just
  // images specifically.
  test("AC-1.4: binary content type (application/pdf) is also refused explicitly", () => {
    const url = new URL("https://example.com/doc.pdf");
    const response = makeResponse("%PDF-1.4 garbage bytes", { contentType: "application/pdf" });

    const page = toReadableContent("%PDF-1.4 garbage bytes", url, response);

    expect(page.markdown.toLowerCase()).toContain("cannot read this content type");
  });

  test("JSON content type passes through as-is without markdown conversion", () => {
    const json = JSON.stringify({ hello: "world" });
    const url = new URL("https://example.com/api/data");
    const response = makeResponse(json, { contentType: "application/json" });

    const page = toReadableContent(json, url, response);

    expect(page.markdown).toBe(json);
    expect(page.title).toBeNull();
  });

  test("plain text content type passes through as-is without markdown conversion", () => {
    const text = "Just some plain text, with *asterisks* that must not be escaped.";
    const url = new URL("https://example.com/notes.txt");
    const response = makeResponse(text, { contentType: "text/plain" });

    const page = toReadableContent(text, url, response);

    expect(page.markdown).toBe(text);
  });
});

describe("looksLikeEmptySpaShell", () => {
  // AC-1.2: Given HTML whose <body> is near-empty with just a root div and script
  // tags, when looksLikeEmptySpaShell() runs, then it returns true.
  test("AC-1.2: near-empty body with a root mount div and script tags is detected as an SPA shell", () => {
    const html = `<!doctype html>
<html>
  <head><title>My App</title></head>
  <body>
    <div id="root"></div>
    <script src="/static/js/main.abc123.js"></script>
  </body>
</html>`;

    expect(looksLikeEmptySpaShell(html)).toBe(true);
  });

  test("AC-1.2: also detects common alternate root-mount id conventions (id=\"app\")", () => {
    const html = `<html><body><div id="app"></div><script src="/app.js"></script></body></html>`;
    expect(looksLikeEmptySpaShell(html)).toBe(true);
  });

  // AC-1.3: Given HTML with substantial real body text (a normal article/doc
  // page), when looksLikeEmptySpaShell() runs, then it returns false.
  test("AC-1.3: a normal server-rendered article page is not flagged as an SPA shell", () => {
    const paragraph =
      "This is a long-form article about widgets. ".repeat(10) +
      "It has plenty of real, readable body text that a search engine or a human reader could use directly.";
    const html = `<!doctype html>
<html>
  <head><title>Widgets: A Deep Dive</title></head>
  <body>
    <article>
      <h1>Widgets: A Deep Dive</h1>
      <p>${paragraph}</p>
    </article>
  </body>
</html>`;

    expect(looksLikeEmptySpaShell(html)).toBe(false);
  });

  // AC-1.3 companion: even a page with a root-mount-shaped div and scripts isn't
  // flagged if the body text itself is substantial — all three conditions
  // (near-empty text AND root div AND script tags) must hold together.
  test("AC-1.3: a page with a root div and scripts but substantial body text is not flagged", () => {
    const paragraph = "Real article content that happens to sit alongside a div id=\"root\" for unrelated reasons. ".repeat(6);
    const html = `<html><body><div id="root-unused"></div><article><p>${paragraph}</p></article><script src="/analytics.js"></script></body></html>`;

    expect(looksLikeEmptySpaShell(html)).toBe(false);
  });

  test("no script tags at all is not flagged even if body text is short and a root div exists", () => {
    const html = `<html><body><div id="root">Loading…</div></body></html>`;
    expect(looksLikeEmptySpaShell(html)).toBe(false);
  });
});

describe("plainFetch", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/redirect") {
          return Response.redirect(new URL("/landed", url).href, 302);
        }
        if (url.pathname === "/landed") {
          return new Response("<html><body><h1>Landed</h1></body></html>", {
            headers: { "content-type": "text/html" },
          });
        }
        return new Response("<html><body><h1>Home</h1></body></html>", {
          headers: { "content-type": "text/html" },
        });
      },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  test("fetches a URL and returns the decoded HTML body plus the raw Response", async () => {
    const { html, response } = await plainFetch(new URL(baseUrl));

    expect(html).toContain("<h1>Home</h1>");
    expect(response.status).toBe(200);
  });

  test("follows redirects and exposes the final URL via response.url", async () => {
    const { html, response } = await plainFetch(new URL(`${baseUrl}/redirect`));

    expect(html).toContain("Landed");
    expect(response.url).toBe(`${baseUrl}/landed`);
  });
});
