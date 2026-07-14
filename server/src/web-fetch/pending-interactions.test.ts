import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { create, resolve, getPending } from "./pending-interactions.js";

/**
 * Tests for the shared PendingInteraction registry (Task 3, SPEC.md's
 * "PendingInteraction registry" subsection). This is the one primitive both the
 * approval gate (private-network confirm) and the headless-render bridge will be
 * built on top of in later, separate tasks — not exercised here.
 *
 * Short real timeoutMs values (20-50ms) are used for the timeout tests rather
 * than mocking timers, per this repo's stated test convention for this task.
 */

describe("pending-interactions", () => {
  // AC-3.1 [R]: Given a new pending interaction is created, when resolve(id,
  // result) is called before the timeout, then the promise from create()
  // resolves with that exact result. This is the core primitive every use of
  // the approval gate depends on.
  test("AC-3.1: resolve() before timeout settles create()'s promise with the exact result", async () => {
    const conversationId = randomUUID();
    const { id, promise } = create(conversationId, {
      conversationId,
      kind: "confirm",
      host: "192.168.1.5",
      timeoutMs: 5000,
    });

    const ok = resolve(id, { kind: "confirm", approved: true });
    expect(ok).toBe(true);

    const result = await promise;
    expect(result).toEqual({ kind: "confirm", approved: true });
  });

  test("AC-3.1: resolve() before timeout works for render-kind interactions too", async () => {
    const conversationId = randomUUID();
    const { id, promise } = create(conversationId, {
      conversationId,
      kind: "render",
      url: "https://example.com/app",
      timeoutMs: 5000,
    });

    const ok = resolve(id, { kind: "render", html: "<html>rendered</html>" });
    expect(ok).toBe(true);

    const result = await promise;
    expect(result).toEqual({ kind: "render", html: "<html>rendered</html>" });
  });

  // AC-3.2 [R]: Given a pending interaction with a short timeoutMs, when
  // nothing calls resolve() within that window, then the promise resolves with
  // the kind-appropriate default. This must be the SAFE (fail-closed) default —
  // a fail-OPEN default (e.g. approved: true) would silently disable the
  // safety boundary the whole feature exists for. Asserted explicitly below.
  test("AC-3.2: confirm-kind interaction times out to the SAFE default { approved: false }", async () => {
    const conversationId = randomUUID();
    const { promise } = create(conversationId, {
      conversationId,
      kind: "confirm",
      host: "10.0.0.7",
      timeoutMs: 30,
    });

    const result = await promise;
    expect(result.kind).toBe("confirm");
    // Explicit safety assertion: the default must be fail-closed (not approved).
    expect((result as { approved: boolean }).approved).toBe(false);
    expect(result).toEqual({ kind: "confirm", approved: false });
  });

  test("AC-3.2: render-kind interaction times out to the default { html: null }", async () => {
    const conversationId = randomUUID();
    const { promise } = create(conversationId, {
      conversationId,
      kind: "render",
      url: "https://example.com/spa",
      timeoutMs: 30,
    });

    const result = await promise;
    expect(result).toEqual({ kind: "render", html: null });
  });

  // AC-3.3: Given an interaction has already timed out or been resolved, when
  // resolve() is called again for that same id, then it returns false and
  // does not throw or double-resolve the original promise.
  test("AC-3.3: resolve() after an explicit resolve returns false and does not throw", async () => {
    const conversationId = randomUUID();
    const { id, promise } = create(conversationId, {
      conversationId,
      kind: "confirm",
      host: "127.0.0.1",
      timeoutMs: 5000,
    });

    expect(resolve(id, { kind: "confirm", approved: true })).toBe(true);

    let secondCallThrew = false;
    let second: boolean;
    try {
      second = resolve(id, { kind: "confirm", approved: false });
    } catch {
      secondCallThrew = true;
      second = true; // unreachable, keeps TS happy
    }

    expect(secondCallThrew).toBe(false);
    expect(second!).toBe(false);

    // The original promise must still hold the FIRST result, not be
    // double-resolved / overwritten by the second call.
    const result = await promise;
    expect(result).toEqual({ kind: "confirm", approved: true });
  });

  test("AC-3.3: resolve() after a timeout has already fired returns false and does not throw", async () => {
    const conversationId = randomUUID();
    const { id, promise } = create(conversationId, {
      conversationId,
      kind: "render",
      url: "https://example.com/late",
      timeoutMs: 20,
    });

    // Wait for the timeout to fire and settle the promise first.
    const result = await promise;
    expect(result).toEqual({ kind: "render", html: null });

    let threw = false;
    let late: boolean;
    try {
      late = resolve(id, { kind: "render", html: "<html>too late</html>" });
    } catch {
      threw = true;
      late = true;
    }

    expect(threw).toBe(false);
    expect(late!).toBe(false);
  });

  // AC-3.4: Given resolve(id, result) is called with an id that was never
  // created, when the call runs, then it returns false without throwing.
  test("AC-3.4: resolve() with an unknown id returns false without throwing", () => {
    let threw = false;
    let outcome: boolean;
    try {
      outcome = resolve(randomUUID(), { kind: "confirm", approved: true });
    } catch {
      threw = true;
      outcome = true;
    }

    expect(threw).toBe(false);
    expect(outcome!).toBe(false);
  });

  test("getPending() returns the public shape only, and undefined once settled", async () => {
    const conversationId = randomUUID();
    const { id, promise } = create(conversationId, {
      conversationId,
      kind: "confirm",
      host: "10.1.1.1",
      timeoutMs: 5000,
    });

    const pending = getPending(conversationId);
    expect(pending).toBeDefined();
    expect(pending).toMatchObject({
      id,
      conversationId,
      kind: "confirm",
      host: "10.1.1.1",
      timeoutMs: 5000,
    });
    expect(typeof pending!.createdAt).toBe("string");
    // Public shape must never leak an internal resolver function.
    expect(Object.values(pending as object).some((v) => typeof v === "function")).toBe(false);

    resolve(id, { kind: "confirm", approved: true });
    await promise;

    expect(getPending(conversationId)).toBeUndefined();
  });

  test("getPending() returns undefined for a conversation with no pending interaction", () => {
    expect(getPending(randomUUID())).toBeUndefined();
  });
});
