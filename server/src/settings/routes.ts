import express, { type Request, type Response, type Router } from "express";
import type { AuthStorage } from "@earendil-works/pi-coding-agent";
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

/**
 * Build a single provider's status. Shared by the GET /providers loop and the
 * POST/DELETE /providers/:id handlers (which only ever need one entry) so the
 * source->public-enum translation logic below lives in exactly one place.
 *
 * authStorage.getAuthStatus()'s own `source` values ("stored" | "runtime" |
 * "environment" | "fallback" | "models_json_key" | "models_json_command") don't
 * literally match this route's public `source` enum ("api_key" | "oauth" | "env" |
 * "none") — SPEC.md's Data Model names the latter, so translate here rather than
 * passing the SDK's internal vocabulary through to the client:
 *   - "stored" means a credential is persisted in auth.json; disambiguate
 *     api_key vs oauth via authStorage.get(id)'s credential.type.
 *   - "environment" (an env var is set, but getAuthStatus reports configured:
 *     false for it) maps to "env".
 *   - everything else (including "runtime"/CLI-only overrides, which this desktop
 *     app doesn't set) maps to "none".
 */
function buildProviderStatus(
  id: string,
  displayName: string,
  authStorage: AuthStorage,
  modelCount: number,
): ProviderStatus {
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
      maskedKey = `…${credential.key.slice(-4)}`;
    }
  } else if (authStatus.source === "environment") {
    source = "env";
  }

  return { id, displayName, configured, source, modelCount, maskedKey };
}

async function handleGetProviders(_req: Request, res: Response): Promise<void> {
  const { authStorage, modelRegistry } = await getAgentDeps();
  const availableModels = modelRegistry.getAvailable();

  // Single grouping pass instead of a `.filter()` per provider inside the `.map()` below
  // (that would be O(providers * models) over the ~33 built-in providers).
  const modelCountByProvider = new Map<string, number>();
  for (const model of availableModels) {
    modelCountByProvider.set(model.provider, (modelCountByProvider.get(model.provider) ?? 0) + 1);
  }

  const providers: ProviderStatus[] = Object.entries(BUILT_IN_PROVIDER_DISPLAY_NAMES).map(
    ([id, displayName]) => buildProviderStatus(id, displayName, authStorage, modelCountByProvider.get(id) ?? 0),
  );

  res.json({ providers });
}

settingsRouter.get("/providers", (req, res) => {
  handleGetProviders(req, res).catch((error: unknown) => {
    console.error("[settings] unhandled error in GET /providers", error);
    if (!res.headersSent) res.status(500).json({ error: "internal_error" });
  });
});

async function handleConnectProvider(req: Request, res: Response): Promise<void> {
  const { id } = req.params as { id: string };
  const displayName = BUILT_IN_PROVIDER_DISPLAY_NAMES[id];
  if (!displayName) {
    res.status(404).json({ error: "Unknown provider." });
    return;
  }

  // Never log `req.body` (SPEC.md Boundaries: never log request bodies on
  // /api/settings/* — they carry raw API keys). Only ever log the provider id.
  const { apiKey } = (req.body ?? {}) as { apiKey?: unknown };
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    res.status(422).json({ error: "An API key is required." });
    return;
  }

  const { authStorage, modelRegistry } = await getAgentDeps();

  authStorage.set(id, { type: "api_key", key: apiKey });

  // Connect is optimistic (revised during /tgd-develop — see PRD.md's US-06 revision
  // note and SPEC.md's POST /providers/:id contract): pi's SDK has no live
  // credential-validation capability anywhere. `refresh()` only reloads/re-parses
  // <agentDir>/models.json (custom provider/model overrides) and rebuilds the
  // in-memory model list from that + the built-in catalog — it makes no network call
  // to confirm the key we just set actually authenticates with the provider. We still
  // call it here so the newly-connected provider's models become visible to a
  // subsequent GET /models, not as a validation step. There is no getError()-based
  // rollback: once authStorage.set() + refresh() succeed without throwing, the
  // provider is always reported Connected. A genuinely bad key is discovered
  // naturally the first time the agent actually uses that provider, not here.
  modelRegistry.refresh();

  const modelCount = modelRegistry.getAvailable().filter((m) => m.provider === id).length;
  res.json({ provider: buildProviderStatus(id, displayName, authStorage, modelCount) });
}

settingsRouter.post("/providers/:id", (req, res) => {
  handleConnectProvider(req, res).catch((error: unknown) => {
    console.error("[settings] unhandled error in POST /providers/:id", error);
    if (!res.headersSent) res.status(500).json({ error: "internal_error" });
  });
});

async function handleDisconnectProvider(req: Request, res: Response): Promise<void> {
  const { id } = req.params as { id: string };
  const displayName = BUILT_IN_PROVIDER_DISPLAY_NAMES[id];
  if (!displayName) {
    res.status(404).json({ error: "Unknown provider." });
    return;
  }

  const { authStorage, modelRegistry } = await getAgentDeps();
  authStorage.remove(id);

  const modelCount = modelRegistry.getAvailable().filter((m) => m.provider === id).length;
  res.json({ provider: buildProviderStatus(id, displayName, authStorage, modelCount) });
}

settingsRouter.delete("/providers/:id", (req, res) => {
  handleDisconnectProvider(req, res).catch((error: unknown) => {
    console.error("[settings] unhandled error in DELETE /providers/:id", error);
    if (!res.headersSent) res.status(500).json({ error: "internal_error" });
  });
});
