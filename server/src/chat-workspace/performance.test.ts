import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatWorkspaceStore } from "./store.js";
import { AttachmentWorkspace, MAX_ATTACHMENT_BYTES } from "./attachments.js";
import { RunManager } from "./runs.js";
import { toAGUIHistory } from "../agent/conversations.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const elapsed = (start: number) => Math.round(performance.now() - start);

describe("agent chat bounded scale evidence", () => {
  test("AC-18.3: 2,000 conversations and 100,000 messages remain bounded", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-scale-")); roots.push(root);
    const store = new ChatWorkspaceStore({ dataDir: root }); const now = new Date().toISOString();
    let start = performance.now();
    for (let index = 0; index < 2_000; index += 1) store.createConversation({ id: `conversation-${index}`, title: `Conversation ${index}`, createdAt: now, updatedAt: now });
    const conversations = store.listConversations(); const conversationMs = elapsed(start);
    expect(conversations).toHaveLength(2_000);
    expect(conversationMs).toBeLessThan(30_000);

    const messages = Array.from({ length: 100_000 }, (_, index) => ({ role: "user", content: `message ${index}`, timestamp: index }));
    start = performance.now(); const restored = toAGUIHistory(messages as never); const messageMs = elapsed(start);
    expect(restored).toHaveLength(100_000);
    expect(messageMs).toBeLessThan(30_000);
    console.info(`[scale] conversations_2000_ms=${conversationMs} messages_100000_ms=${messageMs}`);
    store.close();
  }, 60_000);

  test("AC-18.3: 10,000 committed run events replay monotonically within budget", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-events-")); roots.push(root);
    const store = new ChatWorkspaceStore({ dataDir: root }); const now = new Date().toISOString();
    store.createConversation({ id: "conversation", title: "Scale", createdAt: now, updatedAt: now });
    const manager = new RunManager(store); const run = manager.start({ conversationId: "conversation" });
    const start = performance.now();
    for (let index = 0; index < 10_000; index += 1) manager.emit(run.id, "progress", { index });
    const replay = manager.events(run.id); const replayMs = elapsed(start);
    expect(replay).toHaveLength(10_001);
    expect(replay.at(-1)?.cursor).toBe(10_001);
    expect(replayMs).toBeLessThan(30_000);
    console.info(`[scale] run_events_10000_commit_replay_ms=${replayMs}`);
    store.close();
  }, 60_000);

  test("AC-18.3: a 25 MiB attachment is streamed into app storage", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-attachment-scale-")); roots.push(root);
    const dataDir = path.join(root, "data"); const store = new ChatWorkspaceStore({ dataDir }); const now = new Date().toISOString();
    store.createConversation({ id: "conversation", title: "Scale", createdAt: now, updatedAt: now });
    const source = path.join(root, "boundary.png"); const handle = fs.openSync(source, "w"); fs.writeSync(handle, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])); fs.ftruncateSync(handle, MAX_ATTACHMENT_BYTES); fs.closeSync(handle);
    const start = performance.now(); const record = await new AttachmentWorkspace(store, dataDir).stage("conversation", source); const attachmentMs = elapsed(start);
    expect(record.byteSize).toBe(MAX_ATTACHMENT_BYTES);
    expect(fs.statSync(record.localPath).size).toBe(MAX_ATTACHMENT_BYTES);
    expect(attachmentMs).toBeLessThan(30_000);
    console.info(`[scale] attachment_25mib_ms=${attachmentMs}`);
    store.close();
  }, 60_000);
});
