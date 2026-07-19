import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { ChatWorkspaceStore } from "./store.js";
import { ConversationWorkspace } from "./conversations.js";
import { RunManager } from "./runs.js";
import { createChatWorkspaceRouter } from "./routes.js";

let server: Server; let baseUrl: string; let root: string; let store: ChatWorkspaceStore; let manager: RunManager;
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-run-routes-"));
  store = new ChatWorkspaceStore({ dataDir: root }); manager = new RunManager(store);
  const now = new Date().toISOString(); store.createConversation({ id: "conversation", title: "Run routes", createdAt: now, updatedAt: now });
  const app = express(); app.use("/api", createChatWorkspaceRouter(new ConversationWorkspace(store, root), { runs: manager }));
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", (error?: Error) => error ? reject(error) : resolve());
  });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Expected listener");
  baseUrl = `http://127.0.0.1:${address.port}/api`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); fs.rmSync(root, { recursive: true, force: true }); });

describe("run routes", () => {
  test("AC-9.1: JSON replay honors the after cursor exactly", async () => {
    const created = await fetch(`${baseUrl}/conversations/conversation/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(created.status).toBe(201); const run = await created.json() as { id: string };
    manager.emit(run.id, "progress", { step: 1 }); manager.emit(run.id, "progress", { step: 2 });
    const replay = await (await fetch(`${baseUrl}/runs/${run.id}/events?after=1`)).json() as Array<{ cursor: number }>;
    expect(replay.map((event) => event.cursor)).toEqual([2, 3]);
  });

  test("AC-9.2: disconnecting an SSE client does not stop the owning run", async () => {
    const run = manager.start({ conversationId: "conversation" });
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/runs/${run.id}/events`, { headers: { Accept: "text/event-stream" }, signal: controller.signal });
    expect(response.status).toBe(200); controller.abort(); await response.body?.cancel().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(manager.get(run.id)?.status).toBe("running");
  });

  test("stop is idempotent and returns the persisted terminal state", async () => {
    const run = manager.start({ conversationId: "conversation" });
    const first = await (await fetch(`${baseUrl}/runs/${run.id}/stop`, { method: "POST" })).json() as { status: string };
    const second = await (await fetch(`${baseUrl}/runs/${run.id}/stop`, { method: "POST" })).json() as { status: string };
    expect(first.status).toBe("stopped"); expect(second.status).toBe("stopped");
  });
});
