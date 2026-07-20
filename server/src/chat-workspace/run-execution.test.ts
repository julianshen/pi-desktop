import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatWorkspaceStore } from "./store.js";
import { journalRunStream, RunManager } from "./runs.js";

const roots: string[] = [];
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-run-execution-")); roots.push(root);
  const store = new ChatWorkspaceStore({ dataDir: root });
  const now = new Date().toISOString(); store.createConversation({ id: "conversation", title: "Execution", createdAt: now, updatedAt: now });
  store.createBranch({ id: "branch", conversationId: "conversation", createdAt: now, updatedAt: now });
  return { store, manager: new RunManager(store) };
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("durable run execution", () => {
  test("AC-10.1: every outward chunk is committed before a consumer receives it", async () => {
    const { store, manager } = setup(); const run = manager.start({ conversationId: "conversation", branchId: "branch" });
    const source = new ReadableStream<{ type: string; text?: string }>({ start(controller) { controller.enqueue({ type: "text-delta", text: "hello" }); controller.close(); } });
    const reader = journalRunStream(manager, run.id, source).getReader();
    const first = await reader.read();
    expect(first.value).toEqual({ type: "text-delta", text: "hello" });
    expect(manager.events(run.id).some((event) => event.type === "ui_message_chunk" && (event.data as { text?: string }).text === "hello")).toBe(true);
    await reader.read();
    expect(manager.get(run.id)?.status).toBe("completed");
    store.close();
  });

  test("AC-10.2: cancelling the visible response does not stop the keep-alive drain", async () => {
    const { store, manager } = setup(); const run = manager.start({ conversationId: "conversation" });
    let controller!: ReadableStreamDefaultController<{ type: string }>;
    const source = new ReadableStream<{ type: string }>({ start(value) { controller = value; } });
    const visible = journalRunStream(manager, run.id, source);
    const cancelled = visible.cancel();
    controller.enqueue({ type: "progress" }); controller.close();
    await cancelled;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(manager.events(run.id).some((event) => event.type === "ui_message_chunk")).toBe(true);
    expect(manager.get(run.id)?.status).toBe("completed");
    store.close();
  });

  test("AC-10.3: startup recovery marks an unfinished execution interrupted", () => {
    const { store, manager } = setup(); const run = manager.start({ conversationId: "conversation" });
    const restarted = new RunManager(store);
    expect(restarted.get(run.id)?.status).toBe("interrupted");
    store.close();
  });
});
