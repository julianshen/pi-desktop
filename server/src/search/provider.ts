export interface SearchInput { query: string; limit?: number }
export interface SearchCitation { id: string; title: string; url: string; snippet?: string; source: string }
export interface SearchProvider { search(input: SearchInput, signal: AbortSignal): Promise<SearchCitation[]> }
export type SearchFailureCode = "missing_credentials" | "unauthorized" | "rate_limited" | "timeout" | "malformed_response" | "provider_error";

export class SearchProviderError extends Error {
  constructor(readonly code: SearchFailureCode, message: string, readonly retryable: boolean) { super(message); }
}

export function normalizeCitation(value: unknown, source: string, index: number): SearchCitation {
  if (!value || typeof value !== "object") throw new SearchProviderError("malformed_response", "Search provider returned malformed evidence", false);
  const row = value as Record<string, unknown>;
  if (typeof row.title !== "string" || typeof row.url !== "string") throw new SearchProviderError("malformed_response", "Search provider returned malformed evidence", false);
  let url: URL;
  try {
    url = new URL(row.url);
  } catch {
    throw new SearchProviderError("malformed_response", "Search provider returned an invalid citation URL", false);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new SearchProviderError("malformed_response", "Search provider returned an unsafe citation URL", false);
  return { id: `${source}-${index + 1}`, title: row.title, url: url.toString(), snippet: typeof row.description === "string" ? row.description : undefined, source };
}
