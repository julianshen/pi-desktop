import { describe, expect, test } from "bun:test";
import { BraveSearchProvider } from "./brave.js";
import { SearchProviderError } from "./provider.js";

describe("BraveSearchProvider", () => {
  test("AC-13.1: sends auth privately and returns bounded normalized evidence", async () => {
    let request: { url?: string; token?: string } = {};
    const provider = new BraveSearchProvider({ apiKey: "secret-key", maxResults: 1, fetch: async (input, init) => {
      request = { url: String(input), token: new Headers(init?.headers).get("X-Subscription-Token") ?? undefined };
      return new Response(JSON.stringify({ web: { results: [{ title: "One", url: "https://one.example/", description: "First" }, { title: "Two", url: "https://two.example/" }] } }));
    } });
    const results = await provider.search({ query: "private query" }, new AbortController().signal);
    expect(results).toHaveLength(1); expect(results[0]?.source).toBe("Brave Search");
    expect(request.token).toBe("secret-key");
    expect(JSON.stringify(results)).not.toContain("secret-key");
  });
  test("AC-13.2: missing key, rate limit, and malformed data use typed errors", async () => {
    await expect(new BraveSearchProvider({}).search({ query: "x" }, new AbortController().signal)).rejects.toMatchObject({ code: "missing_credentials" } satisfies Partial<SearchProviderError>);
    await expect(new BraveSearchProvider({ apiKey: "x", fetch: async () => new Response("", { status: 429 }) }).search({ query: "x" }, new AbortController().signal)).rejects.toMatchObject({ code: "rate_limited", retryable: true } satisfies Partial<SearchProviderError>);
    await expect(new BraveSearchProvider({ apiKey: "x", fetch: async () => new Response("{}") }).search({ query: "x" }, new AbortController().signal)).rejects.toMatchObject({ code: "malformed_response" } satisfies Partial<SearchProviderError>);
  });
  test("a valid zero-result response returns an empty list", async () => {
    const provider = new BraveSearchProvider({ apiKey: "x", fetch: async () => new Response(JSON.stringify({ web: {} })) });
    await expect(provider.search({ query: "nothing" }, new AbortController().signal)).resolves.toEqual([]);
  });
});
