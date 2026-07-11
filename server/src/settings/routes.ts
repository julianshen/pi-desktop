import express, { type Router } from "express";
import type { ApiKeyCredential } from "@earendil-works/pi-coding-agent";
import { getAgentDeps } from "../agent/deps.js";

/**
 * Hardcoded copy of the SDK's built-in provider id -> display name map.
 *
 * Verified (this task) that `BUILT_IN_PROVIDER_DISPLAY_NAMES` is NOT part of
 * @earendil-works/pi-coding-agent's public API:
 *   - `grep -rn "BUILT_IN_PROVIDER_DISPLAY_NAMES" dist/**\/*.d.ts` only matches
 *     dist/core/provider-display-names.d.ts, not dist/index.d.ts (the package root).
 *   - The package.json `"exports"` map only declares "." (-> dist/index.js) and
 *     "./rpc-entry" as importable subpaths, so even a deep import of
 *     "@earendil-works/pi-coding-agent/dist/core/provider-display-names.js" would
 *     fail at runtime with ERR_PACKAGE_PATH_NOT_EXPORTED.
 * Copied verbatim from dist/core/provider-display-names.js. Keep in sync manually
 * if the SDK adds/renames built-in providers.
 */
const BUILT_IN_PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  "amazon-bedrock": "Amazon Bedrock",
  "ant-ling": "Ant Ling",
  "azure-openai-responses": "Azure OpenAI Responses",
  cerebras: "Cerebras",
  "cloudflare-ai-gateway": "Cloudflare AI Gateway",
  "cloudflare-workers-ai": "Cloudflare Workers AI",
  deepseek: "DeepSeek",
  fireworks: "Fireworks",
  google: "Google Gemini",
  "google-vertex": "Google Vertex AI",
  groq: "Groq",
  huggingface: "Hugging Face",
  "kimi-coding": "Kimi For Coding",
  mistral: "Mistral",
  minimax: "MiniMax",
  "minimax-cn": "MiniMax (China)",
  moonshotai: "Moonshot AI",
  "moonshotai-cn": "Moonshot AI (China)",
  nvidia: "NVIDIA NIM",
  opencode: "OpenCode Zen",
  "opencode-go": "OpenCode Go",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  together: "Together AI",
  "vercel-ai-gateway": "Vercel AI Gateway",
  xai: "xAI",
  zai: "ZAI Coding Plan (Global)",
  "zai-coding-cn": "ZAI Coding Plan (China)",
  xiaomi: "Xiaomi MiMo",
  "xiaomi-token-plan-cn": "Xiaomi MiMo Token Plan (China)",
  "xiaomi-token-plan-ams": "Xiaomi MiMo Token Plan (Amsterdam)",
  "xiaomi-token-plan-sgp": "Xiaomi MiMo Token Plan (Singapore)",
};

interface ProviderStatus {
  id: string;
  displayName: string;
  configured: boolean;
  source: "api_key" | "oauth" | "env" | "none";
  modelCount: number;
  maskedKey?: string;
}

export const settingsRouter: Router = express.Router();

settingsRouter.get("/providers", async (_req, res) => {
  const { authStorage, modelRegistry } = await getAgentDeps();
  const availableModels = modelRegistry.getAvailable();

  const providers: ProviderStatus[] = Object.entries(BUILT_IN_PROVIDER_DISPLAY_NAMES).map(
    ([id, displayName]) => {
      // authStorage.getAuthStatus()'s own `source` values ("stored" | "runtime" |
      // "environment" | "fallback" | "models_json_key" | "models_json_command") don't
      // literally match this route's public `source` enum ("api_key" | "oauth" | "env" |
      // "none") — SPEC.md's Data Model names the latter, so translate here rather than
      // passing the SDK's internal vocabulary through to the client:
      //   - "stored" means a credential is persisted in auth.json; disambiguate
      //     api_key vs oauth via authStorage.get(id)'s credential.type.
      //   - "environment" (an env var is set, but getAuthStatus reports configured:
      //     false for it) maps to "env".
      //   - everything else (including "runtime"/CLI-only overrides, which this desktop
      //     app doesn't set) maps to "none".
      const authStatus = authStorage.getAuthStatus(id);
      const credential = authStorage.get(id);

      let source: ProviderStatus["source"] = "none";
      let configured = false;
      let maskedKey: string | undefined;

      if (authStatus.configured && credential) {
        configured = true;
        if (credential.type === "oauth") {
          source = "oauth";
        } else {
          source = "api_key";
          const apiKeyCredential = credential as ApiKeyCredential;
          maskedKey = `…${apiKeyCredential.key.slice(-4)}`;
        }
      } else if (authStatus.source === "environment") {
        source = "env";
      }

      const modelCount = availableModels.filter((m) => m.provider === id).length;

      return { id, displayName, configured, source, modelCount, maskedKey };
    },
  );

  res.json({ providers });
});
