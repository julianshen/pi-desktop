import { describe, expect, test } from "bun:test";
import { classifyTarget, DnsResolutionError, type LookupAddress } from "./safety.js";

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
