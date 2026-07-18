import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createWebFetchTools } from "./tools.js";
import { create as createPendingInteraction, resolve as resolvePendingInteraction, getPending } from "./pending-interactions.js";
import { MAX_REDIRECTS } from "./fetcher.js";

/**
 * Task 6 (TASKS.md) — the full execute() gated-fetch matrix for `web_fetch`.
 *
 * Two deliberate choices to keep these tests fast, deterministic, and free
 * of real network/DNS access in CI:
 *
 * 1. Classification uses literal IP addresses as the target hostname
 *    (e.g. "203.0.113.10" for public, "127.0.0.1"/"10.x.x.x" for private)
 *    rather than mocking classifyTarget()/DNS — node:dns's lookup() resolves
 *    an IP literal without any real DNS query (verified directly against
 *    the installed Bun/Node runtime before writing these tests), so this
 *    exercises the REAL classifyTarget() end-to-end, not a stub, while
 *    staying fully offline. (203.0.113.0/24 is the IANA TEST-NET-3 block,
 *    reserved for documentation/testing — guaranteed never to be a private
 *    range and never routable, so it can't accidentally collide with
 *    SPEC.md's private ranges.)
 * 2. The actual HTTP layer (fetcher.ts's plainFetch(), which calls the
 *    ambient global `fetch`) is stubbed via a global.fetch replacement
 *    installed in beforeEach/restored in afterEach — this proves AC-6.5's
 *    "never proceeds to fetch anyway" by asserting the stub was never
 *    invoked, which a real-network test could not do deterministically.
 *
 * ctx.ui.confirm() is wired to the REAL pending-interactions.ts registry
 * (create/resolve/getPending) rather than a bare stub — per this task's own
 * instructions, this gives a more realistic integration test than a
 * hand-rolled confirm() double, and lets these tests assert directly against
 * the same registry AC-6.2/AC-6.4 care about ("a pending interaction now
 * exists" / "no pending interaction was created").
 */

let fetchCalls: Array<{ url: string }>;
let nextFetchResponse: () => Response;
let originalFetch: typeof fetch;

