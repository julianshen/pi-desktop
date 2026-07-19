import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatWorkspaceStore } from "./store.js";
import { RunManager } from "./runs.js";

const roots: string[] = [];
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-runs-")); roots.push(root);
  const store = new ChatWorkspaceStore({ dataDir: root });
  const now = new Date().toISOString();
  store.createConversation({ id: "conversation", title: "Runs", createdAt: now, updatedAt: now });
  return { store, manager: new RunManager(store) };
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("RunManager", () => {
  test("AC-9.1: reconnect after K replays K+1 through N once and in order", () => {
    const { store, manager } = setup();
    const run = manager.start({ conversationId: "conversation" });
    manager.emit(run.id, "step", { n: 1 }); manager.emit(run.id, "step", { n: 2 }); manager.emit(run.id, "step", { n: 3 });
    const all = manager.events(run.id);
    const after = manager.events(run.id, 2);
    expect(all.map((event) => event.cursor)).toEqual([1, 2, 3, 4]);
    expect(after.map((event) => event.cursor)).toEqual([3, 4]);
    store.close();
  });

  test("AC-9.3: stop and natural completion race commits exactly one terminal event", () => {
    const { store, manager } = setup();
    const run = manager.start({ conversationId: "conversation" });
    expect(manager.stop(run.id)?.status).toBe("stopped");
    expect(manager.finish(run.id, "completed")).toBeUndefined();
    expect(manager.events(run.id).filter((event) => /run_(stopped|completed)$/.test(event.type))).toHaveLength(1);
    store.close();
  });

  test("startup converts persisted running rows to interrupted truthfully", () => {
    const { store, manager } = setup();
    const run = manager.start({ conversationId: "conversation" });
    const restarted = new RunManager(store);
    expect(restarted.get(run.id)?.status).toBe("interrupted");
    expect(restarted.events(run.id).at(-1)?.type).toBe("run_interrupted");
    store.close();
  });

  test("steering is accepted only for a running run with an owning handler", async () => {
    const { store, manager } = setup();
    const received: string[] = [];
    const run = manager.start({ conversationId: "conversation", steer: (instruction) => { received.push(instruction); } });
    await manager.steer(run.id, "Focus on the failing tests");
    expect(received).toEqual(["Focus on the failing tests"]);
    expect(manager.events(run.id).at(-1)?.type).toBe("run_steered");
    manager.finish(run.id, "completed");
    await expect(manager.steer(run.id, "too late")).rejects.toThrow("cannot be steered");
    store.close();
  });
});
