import express from "express";
import cors from "cors";
import { env } from "./config/env.js";
import { handleAguiRun } from "./agui/adapter.js";
import { createCopilotEndpoint } from "./copilot/runtime.js";
import { startScheduler } from "./scheduler/index.js";

async function main(): Promise<void> {
  const app = express();
  app.use(cors());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
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

  app.listen(env.port, env.host, () => {
    console.log(`[pi-desktop] server listening on ${baseUrl}`);
  });

  startScheduler();
}

main().catch((error: unknown) => {
  console.error("[pi-desktop] fatal error during startup", error);
  process.exit(1);
});
