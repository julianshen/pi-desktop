import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ChatWorkspaceStore } from "./store.js";
import { BranchWorkspace } from "./branches.js";

const roots: string[] = [];

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-branches-"));
  roots.push(root);
  const store = new ChatWorkspaceStore({ dataDir: path.join(root, "data") });
  const now = new Date().toISOString();
  store.createConversation({ id: "conversation", title: "Branches", createdAt: now, updatedAt: now });
  const manager = SessionManager.create(path.join(root, "cwd"), path.join(root, "sessions"));
  const first = manager.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
  const firstAnswer = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "root answer" }], api: "x", provider: "x", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
  const second = manager.appendMessage({ role: "user", content: "middle", timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "middle answer" }], api: "x", provider: "x", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
  return { store, manager, branches: new BranchWorkspace(store), first, firstAnswer, second };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("BranchWorkspace", () => {
  test("AC-7.1: editing a middle user message creates a child without mutating parent entries", async () => {
    const { store, manager, branches, second } = setup();
    const before = manager.getEntries().map((entry) => JSON.stringify(entry));
    const parent = branches.ensureRoot("conversation", manager);
    const child = await branches.create("conversation", { sourceMessageId: second, replacementContent: "edited middle" }, manager);

    expect(child.parentBranchId).toBe(parent.id);
    expect(manager.getEntries().map((entry) => JSON.stringify(entry))).toEqual(before);
    expect(branches.messages("conversation", child.id, manager).at(-1)).toMatchObject({ content: "edited middle", pending: true });
    store.close();
  });

  test("AC-7.2: editing the first message resets to a replacement root while both roots stay navigable", async () => {
    const { store, manager, branches, first } = setup();
    const original = branches.ensureRoot("conversation", manager);
    const replacement = await branches.create("conversation", { sourceMessageId: first, replacementContent: "new root" }, manager);

    expect(replacement.baseEntryId).toBeUndefined();
    expect(manager.getLeafId()).toBeNull();
    expect(branches.messages("conversation", replacement.id, manager)).toEqual([
      expect.objectContaining({ role: "user", content: "new root", pending: true }),
    ]);
    await branches.select("conversation", original.id, manager);
    expect(branches.messages("conversation", original.id, manager)[0]).toMatchObject({ role: "user", content: "root" });
    store.close();
  });

  test("AC-7.3: A to B to A restores each branch transcript independently", async () => {
    const { store, manager, branches, second } = setup();
    const a = branches.ensureRoot("conversation", manager);
    const aMessages = branches.messages("conversation", a.id, manager);
    const b = await branches.create("conversation", { sourceMessageId: second, replacementContent: "branch B" }, manager);
    expect(branches.messages("conversation", b.id, manager).some((message) => message.content === "middle answer")).toBe(false);
    await branches.select("conversation", a.id, manager);
    expect(branches.messages("conversation", a.id, manager)).toEqual(aMessages);
    store.close();
  });

  test("production navigateTree branches from the edited message parent", async () => {
    const { store, manager, branches, firstAnswer, second } = setup();
    const navigated: string[] = [];
    const session = {
      getLeafId: () => manager.getLeafId(),
      getEntry: (id: string) => manager.getEntry(id),
      getBranch: (id: string) => manager.getBranch(id),
      branch: (id: string) => manager.branch(id),
      resetLeaf: () => manager.resetLeaf(),
      navigateTree: async (id: string) => {
        navigated.push(id);
        manager.branch(id);
        return { cancelled: false };
      },
      appendMessage: (message: { role: "user"; content: string; timestamp: number }) => manager.appendMessage(message),
    };

    const child = await branches.create("conversation", { sourceMessageId: second, replacementContent: "edited middle" }, session);

    expect(navigated).toEqual([firstAnswer]);
    expect(child.baseEntryId).toBe(firstAnswer);
    expect(manager.getLeafId()).toBe(firstAnswer);
    store.close();
  });

  test("materializes a pending edited message exactly once before the next run", async () => {
    const { store, manager, branches, second } = setup();
    const child = await branches.create("conversation", {
      sourceMessageId: second,
      replacementContent: "edited middle",
    }, manager);

    const entryId = await branches.materializePendingReplacement("conversation", child.id, manager);
    expect(entryId).toBeTruthy();
    expect(manager.getEntry(entryId!)).toMatchObject({
      type: "message",
      message: { role: "user", content: "edited middle" },
    });
    expect(store.getBranch("conversation", child.id)).toMatchObject({
      leafEntryId: entryId,
      replacementContent: undefined,
    });

    const entryCount = manager.getEntries().length;
    expect(await branches.materializePendingReplacement("conversation", child.id, manager)).toBeUndefined();
    expect(manager.getEntries()).toHaveLength(entryCount);
    store.close();
  });
});
