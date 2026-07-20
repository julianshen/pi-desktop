import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { BraveSearchProvider } from "./brave.js";
import { getSearchSettings } from "./settings.js";
import { emitActiveRunEvent } from "../agent/plan-tools.js";
import { countBucket, durationBucket, trackServerEvent } from "../analytics/events.js";
import { SearchProviderError } from "./provider.js";

export function createSearchTools(conversationId: string) {
  return [defineTool({
    name: "web_search",
    label: "Search web",
    description: "Search the public web when current external evidence would improve the answer. Returns normalized citations.",
    parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }),
    execute: async (_id, params) => {
      const startedAt = Date.now();
      const settings = getSearchSettings();
      try {
        if (!settings.enabled) throw new SearchProviderError("missing_credentials", "Web search is disabled in Settings", false);
        const citations = await new BraveSearchProvider({ apiKey: settings.apiKey, maxResults: settings.maxResults }).search(params, new AbortController().signal);
        trackServerEvent({ name: "web_search_run_completed", properties: { provider: settings.provider, outcome: "success", result_count_bucket: countBucket(citations.length), latency_bucket: durationBucket(Date.now() - startedAt) } });
        emitActiveRunEvent(conversationId, "search_completed", { provider: settings.provider, resultCount: citations.length, citations });
        return { content: [{ type: "text", text: JSON.stringify({ citations }) }], details: { citations } };
      } catch (error) {
        const outcome = error instanceof SearchProviderError && error.code === "missing_credentials" ? "not_configured" : error instanceof SearchProviderError && error.code === "rate_limited" ? "rate_limited" : "failed";
        trackServerEvent({ name: "web_search_run_completed", properties: { provider: settings.provider, outcome, result_count_bucket: "0", latency_bucket: durationBucket(Date.now() - startedAt) } });
        throw error;
      }
    },
  })];
}
