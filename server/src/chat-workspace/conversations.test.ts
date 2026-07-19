import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatWorkspaceStore } from "./store.js";
import { ConversationWorkspace } from "./conversations.js";

const roots: string[] = [];

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-conversation-workspace-"));
  roots.push(dataDir);
  const store = new ChatWorkspaceStore({ dataDir });
  return { dataDir, store, workspace: new ConversationWorkspace(store, dataDir) };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ConversationWorkspace", () => {
  test("AC-2.1: search/filter returns pinned first then updated descending with a safe snippet", () => {
    const { store, workspace } = setup();
    const project = workspace.createProject({ name: "Launch" });
    const folder = workspace.createFolder({ name: "Research", projectId: project.id });
    const older = workspace.createConversation({ title: "Brave search notes", projectId: project.id, folderId: folder.id });
    const newer = workspace.createConversation({ title: "Brave rollout", projectId: project.id, folderId: folder.id });
    workspace.updateConversation(older.id, { pinned: true });

    const result = workspace.listConversations({ q: "Brave", projectId: project.id, folderId: folder.id, status: "active" });

    expect(result.map((item) => item.id)).toEqual([older.id, newer.id]);
    expect(result.every((item) => item.searchSnippet?.toLowerCase().includes("brave"))).toBe(true);
    store.close();
  });

  test("AC-2.2: rename, move, pin, archive, and restore persist across store restart", () => {
    const { dataDir, store, workspace } = setup();
    const project = workspace.createProject({ name: "Product" });
    const folder = workspace.createFolder({ name: "Chat", projectId: project.id });
    const conversation = workspace.createConversation({ title: "Draft" });
    workspace.updateConversation(conversation.id, {
      title: "Agent chat",
      projectId: project.id,
      folderId: folder.id,
      pinned: true,
      archived: true,
    });
    workspace.updateConversation(conversation.id, { archived: false });
    store.close();

    const reopened = new ChatWorkspaceStore({ dataDir });
    const restored = reopened.getConversation(conversation.id);
    expect(restored).toMatchObject({
      title: "Agent chat",
      projectId: project.id,
      folderId: folder.id,
    });
    expect(restored?.pinnedAt).toBeString();
    expect(restored?.archivedAt).toBeUndefined();
    reopened.close();
  });

  test("AC-2.3: confirmed deletion removes only app-owned conversation data", () => {
    const { dataDir, store, workspace } = setup();
    const conversation = workspace.createConversation({ title: "Delete me" });
    const ownedDir = path.join(dataDir, "conversations", conversation.id);
    fs.mkdirSync(ownedDir, { recursive: true });
    fs.writeFileSync(path.join(ownedDir, "owned.txt"), "owned");
    const generatedDir = path.join(dataDir, "generated-files", conversation.id, "run-1");
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(path.join(generatedDir, "generated-id"), "generated");
    const external = path.join(path.dirname(dataDir), `${conversation.id}-original.txt`);
    fs.writeFileSync(external, "external");

    workspace.deleteConversation(conversation.id, { deleteOwnedFiles: true });

    expect(store.getConversation(conversation.id)).toBeUndefined();
    expect(fs.existsSync(ownedDir)).toBe(false);
    expect(fs.existsSync(generatedDir)).toBe(false);
    expect(fs.readFileSync(external, "utf8")).toBe("external");
    fs.rmSync(external, { force: true });
    store.close();
  });
});
