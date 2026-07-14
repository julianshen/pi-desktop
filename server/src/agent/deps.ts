import fs from "node:fs";
import path from "node:path";
import {
  AuthStorage,
  ModelRegistry,
  defineTool,
  resolveCliModel,
} from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import { env } from "../config/env.js";
import { createMemoryTools } from "../memory/tools.js";
import { createComputerUseTools } from "../computer-use/tools.js";
import { loadMcpTools } from "../mcp/client.js";

export interface AgentDeps {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  model: Model<Api> | undefined;
  customTools: ReturnType<typeof defineTool>[];
}

let depsPromise: Promise<AgentDeps> | undefined;

/**
 * Auth, model registry, and the combined custom tool set (memory, computer-use, MCP)
 * are expensive to build (MCP servers spawn subprocesses) and shared by both the
 * interactive chat session and every scheduled agent run, so build them once.
 *
 * Deliberately NOT part of this bundle: any tool factory that's scoped to a single
 * conversation/task id, e.g. artifacts/tools.ts's `createArtifactTools(conversationId)`
 * or web-fetch/tools.ts's `createWebFetchTools(conversationId, sessionKind)`. Both
 * close over per-conversation state (approved-hosts, artifact storage) and, for
 * web_fetch, over a `sessionKind: "interactive" | "scheduled"` that determines
 * whether a private-target fetch pauses for approval or hard-blocks outright
 * (US-05) — baking either into this singleton, built once from whichever caller
 * happens to trigger it first, would either leak state across conversations or
 * permanently fix `sessionKind` for the process. Callers build those per-session
 * instead, appending onto `customTools` at the actual session-creation call site:
 * agent/conversations.ts's `createSession()` (interactive, `sessionKind:
 * "interactive"`) and scheduler/index.ts's `createScheduledSession()` (scheduled,
 * `sessionKind: "scheduled"`).
 */
export function getAgentDeps(): Promise<AgentDeps> {
  if (!depsPromise) {
    depsPromise = buildDeps();
  }
  return depsPromise;
}

async function buildDeps(): Promise<AgentDeps> {
  fs.mkdirSync(env.agentDir, { recursive: true });

  const authStorage = AuthStorage.create(path.join(env.agentDir, "auth.json"));
  const modelRegistry = ModelRegistry.create(authStorage, path.join(env.agentDir, "models.json"));

  let model: Model<Api> | undefined;
  if (env.modelSpec) {
    const resolved = resolveCliModel({ cliModel: env.modelSpec, modelRegistry });
    if (resolved.error) {
      console.warn(`[agent] could not resolve PI_DESKTOP_MODEL="${env.modelSpec}": ${resolved.error}`);
    } else {
      model = resolved.model;
    }
  }

  const mcpTools = await loadMcpTools();
  const customTools = [...createMemoryTools(), ...createComputerUseTools(), ...mcpTools];

  return { authStorage, modelRegistry, model, customTools };
}
