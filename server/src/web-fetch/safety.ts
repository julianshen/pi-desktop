/**
 * Safety classification for `web_fetch` targets (Task 6, SPEC.md's "Safety
 * classification" subsection). The single upfront gate every fetch path
 * (plain HTTP and the future headless-webview render) must pass through
 * before making a network request.
 *
 * Critical design rule, straight from SPEC.md: resolve the hostname to its
 * real IP address(es) via DNS *before* classifying — never string-match the
 * hostname itself. String-matching would miss DNS rebinding (a
 * public-looking hostname whose DNS answer is a private/loopback address)
 * and would need special-casing "localhost" by name; resolving first closes
 * both problems for free, since "localhost" is private only because it
 * resolves to a loopback address like any other hostname would be.
 */
import { lookup as dnsLookup } from "node:dns/promises";

export type TargetClassification = "public" | "private";

/** Minimal shape this module needs from a DNS lookup result — matches node:dns/promises' LookupAddress. */
export interface LookupAddress {
  address: string;
  family: number;
}

/** Dependency-injection seam for the DNS lookup, used by safety.test.ts to avoid real network calls / module-mocking a Node builtin. */
export type HostResolver = (hostname: string) => Promise<LookupAddress[]>;

const defaultResolveHost: HostResolver = (hostname) => dnsLookup(hostname, { all: true });

/**
 * Thrown when DNS resolution itself fails (e.g. an unresolvable hostname).
 * Deliberately a distinct error type, never a "public"/"private" string —
 * per TASKS.md Task 6, a resolution failure must be something the caller can
 * tell apart from a real classification, not silently defaulted either way.
 */
export class DnsResolutionError extends Error {
  readonly hostname: string;

  constructor(hostname: string, cause: unknown) {
    super(`Could not resolve DNS for "${hostname}": ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "DnsResolutionError";
    this.hostname = hostname;
    if (cause instanceof Error) this.cause = cause;
  }
}

/**
 * "Private" per SPEC.md's classification table:
 * IPv4 loopback (127.0.0.0/8), private (10.0.0.0/8, 172.16.0.0/12,
 * 192.168.0.0/16), link-local (169.254.0.0/16).
 */
function isPrivateIPv4(ip: string): boolean {
  const octets = ip.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const [a, b] = octets;
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  return false;
}

/**
 * Expands a valid IPv6 literal into 8 16-bit groups, handling "::"
 * compression and an embedded dotted-quad IPv4 tail (e.g.
 * "::ffff:192.168.1.1", the IPv4-mapped-IPv6 form). Returns an empty array
 * if `ip` isn't a well-formed IPv6 literal (caller treats that as "not
 * classifiable as private" rather than throwing — DNS itself already
 * validated the address shape).
 */
function expandIPv6(ip: string): number[] {
  let address = ip;

  const ipv4TailMatch = /(^|:)(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (ipv4TailMatch) {
    const ipv4Octets = ipv4TailMatch[2].split(".").map(Number);
    if (ipv4Octets.length !== 4 || ipv4Octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return [];
    const hex1 = ((ipv4Octets[0] << 8) | ipv4Octets[1]).toString(16);
    const hex2 = ((ipv4Octets[2] << 8) | ipv4Octets[3]).toString(16);
    address = address.slice(0, address.length - ipv4TailMatch[2].length) + hex1 + ":" + hex2;
  }

  const doubleColonCount = (address.match(/::/g) ?? []).length;
  if (doubleColonCount > 1) return [];

  let groupStrings: string[];
  if (address.includes("::")) {
    const [head, tail] = address.split("::");
    const headParts = head ? head.split(":").filter((p) => p.length > 0) : [];
    const tailParts = tail ? tail.split(":").filter((p) => p.length > 0) : [];
    const missing = 8 - (headParts.length + tailParts.length);
    if (missing < 0) return [];
    groupStrings = [...headParts, ...Array(missing).fill("0"), ...tailParts];
  } else {
    groupStrings = address.split(":");
  }

  if (groupStrings.length !== 8) return [];

  const groups = groupStrings.map((part) => parseInt(part, 16));
  if (groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return [];
  return groups;
}

/**
 * "Private" per SPEC.md's classification table: IPv6 loopback (::1),
 * unique-local (fc00::/7), link-local (fe80::/10). Also honors an embedded
 * IPv4 address for the IPv4-mapped-IPv6 form (::ffff:a.b.c.d) by deferring
 * to isPrivateIPv4() — a DNS answer in that form is exactly as bypass-able
 * as a bare IPv4 private address would be if left unhandled.
 */
function isPrivateIPv6(ip: string): boolean {
  const groups = expandIPv6(ip.toLowerCase());
  if (groups.length !== 8) return false;

  const isIPv4Mapped =
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff;
  if (isIPv4Mapped) {
    const a = (groups[6] >>> 8) & 0xff;
    const b = groups[6] & 0xff;
    const c = (groups[7] >>> 8) & 0xff;
    const d = groups[7] & 0xff;
    return isPrivateIPv4(`${a}.${b}.${c}.${d}`);
  }

  const isLoopback = groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1;
  if (isLoopback) return true; // ::1

  if ((groups[0] >>> 9) === 0b1111110) return true; // fc00::/7 unique-local
  if ((groups[0] >>> 6) === 0b1111111010) return true; // fe80::/10 link-local

  return false;
}

function isPrivateAddress(addr: LookupAddress): boolean {
  return addr.family === 6 ? isPrivateIPv6(addr.address) : isPrivateIPv4(addr.address);
}

/**
 * Resolves `url`'s hostname to its real IP address(es) via DNS, then
 * classifies as "private" if ANY resolved address falls in a
 * loopback/private/link-local range (SPEC.md: checked once, upfront,
 * against the target — before either the plain-HTTP or webview-render path
 * is attempted).
 *
 * `resolveHost` is an optional dependency-injection seam (defaults to a
 * real `node:dns/promises` lookup) — see safety.test.ts's module doc
 * comment for why this was chosen over mocking the `node:dns` builtin.
 *
 * Throws DnsResolutionError — never returns a default classification — if
 * DNS resolution itself fails, per TASKS.md Task 6's explicit requirement.
 */
export async function classifyTarget(
  url: URL,
  resolveHost: HostResolver = defaultResolveHost,
): Promise<TargetClassification> {
  // URL.hostname wraps IPv6 literals in brackets (e.g. "[::1]"); DNS lookup
  // needs the bare address.
  const hostname = url.hostname.replace(/^\[|\]$/g, "");

  let addresses: LookupAddress[];
  try {
    addresses = await resolveHost(hostname);
  } catch (error) {
    throw new DnsResolutionError(hostname, error);
  }

  if (addresses.length === 0) {
    throw new DnsResolutionError(hostname, new Error("DNS lookup returned no addresses"));
  }

  return addresses.some(isPrivateAddress) ? "private" : "public";
}
