import { describe, expect, test } from "bun:test";
import { classifyTarget, resolveTarget, DnsResolutionError, type LookupAddress } from "./safety.js";

/**
 * Task 6 (TASKS.md) — safety.ts's boundary tests over every IP range in
 * SPEC.md's classification table, plus the DNS-rebinding scenario that is
 * the entire reason classifyTarget() resolves DNS before classifying
 * (SPEC.md's "Safety classification" subsection / CLAUDE.md's DNS-rebinding
 * note).
 *
 * DNS mocking approach: classifyTarget() accepts an optional second
 * parameter, `resolveHost`, a dependency-injection seam for the DNS lookup
 * (defaults to a real `node:dns/promises`-backed lookup). This was chosen
 * over `mock.module("node:dns", ...)` because DI is deterministic (no
 * reliance on Bun's module-mock semantics for a Node builtin, and no
 * flakiness from real network calls), and is explicitly sanctioned by
 * TASKS.md Task 6's own instructions ("...or dependency injection into
 * classifyTarget"). A couple of tests below additionally exercise the
 * *default* (real DNS) parameter path using literal IP addresses
 * (127.0.0.1, 8.8.8.8) — dns.lookup() resolves an IP literal without any
 * real network call, so these stay fast and deterministic too.
 */

function fakeResolver(addresses: LookupAddress[]) {
  return async (_hostname: string): Promise<LookupAddress[]> => addresses;
}

function failingResolver(error: unknown) {
  return async (_hostname: string): Promise<LookupAddress[]> => {
    throw error;
  };
}

describe("classifyTarget — IPv4 boundaries", () => {
  test("127.0.0.1 (loopback) classifies as private", async () => {
    const result = await classifyTarget(
      new URL("http://loop.example.test/"),
      fakeResolver([{ address: "127.0.0.1", family: 4 }]),
    );
    expect(result).toBe("private");
  });

  test("127.255.255.254 (top of loopback /8) classifies as private", async () => {
    const result = await classifyTarget(
      new URL("http://loop2.example.test/"),
      fakeResolver([{ address: "127.255.255.254", family: 4 }]),
    );
    expect(result).toBe("private");
  });

  test("10.0.0.1 (10.0.0.0/8 private) classifies as private", async () => {
    const result = await classifyTarget(
      new URL("http://ten.example.test/"),
      fakeResolver([{ address: "10.0.0.1", family: 4 }]),
    );
    expect(result).toBe("private");
  });

  test("172.16.0.1 (172.16.0.0/12 private, lower bound) classifies as private", async () => {
    const result = await classifyTarget(
      new URL("http://oneseven2-lo.example.test/"),
      fakeResolver([{ address: "172.16.0.1", family: 4 }]),
    );
    expect(result).toBe("private");
  });

  test("172.31.255.255 (172.16.0.0/12 private, upper bound) classifies as private", async () => {
    const result = await classifyTarget(
      new URL("http://oneseven2-hi.example.test/"),
      fakeResolver([{ address: "172.31.255.255", family: 4 }]),
    );
    expect(result).toBe("private");
  });

  test("172.32.0.1 (just outside 172.16.0.0/12) classifies as public", async () => {
    const result = await classifyTarget(
      new URL("http://oneseven2-out.example.test/"),
      fakeResolver([{ address: "172.32.0.1", family: 4 }]),
    );
    expect(result).toBe("public");
  });

  test("192.168.1.1 (192.168.0.0/16 private) classifies as private", async () => {
    const result = await classifyTarget(
      new URL("http://oneninetwo.example.test/"),
      fakeResolver([{ address: "192.168.1.1", family: 4 }]),
    );
    expect(result).toBe("private");
  });

  test("169.254.1.1 (169.254.0.0/16 link-local) classifies as private", async () => {
    const result = await classifyTarget(
      new URL("http://linklocal.example.test/"),
      fakeResolver([{ address: "169.254.1.1", family: 4 }]),
    );
    expect(result).toBe("private");
  });

  test("8.8.8.8 (public) classifies as public", async () => {
    const result = await classifyTarget(
      new URL("http://public.example.test/"),
      fakeResolver([{ address: "8.8.8.8", family: 4 }]),
    );
    expect(result).toBe("public");
  });

  test("default (real DNS) parameter path: literal 127.0.0.1 classifies as private with no injected resolver", async () => {
    const result = await classifyTarget(new URL("http://127.0.0.1:9999/"));
    expect(result).toBe("private");
  });

  test("default (real DNS) parameter path: literal 8.8.8.8 classifies as public with no injected resolver", async () => {
    const result = await classifyTarget(new URL("http://8.8.8.8/"));
    expect(result).toBe("public");
  });
});

