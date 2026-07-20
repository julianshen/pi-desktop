import { normalizeCitation, SearchProviderError, type SearchInput, type SearchProvider, type SearchCitation } from "./provider.js";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export interface BraveOptions { apiKey?: string; timeoutMs?: number; maxResults?: number; fetch?: FetchLike }

export class BraveSearchProvider implements SearchProvider {
  constructor(private readonly options: BraveOptions) {}
  async search(input: SearchInput, signal: AbortSignal): Promise<SearchCitation[]> {
    if (!this.options.apiKey) throw new SearchProviderError("missing_credentials", "Brave Search is enabled but no API key is configured", false);
    const limit = Math.max(1, Math.min(input.limit ?? this.options.maxResults ?? 5, this.options.maxResults ?? 10));
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 10_000);
    const combined = AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", input.query); url.searchParams.set("count", String(limit));
      response = await (this.options.fetch ?? globalThis.fetch)(url, {
        headers: { Accept: "application/json", "X-Subscription-Token": this.options.apiKey }, signal: combined,
      });
    } catch (error) {
      if (timeout.aborted) throw new SearchProviderError("timeout", "Brave Search timed out", true);
      throw error;
    }
    if (response.status === 401 || response.status === 403) throw new SearchProviderError("unauthorized", "Brave Search credentials were rejected", false);
    if (response.status === 429) throw new SearchProviderError("rate_limited", "Brave Search rate limit reached", true);
    if (!response.ok) throw new SearchProviderError("provider_error", `Brave Search failed (${response.status})`, response.status >= 500);
    let body: unknown;
    try { body = await response.json(); } catch { throw new SearchProviderError("malformed_response", "Brave Search returned invalid JSON", false); }
    const web = (body as { web?: unknown })?.web;
    if (!web || typeof web !== "object") throw new SearchProviderError("malformed_response", "Brave Search returned malformed results", false);
    const results = (web as { results?: unknown }).results ?? [];
    if (!Array.isArray(results)) throw new SearchProviderError("malformed_response", "Brave Search returned malformed results", false);
    return results.slice(0, limit).map((row, index) => normalizeCitation(row, "Brave Search", index));
  }
}
