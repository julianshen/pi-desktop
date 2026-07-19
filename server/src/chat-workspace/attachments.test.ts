import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatWorkspaceStore } from "./store.js";
import { AttachmentWorkspace, AttachmentError } from "./attachments.js";

const roots: string[] = [];

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-attachments-"));
  roots.push(root);
  const dataDir = path.join(root, "data");
  const originals = path.join(root, "originals");
  fs.mkdirSync(originals, { recursive: true });
  const store = new ChatWorkspaceStore({ dataDir });
  const now = new Date().toISOString();
  store.createConversation({ id: "conversation", title: "Attachments", createdAt: now, updatedAt: now });
  return { root, dataDir, originals, store, workspace: new AttachmentWorkspace(store, dataDir) };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("AttachmentWorkspace", () => {
  test("AC-5.1: valid text and image are copied, hashed, and leave originals unchanged", async () => {
    const { originals, store, workspace } = setup();
    const textPath = path.join(originals, "notes.md");
    const imagePath = path.join(originals, "pixel.png");
    fs.writeFileSync(textPath, "# Notes\nLocal only");
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));

    const text = await workspace.stage("conversation", textPath);
    const image = await workspace.stage("conversation", imagePath);

    expect(text).toMatchObject({ displayName: "notes.md", mediaType: "text/markdown", ingestionStatus: "ready", providerDisposition: "local_only" });
    expect(image).toMatchObject({ displayName: "pixel.png", mediaType: "image/png", ingestionStatus: "ready", providerDisposition: "local_only" });
    expect(text.sha256).toHaveLength(64);
    expect(fs.readFileSync(text.localPath, "utf8")).toBe("# Notes\nLocal only");
    expect(fs.readFileSync(textPath, "utf8")).toBe("# Notes\nLocal only");
    store.close();
  });

  test("AC-5.2: invalid size, type, signature, and symlink leave no partial files or rows", async () => {
    const { dataDir, originals, store, workspace } = setup();
    const oversized = path.join(originals, "large.txt");
    const html = path.join(originals, "page.html");
    const fakePng = path.join(originals, "fake.png");
    const real = path.join(originals, "real.txt");
    const link = path.join(originals, "link.txt");
    fs.closeSync(fs.openSync(oversized, "w"));
    fs.truncateSync(oversized, 25 * 1024 * 1024 + 1);
    fs.writeFileSync(html, "<script>alert(1)</script>");
    fs.writeFileSync(fakePng, "not a png");
    fs.writeFileSync(real, "real");
    fs.symlinkSync(real, link);

    for (const [file, code] of [[oversized, "TOO_LARGE"], [html, "UNSUPPORTED_TYPE"], [fakePng, "SIGNATURE_MISMATCH"], [link, "SYMLINK_NOT_ALLOWED"]] as const) {
      await expect(workspace.stage("conversation", file)).rejects.toMatchObject({ code } satisfies Partial<AttachmentError>);
    }
    expect(store.listAttachments("conversation")).toEqual([]);
    const owned = path.join(dataDir, "attachments", "conversation");
    expect(fs.existsSync(owned) ? fs.readdirSync(owned) : []).toEqual([]);
    store.close();
  });

  test("AC-5.3: materialization returns only referenced IDs and updates only their disposition", async () => {
    const { originals, store, workspace } = setup();
    const paths = ["one.txt", "two.txt", "three.txt"].map((name, index) => {
      const file = path.join(originals, name);
      fs.writeFileSync(file, `content-${index + 1}`);
      return file;
    });
    const staged = await Promise.all(paths.map((file) => workspace.stage("conversation", file)));

    const materialized = await workspace.materialize("conversation", [staged[1]!.id]);

    expect(materialized.textReferences).toEqual([{ id: staged[1]!.id, name: "two.txt", text: "content-2" }]);
    expect(materialized.images).toEqual([]);
    const rows = store.listAttachments("conversation");
    expect(rows.find((row) => row.id === staged[1]!.id)?.providerDisposition).toBe("referenced");
    expect(rows.filter((row) => row.providerDisposition === "local_only")).toHaveLength(2);
    store.close();
  });

  test("AC-7.3: a staged attachment cannot be materialized from a sibling branch", async () => {
    const { originals, store, workspace } = setup();
    const file = path.join(originals, "branch-secret.txt");
    fs.writeFileSync(file, "branch A only");
    const staged = await workspace.stage("conversation", file, "branch-a");

    await expect(workspace.materialize("conversation", [staged.id], "branch-b")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const ownBranch = await workspace.materialize("conversation", [staged.id], "branch-a");
    expect(ownBranch.textReferences[0]?.text).toBe("branch A only");
    store.close();
  });
});