beforeEach(() => {
  fetchCalls = [];
  nextFetchResponse = () =>
    new Response("<html><body><h1>Hello</h1><p>Some real page content, not a shell.</p></body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchCalls.push({ url: String(input) });
    return nextFetchResponse();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** A ctx.ui.confirm() wired to the real pending-interactions.ts registry — see module doc comment above. */
function buildRealConfirmContext(conversationId: string): ExtensionContext {
  return {
    ui: {
      confirm: async (_title: string, message: string, opts?: { timeout?: number }) => {
        const { promise } = createPendingInteraction(conversationId, {
          conversationId,
          kind: "confirm",
          host: message,
          timeoutMs: opts?.timeout ?? 5000,
        });
        const result = await promise;
        return result.kind === "confirm" ? result.approved : false;
      },
    },
  } as unknown as ExtensionContext;
}

/** A ctx whose confirm() throws if ever called — for asserting a code path never reaches the approval gate at all (AC-6.4). */
function buildConfirmMustNotBeCalledContext(): ExtensionContext {
  return {
    ui: {
      confirm: async () => {
        throw new Error("ctx.ui.confirm() must not be called on this path");
      },
    },
  } as unknown as ExtensionContext;
}

async function waitForPending(conversationId: string, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pending = getPending(conversationId);
    if (pending) return pending;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for a pending interaction for conversation ${conversationId}`);
}

const PUBLIC_URL = "http://203.0.113.10/page";
const PRIVATE_URL = "http://127.0.0.1:9/private-page";

describe("web_fetch tool", () => {
  // AC-6.1 — Given a public URL, when web_fetch is called from an interactive
  // session, then it fetches directly with no confirmation prompt and returns
  // the markdown content.
  test("AC-6.1: public URL fetches directly with no confirmation prompt, returning markdown content", async () => {
    const conversationId = randomUUID();
    const [webFetch] = createWebFetchTools(conversationId, "interactive");
    const ctx = buildConfirmMustNotBeCalledContext(); // proves no confirm attempt happens at all

    const result = await webFetch.execute("call-1", { url: PUBLIC_URL }, undefined, undefined, ctx);

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe(PUBLIC_URL);
    expect(getPending(conversationId)).toBeUndefined();
    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
    expect(text).toContain("Hello");
    expect(text).toContain("Some real page content");
  });

  // AC-6.2 [R] — Given a URL resolving to a private/loopback address, called
  // from an interactive session, with that host not yet approved this
  // conversation, when web_fetch is called, then it creates a kind: "confirm"
  // pending interaction naming the exact host, and does not fetch until that
  // resolves. This IS the safety boundary (US-03).
  test("AC-6.2 [R]: private URL creates a confirm pending interaction naming the exact host, and does not fetch before it resolves", async () => {
    const conversationId = randomUUID();
    const [webFetch] = createWebFetchTools(conversationId, "interactive");
    const ctx = buildRealConfirmContext(conversationId);

    const execPromise = webFetch.execute("call-1", { url: PRIVATE_URL }, undefined, undefined, ctx);

    const pending = await waitForPending(conversationId);
    expect(pending.kind).toBe("confirm");
    // "naming the exact host" — asserted against the private URL's own host,
    // not a paraphrase.
    expect(pending.kind === "confirm" && pending.host).toContain(new URL(PRIVATE_URL).href);
    // No fetch attempted while the interaction is still pending.
    expect(fetchCalls).toHaveLength(0);

    resolvePendingInteraction(pending.id, { kind: "confirm", approved: true });
    await execPromise;
  });

  // AC-6.3 — Given the same private host was already approved earlier in this
  // conversation, when web_fetch is called against it again, then it fetches
  // directly without creating a new pending interaction.
  test("AC-6.3: a private host already approved earlier this conversation fetches directly, no new pending interaction", async () => {
    const conversationId = randomUUID();
    const [webFetch] = createWebFetchTools(conversationId, "interactive");
    const ctx = buildRealConfirmContext(conversationId);

    // First call: approve.
    const firstExec = webFetch.execute("call-1", { url: PRIVATE_URL }, undefined, undefined, ctx);
    const pending = await waitForPending(conversationId);
    resolvePendingInteraction(pending.id, { kind: "confirm", approved: true });
    await firstExec;
    expect(fetchCalls).toHaveLength(1);

    // Second call, same conversation + host: must not create a new pending
    // interaction, and must not call confirm() at all.
    const noConfirmCtx = buildConfirmMustNotBeCalledContext();
    const result = await webFetch.execute("call-2", { url: PRIVATE_URL }, undefined, undefined, noConfirmCtx);

    expect(getPending(conversationId)).toBeUndefined();
    expect(fetchCalls).toHaveLength(2);
    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
    expect(text).toContain("Hello");
  });

  // AC-6.4 [R] — Given a URL resolving to a private/loopback address, called
  // from a SCHEDULED session, when web_fetch is called, then it fails
  // immediately with an explicit "not permitted in a background run" result
  // and NEVER creates a pending interaction. US-05: an unattended scheduled
  // run must never hang waiting on an approval nobody will give.
  //
  // assistant-ui-migration/AC-13.2: also the re-verification that this
  // hard-block is completely unaffected by the AI-SDK migration (Task 13,
  // re-run unmodified -- scheduled sessions never touch the new chat route
  // at all, so this exact test already proves AC-13.2 without any change).
  test("AC-6.4 [R]: scheduled session hard-blocks a private URL immediately, with no pending interaction ever created", async () => {
    const conversationId = randomUUID();
    const [webFetch] = createWebFetchTools(conversationId, "scheduled");
    // Any call to confirm() here would be a bug — this ctx throws if reached,
    // proving the hard-block never touches the approval gate at all.
    const ctx = buildConfirmMustNotBeCalledContext();

    const result = await webFetch.execute("call-1", { url: PRIVATE_URL }, undefined, undefined, ctx);

    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
    expect(text).toContain(new URL(PRIVATE_URL).host);
    expect(text).toContain("not permitted in a background run");
    expect(getPending(conversationId)).toBeUndefined();
    expect(fetchCalls).toHaveLength(0);
  });

  // AC-6.5 [R] — Given the confirm gate resolves to denied (explicit deny or
  // timeout default), when web_fetch's execute() continues, then it returns
  // an explicit "not approved" error result — it NEVER proceeds to fetch
  // anyway. A fail-open bug here would defeat the whole feature's safety
  // premise.
  test("AC-6.5 [R]: denied confirmation returns an explicit not-approved error and never calls fetch", async () => {
    const conversationId = randomUUID();
    const [webFetch] = createWebFetchTools(conversationId, "interactive");
    const ctx = buildRealConfirmContext(conversationId);

    const execPromise = webFetch.execute("call-1", { url: PRIVATE_URL }, undefined, undefined, ctx);
    const pending = await waitForPending(conversationId);
    resolvePendingInteraction(pending.id, { kind: "confirm", approved: false });

    const result = await execPromise;
    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
    expect(text).toContain(new URL(PRIVATE_URL).host);
    expect(text).toContain("not approved");
    // The safety-critical assertion: fetch was never attempted after denial.
    expect(fetchCalls).toHaveLength(0);
  });

  test("AC-6.5 [R]: a confirmation that times out (registry's own fail-closed default) also never calls fetch", async () => {
    const conversationId = randomUUID();
    const [webFetch] = createWebFetchTools(conversationId, "interactive");
    // Reuse the real registry directly with a very short timeout to exercise
    // pending-interactions.ts's own fail-closed default (approved: false),
    // rather than an explicit deny — same safety-critical assertion.
    const ctx: ExtensionContext = {
      ui: {
        confirm: async (_title: string, message: string) => {
          const { promise } = createPendingInteraction(conversationId, {
            conversationId,
            kind: "confirm",
            host: message,
            timeoutMs: 20,
          });
          const result = await promise;
          return result.kind === "confirm" ? result.approved : false;
        },
      },
    } as unknown as ExtensionContext;

    const result = await webFetch.execute("call-1", { url: PRIVATE_URL }, undefined, undefined, ctx);
    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
    expect(text).toContain("not approved");
    expect(fetchCalls).toHaveLength(0);
  });

  // AC-6.6 — Given the plain fetch's content looks like an empty SPA shell
  // and the render fallback returns null, when web_fetch completes, then it
  // returns the plain-fetch content honestly rather than fabricating or
  // erroring silently.
  //
  // Updated for Task 11: this test originally relied on
  // renderViaHeadlessWebview() being a stub that always returned null
  // synchronously. Now that Task 11 wires in the real pending-interaction-
  // backed implementation, a render interaction really is created here — so
  // this test resolves it explicitly with `{ html: null }` (the same shape
  // pending-interactions.ts's own fail-closed timeout default produces, see
  // AC-3.2) to simulate the "render fallback declined/failed" case, still
  // asserting the same honest-fallback outcome AC-6.6 describes.
  test("AC-6.6: an empty-SPA-shell plain fetch honestly falls back to the plain-fetch content (render fallback resolves to null)", async () => {
    const conversationId = randomUUID();
    const [webFetch] = createWebFetchTools(conversationId, "interactive");
    const ctx = buildConfirmMustNotBeCalledContext();

    // Matches fetcher.ts's looksLikeEmptySpaShell() heuristic: near-empty
    // body (<200 visible chars), a framework root-mount div, and a <script>
    // tag present.
    nextFetchResponse = () =>
      new Response(
        `<html><body><div id="root">Loading…</div><script src="/bundle.js"></script></body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );

    const execPromise = webFetch.execute("call-1", { url: PUBLIC_URL }, undefined, undefined, ctx);

    const pending = await waitForPending(conversationId);
    expect(pending.kind).toBe("render");
    resolvePendingInteraction(pending.id, { kind: "render", html: null });

    const result = await execPromise;

    expect(fetchCalls).toHaveLength(1);
    // Honest fallback: some real (if sparse) content is returned, not an
    // error and not fabricated rendered content.
    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
    // The plain-fetch shell's own sparse text ("Loading…") is what comes
    // back — proving this is the honest plain-fetch content, not a silent
    // empty result and not fabricated rendered content.
    expect(text).toContain("Loading");
    expect(text).not.toContain("was not approved");
    expect(text).not.toContain("not permitted");
  });

  // AC-11.1 — Given a real local SPA dev server running (this is the
  // live/manual verification case per SPEC.md's testing strategy — not
  // reproducible in this headless environment). This test instead proves the
  // WIRING is correct: it uses the REAL pending-interactions.ts registry
  // (create/resolve), same as every other test in this file, to simulate the
  // frontend's headless-render bridge (Task 10, not exercised here)
  // successfully resolving a `kind: "render"` interaction with rendered
  // HTML, and asserts web_fetch's final result contains that HTML-derived
  // content rather than the plain-fetch's sparse empty-shell content. What
  // this does NOT prove, and what remains for live /tgd-verify: the actual
  // Rust `render_url_headless` Tauri command and a real webview round-trip
  // against a real running SPA.
  test("AC-11.1: a resolved render pending interaction's HTML becomes web_fetch's final result, not the empty-shell plain-fetch content", async () => {
    const conversationId = randomUUID();
    const [webFetch] = createWebFetchTools(conversationId, "interactive");
    const ctx = buildConfirmMustNotBeCalledContext(); // public URL — no approval gate involved

    // Matches fetcher.ts's looksLikeEmptySpaShell() heuristic: near-empty
    // body, a framework root-mount div, and a <script> tag present.
    nextFetchResponse = () =>
      new Response(
        `<html><body><div id="app">Loading…</div><script src="/bundle.js"></script></body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );

    const execPromise = webFetch.execute("call-1", { url: PUBLIC_URL }, undefined, undefined, ctx);

    const pending = await waitForPending(conversationId);
    expect(pending.kind).toBe("render");
    expect(pending.kind === "render" && pending.url).toBe(new URL(PUBLIC_URL).href);

    resolvePendingInteraction(pending.id, {
      kind: "render",
      html: `<html><body><main>Fully rendered SPA content, not the loading shell</main></body></html>`,
    });

    const result = await execPromise;
    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
    expect(text).toContain("Fully rendered SPA content");
    expect(text).not.toContain("Loading");
  });

  test("AC-11.1: when the render interaction resolves with html: null (the registry's own fail-closed timeout default, per AC-3.2), web_fetch honestly falls back to the plain-fetch shell content", async () => {
    const conversationId = randomUUID();
    const [webFetch] = createWebFetchTools(conversationId, "interactive");
    const ctx = buildConfirmMustNotBeCalledContext();

    nextFetchResponse = () =>
      new Response(
        `<html><body><div id="app">Loading…</div><script src="/bundle.js"></script></body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );

    // Simulates the outcome of pending-interactions.ts's own fail-closed
    // timeout default ({ html: null }, covered directly by AC-3.2) by
    // resolving with that same shape rather than waiting out tools.ts's
    // real 30s RENDER_TIMEOUT_MS, which would be too slow for a unit test.
    // This asserts renderViaHeadlessWebview()'s wiring honors that result
    // (null -> honest plain-fetch fallback), not the timeout mechanism
    // itself.
    const pendingPromise = waitForPending(conversationId);
    const execPromise = webFetch.execute("call-1", { url: PUBLIC_URL }, undefined, undefined, ctx);
    const pending = await pendingPromise;
    expect(pending.kind).toBe("render");
    resolvePendingInteraction(pending.id, { kind: "render", html: null });

    const result = await execPromise;
    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
    expect(text).toContain("Loading");
    expect(text).not.toContain("was not approved");
  });

  // AC-11.2 [R] — Given a URL resolving to a private address that ALSO needs
  // the render fallback (its plain-fetch response would trigger the
  // SPA-shell heuristic), when web_fetch runs, then the approval gate is
  // still enforced BEFORE the render attempt — approval is not bypassable by
  // triggering the SPA-shell heuristic. This is PRD §8's top-named risk and
  // SPEC.md's explicit "Always" boundary: tested here as the actual combined
  // path (confirm interaction created and resolved BEFORE any render
  // interaction is ever created), not as two independently-passing gates.
  test("AC-11.2 [R]: a private+unapproved host whose eventual response would trigger the SPA-shell heuristic still hits the confirm gate first — no render interaction exists until confirm resolves", async () => {
    const conversationId = randomUUID();
    const [webFetch] = createWebFetchTools(conversationId, "interactive");
    const ctx = buildRealConfirmContext(conversationId);

    // This response, if ever reached by plainFetch, would trigger
    // looksLikeEmptySpaShell() and thus renderViaHeadlessWebview(). The
    // whole point of this test is that it must NOT be reached before the
    // confirm gate resolves.
    nextFetchResponse = () =>
      new Response(
        `<html><body><div id="root">Loading…</div><script src="/bundle.js"></script></body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );

    const execPromise = webFetch.execute("call-1", { url: PRIVATE_URL }, undefined, undefined, ctx);

    // The FIRST pending interaction must be the confirm gate, not a render
    // interaction — and no fetch (hence no SPA-shell detection, hence no
    // render interaction) has happened yet.
    const firstPending = await waitForPending(conversationId);
    expect(firstPending.kind).toBe("confirm");
    expect(firstPending.kind === "confirm" && firstPending.host).toContain(new URL(PRIVATE_URL).href);
    expect(fetchCalls).toHaveLength(0);

    resolvePendingInteraction(firstPending.id, { kind: "confirm", approved: true });

    // Only AFTER approval does the plain fetch run, detect the SPA shell,
    // and create the render interaction — proving the render path is not
    // reachable independently of the confirm gate.
    const secondPending = await waitForPending(conversationId);
    expect(secondPending.kind).toBe("render");
    expect(fetchCalls).toHaveLength(1);

    resolvePendingInteraction(secondPending.id, {
      kind: "render",
      html: `<html><body><main>Rendered private-host SPA content</main></body></html>`,
    });

    const result = await execPromise;
    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
    expect(text).toContain("Rendered private-host SPA content");
  });

  test("AC-11.2 [R]: denying the confirm gate on a private+SPA-shell-triggering host never creates a render interaction and never calls fetch", async () => {
    const conversationId = randomUUID();
    const [webFetch] = createWebFetchTools(conversationId, "interactive");
    const ctx = buildRealConfirmContext(conversationId);

    nextFetchResponse = () =>
      new Response(
        `<html><body><div id="root">Loading…</div><script src="/bundle.js"></script></body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );

    const execPromise = webFetch.execute("call-1", { url: PRIVATE_URL }, undefined, undefined, ctx);

    const pending = await waitForPending(conversationId);
    expect(pending.kind).toBe("confirm");
    resolvePendingInteraction(pending.id, { kind: "confirm", approved: false });

    const result = await execPromise;
    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
    expect(text).toContain("not approved");
    // Denial short-circuits before plain-fetch, so the SPA-shell heuristic
    // and thus the render path is never reached — proving the render
    // interaction cannot be created independently of an approved confirm.
    expect(fetchCalls).toHaveLength(0);
    expect(getPending(conversationId)).toBeUndefined();
  });

  test("an invalid URL is rejected immediately with no network calls at all", async () => {
    const conversationId = randomUUID();
    const [webFetch] = createWebFetchTools(conversationId, "interactive");
    const ctx = buildConfirmMustNotBeCalledContext();

    const result = await webFetch.execute("call-1", { url: "not a url" }, undefined, undefined, ctx);

    expect(fetchCalls).toHaveLength(0);
    expect(getPending(conversationId)).toBeUndefined();
    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
    expect(text.toLowerCase()).toContain("invalid url");
  });
});

