import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatWorkspaceStore } from "../chat-workspace/store.js";
import { AttachmentError, AttachmentWorkspace, MAX_ATTACHMENT_BYTES } from "../chat-workspace/attachments.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-security-")); roots.push(root);
  const store = new ChatWorkspaceStore({ dataDir: path.join(root, "data") });
  const now = new Date().toISOString(); store.createConversation({ id: "conversation", title: "Security", createdAt: now, updatedAt: now });
  return { root, store, attachments: new AttachmentWorkspace(store, path.join(root, "data")) };
}

describe("agent chat security boundary matrix", () => {
  test("AC-18.2: symlinks, spoofed images, oversized input, and cross-conversation IDs fail closed", async () => {
    const { root, store, attachments } = workspace();
    const ordinary = path.join(root, "ordinary.txt"); fs.writeFileSync(ordinary, "safe");
    if (process.platform !== "win32") {
      const link = path.join(root, "link.txt"); fs.symlinkSync(ordinary, link);
      await expect(attachments.stage("conversation", link)).rejects.toMatchObject({ code: "SYMLINK_NOT_ALLOWED" } satisfies Partial<AttachmentError>);
    }
    const spoof = path.join(root, "spoof.png"); fs.writeFileSync(spoof, "not a png");
    await expect(attachments.stage("conversation", spoof)).rejects.toMatchObject({ code: "SIGNATURE_MISMATCH" } satisfies Partial<AttachmentError>);
    const oversized = path.join(root, "large.txt"); fs.writeFileSync(oversized, "x"); fs.truncateSync(oversized, MAX_ATTACHMENT_BYTES + 1);
    await expect(attachments.stage("conversation", oversized)).rejects.toMatchObject({ code: "TOO_LARGE" } satisfies Partial<AttachmentError>);
    const staged = await attachments.stage("conversation", ordinary);
    await expect(attachments.materialize("other-conversation", [staged.id])).rejects.toMatchObject({ code: "NOT_FOUND" } satisfies Partial<AttachmentError>);
    store.close();
  });

  test("AC-18.2: rich rendering, credential redaction, and native capability boundaries remain explicit", () => {
    const repo = path.resolve(import.meta.dir, "../../..");
    const message = fs.readFileSync(path.join(repo, "src/components/chat/Message.tsx"), "utf8");
    expect(message).toContain('securityLevel: "strict"');
    expect(message).toContain("linkSafety={{ enabled: true }}");
    const settings = fs.readFileSync(path.join(repo, "server/src/search/settings.ts"), "utf8");
    expect(settings).toContain("keyPresent: !!settings.apiKey");
    expect(settings).not.toMatch(/return\s+\{[^}]*apiKey:\s*settings\.apiKey/s);
    const capability = JSON.parse(fs.readFileSync(path.join(repo, "src-tauri/capabilities/default.json"), "utf8")) as { windows: string[]; permissions: string[] };
    expect(capability.windows).toEqual(["main"]);
    expect(capability.permissions).not.toContain("fs:default");
    const native = fs.readFileSync(path.join(repo, "src-tauri/src/generated_files.rs"), "utf8");
    expect(native).toContain("fn safe_id");
    expect(native).toContain("symlink_metadata");
  });
});
