import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatWorkspaceStore } from "../chat-workspace/store.js";
import { RunManager } from "../chat-workspace/runs.js";
import { createPlanTools, setActivePlanRun } from "./plan-tools.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const context = {} as ExtensionContext;

const roots: string[] = [];
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-plan-tools-")); roots.push(root);
  const store = new ChatWorkspaceStore({ dataDir: root }); const now = new Date().toISOString();
  store.createConversation({ id: "conversation", title: "Plan", createdAt: now, updatedAt: now });
  const manager = new RunManager(store); const run = manager.start({ conversationId: "conversation" });
  setActivePlanRun("conversation", { manager, runId: run.id });
  return { store, manager, run, tool: createPlanTools("conversation")[0]! };
}
afterEach(() => { setActivePlanRun("conversation", undefined); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("update_plan tool", () => {
  test("AC-11.1: projection and committed event contain the same ordered steps", async () => {
    const { store, manager, run, tool } = setup();
    await tool.execute("call", { explanation: "Work", steps: [
      { id: "inspect", text: "Inspect", status: "in_progress" }, { id: "finish", text: "Finish", status: "pending" },
    ] }, undefined, undefined, context);
    expect(manager.plan(run.id).map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "inspect", status: "in_progress" }, { id: "finish", status: "pending" },
    ]);
    expect(manager.events(run.id).at(-1)?.data).toMatchObject({ steps: [{ id: "inspect" }, { id: "finish" }] });
    store.close();
  });

  test("AC-11.3: invalid or terminal updates reject without partial mutation", async () => {
    const { store, manager, run, tool } = setup();
    const invalid = { steps: [{ id: "same", text: "One", status: "in_progress" }, { id: "same", text: "Two", status: "in_progress" }] } as const;
    await expect(tool.execute("call", invalid, undefined, undefined, context)).rejects.toThrow();
    expect(manager.plan(run.id)).toEqual([]);
    manager.finish(run.id, "completed");
    await expect(tool.execute("call", { steps: [{ id: "one", text: "One", status: "completed" }] }, undefined, undefined, context)).rejects.toThrow();
    expect(manager.plan(run.id)).toEqual([]);
    store.close();
  });
});
