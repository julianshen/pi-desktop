import express, { type Request, type Response, type Router } from "express";
import type { AuthStorage } from "@earendil-works/pi-coding-agent";
import { getAgentDeps } from "../agent/deps.js";
import { getSharedSession } from "../agent/session.js";

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

interface ModelOption {
  provider: string;
  id: string;
  name: string;
  contextWindow?: number;
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

  // authStorage.set() persists to disk before refresh() runs below. If refresh()
  // ever throws, the outer .catch() returns 500 but the credential is already
  // saved — a partial-write state. In practice this is believed unreachable:
  // refresh()'s internal models.json parsing swallows its own errors rather than
  // throwing (see model-registry.js's loadModels()), so this route has no known
  // path to actually hit it. Documented rather than silently possible.
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

async function handleGetModels(_req: Request, res: Response): Promise<void> {
  const { modelRegistry } = await getAgentDeps();
  const models: ModelOption[] = modelRegistry.getAvailable().map((model) => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
  }));
  res.json({ models });
}

settingsRouter.get("/models", (req, res) => {
  handleGetModels(req, res).catch((error: unknown) => {
    console.error("[settings] unhandled error in GET /models", error);
    if (!res.headersSent) res.status(500).json({ error: "internal_error" });
  });
});

/*
 * Open question resolved (Task 3, per TASKS.md's "Before writing code" instruction):
 * does `(await getSharedSession()).model` return a sensible value on a cold server
 * start, before any explicit setModel() call / chat turn?
 *
 * Traced through the SDK source (not just the .d.ts prose) to confirm:
 *
 *   - model-resolver.d.ts's findInitialModel() documents priority order:
 *     1. CLI args, 2. first scoped model (non-continuing only), 3. restored from
 *     session, 4. SettingsManager saved default, 5. first available model with a
 *     configured key.
 *   - dist/core/sdk.js's createAgentSession() (the function server/src/agent/session.ts's
 *     createSession() calls) shows this isn't just documentation: when no `model` option
 *     is passed in (our case — agent/deps.ts's `model` is only set if PI_DESKTOP_MODEL is
 *     set) and there's no existing session to restore from, it calls
 *     `findInitialModel({ defaultProvider: settingsManager.getDefaultProvider(),
 *     defaultModelId: settingsManager.getDefaultModel(), ... })` and assigns the result to
 *     `model` BEFORE constructing the Agent/AgentSession — i.e. resolution happens
 *     synchronously during `createAgentSession()`, not lazily on first prompt.
 *   - dist/core/agent-session.js's `setModel()` confirms the write path: it calls
 *     `this.settingsManager.setDefaultModelAndProvider(model.provider, model.id)` on the
 *     *same* `SettingsManager` instance `createAgentSession()` constructed internally and
 *     handed to `new AgentSession({ ..., settingsManager })` — so reads and writes go
 *     through one consistent object, persisted to disk under `<agentDir>/settings.json`
 *     via `FileSettingsStorage`. No gap, no need for a second, competing `SettingsManager`.
 *
 * BUT: live-verified (not just .d.ts-verified) that `session.model` is *never actually
 * `undefined`*, contradicting agent-session.d.ts's "(may be undefined if not yet
 * selected)" comment. A curl against a scratch env with zero providers configured
 * returned `{"provider":"unknown","model":"unknown"}`, not `{provider: null, model:
 * null}`. Root cause, found in pi-agent-core's dist/agent.js (createMutableAgentState):
 * `model: initialState?.model ?? DEFAULT_MODEL`, where `DEFAULT_MODEL` is a hardcoded
 * sentinel object (`{ id: "unknown", provider: "unknown", baseUrl: "", ... }`) — findInitialModel()
 * returning `model: undefined` still results in `agent.state.model` being this sentinel,
 * never real `undefined`. So a plain truthiness check on `session.model` is wrong here.
 * Instead, treat it as "no default set" whenever it doesn't resolve to a real registered
 * model via `modelRegistry.find()` — robust regardless of the sentinel's exact shape, and
 * doesn't require importing pi-agent-core's unexported DEFAULT_MODEL to compare against.
 */
async function handleGetDefaultModel(_req: Request, res: Response): Promise<void> {
  const session = await getSharedSession();
  const { modelRegistry } = await getAgentDeps();
  const current = session.model;
  const registered = current && modelRegistry.find(current.provider, current.id);
  res.json(registered ? { provider: registered.provider, model: registered.id } : { provider: null, model: null });
}

settingsRouter.get("/default-model", (req, res) => {
  handleGetDefaultModel(req, res).catch((error: unknown) => {
    console.error("[settings] unhandled error in GET /default-model", error);
    if (!res.headersSent) res.status(500).json({ error: "internal_error" });
  });
});

async function handleSetDefaultModel(req: Request, res: Response): Promise<void> {
  const { provider, model: modelId } = (req.body ?? {}) as { provider?: unknown; model?: unknown };
  if (typeof provider !== "string" || typeof modelId !== "string" || !provider || !modelId) {
    res.status(422).json({ error: "Both provider and model are required." });
    return;
  }

  const { modelRegistry } = await getAgentDeps();
  const found = modelRegistry.find(provider, modelId);
  if (!found) {
    res.status(422).json({ error: "Model not found or not available." });
    return;
  }

  const session = await getSharedSession();
  // setModel() is the SDK's own documented write path — "Validates that auth is
  // configured, saves to session and settings" (agent-session.d.ts) — and it's the
  // only writer we ever want touching AgentSession/SettingsManager state (see the
  // open-question resolution above). Its thrown error ("No API key for provider/id")
  // is an expected, user-correctable condition (the model was found in the registry
  // but has no configured auth), not a genuine server fault, so it gets its own inner
  // catch -> 422 here rather than falling through to the outer .catch() -> 500 guard.
  try {
    await session.setModel(found);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "No auth configured for that model.";
    res.status(422).json({ error: message });
    return;
  }

  res.json({ provider: found.provider, model: found.id });
}

settingsRouter.put("/default-model", (req, res) => {
  handleSetDefaultModel(req, res).catch((error: unknown) => {
    console.error("[settings] unhandled error in PUT /default-model", error);
    if (!res.headersSent) res.status(500).json({ error: "internal_error" });
  });
});
