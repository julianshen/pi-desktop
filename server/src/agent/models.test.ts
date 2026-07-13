import { describe, expect, test } from "bun:test";
import { resolveCliModel, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import { listAvailableModels, resolveModelById } from "./models.js";

function makeModel(overrides: Partial<Model<Api>> & { id: string; provider: string }): Model<Api> {
  return {
    name: overrides.id,
    api: "anthropic-messages",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0 },
    contextWindow: 100_000,
    maxTokens: 4096,
    ...overrides,
  } as Model<Api>;
}

/** Minimal stub satisfying only the ModelRegistry surface models.ts actually calls. */
function makeRegistryStub(models: Model<Api>[]): ModelRegistry {
  return {
    getAll: () => models,
    getAvailable: () => models,
  } as unknown as ModelRegistry;
}

describe("models", () => {
  // AC-5.1: Given a modelRegistry stub with >=1 configured model (mocked, no real
  // provider calls), when listAvailableModels() is called, then it returns a
  // non-empty array with id/label/provider for each.
  test("AC-5.1: listAvailableModels() returns a non-empty summary array from a stubbed registry", async () => {
    const registry = makeRegistryStub([
      makeModel({ id: "claude-opus-4-5", name: "Claude Opus 4.5", provider: "anthropic" }),
      makeModel({ id: "gpt-5.5", name: "GPT-5.5", provider: "openai" }),
    ]);

    const result = await listAvailableModels(registry);

    expect(result.length).toBe(2);
    expect(result).toContainEqual({ id: "anthropic/claude-opus-4-5", label: "Claude Opus 4.5", provider: "anthropic" });
    expect(result).toContainEqual({ id: "openai/gpt-5.5", label: "GPT-5.5", provider: "openai" });
  });

  // AC-5.2: Given a valid model id, when resolveModelById(id) is called, then it
  // returns a Model<Api> matching what resolveCliModel would return for the
  // equivalent CLI spec.
  test("AC-5.2: resolveModelById() matches resolveCliModel()'s result for the equivalent spec", async () => {
    const opus = makeModel({ id: "claude-opus-4-5", name: "Claude Opus 4.5", provider: "anthropic" });
    const registry = makeRegistryStub([opus]);

    const resolved = await resolveModelById("anthropic/claude-opus-4-5", registry);
    const expected = resolveCliModel({ cliModel: "anthropic/claude-opus-4-5", modelRegistry: registry }).model;

    expect(resolved).toEqual(expected);
    expect(resolved?.id).toBe("claude-opus-4-5");
    expect(resolved?.provider).toBe("anthropic");
  });

  // AC-5.3 [R]: Given an invalid/unknown model id, when resolveModelById(id) is
  // called, then it returns undefined and never throws.
  test("AC-5.3: resolveModelById() returns undefined for an unknown id without throwing", async () => {
    const registry = makeRegistryStub([
      makeModel({ id: "claude-opus-4-5", name: "Claude Opus 4.5", provider: "anthropic" }),
    ]);

    let threw = false;
    let result: Model<Api> | undefined;
    try {
      result = await resolveModelById("nonexistent/does-not-exist", registry);
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result).toBeUndefined();
  });

  test("AC-5.3: resolveModelById() returns undefined for an empty registry, never throws", async () => {
    const registry = makeRegistryStub([]);

    const result = await resolveModelById("anything", registry);

    expect(result).toBeUndefined();
  });
});
