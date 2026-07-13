import { ModelRegistry, resolveCliModel } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import { getAgentDeps } from "./deps.js";

export interface ModelSummary {
  id: string;
  label: string;
  provider: string;
}

/**
 * Decoupled from AgentDeps' MCP-loading bundle: callers may inject a registry
 * directly (tests do this to avoid touching real provider auth/config), and the
 * production default only reads the already-memoized getAgentDeps() promise
 * rather than re-running any expensive setup.
 */
async function defaultRegistry(): Promise<ModelRegistry> {
  const { modelRegistry } = await getAgentDeps();
  return modelRegistry;
}

/** Canonical id format matches what resolveCliModel/findExactModelReferenceMatch accept: "<provider>/<modelId>". */
export async function listAvailableModels(registry?: ModelRegistry): Promise<ModelSummary[]> {
  const modelRegistry = registry ?? (await defaultRegistry());
  return modelRegistry.getAvailable().map((model) => ({
    id: `${model.provider}/${model.id}`,
    label: model.name,
    provider: model.provider,
  }));
}

/** Same resolution path as deps.ts's resolveCliModel, by explicit id. Never throws — unresolvable ids just yield undefined. */
export async function resolveModelById(id: string, registry?: ModelRegistry): Promise<Model<Api> | undefined> {
  const modelRegistry = registry ?? (await defaultRegistry());
  const { model } = resolveCliModel({ cliModel: id, modelRegistry });
  return model;
}
