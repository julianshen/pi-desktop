import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createWebFetchTools } from "./tools.js";
import { create as createPendingInteraction, resolve as resolvePendingInteraction, getPending } from "./pending-interactions.js";

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
  // and the (stubbed, in this task) render fallback returns null, when
  // web_fetch completes, then it returns the plain-fetch content honestly
  // rather than fabricating or erroring silently.
  test("AC-6.6: an empty-SPA-shell plain fetch honestly falls back to the plain-fetch content (render fallback stubbed to null)", async () => {
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

    const result = await webFetch.execute("call-1", { url: PUBLIC_URL }, undefined, undefined, ctx);

    expect(fetchCalls).toHaveLength(1);
    // Honest fallback: some real (if sparse) content is returned, not an
    // error and not fabricated rendered content (render fallback is stubbed
    // to always return null in this task).
    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
    // The plain-fetch shell's own sparse text ("Loading…") is what comes
    // back — proving this is the honest plain-fetch content, not a silent
    // empty result and not fabricated rendered content.
    expect(text).toContain("Loading");
    expect(text).not.toContain("was not approved");
    expect(text).not.toContain("not permitted");
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
