import { afterEach, expect, test } from "bun:test";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { ChatWorkspaceStore } from "./store.js"; import { RunManager } from "./runs.js";
import { createGeneratedFileTools } from "./generated-files.js"; import { setActivePlanRun } from "../agent/plan-tools.js";

const roots: string[] = []; afterEach(() => { setActivePlanRun("conversation", undefined); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
test("generated files are copied into run-scoped app storage and return IDs without source paths", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-generated-tool-")); roots.push(root);
  const dataDir = path.join(root, "data");
  const store = new ChatWorkspaceStore({ dataDir }); const now = new Date().toISOString();
  store.createConversation({ id: "conversation", title: "Files", createdAt: now, updatedAt: now }); const manager = new RunManager(store); const run = manager.start({ conversationId: "conversation" });
  setActivePlanRun("conversation", { manager, runId: run.id }); const cwd = path.join(root, "cwd"); fs.mkdirSync(cwd); fs.writeFileSync(path.join(cwd, "report.csv"), "a,b\n1,2\n");
  const tool = createGeneratedFileTools("conversation", cwd, dataDir)[0]!; const result = await tool.execute("call", { path: "report.csv" }, undefined, undefined, {} as never) as { details: { generatedFile: { id: string; runId: string } } };
  expect(result.details.generatedFile.runId).toBe(run.id);
  expect(fs.readFileSync(path.join(dataDir, "generated-files", "conversation", run.id, result.details.generatedFile.id), "utf8")).toBe("a,b\n1,2\n");
  expect(JSON.stringify(result)).not.toContain(cwd);
  store.close();
});