// REVIEW.md #8: isPrivateIPv4's range table omitted 0.0.0.0/8 ("this
// network", treated as localhost by several stacks) and 100.64.0.0/10
// (RFC 6598 CGNAT/shared-address space) — boundary tests matching the
// existing table's style (just-inside, just-outside each range).
describe("classifyTarget — IPv4 range-table gaps (REVIEW.md #8)", () => {
  test("0.0.0.0 (0.0.0.0/8 'this network', lower bound) classifies as private", async () => {
    const result = await classifyTarget(
      new URL("http://zero-lo.example.test/"),
      fakeResolver([{ address: "0.0.0.0", family: 4 }]),
    );
    expect(result).toBe("private");
  });

  test("0.255.255.255 (0.0.0.0/8, upper bound) classifies as private", async () => {
    const result = await classifyTarget(
      new URL("http://zero-hi.example.test/"),
      fakeResolver([{ address: "0.255.255.255", family: 4 }]),
    );
    expect(result).toBe("private");
  });

  test("1.0.0.0 (just outside 0.0.0.0/8) classifies as public", async () => {
    const result = await classifyTarget(
      new URL("http://zero-out.example.test/"),
      fakeResolver([{ address: "1.0.0.0", family: 4 }]),
    );
    expect(result).toBe("public");
  });

  test("100.64.0.0 (100.64.0.0/10 CGNAT, lower bound) classifies as private", async () => {
    const result = await classifyTarget(
      new URL("http://cgnat-lo.example.test/"),
      fakeResolver([{ address: "100.64.0.0", family: 4 }]),
    );
    expect(result).toBe("private");
  });

  test("100.127.255.255 (100.64.0.0/10 CGNAT, upper bound) classifies as private", async () => {
    const result = await classifyTarget(
      new URL("http://cgnat-hi.example.test/"),
      fakeResolver([{ address: "100.127.255.255", family: 4 }]),
    );
    expect(result).toBe("private");
  });

  test("100.63.255.255 (just below 100.64.0.0/10) classifies as public", async () => {
    const result = await classifyTarget(
      new URL("http://cgnat-below.example.test/"),
      fakeResolver([{ address: "100.63.255.255", family: 4 }]),
    );
    expect(result).toBe("public");
  });

  test("100.128.0.0 (just above 100.64.0.0/10) classifies as public", async () => {
    const result = await classifyTarget(
      new URL("http://cgnat-above.example.test/"),
      fakeResolver([{ address: "100.128.0.0", family: 4 }]),
    );
    expect(result).toBe("public");
  });

  test("::ffff:0.0.0.0 (IPv4-mapped 'this network') classifies as private", async () => {
    const result = await classifyTarget(
      new URL("http://v4mapped-zero.example.test/"),
      fakeResolver([{ address: "::ffff:0.0.0.0", family: 6 }]),
    );
    expect(result).toBe("private");
  });

  test("::ffff:100.64.0.1 (IPv4-mapped CGNAT) classifies as private", async () => {
    const result = await classifyTarget(
      new URL("http://v4mapped-cgnat.example.test/"),
      fakeResolver([{ address: "::ffff:100.64.0.1", family: 6 }]),
    );
    expect(result).toBe("private");
  });
});

describe("classifyTarget — IPv6 boundaries", () => {
  test("::1 (loopback) classifies as private", async () => {
    const result = await classifyTarget(
      new URL("http://[::1]/"),
      fakeResolver([{ address: "::1", family: 6 }]),
    );
    expect(result).toBe("private");
  });

  test("fc00::1 (unique-local fc00::/7, lower bound) classifies as private", async () => {
    const result = await classifyTarget(
      new URL("http://ula-lo.example.test/"),
      fakeResolver([{ address: "fc00::1", family: 6 }]),
    );
    expect(result).toBe("private");
  });

  test("fdff:ffff:ffff:ffff::1 (unique-local fc00::/7, upper bound) classifies as private", async () => {
    const result = await classifyTarget(
      new URL("http://ula-hi.example.test/"),
      fakeResolver([{ address: "fdff:ffff:ffff:ffff::1", family: 6 }]),
    );
    expect(result).toBe("private");
  });

  test("fe80::1 (link-local fe80::/10) classifies as private", async () => {
    const result = await classifyTarget(
      new URL("http://v6linklocal.example.test/"),
      fakeResolver([{ address: "fe80::1", family: 6 }]),
    );
    expect(result).toBe("private");
  });

  test("2001:4860:4860::8888 (public, Google DNS) classifies as public", async () => {
    const result = await classifyTarget(
      new URL("http://v6public.example.test/"),
      fakeResolver([{ address: "2001:4860:4860::8888", family: 6 }]),
    );
    expect(result).toBe("public");
  });

  test("::ffff:127.0.0.1 (IPv4-mapped loopback) classifies as private", async () => {
    const result = await classifyTarget(
      new URL("http://v4mapped.example.test/"),
      fakeResolver([{ address: "::ffff:127.0.0.1", family: 6 }]),
    );
    expect(result).toBe("private");
  });
});

