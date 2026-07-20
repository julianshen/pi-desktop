import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { Server } from "node:http";
import { ChatWorkspaceStore } from "./store.js";
import { ConversationWorkspace } from "./conversations.js";
import { createChatWorkspaceRouter } from "./routes.js";
import { AttachmentWorkspace } from "./attachments.js";

let server: Server;
let baseUrl: string;
let root: string;
let store: ChatWorkspaceStore;
let attachmentWorkspace: AttachmentWorkspace;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-workspace-routes-"));
  store = new ChatWorkspaceStore({ dataDir: root });
  attachmentWorkspace = new AttachmentWorkspace(store, root);
  const app = express();
  app.use("/api", createChatWorkspaceRouter(new ConversationWorkspace(store, root), { attachments: attachmentWorkspace }));
  app.post("/api/conversations/:id/chat", express.json({ limit: "10mb" }), (req, res) => {
    res.json({ textLength: req.body?.messages?.[0]?.parts?.[0]?.text?.length });
  });
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  baseUrl = `http://127.0.0.1:${address.port}/api`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("chat workspace routes", () => {
  test("chat requests bypass the workspace router 1 MiB parser and use their own limit", async () => {
    const text = "x".repeat(1024 * 1024 + 1);
    const response = await fetch(`${baseUrl}/conversations/conversation/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", parts: [{ type: "text", text }] }] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ textLength: text.length });
  });

  test("AC-2.1: organization, lifecycle, and filtered list use stable JSON contracts", async () => {
    const project = await (await fetch(`${baseUrl}/projects`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Launch" }),
    })).json() as { id: string };
    const folder = await (await fetch(`${baseUrl}/folders`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Research", projectId: project.id }),
    })).json() as { id: string };
    const created = await (await fetch(`${baseUrl}/conversations`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Brave notes", projectId: project.id, folderId: folder.id }),
    })).json() as { id: string };

    const patched = await fetch(`${baseUrl}/conversations/${created.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Brave rollout", pinned: true, archived: false }),
    });
    expect(patched.status).toBe(200);

    const list = await (await fetch(`${baseUrl}/conversations?q=Brave&projectId=${project.id}&folderId=${folder.id}&status=active&pinned=true`)).json() as Array<{ id: string; searchSnippet: string }>;
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(created.id);
    expect(list[0]?.searchSnippet).toContain("Brave");
  });

  test("AC-2.2: invalid bodies and unknown IDs use one structured error shape", async () => {
    const invalid = await fetch(`${baseUrl}/projects`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "" }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: { code: "VALIDATION_ERROR", message: "Name is required", retryable: false },
    });

    const missing = await fetch(`${baseUrl}/conversations/missing`, { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Conversation not found", retryable: false },
    });
  });

  test("AC-5.1: attachment routes return opaque metadata without local paths or hashes", async () => {
    const source = path.join(root, "route-notes.txt");
    fs.writeFileSync(source, "route attachment");
    const conversation = await (await fetch(`${baseUrl}/conversations`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Attachment route" }),
    })).json() as { id: string };

    const response = await fetch(`${baseUrl}/conversations/${conversation.id}/attachments`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ localPath: source }),
    });
    expect(response.status).toBe(201);
    const attachment = await response.json() as Record<string, unknown>;
    expect(attachment).toMatchObject({ displayName: "route-notes.txt", mediaType: "text/plain", ingestionStatus: "ready", providerDisposition: "local_only" });
    expect(attachment.localPath).toBeUndefined();
    expect(attachment.sha256).toBeUndefined();

    const remove = await fetch(`${baseUrl}/conversations/${conversation.id}/attachments/${attachment.id}`, { method: "DELETE" });
    expect(remove.status).toBe(204);
  });
});
