import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ChatWorkspaceStore } from "../server/src/chat-workspace/store.js";
import { ConversationWorkspace } from "../server/src/chat-workspace/conversations.js";
import { AttachmentWorkspace } from "../server/src/chat-workspace/attachments.js";
import { BranchWorkspace } from "../server/src/chat-workspace/branches.js";
import { RunManager } from "../server/src/chat-workspace/runs.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("agent chat representative workflow", () => {
  test("AC-18.1: organize, attach, plan, steer, restore, branch, and return without cross-branch leakage", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-chat-e2e-")); roots.push(root);
    const dataDir = path.join(root, "data");
    const store = new ChatWorkspaceStore({ dataDir });
    const conversations = new ConversationWorkspace(store, dataDir);
    const attachments = new AttachmentWorkspace(store, dataDir);
    const branches = new BranchWorkspace(store);
    const project = conversations.createProject({ name: "Launch" });
    const folder = conversations.createFolder({ name: "Research", projectId: project.id });
    const conversation = conversations.createConversation({ title: "Agent command center", projectId: project.id, folderId: folder.id });

    const session = SessionManager.create(path.join(root, "cwd"), path.join(root, "sessions"));
    const rootMessage = session.appendMessage({ role: "user", content: "Research the current landscape", timestamp: Date.now() });
    const branchA = branches.ensureRoot(conversation.id, session);
    const source = path.join(root, "brief.md"); fs.writeFileSync(source, "# Private brief\nReference only when attached.");
    const attachment = await attachments.stage(conversation.id, source, branchA.id);
    const materialized = await attachments.materialize(conversation.id, [attachment.id], branchA.id);
    expect(materialized.textReferences[0]?.text).toContain("Private brief");

    let steered = "";
    const runs = new RunManager(store);
    const run = runs.start({ conversationId: conversation.id, branchId: branchA.id, model: "anthropic/model", steer: (instruction) => { steered = instruction; } });
    runs.updatePlan(run.id, { steps: [
      { id: "inspect", text: "Inspect sources", status: "completed" },
      { id: "synthesize", text: "Synthesize result", status: "in_progress" },
    ] });
    await runs.steer(run.id, "Focus on primary evidence");
    runs.emit(run.id, "search_completed", { provider: "brave", resultCount: 2 });

    // Window hide/reopen does not recreate the tray-owned manager: durable projection remains readable.
    expect(runs.get(run.id)?.status).toBe("running");
    expect(runs.plan(run.id).find((step) => step.status === "in_progress")?.title).toBe("Synthesize result");
    expect(steered).toBe("Focus on primary evidence");
    expect(runs.events(run.id).map((event) => event.cursor)).toEqual([1, 2, 3, 4]);

    runs.finish(run.id, "completed");
    const branchB = await branches.create(conversation.id, { sourceMessageId: rootMessage, replacementContent: "Research a different market" }, session);
    await expect(attachments.materialize(conversation.id, [attachment.id], branchB.id)).rejects.toThrow("not found on the active branch");
    await branches.select(conversation.id, branchA.id, session);
    expect(branches.messages(conversation.id, branchA.id, session)[0]).toMatchObject({ content: "Research the current landscape" });
    expect(branches.messages(conversation.id, branchB.id, session)[0]).toMatchObject({ content: "Research a different market" });
    expect(store.getAttachment(conversation.id, attachment.id)?.providerDisposition).toBe("referenced");
    store.close();
  });
});
