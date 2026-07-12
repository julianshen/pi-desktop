import express, { type Express } from "express";
import cors from "cors";
import { env } from "./config/env.js";
import { handleAguiRun } from "./agui/adapter.js";
import { createCopilotEndpoint } from "./copilot/runtime.js";
import { startScheduler } from "./scheduler/index.js";
import { listConversations, createConversation, getConversationMeta } from "./agent/conversations.js";

/**
 * Builds the Express app without binding a port, so tests (index.test.ts) can
 * app.listen(0) it on an ephemeral port and hit it with real HTTP requests, instead
 * of duplicating route logic or mocking Express. main() below is the only caller
 * that actually binds env.port.
 */
export function createApp(): Express {
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