describe("classifyTarget — DNS-rebinding closure (never string-match the hostname alone)", () => {
  test("a public-looking hostname that resolves to a private IP classifies as private, not public", async () => {
    // The entire point of resolving DNS before classifying (SPEC.md): a
    // hostname with no private-sounding string content at all (no
    // "localhost", no "internal", nothing) still must be caught if its DNS
    // answer is a private/loopback address — this is what closes the
    // DNS-rebinding bypass.
    const result = await classifyTarget(
      new URL("http://totally-public-looking-cdn.example.com/asset.js"),
      fakeResolver([{ address: "192.168.0.1", family: 4 }]),
    );
    expect(result).toBe("private");
  });

  test("localhost is handled for free via DNS resolution, with no hostname string-matching", async () => {
    // No special-casing of the literal string "localhost" anywhere in
    // safety.ts — it's private only because it resolves to a loopback
    // address, exactly like any other hostname would be.
    const result = await classifyTarget(
      new URL("http://localhost:3000/"),
      fakeResolver([{ address: "127.0.0.1", family: 4 }]),
    );
    expect(result).toBe("private");
  });

  test("multiple resolved addresses: private if ANY resolved address is private, even if others are public", async () => {
    const result = await classifyTarget(
      new URL("http://multi.example.test/"),
      fakeResolver([
        { address: "8.8.8.8", family: 4 },
        { address: "10.1.2.3", family: 4 },
      ]),
    );
    expect(result).toBe("private");
  });
});

// REVIEW.md #2 (DNS-rebinding TOCTOU): fetcher.ts's plainFetch() pins its
// actual network connection to resolveTarget()'s `address` field rather than
// letting its HTTP client re-resolve the hostname a second time. These tests
// cover resolveTarget() in isolation — the piece of the fix that lives in
// this file; fetcher.test.ts covers the end-to-end "the pinned address is
// what's actually connected to" behavior.
describe("resolveTarget — returns the specific address classification is based on", () => {
  test("single public address: classification is public and address is that address", async () => {
    const result = await resolveTarget(
      new URL("http://public.example.test/"),
      fakeResolver([{ address: "8.8.8.8", family: 4 }]),
    );
    expect(result.classification).toBe("public");
    expect(result.address).toEqual({ address: "8.8.8.8", family: 4 });
  });

  test("multiple addresses, one private: address is the PRIVATE one, not just the first in the list", async () => {
    // A caller pinning its connection to `address` must connect to the
    // literal address that was judged private — never to a different,
    // still-public address from the same multi-answer DNS response (that
    // would classify "private" but connect somewhere never actually
    // evaluated).
    const result = await resolveTarget(
      new URL("http://multi.example.test/"),
      fakeResolver([
        { address: "8.8.8.8", family: 4 },
        { address: "10.1.2.3", family: 4 },
      ]),
    );
    expect(result.classification).toBe("private");
    expect(result.address).toEqual({ address: "10.1.2.3", family: 4 });
  });

  test("multiple public addresses, none private: address is the first one", async () => {
    const result = await resolveTarget(
      new URL("http://multi-public.example.test/"),
      fakeResolver([
        { address: "8.8.8.8", family: 4 },
        { address: "1.1.1.1", family: 4 },
      ]),
    );
    expect(result.classification).toBe("public");
    expect(result.address).toEqual({ address: "8.8.8.8", family: 4 });
  });
});

describe("classifyTarget — DNS resolution failure", () => {
  test("an unresolvable hostname throws DnsResolutionError, never silently defaulting to public or private", async () => {
    const error = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    await expect(
      classifyTarget(new URL("http://this-host-does-not-exist.invalid/"), failingResolver(error)),
    ).rejects.toBeInstanceOf(DnsResolutionError);
  });

  test("DnsResolutionError is distinguishable from a real classification result (not the string 'public' or 'private')", async () => {
    const error = new Error("boom");
    try {
      await classifyTarget(new URL("http://also-unresolvable.invalid/"), failingResolver(error));
      throw new Error("expected classifyTarget to reject");
    } catch (caught) {
      expect(caught).toBeInstanceOf(DnsResolutionError);
      expect(caught).not.toBe("public");
      expect(caught).not.toBe("private");
    }
  });
});