/**
 * REVIEW.md remediation: Critical #3 (explicit URL-scheme allowlist),
 * Critical #1's redirect half (re-gating a redirect that lands on a private
 * target the caller never had a chance to approve), and Important #6 (never
 * let plainFetch()'s non-SSRF failure modes propagate out of execute()
 * uncaught).
 *
 * These tests reuse this file's own established conventions (see the module
 * doc comment above): IP-literal hostnames so the REAL classifyTarget()/
 * resolveTarget() runs end-to-end without real DNS, and a global.fetch stub
 * standing in for the network. Where a test needs the stub's response to
 * depend on which URL is being requested (redirect chains), it installs its
 * own `globalThis.fetch` directly rather than using the shared
 * `nextFetchResponse` single-response hook — still restored by the same
 * shared `afterEach` as every other test in this file.
 */
describe("web_fetch tool — REVIEW.md remediation", () => {
  /** A ctx.ui.confirm() that always immediately approves, bypassing the pending-interaction registry — used only for the bounded-retry-loop test below, where the thing under test is the LOOP's own attempt cap, not the approval UI wiring (already covered elsewhere by buildRealConfirmContext()). */
  function buildAutoApproveConfirmContext(): ExtensionContext {
    return {
      ui: {
        confirm: async () => true,
      },
    } as unknown as ExtensionContext;
  }

  const REDIRECT_PRIVATE_URL = "http://10.0.0.9/private-page";

  // REVIEW.md Critical #3 — a syntactically valid but non-http(s) URL must be
  // rejected before classifyTarget() (hence before any DNS lookup) and before
  // any fetch attempt.
  test.each([
    ["file:///etc/passwd", "file:"],
    ["javascript:alert(1)", "javascript:"],
  ])("REVIEW.md Critical #3: %s is rejected with reason unsupported-scheme, with no DNS/network call", async (url, scheme) => {
    const conversationId = randomUUID();
    const [webFetch] = createWebFetchTools(conversationId, "interactive");
    const ctx = buildConfirmMustNotBeCalledContext(); // proves classifyTarget()'s confirm path is never reached

    const result = await webFetch.execute("call-1", { url }, undefined, undefined, ctx);

    // No fetch attempt at all — the same assertion this file's existing
    // invalid-url test uses to prove "no network call happened".
    expect(fetchCalls).toHaveLength(0);
    expect(getPending(conversationId)).toBeUndefined();
    expect(result.details).toMatchObject({ ok: false, reason: "unsupported-scheme" });
    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
    expect(text).toContain(scheme);
  });

  // REVIEW.md Critical #1 (redirect half) — a redirect from an already-gated
  // public host to a DIFFERENT, private host is a target the human never had
  // a chance to approve. tools.ts must re-run the same classify+confirm gate
  // against the redirect target, naming it explicitly.
  test("REVIEW.md Critical #1: a redirect to a different private host triggers a fresh confirm naming the redirect target; approval retries plainFetch with the redirect URL and returns success", async () => {
    const conversationId = randomUUID();
    const [webFetch] = createWebFetchTools(conversationId, "interactive");
    const ctx = buildRealConfirmContext(conversationId);

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchCalls.push({ url });
      if (url.startsWith("http://203.0.113.10")) {
        return new Response(null, { status: 302, headers: { location: REDIRECT_PRIVATE_URL } });
      }
      return new Response("<html><body><h1>Hello</h1><p>Some real page content, not a shell.</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as typeof fetch;

    const execPromise = webFetch.execute("call-1", { url: PUBLIC_URL }, undefined, undefined, ctx);

    const pending = await waitForPending(conversationId);
    expect(pending.kind).toBe("confirm");
    // Naming the exact literal redirect target, not a paraphrase — and
    // mentioning the original URL too, so it's clear this is a redirect.
    expect(pending.kind === "confirm" && pending.host).toContain(new URL(REDIRECT_PRIVATE_URL).href);
    expect(pending.kind === "confirm" && pending.host).toContain(new URL(PUBLIC_URL).href);
    // Only the first (redirecting) fetch has happened so far — no retry yet.
    expect(fetchCalls).toHaveLength(1);

    resolvePendingInteraction(pending.id, { kind: "confirm", approved: true });
    const result = await execPromise;

    // The retry is a fresh plainFetch() call against the redirect URL itself.
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[1]?.url).toBe(REDIRECT_PRIVATE_URL);
    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
    expect(text).toContain("Hello");
    expect(result.details).toMatchObject({ ok: true });
  });

  test("REVIEW.md Critical #1: denying the confirm for a redirect target returns a clean not-approved result and does not retry", async () => {
    const conversationId = randomUUID();
    const [webFetch] = createWebFetchTools(conversationId, "interactive");
    const ctx = buildRealConfirmContext(conversationId);

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchCalls.push({ url });
      if (url.startsWith("http://203.0.113.10")) {
        return new Response(null, { status: 302, headers: { location: REDIRECT_PRIVATE_URL } });
      }
      return new Response("<html><body><h1>Hello</h1></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as typeof fetch;

    const execPromise = webFetch.execute("call-1", { url: PUBLIC_URL }, undefined, undefined, ctx);
    const pending = await waitForPending(conversationId);
    resolvePendingInteraction(pending.id, { kind: "confirm", approved: false });

    const result = await execPromise;
    // Denial short-circuits: no retried fetch to the redirect target.
    expect(fetchCalls).toHaveLength(1);
    expect(result.details).toMatchObject({ ok: false, reason: "not-approved" });
    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
    expect(text).toContain(new URL(REDIRECT_PRIVATE_URL).host);
    expect(text).toContain("not approved");
  });

  // REVIEW.md Critical #1 (redirect half), AC-6.3-equivalent for redirects —
  // a redirect landing on a host ALREADY approved earlier this conversation
  // must not re-prompt.
  test("REVIEW.md Critical #1: a redirect to an already-approved host retries immediately without calling ctx.ui.confirm() again", async () => {
    const conversationId = randomUUID();
    const [webFetch] = createWebFetchTools(conversationId, "interactive");
    const approveCtx = buildRealConfirmContext(conversationId);

    // Step 1: approve the private host directly (same shape as AC-6.3),
    // populating approvedHostsByConversation for this conversationId.
    const firstExec = webFetch.execute("call-1", { url: REDIRECT_PRIVATE_URL }, undefined, undefined, approveCtx);
    const firstPending = await waitForPending(conversationId);
    resolvePendingInteraction(firstPending.id, { kind: "confirm", approved: true });
    await firstExec;
    expect(fetchCalls).toHaveLength(1);

    // Step 2: a public URL that redirects to that SAME already-approved
    // host. confirm() must not be called again.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchCalls.push({ url });
      if (url.startsWith("http://203.0.113.10")) {
        return new Response(null, { status: 302, headers: { location: REDIRECT_PRIVATE_URL } });
      }
      return new Response("<html><body><h1>Hello</h1></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as typeof fetch;
    const noConfirmCtx = buildConfirmMustNotBeCalledContext();

    const result = await webFetch.execute("call-2", { url: PUBLIC_URL }, undefined, undefined, noConfirmCtx);

    expect(getPending(conversationId)).toBeUndefined();
    // One fetch to the original public URL (redirect) + one retried fetch to
    // the already-approved redirect target = 2 more calls, no pending
    // interaction created for either.
    expect(fetchCalls).toHaveLength(3);
    expect(result.details).toMatchObject({ ok: true });
  });

  // REVIEW.md Critical #1 (redirect half) + US-05 — a scheduled/background
  // run must hard-block a redirect to a private target exactly like it
  // hard-blocks a directly-private original URL: never call ctx.ui.confirm().
  test("REVIEW.md Critical #1: scheduled session hard-blocks a redirect to a private host, never calling ctx.ui.confirm()", async () => {
    const conversationId = randomUUID();
    const [webFetch] = createWebFetchTools(conversationId, "scheduled");
    const ctx = buildConfirmMustNotBeCalledContext();

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchCalls.push({ url });
      if (url.startsWith("http://203.0.113.10")) {
        return new Response(null, { status: 302, headers: { location: REDIRECT_PRIVATE_URL } });
      }
      return new Response("should never be reached", { status: 200 });
    }) as typeof fetch;

    const result = await webFetch.execute("call-1", { url: PUBLIC_URL }, undefined, undefined, ctx);

    expect(fetchCalls).toHaveLength(1); // no retry after the hard block
    expect(getPending(conversationId)).toBeUndefined();
    expect(result.details).toMatchObject({ ok: false, reason: "scheduled-private-blocked" });
    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
    expect(text).toContain(new URL(REDIRECT_PRIVATE_URL).host);
    expect(text).toContain("not permitted in a background run");
  });

  // REVIEW.md Critical #1 — fetcher.ts's own MAX_REDIRECTS hop cap, exceeded
  // WITHIN a single plainFetch() call (a same-host chain that never
  // settles), must come back as a clean error result, not an uncaught throw.
  test("REVIEW.md Critical #1: plainFetch() throwing TooManyRedirectsError returns a clean error result, not an uncaught throw", async () => {
    const conversationId = randomUUID();
    const [webFetch] = createWebFetchTools(conversationId, "interactive");
    const ctx = buildConfirmMustNotBeCalledContext();

    let hop = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchCalls.push({ url: String(input) });
      hop++;
      // Same host every time -> never triggers PrivateRedirectError, only
      // fetcher.ts's own MAX_REDIRECTS cap.
      return new Response(null, { status: 302, headers: { location: `http://203.0.113.10/hop-${hop}` } });
    }) as typeof fetch;

    const result = await expectNotToThrow(
      webFetch.execute("call-1", { url: PUBLIC_URL }, undefined, undefined, ctx),
    );

    expect(result.details).toMatchObject({ ok: false, reason: "too-many-redirects" });
    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
    expect(text.toLowerCase()).toContain("too many redirects");
  });

  // REVIEW.md Important #6 — any OTHER rejection from plainFetch() (network
  // failure, timeout/AbortError, DNS failure on a hop, etc.) must never
  // propagate out of execute() uncaught; it must come back as a clean
  // WebFetchDetails-shaped failure result.
  test("REVIEW.md Important #6: a generic network error from plainFetch() (simulated AbortError) returns a clean failure result rather than propagating", async () => {
    const conversationId = randomUUID();
    const [webFetch] = createWebFetchTools(conversationId, "interactive");
    const ctx = buildConfirmMustNotBeCalledContext();

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchCalls.push({ url: String(input) });
      throw new DOMException("The operation was aborted.", "AbortError");
    }) as typeof fetch;

    const result = await expectNotToThrow(
      webFetch.execute("call-1", { url: PUBLIC_URL }, undefined, undefined, ctx),
    );

    expect(result.details).toMatchObject({ ok: false, reason: "fetch-failed" });
    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
    expect(text).toContain(new URL(PUBLIC_URL).href);
  });

  // REVIEW.md Critical #1 — a redirect chain that keeps landing on a NEW
  // distinct private host on every hop (each requiring its own approval)
  // must not turn into an unbounded prompt loop. tools.ts's own
  // MAX_REDIRECT_GATE_ATTEMPTS (reusing fetcher.ts's MAX_REDIRECTS) bounds
  // the number of fresh plainFetch() retries.
  test("REVIEW.md Critical #1: a redirect-approval loop hitting a new private host every hop stops at the bound and returns a clean error, not an infinite loop", async () => {
    const conversationId = randomUUID();
    const [webFetch] = createWebFetchTools(conversationId, "interactive");
    // Auto-approve every prompt — the thing under test is the LOOP's own
    // cap, not the approval UI (already covered by the tests above).
    const ctx = buildAutoApproveConfirmContext();

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchCalls.push({ url });
      const match = /^http:\/\/10\.0\.0\.(\d+)\//.exec(url);
      const nextHostNumber = match ? Number(match[1]) + 1 : 1;
      // Every hop redirects to a brand-new distinct private host — a
      // pathological chain that never settles and never repeats a host, so
      // the "already-approved" fast path never kicks in either.
      return new Response(null, { status: 302, headers: { location: `http://10.0.0.${nextHostNumber}/page` } });
    }) as typeof fetch;

    const result = await expectNotToThrow(
      webFetch.execute("call-1", { url: PUBLIC_URL }, undefined, undefined, ctx),
    );

    expect(result.details).toMatchObject({ ok: false, reason: "too-many-redirect-approvals" });
    // Bounded: at most MAX_REDIRECTS fresh plainFetch() calls were made.
    expect(fetchCalls.length).toBeLessThanOrEqual(MAX_REDIRECTS);
    expect(fetchCalls.length).toBeGreaterThan(0);
  });
});

/** Small helper making the "must not throw" assertion explicit at the call site for the Important #6 / TooManyRedirectsError tests above, rather than relying on an unhandled rejection failing the test opaquely. */
async function expectNotToThrow<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    throw new Error(
      `Expected execute() to return a clean error result, but it threw instead: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
    );
  }
}
