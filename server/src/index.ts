import express, { type Express } from "express";
import cors from "cors";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { env } from "./config/env.js";
import { handleAguiRun } from "./agui/adapter.js";
import { createCopilotEndpoint } from "./copilot/runtime.js";
import { startScheduler } from "./scheduler/index.js";
import { listConversations, createConversation, getConversationMeta, touchConversation } from "./agent/conversations.js";
import { listAvailableModels, resolveModelById } from "./agent/models.js";

/**
 * Task 6: both models.ts functions already accept an optional ModelRegistry
 * override (built for exactly this — see models.ts's own comment), so createApp()
 * forwards one through rather than always falling back to the real
 * getAgentDeps()-sourced registry. Lets index.test.ts exercise GET /api/models and
 * PATCH /api/conversations/:id/model against a stubbed registry with configured
 * models, mirroring agent/models.test.ts's makeRegistryStub pattern, instead of a
 * real provider-less registry that would always resolve empty/undefined.
 */
export interface CreateAppOptions {
  modelRegistry?: ModelRegistry;
}

/**
 * Builds the Express app without binding a port, so tests (index.test.ts) can
 * app.listen(0) it on an ephemeral port and hit it with real HTTP requests, instead
 * of duplicating route logic or mocking Express. main() below is the only caller
 * that actually binds env.port.
 */
export function createApp(options?: CreateAppOptions): Express {
  const app = express();
  app.use(cors());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Task 4 (AC-4.1/AC-4.2): list all conversations. listConversations() already
  // sorts by updatedAt desc internally (agent/conversations.ts) — verified there
  // rather than re-sorted here, so this route just forwards its result as the API
  // contract.
  app.get("/api/conversations", (_req, res) => {
    res.json(listConversations());
  });

  // Task 4 (AC-4.2): create a conversation, optionally titled.
  app.post("/api/conversations", express.json(), (req, res) => {
    const body = req.body as { title?: unknown } | undefined;
    const title = typeof body?.title === "string" ? body.title : undefined;
    const meta = createConversation(title);
    res.status(201).json(meta);
  });

  // Task 4 (AC-4.3): 404, not a silent 200 null/empty, for an unknown id.
  app.get("/api/conversations/:id", (req, res) => {
    const meta = getConversationMeta(req.params.id);
    if (!meta) {
      res.status(404).end();
      return;
    }
    res.json(meta);
  });

  // Task 6 (AC-6.1): list available models. listAvailableModels() forwards to
  // getAgentDeps()'s real modelRegistry when options.modelRegistry is unset (the
  // production default); index.test.ts injects a stub via options for a
  // deterministic, non-empty response.
  app.get("/api/models", (_req, res) => {
    listAvailableModels(options?.modelRegistry)
      .then((models) => res.json(models))
      .catch((error: unknown) => {
        console.error("[api/models] unhandled error", error);
        if (!res.headersSent) res.status(500).end();
      });
  });

  // Task 6 (AC-6.2/AC-6.3): switch a conversation's model. 404 for an unknown
  // conversation id (checked first, same pattern as GET /api/conversations/:id
  // above). 400 for a modelId that resolveModelById can't resolve — per Task 5's
  // AC-5.3 contract resolveModelById returns undefined rather than throwing, so this
  // is a plain undefined check; per SPEC.md, touchConversation is deliberately not
  // called in that case, leaving the conversation's modelId unchanged.
  app.patch("/api/conversations/:id/model", express.json(), (req, res) => {
    const meta = getConversationMeta(req.params.id);
    if (!meta) {
      res.status(404).end();
      return;
    }

    const body = req.body as { modelId?: unknown } | undefined;
    const modelId = typeof body?.modelId === "string" ? body.modelId : undefined;

    (modelId ? resolveModelById(modelId, options?.modelRegistry) : Promise.resolve(undefined))
      .then((resolved) => {
        if (!resolved) {
          res.status(400).end();
          return;
        }
        touchConversation(req.params.id, { modelId });
        res.json(getConversationMeta(req.params.id));
      })
      .catch((error: unknown) => {
        console.error("[api/conversations/:id/model] unhandled error", error);
        if (!res.headersSent) res.status(500).end();
      });
  });

  // Raw AG-UI run endpoint, bridging pi's AgentSession event stream (see agui/adapter.ts).
  app.post("/agui", express.json({ limit: "10mb" }), (req, res) => {
    handleAguiRun(req, res).catch((error: unknown) => {
      console.error("[agui] unhandled error", error);
      if (!res.headersSent) res.status(500).end();
    });
  });

  const baseUrl = `http://${env.host}:${env.port}`;

  // Mounted at root (not app.use("/copilotkit", ...)): the handler's internal router is built
  // with basePath: "/copilotkit" and reads the raw req.url, which Express already strips of the
  // mount prefix for path-scoped app.use() — mounting at root keeps req.url as the full path so
  // the two agree. CopilotKit's own runtime does its own body parsing; mount unparsed.
  app.use(createCopilotEndpoint(baseUrl));

  return app;
}

async function main(): Promise<void> {
  const app = createApp();
  const baseUrl = `http://${env.host}:${env.port}`;

  app.listen(env.port, env.host, () => {
    console.log(`[pi-desktop] server listening on ${baseUrl}`);
  });

  startScheduler();
}

// Bun-native entrypoint guard (equivalent of Node's require.main === module): only run
// main()'s side effects (binding env.port, starting the scheduler) when this file is
// executed directly, not when index.test.ts imports createApp() for in-process testing.
if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error("[pi-desktop] fatal error during startup", error);
    process.exit(1);
  });
}
