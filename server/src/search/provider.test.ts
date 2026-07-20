import { describe, expect, test } from "bun:test";
import { normalizeCitation, SearchProviderError } from "./provider.js";

describe("search provider contract", () => {
  test("AC-13.2: malformed evidence fails explicitly without fabricated sources", () => {
    expect(() => normalizeCitation({ title: "Missing URL" }, "test", 0)).toThrow(SearchProviderError);
    expect(() => normalizeCitation({ title: "Unsafe", url: "javascript:alert(1)" }, "test", 0)).toThrow("unsafe citation URL");
    expect(() => normalizeCitation({ title: "Invalid", url: "not a url" }, "test", 0)).toThrow(SearchProviderError);
  });
  test("AC-13.3: normalized citations retain typed evidence metadata", () => {
    expect(normalizeCitation({ title: "Evidence", url: "https://example.com/a", description: "Snippet" }, "Brave Search", 0)).toEqual({
      id: "Brave Search-1", title: "Evidence", url: "https://example.com/a", snippet: "Snippet", source: "Brave Search",
    });
  });
});
